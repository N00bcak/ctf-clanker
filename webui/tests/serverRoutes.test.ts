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
import { fakeResourceControls, testConfig, tempDir } from "./helpers";

class FakeProvider implements RunnerProvider {
    getCapacity: RunnerProvider["getCapacity"];
    getUsage: RunnerProvider["getUsage"];
    setResources: RunnerProvider["setResources"];

    constructor(config = testConfig()) {
        Object.assign(this, fakeResourceControls(config));
    }
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
    const provider = new FakeProvider(config);
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
    it("reports configured and effective local scheduler capacity", async () => {
        const config = testConfig();
        Object.assign(config.local, { concurrency: 8, defaultMemoryMb: 2048, memoryBudgetMb: 8192, cpuBudget: 6 });
        const h = await harness(config);
        await h.app.ready();
        const response = await h.app.inject({ method: "GET", url: "/api/scheduler" });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ maxWorkers: 8, activeWorkers: 0, cpuBudget: 6, memoryBudgetMb: 8192, workerMemoryMb: 2048, memoryReservedMb: 0, workers: [] });
    });

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
        expect(started.statusCode).toBe(202);
        expect(jsonBody<CodexTask>(started).status).toBe("queued");
        await vi.waitFor(() => expect(provider.started).toBe(1));

        const stopped = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/stop` });
        expect(stopped.statusCode).toBe(200);
        expect(jsonBody<CodexTask>(stopped).status).toBe("idle");
        expect(nativeCodex.stopped).toContain(task.id);

        const destroyed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/destroy` });
        expect(destroyed.statusCode).toBe(200);
        expect(jsonBody<{ ok: true; id: string }>(destroyed)).toEqual({ ok: true, id: task.id });
        expect(provider.destroyed).toBe(1);
        expect(db.getTask(task.id)).toBeUndefined();
        expect(db.listOpenIntents()).toHaveLength(0);
        expect(fs.existsSync(taskRoot)).toBe(false);
    });

    it("keeps task records and files when provider destroy fails", async () => {
        const { app, provider, db } = await harness();
        const task = await createTask(app);
        const taskRoot = path.dirname(task.storagePath);
        await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start` });
        await vi.waitFor(() => expect(provider.started).toBe(1));
        provider.destroyError = new Error("docker rm failed");

        const destroyed = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/destroy` });

        expect(destroyed.statusCode).toBe(400);
        expect(jsonBody<{ error: string }>(destroyed).error).toContain("docker rm failed");
        expect(provider.destroyed).toBe(1);
        expect(db.getTask(task.id)?.status).toBe("idle");
        expect(fs.existsSync(taskRoot)).toBe(true);
    });

    it("marks DigitalOcean dry-run starts not ready instead of runnable", async () => {
        const { app } = await harness();
        const task = await createTask(app, { backend: "digitalocean" });

        const started = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start` });

        expect(started.statusCode).toBe(202);
        await vi.waitFor(() => expect(fs.readFileSync(path.join(task.logsPath, "events.jsonl"), "utf8")).toContain("execution.completed"));
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

    it("queues native follow-up prompts and releases the runner afterward", async () => {
        const { app, nativeCodex, db } = await harness();
        const task = await createTask(app);
        const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/prompt`, payload: { prompt: "continue native" } });
        expect(response.statusCode).toBe(202);
        await vi.waitFor(() => expect(db.getTask(task.id)?.workStatus).toBe("needs-attention"));
        expect(db.getTask(task.id)?.status).toBe("idle");
        expect(nativeCodex.prompts).toEqual(["continue native"]);
        expect(fs.readFileSync(path.join(task.logsPath, "events.jsonl"), "utf8")).toContain("native app-server output");
    });

    it("rejects overlapping native prompts", async () => {
        const { app, nativeCodex } = await harness();
        vi.spyOn(nativeCodex, "run").mockImplementation(() => new Promise(() => {}));
        const task = await createTask(app);
        await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start` });
        const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/prompt`, payload: { prompt: "too early" } });
        expect(response.statusCode).toBe(400);
        expect(response.body).toContain("pending or active execution");
    });

    it("reports asynchronous app-server failures on the task", async () => {
        const { app, db, nativeCodex } = await harness();
        const task = await createTask(app);
        nativeCodex.runError = new Error("app-server spawn failed");
        const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/start` });
        expect(response.statusCode).toBe(202);
        await vi.waitFor(() => expect(db.getTask(task.id)?.workStatus).toBe("failed"));
        expect(db.getTask(task.id)?.executionError).toContain("app-server spawn failed");
        expect(db.getTask(task.id)?.status).toBe("idle");
    });

    it("uses injected host bridge for queued host prompts and emits output", async () => {
        const config = testConfig();
        config.codex.credentialMode = "host-codex-cli";
        const { app, hostPrompts, db } = await harness(config);
        const task = await createTask(app);
        const response = await app.inject({ method: "POST", url: `/api/tasks/${task.id}/prompt`, payload: { prompt: "continue host" } });
        expect(response.statusCode).toBe(202);
        await vi.waitFor(() => expect(db.getTask(task.id)?.workStatus).toBe("needs-attention"));
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
        await vi.waitFor(() => expect(provider.started).toBe(1));
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
        await vi.waitFor(() => expect(provider.started).toBe(1));
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

describe("CTFd task intake", () => {
    const source = { platform: "ctfd", competition: "https://ctf.example/event/", account: "team:42", challengeId: "7", contentHash: "a".repeat(64) };
    async function upload(app: FastifyInstance, fields: Array<[string, string | Blob]>) {
        const form = new FormData();
        for (const [name, value] of fields) form.append(name, value);
        const request = new Request("http://localhost/api/tasks", { method: "POST", body: form });
        return app.inject({ method: "POST", url: "/api/tasks", headers: { "content-type": request.headers.get("content-type")! }, payload: Buffer.from(await request.arrayBuffer()) });
    }

    it("persists source deduplication, preserves changed tasks, and separates accounts", async () => {
        const h = await harness();
        const task = await createTask(h.app, { prompt: "original", source });
        const repeated = await h.app.inject({ method: "POST", url: "/api/tasks", payload: { prompt: "original", source: { ...source, competition: "https://ctf.example/event" } } });
        expect(repeated.statusCode).toBe(200);
        expect(repeated.json().id).toBe(task.id);
        const reopened = new WebuiDatabase(h.config);
        expect(reopened.getTaskBySource({ ...source, platform: "ctfd", competition: "https://ctf.example/event" })?.task.id).toBe(task.id);
        reopened.db.close();
        const changed = await h.app.inject({ method: "POST", url: "/api/tasks", payload: { prompt: "changed", source: { ...source, contentHash: "b".repeat(64) } } });
        expect(changed.statusCode).toBe(409);
        expect(fs.readFileSync(task.initialPromptPath, "utf8")).toBe("original");
        await createTask(h.app, { source: { ...source, account: "team:43" } });
        expect(h.db.listTasks()).toHaveLength(2);
        expect(h.provider.provisioned).toBe(0);
    });

    it("accepts multipart bytes, preserves source identity, and queues on explicit start", async () => {
        const h = await harness();
        const response = await upload(h.app, [["task", JSON.stringify({ prompt: "solve", source })], ["attachments/7/file.bin", new Blob([new Uint8Array([0, 255, 1, 2])])]]);
        expect(response.statusCode).toBe(201);
        const task = response.json<CodexTask>();
        expect(fs.readFileSync(path.join(task.storagePath, "attachments/7/file.bin"))).toEqual(Buffer.from([0, 255, 1, 2]));
        expect(task.status).toBe("draft");
        expect(h.provider.provisioned).toBe(0);
        const start = await h.app.inject({ method: "POST", url: `/api/tasks/${task.id}/start`, payload: {} });
        expect(start.statusCode).toBe(202);
        await vi.waitFor(() => expect(h.nativeCodex.prompts).toHaveLength(1));
    });

    it("accepts files beyond the JSON body limit within configured quotas", async () => {
        const config = testConfig();
        config.limits.attachments = { maxFiles: 2, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 3 * 1024 * 1024 };
        const h = await harness(config);
        const response = await upload(h.app, [["task", JSON.stringify({ prompt: "large" })], ["attachments/file.bin", new Blob([Buffer.alloc(1100000, 42)])]]);
        expect(response.statusCode).toBe(201);
        expect(fs.statSync(path.join(response.json().storagePath, "attachments/file.bin")).size).toBe(1100000);
    });

    it("rejects excessive, duplicate, and escaping multipart attachments before task creation", async () => {
        const h = await harness();
        const field: [string, string] = ["task", JSON.stringify({ prompt: "solve" })];
        for (const files of [
            [["attachments/x", new Blob(["123456789"])]],
            [["attachments/x", new Blob(["12345678"])], ["attachments/y", new Blob(["12345678"])]],
            [["attachments/x", new Blob(["a"])], ["attachments/x", new Blob(["b"])]],
            [["attachments/../AGENTS.md", new Blob(["a"])]],
            [["attachments/x", new Blob(["a"])], ["attachments/y", new Blob(["a"])], ["attachments/z", new Blob(["a"])]]
        ] as Array<Array<[string, Blob]>>) {
            const response = await upload(h.app, [field, ...files]);
            expect(response.statusCode).toBeGreaterThanOrEqual(400);
        }
        expect(h.db.listTasks()).toHaveLength(0);
    });
});
