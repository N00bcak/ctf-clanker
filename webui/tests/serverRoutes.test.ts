import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../server/src/main";
import { WebuiDatabase } from "../server/src/db";
import { EventBus } from "../server/src/utils/logs";
import { SecretRedactor } from "../server/src/utils/redactor";
import type { RunnerProvider, ShellTerminal } from "../server/src/providers/Provider";
import type { CodexTerminalSessions } from "../server/src/codex/CodexPtySessionManager";
import type { NativeCodexRunner } from "../server/src/main";
import type { CodexTask, ProvisioningIntent, ProvisioningPlan, RunnerHandle, TaskEvent, WebuiConfig } from "../server/src/types";
import { testConfig, tempDir } from "./helpers";

class FakeProvider implements RunnerProvider {
    provisioned = 0;
    started = 0;
    stopped = 0;
    destroyed = 0;
    destroyError?: Error;
    latestTerminal?: PassThrough;
    terminalDisposeCount = 0;

    describeProvisioning(task: CodexTask): ProvisioningPlan {
        return {
            backend: task.backend,
            expectedResourceName: `fake-${task.id}`,
            labels: { task_id: task.id }
        };
    }

    async provision(task: CodexTask, intent: ProvisioningIntent): Promise<RunnerHandle> {
        this.provisioned += 1;
        return {
            provider: task.backend,
            taskId: task.id,
            intentId: intent.id,
            containerName: `fake-${task.id}`,
            createdAt: new Date().toISOString()
        };
    }

    async start(): Promise<void> {
        this.started += 1;
    }

    async openTerminal(): Promise<ShellTerminal> {
        const terminal = new PassThrough();
        this.latestTerminal = terminal;
        return {
            stream: terminal as NodeJS.ReadWriteStream,
            dispose: () => {
                this.terminalDisposeCount += 1;
                terminal.destroy();
            }
        };
    }

    async openEventStream(): Promise<AsyncIterable<TaskEvent>> {
        return (async function* () {})();
    }

    async sendPrompt(): Promise<void> {
        return;
    }

    async collect(): Promise<void> {
        return;
    }

    async stop(): Promise<void> {
        this.stopped += 1;
    }

    async destroy(): Promise<void> {
        this.destroyed += 1;
        if (this.destroyError) {
            throw this.destroyError;
        }
    }
}

class FakeCodexPty implements CodexTerminalSessions {
    prompts: string[] = [];
    stopped: Array<{ taskId: string; suppressExitLog?: boolean }> = [];
    writes: Array<{ taskId: string; data: string }> = [];
    sendError?: Error;

    async sendPrompt(_task: CodexTask, _handle: RunnerHandle, prompt: string): Promise<void> {
        if (this.sendError) {
            throw this.sendError;
        }
        this.prompts.push(prompt);
    }

    async attach(_task: CodexTask, _handle: RunnerHandle, onData: (text: string) => void): Promise<() => void> {
        onData("pty replay");
        return () => undefined;
    }

    write(taskId: string, data: string): void {
        this.writes.push({ taskId, data });
    }

    stop(taskId: string, options: { suppressExitLog?: boolean } = {}): void {
        this.stopped.push({ taskId, suppressExitLog: options.suppressExitLog });
    }

    state(): { state: "not-started" | "active" | "closed" } {
        return { state: "not-started" };
    }
}

class FakeNativeCodex implements NativeCodexRunner {
    prompts: string[] = [];
    stopped: string[] = [];
    runError?: Error;
    sessionState: "not-started" | "active" | "closed" = "not-started";

    async run(_task: CodexTask, _handle: RunnerHandle, prompt: string, onOutput: (text: string) => void): Promise<void> {
        if (this.runError) throw this.runError;
        this.sessionState = "active";
        this.prompts.push(prompt);
        onOutput("native app-server output");
        this.sessionState = "closed";
    }

    stop(taskId: string): void {
        this.stopped.push(taskId);
        this.sessionState = "closed";
    }

    state(): { state: "not-started" | "active" | "closed" } {
        return { state: this.sessionState };
    }
}

