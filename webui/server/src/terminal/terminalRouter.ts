import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { WebuiDatabase } from "../db.js";
import type { Scheduler } from "../scheduler.js";
import type { WebuiConfig } from "../types.js";
import { appendCapped } from "../utils/logs.js";
import type { SecretRedactor } from "../utils/redactor.js";
import type { CodexTerminalSessions } from "../codex/CodexPtySessionManager.js";

export async function registerTerminalRoutes(
    app: FastifyInstance,
    db: WebuiDatabase,
    scheduler: Scheduler,
    config: WebuiConfig,
    redactor: SecretRedactor,
    codexPty: CodexTerminalSessions
): Promise<void> {
    void codexPty;

    app.get("/ws/tasks/:id/shell", { websocket: true }, async (socket, request) => {
        const { id } = request.params as { id: string };
        const task = db.getTask(id);
        if (!task) {
            socket.close(1008, "task not found");
            return;
        }
        if (task.codexRuntime === "host") {
            socket.close(1008, "shell unavailable for host mode");
            return;
        }
        const handle = scheduler.getHandle(task);
        if (!handle) {
            socket.close(1008, "runner not ready");
            return;
        }
        const provider = scheduler.providerForTask(task);
        const terminal = await provider.openTerminal(task, handle);
        let closed = false;
        const cleanup = () => {
            if (closed) return;
            closed = true;
            terminal.stream.removeAllListeners?.();
            terminal.dispose();
        };
        socket.on("message", (message: Buffer) => {
            if (!closed) {
                terminal.stream.write(message.toString());
            }
        });
        terminal.stream.on("data", (chunk: Buffer) => {
            const text = redactor.redact(chunk.toString());
            appendCapped(path.join(task.logsPath, "terminal.log"), text, config);
            socket.send(text);
        });
        terminal.stream.on("close", () => {
            cleanup();
            socket.close();
        });
        socket.on("close", cleanup);
    });
}
