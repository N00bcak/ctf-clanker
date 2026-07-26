import fs from "node:fs";
import path from "node:path";
import fastify from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { loadConfig, WEBUI_ROOT } from "./config.js";
import { WebuiDatabase } from "./db.js";
import { createTask } from "./tasks/createTask.js";
import { deleteFile, listFiles, readFile, writeFile } from "./tasks/fileBrowser.js";
import { readPermissions, writePermissions } from "./tasks/permissions.js";
import { LocalDockerProvider } from "./providers/LocalDockerProvider.js";
import { DigitalOceanProvider } from "./providers/DigitalOceanProvider.js";
import { Scheduler } from "./scheduler.js";
import { Reaper } from "./reaper.js";
import { EventBus } from "./utils/logs.js";
import { SecretRedactor } from "./utils/redactor.js";
import { HostCodexCliBridge } from "./codex/HostCodexCliBridge.js";
import { CodexPtySessionManager, type CodexTerminalSessions } from "./codex/CodexPtySessionManager.js";
import { CodexAppServerBridge } from "./codex/CodexAppServerBridge.js";
import { registerTerminalRoutes } from "./terminal/terminalRouter.js";
import type { CodexTask, CreateTaskInput, WebuiConfig, WorkStatus } from "./types.js";
import type { RunnerProvider } from "./providers/Provider.js";

export interface HostCodexRunner {
    run(task: CodexTask, userPrompt: string, onOutput: (text: string) => void): Promise<void>;
}

export interface NativeCodexRunner {
    run(task: CodexTask, handle: import("./types.js").RunnerHandle, userPrompt: string, onOutput: (text: string) => void): Promise<void>;
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
    const scheduler = new Scheduler(db, providers, config, events, redactor, (taskId) => nativeCodex.stop(taskId));
    const hostCodex = options.hostCodex ?? new HostCodexCliBridge(config, redactor);
    const reaper = new Reaper(db, config, scheduler);
    const app = fastify({ logger: false });

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
        reply.code(400).send({ error: redactor.redact(error instanceof Error ? error.message : String(error)) });
    });

    app.post("/api/tasks", async (request, reply) => {
        const input = request.body as CreateTaskInput;
        const task = createTask(input, config, db);
        scheduler.emit(task, "task.created", { status: task.status });
        return reply.code(201).send(task);
    });

    app.get("/api/tasks", async () => db.listTasks());

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

    app.post("/api/tasks/:id/start", async (request) => {
        const { id } = request.params as { id: string };
        return scheduler.startTask(id);
    });

    app.post("/api/tasks/:id/stop", async (request) => {
        const { id } = request.params as { id: string };
        return scheduler.stopTask(id);
    });

    app.post("/api/tasks/:id/destroy", async (request) => {
        const { id } = request.params as { id: string };
        return scheduler.destroyTask(id);
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
        db.updateWorkStatus(id, body.workStatus);
        return db.getTask(id);
    });

    app.post("/api/tasks/:id/prompt", async (request) => {
        const { id } = request.params as { id: string };
        const body = request.body as { prompt?: string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        if (!body.prompt) throw new Error("prompt is required");
        if (task.bridgeMode === "host-codex-broker") {
            await hostCodex.run(task, body.prompt, (text) => {
                scheduler.emit(task, "codex.output", { text });
            });
            if (task.workStatus !== "done") {
                db.updateWorkStatus(id, "running");
            }
            db.updateTaskStatus(id, "idle");
            return db.getTask(id);
        }
        const handle = scheduler.getHandle(task);
        if (!handle) throw new Error("runner not ready");
        if (task.status !== "running") throw new Error("runner not running");
        try {
            scheduler.emit(task, "codex.session.started");
            await nativeCodex.run(task, handle, body.prompt, (text) => {
                scheduler.emit(task, "codex.output", { text });
            });
        } catch (error) {
            db.updateWorkStatus(id, "failed");
            throw error;
        } finally {
            scheduler.emit(task, "codex.session.closed");
        }
        if (task.workStatus !== "done") {
            db.updateWorkStatus(id, "running");
        }
        db.updateTaskStatus(id, "running");
        return db.getTask(id);
    });

    app.patch("/api/tasks/:id/permissions", async (request) => {
        const { id } = request.params as { id: string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        const filePath = path.join(path.dirname(task.storagePath), "permissions.yaml");
        writePermissions(filePath, request.body as never, config);
        return readPermissions(filePath, config);
    });

    app.get("/api/tasks/:id/files", async (request) => {
        const { id } = request.params as { id: string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        return listFiles(task, (request.query as { path?: string }).path ?? "");
    });

    app.get("/api/tasks/:id/files/*", async (request, reply) => {
        const { id, "*": filePath } = request.params as { id: string; "*": string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        const buffer = readFile(task, filePath);
        return reply.type("application/octet-stream").send(buffer);
    });

    app.put("/api/tasks/:id/files/*", async (request) => {
        const { id, "*": filePath } = request.params as { id: string; "*": string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
        const body = request.body === undefined ? await rawBodyToBuffer(request.raw) : bodyToBuffer(request.body);
        writeFile(task, filePath, body, config);
        return { ok: true };
    });

    app.delete("/api/tasks/:id/files/*", async (request) => {
        const { id, "*": filePath } = request.params as { id: string; "*": string };
        const task = db.getTask(id);
        if (!task) throw new Error("task not found");
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
