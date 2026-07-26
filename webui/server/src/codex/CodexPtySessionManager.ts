import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { spawn as spawnPty, type IPty } from "node-pty";
import { expandHome } from "./auth.js";
import { appendSteeringLog, buildNativePtyPrompt } from "./context.js";
import { codexConfigArgs, nativeCodexSettings } from "./settings.js";
import type { CodexTask, RunnerHandle, WebuiConfig } from "../types.js";
import { appendCapped, EventBus, writeTaskEvent } from "../utils/logs.js";
import type { SecretRedactor } from "../utils/redactor.js";

export interface PtyLike {
    write(data: string): void;
    kill(): void;
    onData(listener: (data: string) => void): { dispose(): void };
    onExit(listener: () => void): { dispose(): void };
}

export type PtySpawner = (command: string, args: string[], options: { cols: number; rows: number; env: NodeJS.ProcessEnv }) => PtyLike;

export interface CodexTerminalSessions {
    sendPrompt(task: CodexTask, handle: RunnerHandle, prompt: string): Promise<void>;
    attach(task: CodexTask, handle: RunnerHandle, onData: (text: string) => void): Promise<() => void>;
    write(taskId: string, data: string): void;
    stop(taskId: string, options?: { suppressExitLog?: boolean }): void;
    state(taskId: string): CodexSessionState;
}

export interface CodexSessionState {
    state: "not-started" | "active" | "closed";
}

interface CodexPtySession {
    task: CodexTask;
    pty: PtyLike;
    subscribers: Set<(text: string) => void>;
    replay: string[];
    replayBytes: number;
    closed: boolean;
    hasSentContext: boolean;
    suppressExitLog: boolean;
    closedEventEmitted: boolean;
    dataSubscription?: { dispose(): void };
    exitSubscription?: { dispose(): void };
}

const require = createRequire(import.meta.url);

