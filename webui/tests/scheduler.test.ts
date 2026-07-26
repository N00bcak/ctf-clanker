import { describe, expect, it } from "vitest";
import { WebuiDatabase } from "../server/src/db";
import { Scheduler } from "../server/src/scheduler";
import { Reaper } from "../server/src/reaper";
import { createTask } from "../server/src/tasks/createTask";
import { EventBus } from "../server/src/utils/logs";
import { SecretRedactor } from "../server/src/utils/redactor";
import type { CodexTask, ProvisioningIntent, ProvisioningPlan, RunnerHandle, TaskEvent } from "../server/src/types";
import type { RunnerProvider, ShellTerminal } from "../server/src/providers/Provider";
import { testConfig, tempDir } from "./helpers";

class FakeProvider implements RunnerProvider {
    provisioned = 0;
    started = 0;
    stopped = 0;

    describeProvisioning(task: CodexTask): ProvisioningPlan {
        return { backend: task.backend, expectedResourceName: `fake-${task.id}`, labels: {} };
    }
    async provision(task: CodexTask, intent: ProvisioningIntent): Promise<RunnerHandle> {
        this.provisioned += 1;
        return { provider: task.backend, taskId: task.id, intentId: intent.id, containerName: `fake-${task.id}`, createdAt: new Date().toISOString() };
    }
    async start(): Promise<void> {
        this.started += 1;
    }
    async openTerminal(): Promise<ShellTerminal> {
        throw new Error("not used");
    }
    async openEventStream(): Promise<AsyncIterable<TaskEvent>> {
        return (async function* () {})();
    }
    async sendPrompt(): Promise<void> {}
    async collect(): Promise<void> {}
    async stop(): Promise<void> {
        this.stopped += 1;
    }
    async destroy(): Promise<void> {}
}

class FailingProvider extends FakeProvider {
    startCalled = false;

    async provision(): Promise<RunnerHandle> {
        throw new Error("fake provision failed");
    }

    async start(): Promise<void> {
        this.startCalled = true;
    }
}

