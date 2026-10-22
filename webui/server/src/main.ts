import fs from "node:fs";
import path from "node:path";
import fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { loadConfig, validateLocalResources, WEBUI_ROOT } from "./config.js";
import { WebuiDatabase } from "./db.js";
import { readTaskInput } from "./tasks/readTaskInput.js";
import { createTask, normalizeTaskSource } from "./tasks/createTask.js";
import { deleteFile, listFiles, readFile, writeFile } from "./tasks/fileBrowser.js";
import { readPermissions, saveTaskPermissions, supportedNetworkModes, type TaskPermissions } from "./tasks/permissions.js";
import { workspaceSnapshotPath } from "./providers/workspaceTransfer.js";
import { LocalDockerProvider } from "./providers/LocalDockerProvider.js";
import { DigitalOceanProvider } from "./providers/DigitalOceanProvider.js";
import { ExecutionQueue } from "./executionQueue.js";
import { Scheduler } from "./scheduler.js";
import { Reaper } from "./reaper.js";
import { EventBus } from "./utils/logs.js";
import { SecretRedactor } from "./utils/redactor.js";
import { HostCodexCliBridge } from "./codex/HostCodexCliBridge.js";
import { CodexPtySessionManager, type CodexTerminalSessions } from "./codex/CodexPtySessionManager.js";
import { CodexAppServerBridge } from "./codex/CodexAppServerBridge.js";
import { CodexModelCatalog, type CodexModelCatalogReader } from "./codex/modelCatalog.js";
import { registerTerminalRoutes } from "./terminal/terminalRouter.js";
import type { CodexTask, WebuiConfig, WorkStatus } from "./types.js";
import type { RunnerProvider } from "./providers/Provider.js";

export interface HostCodexRunner {
    run(task: CodexTask, userPrompt: string, onOutput: (text: string) => void): Promise<string | void>;
    stop?(taskId: string): void | Promise<void>;
}

export interface NativeCodexRunner {
    run(task: CodexTask, handle: import("./types.js").RunnerHandle, userPrompt: string, onOutput: (text: string) => void): Promise<string | void>;
    stop(taskId: string): void;
    state(taskId: string): { state: "not-started" | "active" | "closed" };
}

export interface BuildServerOptions {
    config?: WebuiConfig;
    db?: WebuiDatabase;
    providers?: Map<string, RunnerProvider>;
    events?: EventBus;
    redactor?: SecretRedactor;
    hostCodex?: HostCodexRunner;
    nativeCodex?: NativeCodexRunner;
    codexPty?: CodexTerminalSessions;
    codexModels?: CodexModelCatalogReader;
}

function bodyToBuffer(body: unknown): Buffer {
    if (Buffer.isBuffer(body)) {
        return body;
    }
    if (typeof body === "string") {
        return Buffer.from(body);
    }
    if (body === undefined || body === null) {
        return Buffer.alloc(0);
    }
    return Buffer.from(JSON.stringify(body));
}

async function rawBodyToBuffer(raw: AsyncIterable<Buffer | string>): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of raw) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

