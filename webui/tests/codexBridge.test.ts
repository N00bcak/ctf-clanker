import { describe, expect, it } from "vitest";
import { approvalResult, codexAppServerCommand } from "../server/src/codex/CodexAppServerBridge";
import { hostCodexCommandArgs } from "../server/src/codex/HostCodexCliBridge";
import { createTask } from "../server/src/tasks/createTask";
import { WebuiDatabase } from "../server/src/db";
import { testConfig, tempDir } from "./helpers";

describe("Codex bridge command boundaries", () => {
    it("creates host broker tasks rooted at storage with workspace-write and no add-dir", () => {
        const root = tempDir();
        const config = testConfig(root);
        config.codex.credentialMode = "host-codex-cli";
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "host broker" }, config, db);

        expect(task.storagePath).toBe(`${root}/${task.id}/storage`);
        expect(task.codexRuntime).toBe("host");
        expect(task.bridgeMode).toBe("host-codex-broker");

        const command = hostCodexCommandArgs(task, config);
        expect(command.command).toBe("codex");
        expect(command.args).toEqual([
            "exec",
            "-c",
            "web_search=\"disabled\"",
            "-C",
            task.storagePath,
            "--sandbox",
            "workspace-write",
            "--ask-for-approval",
            "never",
            "--skip-git-repo-check",
            "-"
        ]);
        expect(command.args).not.toContain("--add-dir");
        expect(command.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    });

    it("uses native app-server mode with task-local auth.json for local containers", () => {
        const root = tempDir();
        const config = testConfig(root);
        config.codex.credentialMode = "codex-auth-json";
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "container codex", backend: "local" }, config, db);

        expect(task.storagePath).toBe(`${root}/${task.id}/storage`);
        expect(task.codexRuntime).toBe("container");
        expect(task.bridgeMode).toBe("native-codex-app-server");
        expect(codexAppServerCommand(task, {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: "container-1",
            createdAt: new Date().toISOString()
        }, config)).toEqual({
            command: "docker",
            args: ["exec", "-i", "-w", "/workspace", "container-1", "codex", "-c", "web_search=\"disabled\"", "app-server", "--listen", "stdio://"]
        });
    });

    it("passes per-task Codex settings to host broker commands", () => {
        const root = tempDir();
        const config = testConfig(root);
        config.codex.credentialMode = "host-codex-cli";
        const db = new WebuiDatabase(config);
        const task = createTask({
            prompt: "host broker",
            codexSettings: {
                model: "gpt-5.5",
                profile: "ctf",
                sandbox: "danger-full-access",
                approvalPolicy: "on-request",
                webSearch: true
            }
        }, config, db);

        expect(hostCodexCommandArgs(task, config).args).toEqual([
            "exec",
            "-m",
            "gpt-5.5",
            "-p",
            "ctf",
            "-c",
            "web_search=\"live\"",
            "-C",
            task.storagePath,
            "--sandbox",
            "danger-full-access",
            "--ask-for-approval",
            "on-request",
            "--skip-git-repo-check",
            "-"
        ]);
    });

    it("passes per-task Codex settings to native app-server commands", () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({
            prompt: "container codex",
            codexSettings: {
                model: "gpt-5.5",
                profile: "ctf",
                sandbox: "workspace-write",
                approvalPolicy: "never",
                webSearch: true
            }
        }, config, db);

        expect(codexAppServerCommand(task, {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: "container-1",
            createdAt: new Date().toISOString()
        }, config).args).toEqual([
            "exec",
            "-i",
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
            "app-server",
            "--listen",
            "stdio://"
        ]);
    });

    it("builds native app-server SSH commands for DigitalOcean droplets", () => {
        const root = tempDir();
        const config = testConfig(root);
        config.codex.credentialMode = "codex-auth-json";
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "droplet codex", backend: "digitalocean" }, config, db);

        expect(task.codexRuntime).toBe("droplet");
        expect(task.bridgeMode).toBe("native-codex-app-server");
        expect(codexAppServerCommand(task, {
            provider: "digitalocean",
            taskId: task.id,
            intentId: "intent",
            dropletId: "123",
            sshHost: "203.0.113.10",
            createdAt: new Date().toISOString()
        }, config)).toEqual({
            command: "ssh",
            args: [
                "-i",
                config.cloud.sshKeyPath,
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-o",
                "UserKnownHostsFile=~/.ssh/known_hosts",
                "root@203.0.113.10",
                "cd /workspace && codex '-c' 'web_search=\"disabled\"' app-server --listen stdio://"
            ]
        });
    });

    it("rejects removed API-key credential mode", () => {
        const root = tempDir();
        const config = testConfig(root);
        config.codex.credentialMode = "host-env-api-key" as never;
        const db = new WebuiDatabase(config);

        expect(() => createTask({ prompt: "old mode" }, config, db)).toThrow(/Unsupported Codex credential mode/);
    });

    it("builds app-server approval responses", () => {
        expect(approvalResult("item/commandExecution/requestApproval")).toEqual({ decision: "accept" });
        expect(approvalResult("execCommandApproval")).toEqual({ decision: "approved" });
        expect(approvalResult("item/permissions/requestApproval")).toEqual({
            permissions: { type: "dangerFullAccess" },
            scope: "session"
        });
    });
});