export function ensureNodePtySpawnHelperExecutable(): void {
    if (process.platform !== "darwin") {
        return;
    }
    const entry = require.resolve("node-pty");
    const helper = path.resolve(path.dirname(entry), `../prebuilds/darwin-${process.arch}/spawn-helper`);
    if (!fs.existsSync(helper)) {
        return;
    }
    const mode = fs.statSync(helper).mode;
    if ((mode & 0o111) !== 0) {
        return;
    }
    fs.chmodSync(helper, mode | 0o755);
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

export function codexPtyCommand(task: CodexTask, handle: RunnerHandle, config: WebuiConfig): { command: string; args: string[] } {
    const codexArgs = [
        ...codexConfigArgs(nativeCodexSettings(task)),
        "--no-alt-screen",
        "--dangerously-bypass-approvals-and-sandbox"
    ];
    if (task.codexRuntime === "container") {
        if (!handle.containerName) {
            throw new Error("native container Codex terminal requires container handle");
        }
        return {
            command: "docker",
            args: ["exec", "-it", "-w", "/workspace", handle.containerName, "codex", ...codexArgs]
        };
    }
    if (task.codexRuntime === "droplet") {
        if (!handle.sshHost) {
            throw new Error("native droplet Codex terminal requires ssh host");
        }
        return {
            command: "ssh",
            args: [
                "-tt",
                "-i",
                expandHome(config.cloud.sshKeyPath),
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-o",
                "UserKnownHostsFile=~/.ssh/known_hosts",
                `${config.cloud.sshUser}@${handle.sshHost}`,
                `cd /workspace && exec ${["codex", ...codexArgs].map(shellQuote).join(" ")}`
            ]
        };
    }
    throw new Error(`native Codex terminal does not support runtime ${task.codexRuntime}`);
}

export class CodexPtySessionManager implements CodexTerminalSessions {
    private readonly sessions = new Map<string, CodexPtySession>();
    private readonly pendingSubscribers = new Map<string, Set<(text: string) => void>>();
    private readonly lastState = new Map<string, CodexSessionState>();
    private readonly maxReplayBytes = 128 * 1024;

    constructor(
        private readonly config: WebuiConfig,
        private readonly redactor: SecretRedactor,
        private readonly events: EventBus,
        private readonly spawn: PtySpawner = (command, args, options) => {
            ensureNodePtySpawnHelperExecutable();
            return spawnPty(command, args, {
                name: "xterm-256color",
                cols: options.cols,
                rows: options.rows,
                env: options.env
            }) as IPty;
        }
    ) {}

    async sendPrompt(task: CodexTask, handle: RunnerHandle, prompt: string): Promise<void> {
        const session = this.ensureSession(task, handle);
        appendSteeringLog(task, prompt, this.config, this.redactor);
        const text = buildNativePtyPrompt(task, prompt, !session.hasSentContext);
        session.hasSentContext = true;
        session.pty.write(`\x1b[200~${text}\x1b[201~\r`);
    }

    async attach(task: CodexTask, handle: RunnerHandle, onData: (text: string) => void): Promise<() => void> {
        void handle;
        const session = this.sessions.get(task.id);
        if (!session || session.closed) {
            const subscribers = this.pendingSubscribers.get(task.id) ?? new Set<(text: string) => void>();
            subscribers.add(onData);
            this.pendingSubscribers.set(task.id, subscribers);
            return () => {
                subscribers.delete(onData);
                if (subscribers.size === 0) {
                    this.pendingSubscribers.delete(task.id);
                }
            };
        }
        for (const chunk of session.replay) {
            onData(chunk);
        }
        session.subscribers.add(onData);
        return () => {
            session.subscribers.delete(onData);
        };
    }

    write(taskId: string, data: string): void {
        this.sessions.get(taskId)?.pty.write(data);
    }

    state(taskId: string): CodexSessionState {
        const session = this.sessions.get(taskId);
        if (session && !session.closed) {
            return { state: "active" };
        }
        return this.lastState.get(taskId) ?? { state: "not-started" };
    }

    stop(taskId: string, options: { suppressExitLog?: boolean } = {}): void {
        this.pendingSubscribers.delete(taskId);
        const session = this.sessions.get(taskId);
        if (!session) {
            return;
        }
        session.closed = true;
        session.suppressExitLog = Boolean(options.suppressExitLog);
        this.lastState.set(taskId, { state: "closed" });
        this.emitSessionClosed(session);
        if (session.suppressExitLog) {
            session.dataSubscription?.dispose();
            session.exitSubscription?.dispose();
            session.subscribers.clear();
        }
        session.pty.kill();
        this.sessions.delete(taskId);
    }

    private ensureSession(task: CodexTask, handle: RunnerHandle): CodexPtySession {
        const existing = this.sessions.get(task.id);
        if (existing && !existing.closed) {
            return existing;
        }
        const { command, args } = codexPtyCommand(task, handle, this.config);
        const pty = this.spawn(command, args, {
            cols: 120,
            rows: 32,
            env: process.env
        });
        const session: CodexPtySession = {
            task,
            pty,
            subscribers: new Set(),
            replay: [],
            replayBytes: 0,
            closed: false,
            hasSentContext: false,
            suppressExitLog: false,
            closedEventEmitted: false
        };
        this.sessions.set(task.id, session);
        this.lastState.set(task.id, { state: "active" });
        const pending = this.pendingSubscribers.get(task.id);
        if (pending) {
            for (const subscriber of pending) {
                session.subscribers.add(subscriber);
            }
            this.pendingSubscribers.delete(task.id);
        }
        this.emitSessionEvent(task, "codex.session.started");
        session.dataSubscription = pty.onData((chunk) => this.recordOutput(session, chunk));
        session.exitSubscription = pty.onExit(() => {
            session.closed = true;
            this.sessions.delete(task.id);
            this.lastState.set(task.id, { state: "closed" });
            if (!session.suppressExitLog) {
                this.recordOutput(session, "\r\n[codex session closed]\r\n");
            }
            this.emitSessionClosed(session);
        });
        return session;
    }

    private emitSessionEvent(task: CodexTask, type: "codex.session.started" | "codex.session.closed"): void {
        const event = writeTaskEvent(task.logsPath, {
            ts: new Date().toISOString(),
            taskId: task.id,
            type
        }, this.config, this.redactor);
        this.events.publish(event);
    }

    private emitSessionClosed(session: CodexPtySession): void {
        if (session.suppressExitLog || session.closedEventEmitted) {
            return;
        }
        session.closedEventEmitted = true;
        this.emitSessionEvent(session.task, "codex.session.closed");
    }

    private recordOutput(session: CodexPtySession, chunk: string): void {
        const text = this.redactor.redact(chunk);
        session.replay.push(text);
        session.replayBytes += Buffer.byteLength(text);
        while (session.replayBytes > this.maxReplayBytes && session.replay.length > 1) {
            session.replayBytes -= Buffer.byteLength(session.replay.shift() ?? "");
        }
        appendCapped(path.join(session.task.logsPath, "terminal.log"), text, this.config);
        appendCapped(path.join(session.task.logsPath, "codex.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), stream: "pty", text })}\n`, this.config);
        const event = writeTaskEvent(session.task.logsPath, {
            ts: new Date().toISOString(),
            taskId: session.task.id,
            type: "codex.output",
            text
        }, this.config, this.redactor);
        this.events.publish(event);
        for (const subscriber of session.subscribers) {
            subscriber(text);
        }
    }
}