export async function buildServer(options: BuildServerOptions = {}) {
    const config = options.config ?? loadConfig();
    validateLocalResources(config);
    const redactor = options.redactor ?? new SecretRedactor(process.env, [
        "DIGITALOCEAN_TOKEN",
        "DO_API_TOKEN",
        "WEBUI_AUTH_TOKEN"
    ]);
    const db = options.db ?? new WebuiDatabase(config);
    const events = options.events ?? new EventBus();
    const providers = options.providers ?? new Map<string, RunnerProvider>([
        ["local", new LocalDockerProvider(config)],
        ["digitalocean", new DigitalOceanProvider(config)]
    ]);
    const codexPty = options.codexPty ?? new CodexPtySessionManager(config, redactor, events);
    const nativeCodex = options.nativeCodex ?? new CodexAppServerBridge(config, redactor, db);
    const codexModels = options.codexModels ?? new CodexModelCatalog(config);
    const hostCodex = options.hostCodex ?? new HostCodexCliBridge(config, redactor);
    const scheduler = new Scheduler(db, providers, config, events, redactor, async (taskId) => {
        nativeCodex.stop(taskId);
        await hostCodex.stop?.(taskId);
        codexPty.stop(taskId);
    });
    const queue = new ExecutionQueue(db, scheduler, config, async (task, prompt, isCurrent) => {
        scheduler.emit(task, "codex.session.started");
        try {
            const output = (text: string) => {
                if (isCurrent()) scheduler.emit(task, "codex.output", { text });
            };
            if (task.bridgeMode === "host-codex-broker") return await hostCodex.run(task, prompt, output);
            const handle = scheduler.getHandle(task);
            if (!handle) throw new Error("runner not ready");
            return await nativeCodex.run(task, handle, prompt, output);
        } finally {
            if (isCurrent()) scheduler.emit(task, "codex.session.closed");
        }
    });
    const reaper = new Reaper(db, config, { emit: scheduler.emit.bind(scheduler), destroyTask: queue.destroy.bind(queue) });
    const app = fastify({ logger: false });
    app.addHook("onReady", () => queue.recover());
    app.addHook("onClose", async () => { reaper.stop(); await queue.close(); });

    await app.register(websocket);
    await app.register(multipart, {
        limits: {
            files: config.limits.attachments.maxFiles,
            fileSize: config.limits.attachments.maxFileBytes
        }
    });
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_request, body, done) => {
        done(null, body);
    });

    app.addHook("onRequest", async (request, reply) => {
        if (config.server.auth.mode !== "token") {
            return;
        }
        const token = process.env[config.server.auth.tokenEnv];
        const header = request.headers.authorization;
        if (!token || header !== `Bearer ${token}`) {
            await reply.code(401).send({ error: "unauthorized" });
        }
    });

    app.setErrorHandler((error, _request, reply) => {
        const statusCode = (error as { statusCode?: number }).statusCode;
        reply.code(statusCode && statusCode >= 400 && statusCode < 500 ? statusCode : 400).send({ error: redactor.redact(error instanceof Error ? error.message : String(error)) });
    });

    app.post("/api/tasks", async (request, reply) => {
        const input = await readTaskInput(request, config);
        const source = normalizeTaskSource(input.source);
        const existing = source ? db.getTaskBySource(source) : undefined;
        const task = createTask({ ...input, source }, config, db);
        if (!existing) scheduler.emit(task, "task.created", { status: task.status });
        return reply.code(existing ? 200 : 201).send(task);
    });

    app.get("/api/tasks", async () => db.listTasks());

    app.get("/api/scheduler", async () => queue.status());

    app.get("/api/codex/models", async () => codexModels.listModels());

    app.get("/api/tasks/:id", async (request) => {
        const { id } = request.params as { id: string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        return task;
    });

    app.get("/api/tasks/:id/initial-prompt", async (request) => {
        const { id } = request.params as { id: string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        return { prompt: fs.readFileSync(task.initialPromptPath, "utf8") };
    });

    app.post("/api/tasks/:id/start", async (request, reply) => {
        const { id } = request.params as { id: string };
        return reply.code(202).send(queue.enqueue(id));
    });

    app.post("/api/tasks/:id/stop", async (request) => {
        const { id } = request.params as { id: string };
        return queue.stop(id);
    });

    app.post("/api/tasks/:id/destroy", async (request) => {
        const { id } = request.params as { id: string };
        return queue.destroy(id);
    });

    app.get("/api/tasks/:id/codex-session", async (request) => {
        const { id } = request.params as { id: string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        return task.bridgeMode === "native-codex-app-server" ? nativeCodex.state(id) : codexPty.state(id);
    });

    app.patch("/api/tasks/:id/status", async (request) => {
        const { id } = request.params as { id: string };
        const body = request.body as { workStatus?: WorkStatus };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        const allowed: WorkStatus[] = ["not-started", "running", "needs-attention", "done", "failed"];
        if (!body.workStatus || !allowed.includes(body.workStatus)) {
            throw new Error("invalid work status");
        }
        if (body.workStatus === "done" || body.workStatus === "failed") return queue.stop(id, body.workStatus);
        db.updateWorkStatus(id, body.workStatus);
        return db.getTask(id);
    });

    app.post("/api/tasks/:id/prompt", async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as { prompt?: string };
        if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new Error("prompt is required");
        return reply.code(202).send(queue.enqueue(id, body.prompt));
    });

    function permissionEditable(task: CodexTask): boolean {
        return !db.hasOpenExecution(task.id) && !["queued", "provisioning", "running", "collecting", "destroying", "orphaned"].includes(task.status)
            && task.workspaceSync?.owner !== "remote" && !["uploading", "syncing"].includes(task.workspaceSync?.state ?? "idle");
    }

    app.get("/api/tasks/:id/permissions", async (request) => {
        const { id } = request.params as { id: string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        const editable = permissionEditable(task);
        return { permissions: readPermissions(path.join(path.dirname(task.storagePath), "permissions.yaml"), config),
            supportedNetworkModes: supportedNetworkModes(task), editable,
            ...(!editable ? { reason: "Stop must finish before changing permissions." } : {}) };
    });

    app.patch("/api/tasks/:id/permissions", async (request, reply) => {
        const { id } = request.params as { id: string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        if (!permissionEditable(task)) return reply.code(409).send({ error: "Stop must finish before changing permissions." });
        saveTaskPermissions(task, request.body as TaskPermissions, config, db);
        scheduler.emit(db.getTask(id)!, "permissions.saved");
        return readPermissions(path.join(path.dirname(task.storagePath), "permissions.yaml"), config);
    });

    function fileReadTask(task: CodexTask): CodexTask {
        return task.workspaceSync?.owner === "remote" && task.workspaceSync.generation
            ? { ...task, storagePath: workspaceSnapshotPath(task, task.workspaceSync.generation) } : task;
    }

    function cloudFilesLocked(task: CodexTask): boolean {
        return task.codexRuntime === "droplet" && (db.hasOpenExecution(task.id) || task.workspaceSync?.owner === "remote"
            || ["uploading", "syncing"].includes(task.workspaceSync?.state ?? "idle"));
    }

    app.get("/api/tasks/:id/files", async (request) => {
        const { id } = request.params as { id: string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        return listFiles(fileReadTask(task), (request.query as { path?: string }).path ?? "");
    });

    app.get("/api/tasks/:id/files/*", async (request, reply) => {
        const { id, "*": filePath } = request.params as { id: string; "*": string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        const buffer = readFile(fileReadTask(task), filePath);
        return reply.type("application/octet-stream").send(buffer);
    });

    app.put("/api/tasks/:id/files/*", async (request, reply) => {
        const { id, "*": filePath } = request.params as { id: string; "*": string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        const body = request.body === undefined ? await rawBodyToBuffer(request.raw) : bodyToBuffer(request.body);
        const current = db.getTask(id);
        if (!current) throw new Error("task not found");
        if (cloudFilesLocked(current)) return reply.code(409).send({ error: "Cloud files are read-only until execution and final collection finish." });
        writeFile(current, filePath, body, config);
        return { ok: true };
    });

    app.delete("/api/tasks/:id/files/*", async (request, reply) => {
        const { id, "*": filePath } = request.params as { id: string; "*": string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        if (cloudFilesLocked(task)) return reply.code(409).send({ error: "Cloud files are read-only until execution and final collection finish." });
        deleteFile(task, filePath);
        return { ok: true };
    });

    app.get("/api/tasks/:id/logs/events", async (request) => {
        const { id } = request.params as { id: string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        return fs.readFileSync(path.join(task.logsPath, "events.jsonl"), "utf8");
    });

    app.get("/api/tasks/:id/logs/codex", async (request) => {
        const { id } = request.params as { id: string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        return fs.readFileSync(path.join(task.logsPath, "codex.jsonl"), "utf8");
    });

    app.get("/ws/tasks/:id/events", { websocket: true }, (socket, request) => {
        const { id } = request.params as { id: string };
        const task = db.getTask(id);
        if (!task) {
            socket.close(1008, "task not found");
            return;
        }
        const unsubscribe = events.subscribe(id, (event) => socket.send(JSON.stringify(event)));
        socket.on("close", unsubscribe);
    });

    await registerTerminalRoutes(app, db, scheduler, config, redactor, codexPty);

    const clientDist = path.join(WEBUI_ROOT, "dist/client");
    if (fs.existsSync(clientDist)) {
        await app.register(fastifyStatic, {
            root: clientDist,
            prefix: "/"
        });
    }

    return { app, config, reaper };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { app, config, reaper } = await buildServer();
    reaper.start();
    await app.listen({ host: config.server.host, port: config.server.port });
    console.log(`webui listening on http://${config.server.host}:${config.server.port}`);
}
