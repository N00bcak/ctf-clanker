import { describe, expect, it } from "vitest";
import { detectDockerRuntime, docker } from "../server/src/providers/docker";
import fs from "node:fs";
import path from "node:path";
import { testConfig } from "./helpers";
import { WebuiDatabase } from "../server/src/db";
import { createTask } from "../server/src/tasks/createTask";
import { LocalDockerProvider } from "../server/src/providers/LocalDockerProvider";
import { Scheduler } from "../server/src/scheduler";
import { EventBus } from "../server/src/utils/logs";
import { SecretRedactor } from "../server/src/utils/redactor";
import { defaultPermissions, saveTaskPermissions } from "../server/src/tasks/permissions";

const runDockerSmoke = process.env.MECHA_WEBUI_LIVE_DOCKER === "1";
const runDigitalOceanSmoke = process.env.MECHA_WEBUI_LIVE_DO === "1"
    && Boolean(process.env.DIGITALOCEAN_TOKEN ?? process.env.DO_API_TOKEN);

describe.skipIf(!runDockerSmoke)("live Docker smoke", () => {
    it("detects Docker and the local runner image", async () => {
        const runtime = await detectDockerRuntime();
        expect(runtime.ok, runtime.detail).toBe(true);

        await expect(docker(["image", "inspect", "mecha-codex-runner:base"])).resolves.toEqual(expect.objectContaining({
            stdout: expect.any(String)
        }));
    });

    it("recreates a stopped container with no network while retaining workspace and sessions", async () => {
        const config = testConfig();
        config.codex.credentialMode = "none";
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "credential-free network smoke" }, config, db);
        const provider = new LocalDockerProvider(config);
        const scheduler = new Scheduler(db, new Map([["local", provider]]), config, new EventBus(), new SecretRedactor({}, []));
        const name = `mecha-task-${task.id}`;
        fs.writeFileSync(path.join(task.storagePath, "retained.txt"), "workspace survives");
        fs.mkdirSync(path.join(task.codexHomePath, "sessions"));
        fs.writeFileSync(path.join(task.codexHomePath, "sessions", "fixture.jsonl"), "session survives");
        try {
            db.db.prepare("INSERT INTO executions(task_id,prompt,state,cpu,memory_mb) VALUES (?,?,'active',?,?)")
                .run(task.id, "credential-free network smoke", config.local.defaultCpu, config.local.defaultMemoryMb);
            await scheduler.startTask(task.id);
            const before = JSON.parse((await docker(["inspect", name])).stdout)[0];
            expect(before.HostConfig.NetworkMode).not.toBe("none");
            await scheduler.stopTask(task.id);
            const permissions = defaultPermissions(config);
            permissions.network = { mode: "none", enforcement: "docker-none", allow: [] };
            saveTaskPermissions(db.getTask(task.id)!, permissions, config, db);
            await scheduler.startTask(task.id);
            const after = JSON.parse((await docker(["inspect", name])).stdout)[0];
            expect(after.Id).not.toBe(before.Id);
            expect(after.HostConfig.NetworkMode).toBe("none");
            expect((await docker(["exec", name, "cat", "/workspace/retained.txt"])).stdout).toBe("workspace survives");
            expect(fs.readFileSync(path.join(task.codexHomePath, "sessions", "fixture.jsonl"), "utf8")).toBe("session survives");
        } finally {
            await docker(["rm", "-f", name]).catch(() => undefined);
            db.db.close();
            fs.rmSync(config.paths.cacheDir, { recursive: true, force: true });
        }
    }, 60_000);
});

describe.skipIf(!runDigitalOceanSmoke)("live DigitalOcean smoke", () => {
    it("authenticates against the account API without provisioning resources", async () => {
        const token = process.env.DIGITALOCEAN_TOKEN ?? process.env.DO_API_TOKEN;
        const response = await fetch("https://api.digitalocean.com/v2/account", {
            headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json"
            }
        });

        expect(response.ok, await response.text()).toBe(true);
    });
});
