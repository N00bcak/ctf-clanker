import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CodexAppServerBridge, type AppServerProcess } from "../server/src/codex/CodexAppServerBridge";
import { WebuiDatabase } from "../server/src/db";
import { createTask } from "../server/src/tasks/createTask";
import { SecretRedactor } from "../server/src/utils/redactor";
import { testConfig, tempDir } from "./helpers";

class FakeCodexAppServer extends EventEmitter implements AppServerProcess {
    stdin = new PassThrough();
    stdout = new PassThrough();
    stderr = new PassThrough();
    killed = false;
    requests: Array<Record<string, unknown>> = [];
    private buffer = "";
    private approvalRequestId = 9000;

    constructor(
        private readonly threadId = "thread-test",
        private readonly notifyBeforeTurnResponse = false,
        private readonly streamAgentMessage = false
    ) {
        super();
        this.stdin.on("data", (chunk) => {
            this.buffer += chunk.toString();
            let newline = this.buffer.indexOf("\n");
            while (newline >= 0) {
                const line = this.buffer.slice(0, newline).trim();
                this.buffer = this.buffer.slice(newline + 1);
                if (line) {
                    this.handle(JSON.parse(line) as Record<string, unknown>);
                }
                newline = this.buffer.indexOf("\n");
            }
        });
        this.stdin.on("finish", () => {
            setImmediate(() => {
                this.stdout.end();
                this.emit("close", 0);
            });
        });
    }

    kill(): void {
        this.killed = true;
        this.emit("close", 0);
    }

    private write(message: Record<string, unknown>): void {
        this.stdout.write(`${JSON.stringify(message)}\n`);
    }

    private handle(message: Record<string, unknown>): void {
        this.requests.push(message);
        if (message.method === "initialize") {
            this.write({ jsonrpc: "2.0", id: message.id, result: { server: "fake-codex" } });
            return;
        }
        if (message.method === "thread/start") {
            this.write({ jsonrpc: "2.0", id: message.id, result: { thread: { id: this.threadId } } });
            return;
        }
        if (message.method === "thread/resume") {
            this.write({ jsonrpc: "2.0", id: message.id, result: { thread: { id: message.params && typeof message.params === "object" ? (message.params as Record<string, unknown>).threadId : this.threadId } } });
            return;
        }
        if (message.method === "turn/start") {
            const approval = {
                jsonrpc: "2.0",
                id: this.approvalRequestId,
                method: "item/commandExecution/requestApproval",
                params: { item: { command: "true" } }
            };
            if (this.notifyBeforeTurnResponse) {
                this.write(approval);
            }
            this.write({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-test" } } });
            if (!this.notifyBeforeTurnResponse) {
                this.write(approval);
            }
            return;
        }
        if (message.id === this.approvalRequestId && message.result) {
            if (this.streamAgentMessage) {
                this.write({
                    jsonrpc: "2.0",
                    method: "item/agentMessage/delta",
                    params: { itemId: "agent-1", delta: "done offline" }
                });
            }
            this.write({
                jsonrpc: "2.0",
                method: "item/completed",
                params: { item: { id: "agent-1", type: "agentMessage", text: "done offline" } }
            });
            this.write({
                jsonrpc: "2.0",
                method: "thread/status/changed",
                params: { status: { type: "idle" } }
            });
        }
    }
}

describe("Codex app-server transcript bridge", () => {
    it("runs initialize/start/turn, auto-approves, and stores codexThreadId without real Codex", async () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "offline app-server" }, config, db);
        const fake = new FakeCodexAppServer("thread-1");
        const output: string[] = [];
        const bridge = new CodexAppServerBridge(config, new SecretRedactor({}, []), db, () => fake);

        await bridge.run(task, {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: "fake-container",
            createdAt: new Date().toISOString()
        }, "hello", (text) => output.push(text));

        expect(fake.requests.some((request) => request.method === "initialize")).toBe(true);
        expect(fake.requests.some((request) => request.method === "thread/start")).toBe(true);
        expect(fake.requests.some((request) => request.method === "turn/start")).toBe(true);
        expect(fake.requests.some((request) => request.id === 9000 && (request.result as Record<string, unknown>)?.decision === "accept")).toBe(true);
        expect(db.getTask(task.id)?.providerState?.codexThreadId).toBe("thread-1");
        expect(output.join("")).toContain("done offline");
    });

    it("resumes a stored thread on the next prompt", async () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "offline resume" }, config, db);
        db.mergeProviderState(task.id, { codexThreadId: "thread-existing" });
        const refreshed = db.getTask(task.id)!;
        const fake = new FakeCodexAppServer("unused");
        const bridge = new CodexAppServerBridge(config, new SecretRedactor({}, []), db, () => fake);

        await bridge.run(refreshed, {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: "fake-container",
            createdAt: new Date().toISOString()
        }, "resume", () => undefined);

        const resume = fake.requests.find((request) => request.method === "thread/resume");
        expect(resume).toBeTruthy();
        expect((resume?.params as Record<string, unknown>).threadId).toBe("thread-existing");
        expect(fake.requests.some((request) => request.method === "thread/start")).toBe(false);
    });

    it("handles app-server notifications that arrive before the turn/start response", async () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "offline notification ordering" }, config, db);
        const fake = new FakeCodexAppServer("thread-before-response", true);
        const output: string[] = [];
        const bridge = new CodexAppServerBridge(config, new SecretRedactor({}, []), db, () => fake);

        await bridge.run(task, {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: "fake-container",
            createdAt: new Date().toISOString()
        }, "hello", (text) => output.push(text));

        expect(fake.requests.some((request) => request.id === 9000 && (request.result as Record<string, unknown>)?.decision === "accept")).toBe(true);
        expect(output.join("")).toContain("done offline");
    });

    it("does not duplicate a completed agent message after streaming its deltas", async () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "offline streaming" }, config, db);
        const fake = new FakeCodexAppServer("thread-stream", false, true);
        const output: string[] = [];
        const bridge = new CodexAppServerBridge(config, new SecretRedactor({}, []), db, () => fake);

        await bridge.run(task, {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: "fake-container",
            createdAt: new Date().toISOString()
        }, "stream", (text) => output.push(text));

        expect(output.filter((text) => text === "done offline")).toHaveLength(1);
    });

    it("sends per-task approval, sandbox, and model settings", async () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({
            prompt: "offline settings",
            codexSettings: {
                model: "gpt-5.5",
                sandbox: "workspace-write",
                approvalPolicy: "on-request",
                webSearch: false
            }
        }, config, db);
        const fake = new FakeCodexAppServer("thread-settings");
        const bridge = new CodexAppServerBridge(config, new SecretRedactor({}, []), db, () => fake);

        await bridge.run(task, {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: "fake-container",
            createdAt: new Date().toISOString()
        }, "settings", () => undefined);

        const start = fake.requests.find((request) => request.method === "thread/start");
        const turn = fake.requests.find((request) => request.method === "turn/start");
        expect(start?.params).toMatchObject({
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            model: "gpt-5.5"
        });
        expect(turn?.params).toMatchObject({
            approvalPolicy: "on-request",
            sandboxPolicy: { type: "workspaceWrite" },
            model: "gpt-5.5"
        });
    });
});