interface Harness {
    app: FastifyInstance;
    config: WebuiConfig;
    db: WebuiDatabase;
    provider: FakeProvider;
    codexPty: FakeCodexPty;
    nativeCodex: FakeNativeCodex;
    hostPrompts: string[];
}

const openApps: FastifyInstance[] = [];

async function harness(config = testConfig()): Promise<Harness> {
    const db = new WebuiDatabase(config);
    const provider = new FakeProvider();
    const codexPty = new FakeCodexPty();
    const nativeCodex = new FakeNativeCodex();
    const hostPrompts: string[] = [];
    const { app } = await buildServer({
        config,
        db,
        providers: new Map([
            ["local", provider],
            ["digitalocean", provider]
        ]),
        events: new EventBus(),
        redactor: new SecretRedactor({}, []),
        hostCodex: {
            async run(_task, prompt, onOutput) {
                hostPrompts.push(prompt);
                onOutput("host bridge output");
            }
        },
        codexPty,
        nativeCodex,
        codexModels: {
            async listModels() {
                return {
                    source: "local-runner-app-server",
                    runtimeVersion: "0.144.5",
                    queriedAt: "2026-07-26T00:00:00.000Z",
                    models: [{
                        model: "gpt-5.6-sol",
                        displayName: "GPT-5.6 Sol",
                        description: "Frontier coding model",
                        isDefault: true
                    }]
                };
            }
        }
    });
    openApps.push(app);
    return { app, config, db, provider, codexPty, nativeCodex, hostPrompts };
}

function jsonBody<T>(response: { body: string }): T {
    return JSON.parse(response.body) as T;
}

async function createTask(app: FastifyInstance, input: Record<string, unknown> = {}): Promise<CodexTask> {
    const response = await app.inject({
        method: "POST",
        url: "/api/tasks",
        payload: {
            prompt: "inspect route behavior",
            ...input
        }
    });
    expect(response.statusCode).toBe(201);
    return jsonBody<CodexTask>(response);
}

