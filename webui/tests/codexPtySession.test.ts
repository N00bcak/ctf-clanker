import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CodexPtySessionManager, codexPtyCommand, ensureNodePtySpawnHelperExecutable, type PtyLike } from "../server/src/codex/CodexPtySessionManager";
import { WebuiDatabase } from "../server/src/db";
import { createTask } from "../server/src/tasks/createTask";
import { EventBus } from "../server/src/utils/logs";
import { SecretRedactor } from "../server/src/utils/redactor";
import type { RunnerHandle } from "../server/src/types";
import { testConfig, tempDir } from "./helpers";

class FakePty implements PtyLike {
    writes: string[] = [];
    dataListeners: Array<(data: string) => void> = [];
    exitListeners: Array<() => void> = [];
    killed = false;

    write(data: string): void {
        this.writes.push(data);
    }

    kill(): void {
        this.killed = true;
        for (const listener of this.exitListeners) {
            listener();
        }
    }

    onData(listener: (data: string) => void): { dispose(): void } {
        this.dataListeners.push(listener);
        return { dispose: () => {
            this.dataListeners = this.dataListeners.filter((item) => item !== listener);
        } };
    }

    onExit(listener: () => void): { dispose(): void } {
        this.exitListeners.push(listener);
        return { dispose: () => {
            this.exitListeners = this.exitListeners.filter((item) => item !== listener);
        } };
    }

    emitData(data: string): void {
        for (const listener of this.dataListeners) {
            listener(data);
        }
    }
}

