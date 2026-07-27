import { spawn } from "node:child_process";
import readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import { REPO_ROOT } from "../config.js";
import { resolveCodexAuthJsonPath } from "./auth.js";
import type { WebuiConfig } from "../types.js";

export interface CodexModelOption {
    model: string;
    displayName: string;
    description: string;
    isDefault: boolean;
}

export interface CodexModelCatalogResult {
    models: CodexModelOption[];
    source: "local-runner-app-server" | "host-app-server-fallback";
    runtimeVersion?: string;
    queriedAt: string;
}

export interface CodexModelCatalogReader {
    listModels(): Promise<CodexModelCatalogResult>;
}

export interface ModelAppServerProcess {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    killed: boolean;
    kill(): unknown;
    on(event: "error", listener: (error: Error) => void): this;
}

export interface SpawnedModelAppServer {
    process: ModelAppServerProcess;
    source: CodexModelCatalogResult["source"];
}

export type ModelAppServerSpawner = (config: WebuiConfig) => SpawnedModelAppServer;

function runnerSpawner(config: WebuiConfig): SpawnedModelAppServer {
    const authPath = resolveCodexAuthJsonPath(config);
    return {
        process: spawn("docker", [
            "run",
            "--rm",
            "-i",
            "--entrypoint",
            "codex",
            "--security-opt",
            "no-new-privileges",
            "--cap-drop",
            "ALL",
            "--pids-limit",
            "128",
            "--memory",
            "512m",
            "--cpus",
            "0.5",
            "-v",
            `${authPath}:/root/.codex/auth.json:ro`,
            config.local.runnerImage,
            "app-server",
            "--listen",
            "stdio://"
        ], {
            cwd: REPO_ROOT,
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"]
        }) as ModelAppServerProcess,
        source: "local-runner-app-server"
    };
}

function hostSpawner(config: WebuiConfig): SpawnedModelAppServer {
    const command = config.codex.hostCliPath === "auto" ? "codex" : config.codex.hostCliPath;
    return {
        process: spawn(command, ["app-server", "--listen", "stdio://"], {
            cwd: REPO_ROOT,
            env: process.env,
            stdio: ["pipe", "pipe", "pipe"]
        }) as ModelAppServerProcess,
        source: "host-app-server-fallback"
    };
}

function asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export class CodexModelCatalog implements CodexModelCatalogReader {
    constructor(
        private readonly config: WebuiConfig,
        private readonly spawnAppServer: ModelAppServerSpawner = runnerSpawner,
        private readonly timeoutMs = 10_000,
        private readonly spawnFallback: ModelAppServerSpawner | undefined =
            spawnAppServer === runnerSpawner ? hostSpawner : undefined
    ) {}

    async listModels(): Promise<CodexModelCatalogResult> {
        try {
            return await this.listFrom(this.spawnAppServer);
        } catch (primaryError) {
            if (!this.spawnFallback) throw primaryError;
            try {
                return await this.listFrom(this.spawnFallback);
            } catch (fallbackError) {
                throw new Error(`Runner model discovery failed: ${String(primaryError)}. Host fallback failed: ${String(fallbackError)}`);
            }
        }
    }

    private async listFrom(spawnAppServer: ModelAppServerSpawner): Promise<CodexModelCatalogResult> {
        const spawned = spawnAppServer(this.config);
        const child = spawned.process;
        child.stderr.resume();
        let timeout: NodeJS.Timeout | undefined;
        const timeoutFailure = new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error("Codex model discovery timed out")), this.timeoutMs);
        });
        const processFailure = new Promise<never>((_resolve, reject) => {
            child.on("error", (error) => reject(error));
        });

        try {
            return await Promise.race([this.readCatalog(child, spawned.source), processFailure, timeoutFailure]);
        } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                throw new Error(`${spawned.source === "local-runner-app-server" ? "Docker CLI" : "Codex CLI"} not found`);
            }
            throw error;
        } finally {
            if (timeout) clearTimeout(timeout);
            child.stdin.end();
            if (!child.killed) child.kill();
        }
    }

    private async readCatalog(
        child: ModelAppServerProcess,
        source: CodexModelCatalogResult["source"]
    ): Promise<CodexModelCatalogResult> {
        const rl = readline.createInterface({ input: child.stdout });
        const lines = rl[Symbol.asyncIterator]();
        let requestId = 0;
        const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);
        const request = (method: string, params: Record<string, unknown>) => {
            requestId += 1;
            send({ jsonrpc: "2.0", id: requestId, method, params });
            return requestId;
        };
        const readResponse = async (id: number): Promise<Record<string, unknown>> => {
            while (true) {
                const next = await lines.next();
                if (next.done) throw new Error("Codex app-server closed during model discovery");
                const line = String(next.value).trim();
                if (!line) continue;
                let message: Record<string, unknown>;
                try {
                    message = asRecord(JSON.parse(line));
                } catch {
                    continue;
                }
                if (message.id !== id) continue;
                if (message.error) {
                    throw new Error(`Codex model discovery failed: ${JSON.stringify(message.error)}`);
                }
                return asRecord(message.result);
            }
        };

        try {
            const initializeId = request("initialize", {
                clientInfo: { name: "mecha-webui", title: "Mecha WebUI", version: "0.1.0" }
            });
            const initialized = await readResponse(initializeId);
            send({ jsonrpc: "2.0", method: "initialized", params: {} });

            const models: CodexModelOption[] = [];
            const seen = new Set<string>();
            let cursor: string | null = null;
            for (let page = 0; page < 10; page += 1) {
                const listId = request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
                const result = await readResponse(listId);
                const data = Array.isArray(result.data) ? result.data : [];
                for (const value of data) {
                    const model = asRecord(value);
                    const slug = String(model.model ?? "").trim();
                    if (!slug || model.hidden === true || seen.has(slug)) continue;
                    seen.add(slug);
                    models.push({
                        model: slug,
                        displayName: String(model.displayName ?? slug),
                        description: String(model.description ?? ""),
                        isDefault: model.isDefault === true
                    });
                }
                cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : null;
                if (!cursor) break;
            }
            if (!models.length) throw new Error("Codex app-server returned no selectable models");
            const versionMatch = String(initialized.userAgent ?? "").match(/\/(\d+\.\d+\.\d+)/);
            return {
                models,
                source,
                ...(versionMatch ? { runtimeVersion: versionMatch[1] } : {}),
                queriedAt: new Date().toISOString()
            };
        } finally {
            rl.close();
        }
    }
}