describe("server routes", () => {
    afterEach(async () => {
        for (const app of openApps.splice(0)) {
            await app.close();
        }
        vi.unstubAllEnvs();
    });

    it("creates, persists, lists, and reads tasks while logging creation", async () => {
        const { app, db } = await harness();
        const task = await createTask(app, { name: "Route task" });

        expect(db.getTask(task.id)?.name).toBe("Route task");

        const list = await app.inject({ method: "GET", url: "/api/tasks" });
        expect(list.statusCode).toBe(200);
        expect(jsonBody<CodexTask[]>(list).map((item) => item.id)).toContain(task.id);

        const read = await app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
        expect(read.statusCode).toBe(200);
        expect(jsonBody<CodexTask>(read).id).toBe(task.id);

        const events = fs.readFileSync(path.join(task.logsPath, "events.jsonl"), "utf8");
        expect(events).toContain("task.created");
    });

    it("returns redacted 400 errors for missing tasks", async () => {
        const { app } = await harness();
        const response = await app.inject({ method: "GET", url: "/api/tasks/not-real" });

        expect(response.statusCode).toBe(400);
        expect(jsonBody<{ error: string }>(response)).toEqual({ error: "task not found" });
    });

    it("returns the live Codex app-server model catalog", async () => {
        const { app } = await harness();
        const response = await app.inject({ method: "GET", url: "/api/codex/models" });

        expect(response.statusCode).toBe(200);
        expect(jsonBody<{ models: Array<{ model: string; isDefault: boolean }> }>(response)).toEqual({
            source: "local-runner-app-server",
            runtimeVersion: "0.144.5",
            queriedAt: "2026-07-26T00:00:00.000Z",
            models: [{ model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "Frontier coding model", isDefault: true }]
        });
    });

    it("returns the stored initial prompt for a task", async () => {
        const { app } = await harness();
        const task = await createTask(app, { prompt: "stored initial prompt" });

        const response = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/initial-prompt` });

        expect(response.statusCode).toBe(200);
        expect(jsonBody<{ prompt: string }>(response)).toEqual({ prompt: "stored initial prompt" });
    });

    it("updates and returns manual work status", async () => {
        const { app, db } = await harness();
        const task = await createTask(app);

        const response = await app.inject({
            method: "PATCH",
            url: `/api/tasks/${task.id}/status`,
            payload: { workStatus: "done" }
        });

        expect(response.statusCode).toBe(200);
        expect(jsonBody<CodexTask>(response).workStatus).toBe("done");
        expect(db.getTask(task.id)?.workStatus).toBe("done");
    });

    it("returns Codex session state", async () => {
        const { app } = await harness();
        const task = await createTask(app);

        const response = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/codex-session` });

        expect(response.statusCode).toBe(200);
        expect(jsonBody<{ state: string }>(response)).toEqual({ state: "not-started" });
    });

    it("returns an error for a missing task initial prompt", async () => {
        const { app } = await harness();

        const response = await app.inject({ method: "GET", url: "/api/tasks/not-real/initial-prompt" });

        expect(response.statusCode).toBe(400);
        expect(jsonBody<{ error: string }>(response)).toEqual({ error: "task not found" });
    });

    it("enforces token auth when configured", async () => {
        const config = testConfig();
        config.server.auth.mode = "token";
        config.server.auth.tokenEnv = "WEBUI_AUTH_TOKEN";
        vi.stubEnv("WEBUI_AUTH_TOKEN", "route-token");
        const { app } = await harness(config);

        const rejected = await app.inject({ method: "GET", url: "/api/tasks" });
        expect(rejected.statusCode).toBe(401);

        const accepted = await app.inject({
            method: "GET",
            url: "/api/tasks",
            headers: { authorization: "Bearer route-token" }
        });
        expect(accepted.statusCode).toBe(200);
    });

    it("updates permissions and rejects denied host mounts", async () => {
        const root = tempDir();
        const config = testConfig(root);
        const allowedMount = path.join(root, "allowed-mount");
        fs.mkdirSync(allowedMount, { recursive: true });
        const { app } = await harness(config);
        const task = await createTask(app);

        const accepted = await app.inject({
            method: "PATCH",
            url: `/api/tasks/${task.id}/permissions`,
            payload: {
                version: 1,
                network: { mode: "open", enforcement: "open-warning", allow: [] },
                mounts: [{ label: "fixtures", source: allowedMount, target: "/mnt/extra/fixtures", mode: "ro" }]
            }
        });
        expect(accepted.statusCode).toBe(200);
        expect(jsonBody<{ mounts: unknown[] }>(accepted).mounts).toHaveLength(1);

        const rejected = await app.inject({
            method: "PATCH",
            url: `/api/tasks/${task.id}/permissions`,
            payload: {
                version: 1,
                network: { mode: "open", enforcement: "open-warning", allow: [] },
                mounts: [{ label: "root", source: "/", target: "/mnt/extra/root", mode: "ro" }]
            }
        });
        expect(rejected.statusCode).toBe(400);
        expect(jsonBody<{ error: string }>(rejected).error).toMatch(/mount source is denied/);
    });

    it("handles file list, write, read, delete, traversal rejection, and root delete rejection", async () => {
        const { app } = await harness();
        const task = await createTask(app);

        const write = await app.inject({
            method: "PUT",
            url: `/api/tasks/${task.id}/files/route.txt`,
            headers: { "content-type": "application/octet-stream" },
            payload: Buffer.from("hello from route")
        });
        expect(write.statusCode, write.body).toBe(200);

        const list = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/files` });
        expect(list.statusCode).toBe(200);
        expect(jsonBody<Array<{ name: string }>>(list).map((entry) => entry.name)).toContain("route.txt");

        const read = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/files/route.txt` });
        expect(read.statusCode).toBe(200);
        expect(read.body).toBe("hello from route");

        const traversal = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/files?path=..%2Foutside` });
        expect(traversal.statusCode).toBe(400);
        expect(jsonBody<{ error: string }>(traversal).error).toMatch(/path escapes workspace/);

        const rootDelete = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}/files/` });
        expect(rootDelete.statusCode).toBe(400);
        expect(jsonBody<{ error: string }>(rootDelete).error).toMatch(/cannot delete workspace root/);

        const deleted = await app.inject({ method: "DELETE", url: `/api/tasks/${task.id}/files/route.txt` });
        expect(deleted.statusCode).toBe(200);
        expect(fs.existsSync(path.join(task.storagePath, "route.txt"))).toBe(false);
    });

    it("returns event and codex log files", async () => {
        const { app } = await harness();
        const task = await createTask(app);
        fs.appendFileSync(path.join(task.logsPath, "codex.jsonl"), "{\"text\":\"codex line\"}\n");

        const events = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/logs/events` });
        expect(events.statusCode).toBe(200);
        expect(events.body).toContain("task.created");

        const codex = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/logs/codex` });
        expect(codex.statusCode).toBe(200);
        expect(codex.body).toContain("codex line");
    });

    it("starts, stops, and destroys tasks through injected providers", async () => {
        const { app, provider, db, nativeCodex } = await harness();
        const task = await createTask(app);
        const taskRoot = path.dirname(task.storagePath);

        const started = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start` });
        expect(started.statusCode).toBe(200);
        expect(jsonBody<CodexTask>(started).status).toBe("running");
        expect(provider.provisioned).toBe(1);
        expect(provider.started).toBe(1);

        const stopped = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/stop` });
        expect(stopped.statusCode).toBe(200);
        expect(jsonBody<CodexTask>(stopped).status).toBe("idle");
        expect(provider.stopped).toBe(1);
        expect(nativeCodex.stopped).toContain(task.id);

        const destroyed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/destroy` });
        expect(destroyed.statusCode).toBe(200);
        expect(jsonBody<{ ok: true; id: string }>(destroyed)).toEqual({ ok: true, id: task.id });
        expect(provider.destroyed).toBe(1);
        expect(db.getTask(task.id)).toBeUndefined();
        expect(db.getIntent(jsonBody<CodexTask>(started).activeProvisioningIntentId!)).toBeUndefined();
        expect(fs.existsSync(taskRoot)).toBe(false);
    });

    it("keeps task records and files when provider destroy fails", async () => {
        const { app, provider, db } = await harness();
        const task = await createTask(app);
        const taskRoot = path.dirname(task.storagePath);
        await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start` });
        provider.destroyError = new Error("docker rm failed");

        const destroyed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/destroy` });

        expect(destroyed.statusCode).toBe(400);
        expect(jsonBody<{ error: string }>(destroyed).error).toContain("docker rm failed");
        expect(provider.destroyed).toBe(1);
        expect(db.getTask(task.id)?.status).toBe("running");
        expect(fs.existsSync(taskRoot)).toBe(true);
    });

    it("marks DigitalOcean dry-run starts not ready instead of runnable", async () => {
        const { app } = await harness();
        const task = await createTask(app, { backend: "digitalocean" });

        const started = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start` });

        expect(started.statusCode).toBe(200);
        expect(jsonBody<CodexTask>(started).status).toBe("idle");
        expect(jsonBody<CodexTask>(started).activeProvisioningIntentId).toBeTruthy();
        const events = fs.readFileSync(path.join(task.logsPath, "events.jsonl"), "utf8");
        expect(events).toContain("runner.not_ready");
        expect(events).toContain("dry-run runner has no ssh host");
    });

    it("rejects unsafe task root deletion outside the cache directory", async () => {
        const root = tempDir();
        const outsideRoot = tempDir();
        const { app, db } = await harness(testConfig(root));
        const task = await createTask(app);
        const unsafeTaskRoot = path.join(outsideRoot, task.id);
        fs.mkdirSync(path.join(unsafeTaskRoot, "storage"), { recursive: true });
        fs.writeFileSync(path.join(unsafeTaskRoot, "keep.txt"), "do not delete");
        db.db.prepare("UPDATE tasks SET storage_path = ? WHERE id = ?").run(path.join(unsafeTaskRoot, "storage"), task.id);

        const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/destroy` });

        expect(response.statusCode).toBe(400);
        expect(jsonBody<{ error: string }>(response).error).toMatch(/outside cache/);
        expect(fs.existsSync(path.join(unsafeTaskRoot, "keep.txt"))).toBe(true);
        expect(db.getTask(task.id)).toBeTruthy();
    });

    it("uses injected Codex app-server for native prompt routes and leaves the runner running", async () => {
        const { app, nativeCodex } = await harness();
        const task = await createTask(app);
        await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start` });

        const response = await app.inject({
            method: "POST",
            url: `/api/tasks/${task.id}/prompt`,
            payload: { prompt: "continue native" }
        });
        expect(response.statusCode).toBe(200);
        expect(jsonBody<CodexTask>(response).status).toBe("running");
        expect(jsonBody<CodexTask>(response).workStatus).toBe("running");
        expect(nativeCodex.prompts).toEqual(["continue native"]);
        expect(fs.readFileSync(path.join(task.logsPath, "events.jsonl"), "utf8")).toContain("native app-server output");
    });

    it("does not mark native prompt running when the runner is not ready", async () => {
        const { app, db } = await harness();
        const task = await createTask(app);

        const response = await app.inject({
            method: "POST",
            url: `/api/tasks/${task.id}/prompt`,
            payload: { prompt: "too early" }
        });

        expect(response.statusCode).toBe(400);
        expect(db.getTask(task.id)?.workStatus).toBe("not-started");
    });

    it("marks native prompt failed when app-server execution fails", async () => {
        const { app, db, nativeCodex } = await harness();
        const task = await createTask(app);
        await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start` });
        nativeCodex.runError = new Error("app-server spawn failed");

        const response = await app.inject({
            method: "POST",
            url: `/api/tasks/${task.id}/prompt`,
            payload: { prompt: "continue native" }
        });

        expect(response.statusCode).toBe(400);
        expect(jsonBody<{ error: string }>(response).error).toContain("app-server spawn failed");
        expect(db.getTask(task.id)?.workStatus).toBe("failed");
    });

    it("uses injected host bridge for host prompt routes and emits codex output", async () => {
        const config = testConfig();
        config.codex.credentialMode = "host-codex-cli";
        const { app, hostPrompts } = await harness(config);
        const task = await createTask(app);

        const response = await app.inject({
            method: "POST",
            url: `/api/tasks/${task.id}/prompt`,
            payload: { prompt: "continue host" }
        });
        expect(response.statusCode).toBe(200);
        expect(jsonBody<CodexTask>(response).workStatus).toBe("running");
        expect(hostPrompts).toEqual(["continue host"]);
        expect(fs.readFileSync(path.join(task.logsPath, "events.jsonl"), "utf8")).toContain("host bridge output");
    });

    it("changes running work status to needs-attention when stopping", async () => {
        const { app } = await harness();
        const task = await createTask(app);
        await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start` });

        const stopped = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/stop` });

        expect(stopped.statusCode).toBe(200);
        expect(jsonBody<CodexTask>(stopped).status).toBe("idle");
        expect(jsonBody<CodexTask>(stopped).workStatus).toBe("needs-attention");
    });

    it("disposes the provider shell terminal when websocket closes", async () => {
        const { app, provider } = await harness();
        const task = await createTask(app);
        await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start` });
        await app.ready();

        const ws = await (app as FastifyInstance & { injectWS(path: string): Promise<{ terminate(): void }> }).injectWS(`/ws/tasks/${task.id}/shell`);
        ws.terminate();
        await new Promise((resolve) => setImmediate(resolve));

        expect(provider.terminalDisposeCount).toBe(1);
    });

    it("writes shell output only to terminal logs", async () => {
        const { app, provider } = await harness();
        const task = await createTask(app);
        await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start` });
        await app.ready();

        const ws = await (app as FastifyInstance & { injectWS(path: string): Promise<{ terminate(): void }> }).injectWS(`/ws/tasks/${task.id}/shell`);
        provider.latestTerminal?.emit("data", Buffer.from("shell-only output\n"));
        await new Promise((resolve) => setImmediate(resolve));
        ws.terminate();

        expect(fs.readFileSync(path.join(task.logsPath, "terminal.log"), "utf8")).toContain("shell-only output");
        const codexLogPath = path.join(task.logsPath, "codex.jsonl");
        const codexLog = fs.existsSync(codexLogPath) ? fs.readFileSync(codexLogPath, "utf8") : "";
        expect(codexLog).not.toContain("shell-only output");
    });
});
