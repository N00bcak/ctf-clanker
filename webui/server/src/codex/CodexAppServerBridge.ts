import { spawn } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { dockerSpawn } from "../providers/docker.js";
import { WebuiDatabase } from "../db.js";
import type { CodexTask, RunnerHandle, WebuiConfig } from "../types.js";
import { appendCapped } from "../utils/logs.js";
import type { SecretRedactor } from "../utils/redactor.js";
import type { CodexSessionState } from "./CodexPtySessionManager.js";
import { expandHome, scrubTaskCodexHome } from "./auth.js";
import { appendSteeringLog, buildCodexPrompt, updateBridgeContext } from "./context.js";
import { codexConfigArgs, codexSandboxPolicy, nativeCodexSettings } from "./settings.js";

const APPROVAL_METHODS = new Set([
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
    "execCommandApproval",
    "applyPatchApproval"
]);

export interface AppServerProcess {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    killed: boolean;
    kill(): unknown;
    on(event: "close", listener: (code: number | null) => void): this;
}

export type AppServerSpawner = (task: CodexTask, handle: RunnerHandle, config: WebuiConfig) => AppServerProcess;

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

function defaultAppServerSpawner(task: CodexTask, handle: RunnerHandle, config: WebuiConfig): AppServerProcess {
    const { command, args } = codexAppServerCommand(task, handle, config);
    return task.codexRuntime === "container"
        ? dockerSpawn(args) as AppServerProcess
        : spawn(command, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] }) as AppServerProcess;
}

export function codexAppServerCommand(task: CodexTask, handle: RunnerHandle, config: WebuiConfig): { command: string; args: string[] } {
    const configArgs = codexConfigArgs(nativeCodexSettings(task));
    const remoteConfigArgs = configArgs.length ? ` ${configArgs.map(shellQuote).join(" ")}` : "";
    if (task.codexRuntime === "container") {
        if (!handle.containerName) {
            throw new Error("native container Codex execution requires container handle");
        }
        return {
            command: "docker",
            args: ["exec", "-i", "-w", "/workspace", handle.containerName, "codex", ...configArgs, "app-server", "--listen", "stdio://"]
        };
    }
    if (task.codexRuntime === "droplet") {
        if (!handle.sshHost) {
            throw new Error("native droplet Codex execution requires ssh host");
        }
        return {
            command: "ssh",
            args: [
                "-i",
                expandHome(config.cloud.sshKeyPath),
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-o",
                "UserKnownHostsFile=~/.ssh/known_hosts",
                `${config.cloud.sshUser}@${handle.sshHost}`,
                `cd /workspace && codex${remoteConfigArgs} app-server --listen stdio://`
            ]
        };
    }
    throw new Error(`native app-server bridge does not support Codex runtime ${task.codexRuntime}`);
}

export function approvalResult(method: string): Record<string, unknown> {
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        return { decision: "accept" };
    }
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
        return { decision: "approved" };
    }
    if (method === "item/permissions/requestApproval") {
        return {
            permissions: { type: "dangerFullAccess" },
            scope: "session"
        };
    }
    return {};
}

function itemText(item: Record<string, unknown>, itemEventType: "started" | "completed"): string | undefined {
    const itemType = String(item.type ?? "");
    if (itemType === "agentMessage") {
        const text = String(item.text ?? "");
        return text || undefined;
    }
    if (itemType === "reasoning") {
        const parts = Array.isArray(item.content) ? item.content.map(String) : [];
        const summary = Array.isArray(item.summary) ? item.summary.map(String) : [];
        const text = parts.length ? parts.join("\n") : summary.join("\n");
        return text ? `[reasoning]\n${text}` : undefined;
    }
    if (itemType === "commandExecution") {
        if (itemEventType === "started") {
            return `[exec] ${String(item.command ?? "")}`;
        }
        const output = String(item.aggregatedOutput ?? "");
        const exitCode = item.exitCode === undefined || item.exitCode === null ? "" : ` exit=${String(item.exitCode)}`;
        return `[exec completed${exitCode}]\n${output}`.trim();
    }
    if (itemType === "fileChange") {
        if (itemEventType === "started") {
            return "[file change started]";
        }
        const changes = Array.isArray(item.changes) ? item.changes as Array<Record<string, unknown>> : [];
        const paths = changes.map((change) => String(change.path ?? "")).filter(Boolean);
        const diffs = changes.map((change) => String(change.diff ?? "")).filter(Boolean);
        return diffs.length ? diffs.join("\n") : `[file change completed] ${paths.join(", ")}`;
    }
    return undefined;
}

