import { afterEach, describe, expect, it, vi } from "vitest";
import { WebuiDatabase } from "../server/src/db";
import { LocalResources } from "../server/src/localResources";
import type { RunnerProvider, RunnerUsage } from "../server/src/providers/Provider";
import { createTask } from "../server/src/tasks/createTask";
import type { CodexTask, RunnerHandle, RunnerResources } from "../server/src/types";
import { testConfig } from "./helpers";

const databases: WebuiDatabase[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.db.close(); });

function fixture(options: { memoryBudgetMb?: number; daemonMemoryMb?: number; cpuBudget?: number; concurrency?: number } = {}) {
    const config = testConfig();
    Object.assign(config.local, {
        concurrency: options.concurrency ?? 8,
        defaultMemoryMb: 2048,
        memoryBudgetMb: options.memoryBudgetMb ?? 8192,
        defaultCpu: 1,
        cpuBudget: options.cpuBudget ?? 6
    });
    const db = new WebuiDatabase(config); databases.push(db);
    const handles = new Map<string, RunnerHandle>();
    const limits = new Map<string, RunnerResources>();
    const usage = new Map<string, number>();
    let now = 1_000_000;
    let omitTelemetry = false;
    const updates: Array<{ taskId: string; cpu: number; memoryMb: number }> = [];
    const provider = {
        getCapacity: vi.fn(async () => ({ cpuCount: 8, memoryMb: options.daemonMemoryMb ?? 64 * 1024 })),
        getUsage: vi.fn(async (requested: RunnerHandle[]): Promise<RunnerUsage[]> => omitTelemetry ? [] : requested.map((handle) => {
            const resource = limits.get(handle.taskId)!;
            return { taskId: handle.taskId, cpu: usage.get(handle.taskId) ?? 0, memoryMb: 32, cpuLimit: resource.cpu, memoryLimitMb: resource.memoryMb, running: true };
        })),
        setResources: vi.fn(async (_task: CodexTask, handle: RunnerHandle, resources: RunnerResources) => {
            updates.push({ taskId: handle.taskId, ...resources });
            limits.set(handle.taskId, { ...resources });
        })
    } as unknown as RunnerProvider;
    const controller = new LocalResources(db, config, provider, (task) => handles.get(task.id), () => now);
    function pending(prompt = "resource fixture") {
        const task = createTask({ prompt }, config, db);
        db.updateTaskStatus(task.id, "queued");
        const execution = db.db.prepare("INSERT INTO executions(task_id,prompt,state) VALUES (?,?,'pending')").run(task.id, prompt);
        return { task, executionId: Number(execution.lastInsertRowid) };
    }
    async function admit(job: ReturnType<typeof pending>) {
        const admitted = await controller.admit(job.executionId, db.getTask(job.task.id)!);
        if (admitted) {
            const resource = db.getTask(job.task.id)!.resources!;
            limits.set(job.task.id, { ...resource });
            handles.set(job.task.id, { provider: "local", taskId: job.task.id, intentId: `intent-${job.task.id}`, containerName: job.task.id, createdAt: new Date(now).toISOString() });
            db.updateTaskStatus(job.task.id, "running");
        }
        return admitted;
    }
    async function observe(milliseconds = 35_000) {
        await controller.refresh();
        for (let elapsed = 0; elapsed < milliseconds; elapsed += 5000) {
            now += 5000;
            await controller.refresh();
        }
    }
    return { config, db, controller, provider, pending, admit, observe, handles, limits, usage, updates,
        advance: (milliseconds: number) => { now += milliseconds; }, omitTelemetry: (omit: boolean) => { omitTelemetry = omit; }, now: () => now };
}