describe("Codex PTY session manager", () => {
    it("repairs the macOS node-pty spawn helper execute bit when present", () => {
        expect(() => ensureNodePtySpawnHelperExecutable()).not.toThrow();
    });

    it("builds local native Codex PTY commands with outer-sandbox-only execution", () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({
            prompt: "pty",
            codexSettings: {
                model: "gpt-5.5",
                profile: "ctf",
                sandbox: "workspace-write",
                approvalPolicy: "never",
                webSearch: true
            }
        }, config, db);

        const command = codexPtyCommand(task, {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: "container-1",
            createdAt: new Date().toISOString()
        }, config);

        expect(command).toEqual({
            command: "docker",
            args: [
                "exec",
                "-it",
                "-w",
                "/workspace",
                "container-1",
                "codex",
                "-m",
                "gpt-5.5",
                "-p",
                "ctf",
                "-c",
                "web_search=\"live\"",
                "--no-alt-screen",
                "--dangerously-bypass-approvals-and-sandbox"
            ]
        });
        expect(command.args).not.toContain("workspace-write");
        expect(command.args).not.toContain("read-only");
    });

    it("reuses one PTY session, injects prompts, replays output, and mirrors logs", async () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "pty" }, config, db);
        const handle: RunnerHandle = {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: "container-1",
            createdAt: new Date().toISOString()
        };
        const ptys: FakePty[] = [];
        const manager = new CodexPtySessionManager(config, new SecretRedactor({}, []), new EventBus(), () => {
            const pty = new FakePty();
            ptys.push(pty);
            return pty;
        });

        await manager.sendPrompt(task, handle, "first prompt");
        ptys[0].emitData("Codex says hello");
        await manager.sendPrompt(task, handle, "second prompt");
        const replay: string[] = [];
        const detach = await manager.attach(task, handle, (text) => replay.push(text));
        manager.write(task.id, "typed");
        detach();

        expect(ptys).toHaveLength(1);
        expect(ptys[0].writes).toHaveLength(3);
        expect(ptys[0].writes[0]).toContain("# Mecha Context");
        expect(ptys[0].writes[0]).toContain("first prompt");
        expect(ptys[0].writes[0]).toContain("live terminal session");
        expect(ptys[0].writes[1]).not.toContain("# Mecha Context");
        expect(ptys[0].writes[1]).toContain("## Task Reminder");
        expect(ptys[0].writes[1]).toContain("second prompt");
        expect(ptys[0].writes[2]).toBe("typed");
        expect(replay.join("")).toContain("Codex says hello");
        expect(fs.readFileSync(`${task.logsPath}/terminal.log`, "utf8")).toContain("Codex says hello");
        expect(fs.readFileSync(`${task.logsPath}/codex.jsonl`, "utf8")).toContain("\"stream\":\"pty\"");
        expect(fs.readFileSync(`${task.logsPath}/steering.jsonl`, "utf8")).toContain("first prompt");
        expect(fs.readFileSync(`${task.logsPath}/steering.jsonl`, "utf8")).toContain("second prompt");
    });

    it("attaches passively before a prompt starts the PTY session", async () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "pty" }, config, db);
        const handle: RunnerHandle = {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: "container-1",
            createdAt: new Date().toISOString()
        };
        const ptys: FakePty[] = [];
        const manager = new CodexPtySessionManager(config, new SecretRedactor({}, []), new EventBus(), () => {
            const pty = new FakePty();
            ptys.push(pty);
            return pty;
        });
        const received: string[] = [];

        const detach = await manager.attach(task, handle, (text) => received.push(text));

        expect(ptys).toHaveLength(0);
        expect(manager.state(task.id)).toEqual({ state: "not-started" });

        await manager.sendPrompt(task, handle, "first prompt");
        ptys[0].emitData("live codex output");
        detach();

        expect(ptys).toHaveLength(1);
        expect(manager.state(task.id)).toEqual({ state: "active" });
        expect(received.join("")).toContain("live codex output");
    });

    it("clears pending passive subscribers when stopped before a PTY starts", async () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "pty" }, config, db);
        const handle: RunnerHandle = {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: "container-1",
            createdAt: new Date().toISOString()
        };
        const ptys: FakePty[] = [];
        const manager = new CodexPtySessionManager(config, new SecretRedactor({}, []), new EventBus(), () => {
            const pty = new FakePty();
            ptys.push(pty);
            return pty;
        });
        const received: string[] = [];

        await manager.attach(task, handle, (text) => received.push(text));
        manager.stop(task.id);
        await manager.sendPrompt(task, handle, "after stopped attach");
        ptys[0].emitData("new session output");

        expect(received).toEqual([]);
        expect(manager.state(task.id)).toEqual({ state: "active" });
    });

    it("sends full context again after a PTY session is recreated", async () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "pty" }, config, db);
        const handle: RunnerHandle = {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: "container-1",
            createdAt: new Date().toISOString()
        };
        const ptys: FakePty[] = [];
        const manager = new CodexPtySessionManager(config, new SecretRedactor({}, []), new EventBus(), () => {
            const pty = new FakePty();
            ptys.push(pty);
            return pty;
        });

        await manager.sendPrompt(task, handle, "first prompt");
        manager.stop(task.id);
        await manager.sendPrompt(task, handle, "after restart");

        expect(ptys).toHaveLength(2);
        expect(ptys[0].writes[0]).toContain("# Mecha Context");
        expect(ptys[1].writes[0]).toContain("# Mecha Context");
        expect(ptys[1].writes[0]).toContain("after restart");
    });

    it("emits one closed session event when explicitly stopped", async () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "pty" }, config, db);
        const handle: RunnerHandle = {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: "container-1",
            createdAt: new Date().toISOString()
        };
        const ptys: FakePty[] = [];
        const events = new EventBus();
        const published: string[] = [];
        events.subscribe(task.id, (event) => published.push(event.type));
        const manager = new CodexPtySessionManager(config, new SecretRedactor({}, []), events, () => {
            const pty = new FakePty();
            ptys.push(pty);
            return pty;
        });

        await manager.sendPrompt(task, handle, "stop me");
        manager.stop(task.id);

        expect(published).toContain("codex.session.started");
        expect(published.filter((type) => type === "codex.session.closed")).toHaveLength(1);
        expect(manager.state(task.id)).toEqual({ state: "closed" });
    });

    it("suppresses exit logging during hard delete so logs are not recreated", async () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "pty" }, config, db);
        const handle: RunnerHandle = {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: "container-1",
            createdAt: new Date().toISOString()
        };
        const ptys: FakePty[] = [];
        const events = new EventBus();
        const published: string[] = [];
        events.subscribe(task.id, (event) => published.push(event.type));
        const manager = new CodexPtySessionManager(config, new SecretRedactor({}, []), events, () => {
            const pty = new FakePty();
            ptys.push(pty);
            return pty;
        });

        await manager.sendPrompt(task, handle, "delete me");
        manager.stop(task.id, { suppressExitLog: true });
        fs.rmSync(path.dirname(task.storagePath), { recursive: true, force: true });
        ptys[0].emitData("late output");

        expect(ptys[0].killed).toBe(true);
        expect(published).not.toContain("codex.session.closed");
        expect(fs.existsSync(path.dirname(task.storagePath))).toBe(false);
    });
});