export class CodexAppServerBridge {
    private readonly active = new Map<string, AppServerProcess>();
    private readonly lastState = new Map<string, CodexSessionState>();

    constructor(
        private readonly config: WebuiConfig,
        private readonly redactor: SecretRedactor,
        private readonly db: WebuiDatabase,
        private readonly spawnAppServer: AppServerSpawner = defaultAppServerSpawner
    ) {}

    async run(task: CodexTask, handle: RunnerHandle, userPrompt: string, onOutput: (text: string) => void): Promise<void> {
        if (task.credentialMode !== "codex-auth-json") {
            throw new Error(`native Codex app-server requires codex-auth-json credential mode, got ${task.credentialMode}`);
        }
        const prompt = buildCodexPrompt(
            task,
            userPrompt,
            `Codex is running natively inside the ${task.codexRuntime} task environment through codex app-server. The task environment is the isolation boundary; Codex is allowed full permissions inside /workspace and task-local mounted paths.`,
            "Codex thread state is persisted by the native app-server bridge. Update NOTES.md with important findings, commands, changed files, risks, and next actions."
        );
        appendSteeringLog(task, userPrompt, this.config, this.redactor);
        if (this.active.has(task.id)) {
            throw new Error("Codex app-server turn already active");
        }
        const child = this.spawnAppServer(task, handle, this.config);
        this.active.set(task.id, child);
        this.lastState.set(task.id, { state: "active" });

        try {
            const exitCode = await this.runJsonRpcSession(child, task, prompt, userPrompt, onOutput);
            updateBridgeContext(task, userPrompt, exitCode, this.redactor);
            scrubTaskCodexHome(task);
            if (exitCode !== 0) {
                throw new Error(`codex app-server exited with ${exitCode}`);
            }
        } finally {
            this.active.delete(task.id);
            this.lastState.set(task.id, { state: "closed" });
            if (!child.killed) {
                child.kill();
            }
        }
    }

    state(taskId: string): CodexSessionState {
        if (this.active.has(taskId)) {
            return { state: "active" };
        }
        return this.lastState.get(taskId) ?? { state: "not-started" };
    }

    stop(taskId: string): void {
        const child = this.active.get(taskId);
        if (!child) {
            return;
        }
        this.active.delete(taskId);
        this.lastState.set(taskId, { state: "closed" });
        if (!child.killed) {
            child.kill();
        }
    }