describe("scheduler and reaper", () => {
    it("enforces local concurrency one", async () => {
        const config = testConfig(tempDir());
        const db = new WebuiDatabase(config);
        const provider = new FakeProvider();
        const scheduler = new Scheduler(db, new Map([["local", provider]]), config, new EventBus(), new SecretRedactor({}, []));
        const one = createTask({ prompt: "one" }, config, db);
        const two = createTask({ prompt: "two" }, config, db);

        await scheduler.startTask(one.id);
        const queued = await scheduler.startTask(two.id);

        expect(db.getTask(one.id)?.status).toBe("running");
        expect(queued.status).toBe("queued");
        expect(provider.provisioned).toBe(1);
        expect(provider.started).toBe(1);
    });

    it("marks host broker tasks ready without provisioning or consuming local concurrency", async () => {
        const config = testConfig(tempDir());
        config.codex.credentialMode = "host-codex-cli";
        const db = new WebuiDatabase(config);
        const provider = new FakeProvider();
        const scheduler = new Scheduler(db, new Map([["local", provider]]), config, new EventBus(), new SecretRedactor({}, []));
        const one = createTask({ prompt: "host one" }, config, db);
        const two = createTask({ prompt: "host two" }, config, db);

        const first = await scheduler.startTask(one.id);
        const second = await scheduler.startTask(two.id);

        expect(first.status).toBe("idle");
        expect(second.status).toBe("idle");
        expect(first.activeProvisioningIntentId).toBeUndefined();
        expect(provider.provisioned).toBe(0);
        expect(provider.started).toBe(0);
    });

    it("does not queue or reprovision a task that is already running", async () => {
        const config = testConfig(tempDir());
        const db = new WebuiDatabase(config);
        const provider = new FakeProvider();
        const scheduler = new Scheduler(db, new Map([["local", provider]]), config, new EventBus(), new SecretRedactor({}, []));
        const task = createTask({ prompt: "already running" }, config, db);

        await scheduler.startTask(task.id);
        const secondStart = await scheduler.startTask(task.id);

        expect(secondStart.status).toBe("running");
        expect(provider.provisioned).toBe(1);
        expect(provider.started).toBe(1);
    });

    it("restarts an idle task with its attached handle instead of reprovisioning", async () => {
        const config = testConfig(tempDir());
        const db = new WebuiDatabase(config);
        const provider = new FakeProvider();
        const scheduler = new Scheduler(db, new Map([["local", provider]]), config, new EventBus(), new SecretRedactor({}, []));
        const task = createTask({ prompt: "restart idle" }, config, db);

        await scheduler.startTask(task.id);
        await scheduler.stopTask(task.id);
        const restarted = await scheduler.startTask(task.id);

        expect(restarted.status).toBe("running");
        expect(provider.provisioned).toBe(1);
        expect(provider.started).toBe(2);
        expect(provider.stopped).toBe(1);
    });

    it("recovers the latest attached handle after a failed start attempt replaced the active intent", async () => {
        const config = testConfig(tempDir());
        const db = new WebuiDatabase(config);
        const provider = new FakeProvider();
        const scheduler = new Scheduler(db, new Map([["local", provider]]), config, new EventBus(), new SecretRedactor({}, []));
        const task = createTask({ prompt: "recover attached handle" }, config, db);

        await scheduler.startTask(task.id);
        const attachedIntentId = db.getTask(task.id)!.activeProvisioningIntentId!;
        const failedIntent = db.createIntent(db.getTask(task.id)!, { backend: "local", expectedResourceName: "failed", labels: {} }, 120);
        db.markFailed(failedIntent.id, "fake stale failure");
        db.updateTaskStatus(task.id, "failed");

        const recovered = await scheduler.startTask(task.id);

        expect(recovered.status).toBe("running");
        expect(recovered.finishedAt).toBeUndefined();
        expect(recovered.activeProvisioningIntentId).toBe(attachedIntentId);
        expect(provider.provisioned).toBe(1);
        expect(provider.started).toBe(2);
    });

    it("abandons expired unattached provisioning intents", async () => {
        const config = testConfig(tempDir());
        config.security.reaperGraceSeconds = -1;
        const db = new WebuiDatabase(config);
        const scheduler = new Scheduler(db, new Map([["local", new FakeProvider()]]), config, new EventBus(), new SecretRedactor({}, []));
        const reaper = new Reaper(db, config, scheduler);
        const task = createTask({ prompt: "stuck" }, config, db);
        db.withTransaction(() => {
            db.updateTaskStatus(task.id, "provisioning");
            db.createIntent(task, { backend: "local", expectedResourceName: "fake", labels: {} }, -1);
        });

        await reaper.runOnce();

        const open = db.listOpenIntents();
        expect(open).toHaveLength(0);
    });

    it("marks task and intent failed when provisioning fails", async () => {
        const config = testConfig(tempDir());
        const db = new WebuiDatabase(config);
        const provider = new FailingProvider();
        const scheduler = new Scheduler(db, new Map([["local", provider]]), config, new EventBus(), new SecretRedactor({}, []));
        const task = createTask({ prompt: "fail during provision" }, config, db);

        await expect(scheduler.startTask(task.id)).rejects.toThrow(/fake provision failed/);

        const failed = db.getTask(task.id)!;
        expect(failed.status).toBe("failed");
        expect(failed.activeProvisioningIntentId).toBeTruthy();
        expect(db.getIntent(failed.activeProvisioningIntentId!)?.status).toBe("failed");
        expect(db.getHandleForIntent(failed.activeProvisioningIntentId!)).toBeUndefined();
        expect(db.listOpenIntents()).toHaveLength(0);
        expect(provider.startCalled).toBe(false);
    });
});
