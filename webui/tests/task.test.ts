import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { WebuiDatabase } from "../server/src/db";
import { createTask } from "../server/src/tasks/createTask";
import type { RunnerHandle } from "../server/src/types";
import { testConfig, tempDir } from "./helpers";

describe("task creation", () => {
    it("creates durable task layout and SQLite record", () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "inspect this", name: "Inspect" }, config, db);

        expect(db.getTask(task.id)?.id).toBe(task.id);
        expect(fs.existsSync(path.join(root, task.id, "task.yaml"))).toBe(true);
        expect(fs.existsSync(path.join(task.storagePath, "AGENTS.md"))).toBe(true);
        expect(fs.existsSync(path.join(task.storagePath, "NOTES.md"))).toBe(true);
        expect(fs.existsSync(path.join(task.controlPath, "MECHA_CONTEXT.md"))).toBe(true);
        expect(fs.existsSync(task.codexHomePath)).toBe(true);
        expect(task.storagePath.endsWith(path.join(task.id, "storage"))).toBe(true);
        expect(task.bridgeMode).toBe("native-codex-app-server");
        expect(task.codexRuntime).toBe("container");
    });

    it("writes stable task and permission contracts", () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({
            prompt: "inspect this",
            name: "Inspect",
            codexSettings: {
                model: "gpt-5.5",
                sandbox: "workspace-write",
                approvalPolicy: "never",
                webSearch: false
            }
        }, config, db);

        const taskYaml = YAML.parse(fs.readFileSync(path.join(root, task.id, "task.yaml"), "utf8"));
        const permissionsYaml = YAML.parse(fs.readFileSync(path.join(root, task.id, "permissions.yaml"), "utf8"));

        expect(taskYaml).toMatchObject({
            id: task.id,
            name: "Inspect",
            backend: "local",
            status: "draft",
            credentialMode: "codex-auth-json",
            codexHomeRetention: "purge-after-run",
            codexRuntime: "container",
            bridgeMode: "native-codex-app-server",
            workspaceHostPath: task.storagePath,
            workspaceContainerPath: "/workspace",
            networkMode: "open",
            networkEnforcement: "open-warning",
            codexSettings: {
                model: "gpt-5.5",
                sandbox: "workspace-write",
                approvalPolicy: "never",
                webSearch: false
            }
        });
        expect(typeof taskYaml.createdAt).toBe("string");
        expect(db.getTask(task.id)?.providerSpec.codexSettings).toEqual(task.codexSettings);
        expect(permissionsYaml).toEqual({
            version: 1,
            network: { mode: "open", enforcement: "open-warning", allow: [] },
            mounts: []
        });
        expect(fs.readFileSync(path.join(task.controlPath, "MECHA_CONTEXT.md"), "utf8")).toContain("JSON-RPC app-server inside the container runner");
        expect(fs.readFileSync(path.join(task.controlPath, "MECHA_CONTEXT.md"), "utf8")).toContain("workspace-write sandbox");
        expect(fs.readFileSync(path.join(task.controlPath, "MECHA_CONTEXT.md"), "utf8")).not.toContain("stores Codex thread state");
    });

    it("generates host-broker context for host CLI tasks", () => {
        const root = tempDir();
        const config = testConfig(root);
        config.codex.credentialMode = "host-codex-cli";
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "host context" }, config, db);

        const context = fs.readFileSync(path.join(task.controlPath, "MECHA_CONTEXT.md"), "utf8");
        expect(context).toContain("Codex runs one-shot on the host");
        expect(context).toContain(task.storagePath);
        expect(context).not.toContain("stores Codex thread state");
    });

    it("persists tasks, intents, handles, and provider state across database reopen", () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "persist this", name: "Persist" }, config, db);
        const intent = db.createIntent(task, { backend: "local", expectedResourceName: "fake", labels: { task_id: task.id } }, 120);
        const handle: RunnerHandle = {
            provider: "local",
            taskId: task.id,
            intentId: intent.id,
            containerName: `fake-${task.id}`,
            createdAt: new Date().toISOString()
        };
        db.bindResource(intent.id, handle);
        db.updateProviderState(task.id, { containerName: handle.containerName });
        db.db.close();

        const reopened = new WebuiDatabase(config);
        const persisted = reopened.getTask(task.id);

        expect(persisted?.activeProvisioningIntentId).toBe(intent.id);
        expect(persisted?.providerState).toEqual({ containerName: handle.containerName });
        expect(reopened.getIntent(intent.id)?.status).toBe("attached");
        expect(reopened.listOpenIntents().map((item) => item.id)).toContain(intent.id);
        expect(reopened.getHandleForIntent(intent.id)).toMatchObject(handle);
        reopened.db.close();
    });

    it("rejects oversized attachments", () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        expect(() => createTask({
            prompt: "x",
            attachments: [{ path: "big.bin", contentBase64: Buffer.alloc(9).toString("base64") }]
        }, config, db)).toThrow(/maxFileBytes/);
    });

    it("writes attachment paths relative to the workspace root", () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({
            prompt: "inspect attachments",
            attachments: [{ path: "attachments/flag.txt", contentBase64: Buffer.from("flag").toString("base64") }]
        }, config, db);

        expect(fs.readFileSync(path.join(task.storagePath, "attachments/flag.txt"), "utf8")).toBe("flag");
        expect(fs.existsSync(path.join(task.storagePath, "attachments/attachments/flag.txt"))).toBe(false);
        expect(fs.readFileSync(path.join(root, task.id, "input/attachments/attachments/flag.txt"), "utf8")).toBe("flag");
    });
});