    private async runJsonRpcSession(
        child: AppServerProcess,
        task: CodexTask,
        prompt: string,
        userPrompt: string,
        onOutput: (text: string) => void
    ): Promise<number> {
        let requestId = 0;
        const deferred: Array<Record<string, unknown>> = [];
        const streamedAgentMessageIds = new Set<string>();
        let streamedUnnamedAgentMessage = false;
        const outputPath = path.join(task.logsPath, "codex.jsonl");
        const rl = readline.createInterface({ input: child.stdout });
        const lineIterator = rl[Symbol.asyncIterator]();

        child.stderr.on("data", (chunk) => this.emitOutput(task, outputPath, "stderr", chunk.toString(), onOutput));

        const send = (message: Record<string, unknown>) => {
            child.stdin.write(`${JSON.stringify(message)}\n`);
        };
        const request = (method: string, params: Record<string, unknown>) => {
            requestId += 1;
            send({ jsonrpc: "2.0", id: requestId, method, params });
            return requestId;
        };
        const notify = (method: string, params?: Record<string, unknown>) => {
            send(params ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", method });
        };
        const respond = (id: unknown, result: Record<string, unknown>) => {
            send({ jsonrpc: "2.0", id, result });
        };

        const readStdoutMessage = async (): Promise<Record<string, unknown> | undefined> => {
            const result = await lineIterator.next();
            if (result.done) {
                return undefined;
            }
            const line = String(result.value).trim();
            if (!line) {
                return readStdoutMessage();
            }
            try {
                const parsed = JSON.parse(line) as unknown;
                return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
            } catch {
                this.emitOutput(task, outputPath, "stdout", line, onOutput);
                return readStdoutMessage();
            }
        };

        const nextMessage = async (): Promise<Record<string, unknown> | undefined> => {
            if (deferred.length) {
                return deferred.shift();
            }
            return readStdoutMessage();
        };

        const readResponse = async (id: number): Promise<Record<string, unknown>> => {
            while (true) {
                const message = await readStdoutMessage();
                if (!message) {
                    return {};
                }
                if (message.id === id && ("result" in message || "error" in message)) {
                    if (message.error) {
                        throw new Error(`Codex JSON-RPC error: ${JSON.stringify(message.error)}`);
                    }
                    return (message.result && typeof message.result === "object" ? message.result : {}) as Record<string, unknown>;
                }
                deferred.push(message);
            }
        };

        const initId = request("initialize", {
            clientInfo: { name: "mecha-webui", version: "0.1.0" },
            capabilities: { experimentalApi: true }
        });
        await readResponse(initId);
        notify("initialized");

        const settings = nativeCodexSettings(task);
        const sandboxPolicy = codexSandboxPolicy(settings);
        let threadId = typeof task.providerState?.codexThreadId === "string" ? task.providerState.codexThreadId : undefined;
        if (threadId) {
            const resumeId = request("thread/resume", {
                threadId,
                approvalPolicy: settings.approvalPolicy,
                sandbox: settings.sandbox,
                ...(settings.model ? { model: settings.model } : {})
            });
            try {
                await readResponse(resumeId);
            } catch {
                threadId = undefined;
            }
        }
        if (!threadId) {
            const startId = request("thread/start", {
                cwd: "/workspace",
                ephemeral: false,
                approvalPolicy: settings.approvalPolicy,
                sandbox: settings.sandbox,
                ...(settings.model ? { model: settings.model } : {})
            });
            const result = await readResponse(startId);
            const thread = result.thread && typeof result.thread === "object" ? result.thread as Record<string, unknown> : {};
            threadId = String(thread.id ?? "");
            if (!threadId) {
                throw new Error("Codex app-server did not return a thread id");
            }
            this.db.mergeProviderState(task.id, { codexThreadId: threadId });
        }

        const turnId = request("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt }],
            approvalPolicy: settings.approvalPolicy,
            sandboxPolicy,
            ...(settings.model ? { model: settings.model } : {})
        });
        await readResponse(turnId);

        while (true) {
            const message = await nextMessage();
            if (!message) {
                break;
            }
            if ("id" in message && "method" in message) {
                const method = String(message.method);
                if (APPROVAL_METHODS.has(method)) {
                    respond(message.id, approvalResult(method));
                    this.emitOutput(task, outputPath, "system", `Auto-approved: ${method}`, onOutput);
                } else if (method === "item/tool/requestUserInput") {
                    respond(message.id, { input: "" });
                } else if (method === "mcpServer/elicitation/request") {
                    respond(message.id, { action: "confirm" });
                } else {
                    respond(message.id, {});
                }
                continue;
            }

            const method = String(message.method ?? "");
            const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
            if (method === "thread/started") {
                const thread = params.thread && typeof params.thread === "object" ? params.thread as Record<string, unknown> : {};
                if (thread.id) {
                    threadId = String(thread.id);
                    this.db.mergeProviderState(task.id, { codexThreadId: threadId });
                }
                continue;
            }
            if (method === "item/started" || method === "item/completed") {
                const item = params.item && typeof params.item === "object" ? params.item as Record<string, unknown> : {};
                const itemId = String(item.id ?? "");
                if (method === "item/completed" && item.type === "agentMessage" && (itemId ? streamedAgentMessageIds.has(itemId) : streamedUnnamedAgentMessage)) {
                    continue;
                }
                const text = itemText(item, method === "item/started" ? "started" : "completed");
                if (text) {
                    this.emitOutput(task, outputPath, "stdout", text, onOutput);
                }
                continue;
            }
            if (method === "item/agentMessage/delta" || method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") {
                const delta = String(params.delta ?? "");
                if (delta) {
                    if (method === "item/agentMessage/delta") {
                        const itemId = String(params.itemId ?? params.id ?? "");
                        if (itemId) streamedAgentMessageIds.add(itemId);
                        else streamedUnnamedAgentMessage = true;
                    }
                    this.emitOutput(task, outputPath, "stdout", delta, onOutput);
                }
                continue;
            }
            if (method === "turn/completed") {
                break;
            }
            if (method === "thread/status/changed") {
                const status = params.status && typeof params.status === "object" ? params.status as Record<string, unknown> : {};
                if (status.type === "idle") {
                    break;
                }
            }
        }

        child.stdin.end();
        return await new Promise<number>((resolve) => {
            child.on("close", (code) => resolve(code ?? 0));
            setTimeout(() => {
                if (!child.killed) {
                    child.kill();
                }
                resolve(0);
            }, 1000).unref();
        });
    }

    private emitOutput(task: CodexTask, outputPath: string, stream: string, text: string, onOutput: (text: string) => void): void {
        const redacted = this.redactor.redact(text);
        appendCapped(outputPath, `${JSON.stringify({ ts: new Date().toISOString(), stream, text: redacted })}\n`, this.config);
        onOutput(redacted);
    }
}