describe("local Docker resource admission", () => {
    it("starts the first worker immediately and observes 30 seconds before the next", async () => {
        const f = fixture(); const first = f.pending("first"), second = f.pending("second");
        await f.controller.refresh();
        expect(await f.admit(first)).toBe(true);
        expect(f.db.getTask(first.task.id)?.resources).toEqual({ cpu: 1, memoryMb: 2048 });
        expect(await f.admit(second)).toBe(false);
        await f.observe(25_000);
        expect(await f.admit(second)).toBe(false);
        f.advance(5000); await f.controller.refresh();
        expect(await f.admit(second)).toBe(true);
        expect(f.controller.status().activeWorkers).toBe(2);
        expect(f.controller.status().memoryReservedMb).toBe(4096);
    });

    it("reserves full per-worker memory and enforces the configurable global budget", async () => {
        const f = fixture(); await f.controller.refresh();
        for (let index = 0; index < 4; index++) {
            const job = f.pending();
            if (index) await f.observe();
            expect(await f.admit(job)).toBe(true);
        }
        await f.observe();
        const queued = f.pending("no overcommit despite tiny measured usage");
        expect(await f.admit(queued)).toBe(false);
        expect(f.controller.status()).toMatchObject({ maxWorkers: 8, activeWorkers: 4, workerMemoryMb: 2048, memoryBudgetMb: 8192, effectiveMemoryMb: 8192, memoryReservedMb: 8192 });
        expect(f.controller.status().workers.every((worker) => worker.memoryMb === 2048)).toBe(true);
        expect(f.db.getTask(queued.task.id)?.resources).toBeUndefined();
    });

    it("clamps memory to Docker total minus one runtime reserve", async () => {
        const f = fixture({ daemonMemoryMb: 7833 }); await f.controller.refresh();
        for (let index = 0; index < 3; index++) {
            if (index) await f.observe();
            expect(await f.admit(f.pending())).toBe(true);
        }
        await f.observe();
        expect(await f.admit(f.pending())).toBe(false);
        expect(f.controller.status()).toMatchObject({ effectiveMemoryMb: 6809, effectiveMaxWorkers: 3, memoryReservedMb: 6144 });
    });

    it("explains when Docker cannot fit even one fixed worker", async () => {
        const f = fixture({ daemonMemoryMb: 2048 }); await f.controller.refresh();
        const job = f.pending();
        expect(await f.admit(job)).toBe(false);
        const status = f.controller.status();
        expect(status).toMatchObject({ activeWorkers: 0, effectiveMemoryMb: 1024, effectiveMaxWorkers: 0 });
        expect(status.reason ?? status.waiting[0]?.reason).toMatch(/memory|RAM|capacity/i);
    });

    it("holds at eight workers and six allocated CPUs when memory allows more", async () => {
        const f = fixture({ memoryBudgetMb: 32 * 1024 }); await f.controller.refresh();
        for (let index = 0; index < 8; index++) {
            if (index) await f.observe();
            expect(await f.admit(f.pending())).toBe(true);
            expect(f.controller.status().cpuAllocated).toBeLessThanOrEqual(6);
        }
        await f.observe();
        expect(await f.admit(f.pending())).toBe(false);
        expect(f.controller.status().activeWorkers).toBe(8);
        expect(f.controller.status().workers.every((worker) => worker.cpu >= 0.25)).toBe(true);
    });

    it("uses the configured products as budget defaults", async () => {
        const f = fixture({ concurrency: 2 });
        delete f.config.local.cpuBudget; delete f.config.local.memoryBudgetMb;
        const controller = new LocalResources(f.db, f.config, f.provider, (task) => f.handles.get(task.id), f.now);
        await controller.refresh();
        expect(controller.status()).toMatchObject({ cpuBudget: 2, memoryBudgetMb: 4096 });
    });

    it("redistributes CPU with peak headroom and applies decreases before increases", async () => {
        const f = fixture(); await f.controller.refresh();
        const a = f.pending("A"), b = f.pending("B");
        expect(await f.admit(a)).toBe(true); await f.observe(); expect(await f.admit(b)).toBe(true);
        f.usage.set(a.task.id, 4); f.advance(5000); await f.controller.refresh();
        expect(f.limits.get(a.task.id)?.cpu).toBeCloseTo(5);
        expect(f.limits.get(b.task.id)?.cpu).toBeCloseTo(0.25);
        f.usage.set(a.task.id, 0); f.usage.set(b.task.id, 4);
        await f.observe(35_000);
        expect(f.limits.get(a.task.id)?.cpu).toBeCloseTo(0.25);
        expect(f.limits.get(b.task.id)?.cpu).toBeCloseTo(5);
        const decrease = f.updates.map((update) => update.taskId === a.task.id && update.cpu === 0.25).lastIndexOf(true);
        const increase = f.updates.map((update) => update.taskId === b.task.id && update.cpu === 5).lastIndexOf(true);
        expect(decrease).toBeGreaterThanOrEqual(0);
        expect(increase).toBeGreaterThan(decrease);
        expect(f.controller.status().cpuAllocated).toBeLessThanOrEqual(6);
    });

    it("keeps busy workers above the minimum and prevents admission under unmet demand", async () => {
        const f = fixture(); await f.controller.refresh();
        const a = f.pending(), b = f.pending();
        expect(await f.admit(a)).toBe(true); await f.observe(); expect(await f.admit(b)).toBe(true);
        f.usage.set(a.task.id, 5); f.usage.set(b.task.id, 5);
        await f.observe();
        expect(f.limits.get(a.task.id)?.cpu).toBeCloseTo(3);
        expect(f.limits.get(b.task.id)?.cpu).toBeCloseTo(3);
        expect(await f.admit(f.pending())).toBe(false);
        expect(f.controller.status().cpuAllocated).toBeCloseTo(6);
    });

    it("seeds a new worker from spare CPU without reducing existing demand", async () => {
        const f = fixture({ concurrency: 2, cpuBudget: 1 }); await f.controller.refresh();
        const a = f.pending("existing demand"), b = f.pending("new seed");
        expect(await f.admit(a)).toBe(true);
        f.usage.set(a.task.id, 0.5); await f.observe();
        expect(f.limits.get(a.task.id)?.cpu).toBeCloseTo(0.625);
        expect(await f.admit(b)).toBe(true);
        expect(f.limits.get(a.task.id)?.cpu).toBeCloseTo(0.625);
        expect(f.db.getTask(b.task.id)?.resources?.cpu).toBeCloseTo(0.375);
        expect(f.controller.status().cpuAllocated).toBeCloseTo(1);
    });

    it.each(["provisioning", "cleanup"])("keeps sampling running workers while another worker is in %s", async (lifecycle) => {
        const f = fixture(); await f.controller.refresh();
        const a = f.pending("running worker"), b = f.pending("frozen reservation");
        expect(await f.admit(a)).toBe(true); await f.observe(); expect(await f.admit(b)).toBe(true);
        if (lifecycle === "provisioning") f.db.updateTaskStatus(b.task.id, "provisioning");
        else f.db.mergeProviderState(b.task.id, { pendingCompletion: { executionId: b.executionId, workStatus: "needs-attention" } });
        f.usage.set(a.task.id, 4.8); f.advance(5000); await f.controller.refresh();
        expect(f.limits.get(a.task.id)?.cpu).toBeCloseTo(5);
        expect(f.db.getTask(b.task.id)?.resources).toEqual({ cpu: 1, memoryMb: 2048 });
        const requestedHandles = vi.mocked(f.provider.getUsage!).mock.calls.at(-1)![0];
        expect(requestedHandles.map(handle => handle.taskId)).toEqual([a.task.id]);
        expect(f.controller.status()).toMatchObject({ state: "blocked", activeWorkers: 2, cpuAllocated: 6, memoryReservedMb: 4096 });
        expect(await f.admit(f.pending())).toBe(false);
    });

    it("fails closed when controls or worker telemetry are unavailable", async () => {
        const f = fixture();
        const unsupported = new LocalResources(f.db, f.config, undefined, () => undefined, f.now);
        await unsupported.refresh();
        expect(await unsupported.admit(f.pending().executionId, f.db.listTasks()[0]!)).toBe(false);
        await f.controller.refresh(); const a = f.pending(); expect(await f.admit(a)).toBe(true);
        await f.observe(); f.omitTelemetry(true); f.advance(5000); await f.controller.refresh();
        expect(await f.admit(f.pending())).toBe(false);
        expect(f.controller.status().state).toBe("blocked");
    });

    it("does not admit on stale measurements", async () => {
        const f = fixture(); await f.controller.refresh(); expect(await f.admit(f.pending())).toBe(true);
        await f.observe(); f.advance(60_000);
        expect(await f.admit(f.pending())).toBe(false);
    });

    it("retains reservations after a resource update fails", async () => {
        const f = fixture(); await f.controller.refresh(); const a = f.pending(); expect(await f.admit(a)).toBe(true);
        vi.mocked(f.provider.setResources!).mockRejectedValueOnce(new Error("Docker update uncertain"));
        f.usage.set(a.task.id, 3); f.advance(5000); await f.controller.refresh();
        expect(f.controller.status()).toMatchObject({ activeWorkers: 1, memoryReservedMb: 2048, state: "blocked" });
        expect(await f.admit(f.pending())).toBe(false);
        const persisted = f.db.db.prepare("SELECT resource_error FROM executions WHERE id=?").get(a.executionId) as { resource_error: string };
        expect(persisted.resource_error).toMatch(/verification|uncertain|unconfirmed/i);
        expect(f.controller.status().cpuAllocated).toBeGreaterThanOrEqual(1);
        f.advance(5000); await f.controller.refresh();
        expect(f.controller.status().state).not.toBe("blocked");
    });

    it.each(["decrease", "increase"])("keeps the CPU ceiling when a %s update becomes uncertain", async (phase) => {
        const f = fixture(); await f.controller.refresh();
        const a = f.pending("decreasing"), b = f.pending("increasing");
        expect(await f.admit(a)).toBe(true); await f.observe(); expect(await f.admit(b)).toBe(true);
        f.usage.set(a.task.id, 4); f.advance(5000); await f.controller.refresh();
        expect(f.limits.get(a.task.id)?.cpu).toBe(5);
        f.usage.set(a.task.id, 0); f.usage.set(b.task.id, 4);
        const apply = vi.mocked(f.provider.setResources!).getMockImplementation()!;
        const changed: string[] = [];
        vi.mocked(f.provider.setResources!).mockImplementation(async (task, handle, resources) => {
            changed.push(task.id);
            await apply(task, handle, resources);
            expect([...f.limits.values()].reduce((sum, value) => sum + value.cpu, 0)).toBeLessThanOrEqual(6);
            if (task.id === (phase === "decrease" ? a.task.id : b.task.id)) throw new Error("Docker applied the update but the response was lost");
        });
        f.advance(35_000); await f.controller.refresh();
        expect(changed[0]).toBe(a.task.id);
        expect(changed).toHaveLength(phase === "decrease" ? 1 : 2);
        expect(f.controller.status().cpuAllocated).toBeLessThanOrEqual(6);
        expect(f.controller.status().state).toBe("blocked");
        expect(await f.admit(f.pending())).toBe(false);
    });

    it("uses a smaller CPU floor when eight workers share less than two CPUs", async () => {
        const f = fixture({ cpuBudget: 1, memoryBudgetMb: 32 * 1024 }); await f.controller.refresh();
        for (let index = 0; index < 8; index++) {
            if (index) await f.observe();
            expect(await f.admit(f.pending())).toBe(true);
            expect(f.controller.status().cpuAllocated).toBeLessThanOrEqual(1);
        }
        expect(f.controller.status().workers.every((worker) => worker.cpu >= 0.125)).toBe(true);
    });

    it("blocks when an inspected RAM limit exceeds its durable reservation", async () => {
        const f = fixture(); await f.controller.refresh(); const a = f.pending(); expect(await f.admit(a)).toBe(true);
        f.limits.set(a.task.id, { cpu: 1, memoryMb: 4096 });
        f.advance(5000); await f.controller.refresh();
        expect(f.controller.status()).toMatchObject({ state: "blocked", memoryReservedMb: 4096 });
        expect(await f.admit(f.pending())).toBe(false);
        await f.observe();
        expect(f.controller.status()).toMatchObject({ state: "blocked", memoryReservedMb: 4096 });
        expect(await f.admit(f.pending())).toBe(false);
    });

    it("keeps fixed RAM reservations and CPU limits when the database reopens", async () => {
        const f = fixture(); await f.controller.refresh(); const a = f.pending(); expect(await f.admit(a)).toBe(true);
        const resources = f.db.getTask(a.task.id)!.resources;
        f.db.db.close(); databases.splice(databases.indexOf(f.db), 1);
        const reopened = new WebuiDatabase(f.config); databases.push(reopened);
        expect(reopened.getTask(a.task.id)?.resources).toEqual(resources);
        const controller = new LocalResources(reopened, f.config, f.provider, task => f.handles.get(task.id), f.now);
        expect(controller.status()).toMatchObject({ activeWorkers: 1, cpuAllocated: 1, memoryReservedMb: 2048 });
        expect(await controller.admit(a.executionId, a.task)).toBe(false);
    });

    it("holds failed cleanup reservations across a controller restart", async () => {
        const f = fixture(); await f.controller.refresh(); const a = f.pending(); expect(await f.admit(a)).toBe(true);
        f.db.db.prepare("UPDATE executions SET error=? WHERE id=?").run("Retry Stop to release capacity: cleanup failed", a.executionId);
        const restarted = new LocalResources(f.db, f.config, f.provider, (task) => f.handles.get(task.id), f.now);
        await restarted.refresh();
        expect(restarted.status()).toMatchObject({ activeWorkers: 1, memoryReservedMb: 2048, state: "blocked" });
        const b = f.pending(); expect(await restarted.admit(b.executionId, b.task)).toBe(false);
        expect(f.db.getTask(a.task.id)?.resources?.memoryMb).toBe(2048);
    });
});
