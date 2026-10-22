import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { buildServer } from "../server/src/main";
import { WebuiDatabase } from "../server/src/db";
import { LocalResources } from "../server/src/localResources";
import { fakeResourceControls, testConfig } from "./helpers";
import type { FastifyInstance } from "fastify";
import type { CodexTask, ProvisioningIntent } from "../server/src/types";
import type { RunnerProvider } from "../server/src/providers/Provider";

const servers: FastifyInstance[] = [];
afterEach(async () => { vi.useRealTimers(); for (const app of servers.splice(0)) await app.close(); vi.restoreAllMocks(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function until(assertion: () => void) {
    for (let index = 0; index < 100; index++) {
        try { assertion(); return; }
        catch { await new Promise<void>(resolve => setImmediate(resolve)); }
    }
    assertion();
}
async function fixture(concurrency = 1) {
    const config = testConfig();
    config.local.concurrency = concurrency;
    const db = new WebuiDatabase(config);
    const turns: Array<{ id: string; prompt: string; done: ReturnType<typeof deferred<string>> }> = [];
    const provider = {
        ...fakeResourceControls(config),
        describeProvisioning: (t: CodexTask) => ({ backend: "local", expectedResourceName: t.id, labels: {} }),
        provision: vi.fn(async (t: CodexTask, i: ProvisioningIntent) => ({ provider: "local", taskId: t.id, intentId: i.id, containerName: t.id, createdAt: new Date().toISOString() })),
        start: vi.fn(async () => {}), stop: vi.fn(async () => {}), destroy: vi.fn(async () => {})
    } as unknown as RunnerProvider;
    const nativeCodex = {
        run: vi.fn(async (t: CodexTask, _h: unknown, prompt: string) => { const done = deferred<string>(); turns.push({ id: t.id, prompt, done }); return done.promise; }),
        stop: vi.fn(), state: () => ({ state: "closed" as const })
    };
    const hostCodex = { run: (task: CodexTask, prompt: string) => nativeCodex.run(task, undefined, prompt), stop: vi.fn(async (_taskId: string) => {}) };
    const { app } = await buildServer({ config, db, providers: new Map([["local", provider]]), nativeCodex, hostCodex });
    servers.push(app);
    const call = async (method: "POST" | "GET" | "PATCH", url: string, payload?: Record<string, unknown>) => app.inject({ method, url, payload });
    const create = async (prompt: string) => (await call("POST", "/api/tasks", { prompt })).json();
    const get = async (id: string) => (await call("GET", `/api/tasks/${id}`)).json();
    return { app, db, config, provider, nativeCodex, hostCodex, turns, call, create, get };
}

async function admissionRaceFixture() {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const f = await fixture(2);
    const a = await f.create("active during admission"), b = await f.create("cancelled during admission");
    await f.call("POST", `/api/tasks/${a.id}/start`);
    await until(() => expect(f.turns).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(35_000);
    const gate = deferred<void>();
    let awaitingAdmission = false;
    const admit = LocalResources.prototype.admit;
    vi.spyOn(LocalResources.prototype, "admit").mockImplementation(async function (this: LocalResources, executionId, task) {
        const admitted = await admit.call(this, executionId, task);
        if (admitted && task.id === b.id) {
            awaitingAdmission = true;
            await gate.promise;
        }
        return admitted;
    });
    await f.call("POST", `/api/tasks/${b.id}/start`);
    await until(() => expect(awaitingAdmission).toBe(true));
    return { ...f, a, b, gate };
}
it("accepts once, dispatches FIFO, and yields after unresolved and solved turns", async () => {
    const f = await fixture(); const a = await f.create("first"); const b = await f.create("second");
    const responses = await Promise.all([f.call("POST", `/api/tasks/${a.id}/start`), f.call("POST", `/api/tasks/${a.id}/start`), f.call("POST", `/api/tasks/${b.id}/start`)]);
    expect(responses.map(r => r.statusCode)).toEqual([202, 202, 202]);
    await vi.waitFor(() => expect(f.turns).toHaveLength(1));
    expect((await f.get(b.id)).status).toBe("queued");
    f.turns[0].done.resolve('{"outcome":"unresolved","summary":"Need more evidence"}');
    await vi.waitFor(() => expect(f.turns).toHaveLength(2));
    expect(f.turns.map(t => t.prompt)).toEqual(["first", "second"]);
    expect((await f.get(a.id)).workStatus).toBe("needs-attention");
    expect(f.provider.stop).toHaveBeenCalledTimes(1);
    f.turns[1].done.resolve('{"outcome":"solved","summary":"Recovered","flag":"flag{fixture}"}');
    await vi.waitFor(async () => expect((await f.get(b.id)).workStatus).toBe("done"));
    expect((await f.get(b.id)).status).toBe("idle");
});
it("manual completion wins over late output and frees capacity", async () => {
    const f = await fixture(); const a = await f.create("first"); const b = await f.create("second");
    await f.call("POST", `/api/tasks/${a.id}/start`); await f.call("POST", `/api/tasks/${b.id}/start`);
    await vi.waitFor(() => expect(f.turns).toHaveLength(1));
    await f.call("PATCH", `/api/tasks/${a.id}/status`, { workStatus: "done" });
    await vi.waitFor(() => expect(f.turns).toHaveLength(2));
    f.turns[0].done.resolve("late unresolved output");
    await new Promise(resolve => setImmediate(resolve));
    expect((await f.get(a.id)).workStatus).toBe("done");
    f.turns[1].done.resolve("");
});
it("reserves capacity after cleanup failure and retries on Stop", async () => {
    const f = await fixture(); const a = await f.create("first"); const b = await f.create("second");
    vi.mocked(f.provider.stop).mockRejectedValueOnce(new Error("stop failed"));
    await f.call("POST", `/api/tasks/${a.id}/start`); await f.call("POST", `/api/tasks/${b.id}/start`);
    await vi.waitFor(() => expect(f.turns).toHaveLength(1)); f.turns[0].done.resolve("");
    await vi.waitFor(() => expect(f.provider.stop).toHaveBeenCalledTimes(1));
    expect((await f.get(b.id)).status).toBe("queued");
    expect(fs.readFileSync(`${f.config.paths.cacheDir}/${a.id}/logs/events.jsonl`, "utf8")).toContain("execution.cleanup_failed");
    await f.call("POST", `/api/tasks/${a.id}/stop`);
    expect((await f.get(a.id)).executionError).toBeUndefined();
    await vi.waitFor(() => expect(f.turns).toHaveLength(2)); f.turns[1].done.resolve("");
});
it("continues after provisioning failure and executes follow-up prompts", async () => {
    const f = await fixture(); const a = await f.create("bad runner"); const b = await f.create("good runner");
    vi.mocked(f.provider.provision).mockRejectedValueOnce(new Error("provision failed"));
    await f.call("POST", `/api/tasks/${a.id}/start`); await f.call("POST", `/api/tasks/${b.id}/start`);
    await vi.waitFor(() => expect(f.turns).toHaveLength(1));
    expect(f.turns[0].id).toBe(b.id);
    expect((await f.get(a.id)).workStatus).toBe("failed");
    expect((await f.get(a.id)).executionError).toContain("provision failed");
    f.turns[0].done.resolve("");
    await vi.waitFor(async () => expect((await f.get(b.id)).status).toBe("idle"));
    const accepted = await f.call("POST", `/api/tasks/${b.id}/prompt`, { prompt: "follow up" });
    expect(accepted.statusCode).toBe(202);
    await vi.waitFor(() => expect(f.turns).toHaveLength(2));
    expect(f.turns[1].prompt).toBe("follow up");
    expect(f.provider.provision).toHaveBeenCalledTimes(2);
    f.turns[1].done.resolve("");
});
it("waits for provisioning before cancellation and ignores late completion after deletion", async () => {
    const f = await fixture(); const a = await f.create("first"); const b = await f.create("second");
    const gate = deferred<void>(); const original = f.provider.provision.bind(f.provider);
    vi.mocked(f.provider.provision).mockImplementationOnce(async (...args) => { await gate.promise; return original(...args); });
    await f.call("POST", `/api/tasks/${a.id}/start`);
    await vi.waitFor(() => expect(f.provider.provision).toHaveBeenCalledTimes(1));
    const stop = f.call("POST", `/api/tasks/${a.id}/stop`);
    await new Promise(resolve => setImmediate(resolve)); gate.resolve(); await stop;
    expect(f.turns).toHaveLength(0);
    await f.call("POST", `/api/tasks/${b.id}/start`);
    await vi.waitFor(() => expect(f.turns).toHaveLength(1));
    expect((await f.call("POST", `/api/tasks/${b.id}/destroy`)).statusCode).toBe(200);
    f.turns[0].done.resolve('{"outcome":"solved","summary":"late","flag":"flag{late}"}');
    await new Promise(resolve => setImmediate(resolve));
    expect((await f.call("GET", `/api/tasks/${b.id}`)).statusCode).toBe(400);
    expect(fs.existsSync(`${f.config.paths.cacheDir}/${b.id}`)).toBe(false);
});
it("keeps cancellation and its reservation while asynchronous admission finishes", async () => {
    const f = await admissionRaceFixture();
    const cleanup = deferred<void>();
    f.hostCodex.stop.mockImplementation(async taskId => { if (taskId === f.b.id) await cleanup.promise; });
    try {
        const stopping = f.call("POST", `/api/tasks/${f.b.id}/stop`);
        for (let index = 0; index < 8; index++) await new Promise<void>(resolve => setImmediate(resolve));
        f.gate.resolve();
        await until(() => expect(f.hostCodex.stop).toHaveBeenCalledWith(f.b.id));
        for (let index = 0; index < 8; index++) await new Promise<void>(resolve => setImmediate(resolve));
        expect(f.turns.map(turn => turn.id)).toEqual([f.a.id]);
        expect(f.provider.provision).toHaveBeenCalledTimes(1);
        expect(f.db.hasOpenExecution(f.b.id)).toBe(true);
        expect(f.db.getTask(f.b.id)?.resources?.memoryMb).toBe(1024);
        cleanup.resolve();
        expect((await stopping).statusCode).toBe(200);
        expect(f.db.hasOpenExecution(f.b.id)).toBe(false);
        expect(f.db.getTask(f.b.id)?.resources).toBeUndefined();
        expect(f.turns.map(turn => turn.id)).toEqual([f.a.id]);
    } finally { f.gate.resolve(); cleanup.resolve(); }
});
it("does not start an admitted prompt after shutdown begins during asynchronous admission", async () => {
    const f = await admissionRaceFixture();
    try {
        const closing = f.app.close();
        for (let index = 0; index < 8; index++) await new Promise<void>(resolve => setImmediate(resolve));
        f.gate.resolve();
        await closing;
        expect(f.turns.map(turn => turn.id)).toEqual([f.a.id]);
        expect(f.provider.provision).toHaveBeenCalledTimes(1);
        expect(f.db.hasOpenExecution(f.a.id)).toBe(false);
        expect(f.db.hasOpenExecution(f.b.id)).toBe(false);
    } finally { f.gate.resolve(); }
});
it("recovers persisted and legacy queues without replaying an interrupted turn", async () => {
    const { WebuiDatabase } = await import("../server/src/db");
    const { createTask } = await import("../server/src/tasks/createTask");
    const config = testConfig(); const db = new WebuiDatabase(config);
    const a = createTask({ prompt: "interrupted" }, config, db);
    const b = createTask({ prompt: "pending" }, config, db);
    const c = createTask({ prompt: "legacy" }, config, db);
    db.db.prepare("INSERT INTO executions(task_id,prompt,state) VALUES (?,?,'active')").run(a.id, "interrupted");
    db.db.prepare("INSERT INTO executions(task_id,prompt,state) VALUES (?,?,'pending')").run(b.id, "pending");
    db.updateTaskStatus(a.id, "running"); db.updateTaskStatus(b.id, "queued"); db.updateTaskStatus(c.id, "queued");
    const prompts: string[] = [];
    const provider = {
        ...fakeResourceControls(config),
        describeProvisioning: (t: CodexTask) => ({ backend: "local", expectedResourceName: t.id, labels: {} }),
        provision: async (t: CodexTask, i: ProvisioningIntent) => ({ provider: "local", taskId: t.id, intentId: i.id, containerName: t.id, createdAt: new Date().toISOString() }),
        start: async () => {}, stop: async () => {}
    } as unknown as RunnerProvider;
    const { app } = await buildServer({ config, db, providers: new Map([["local", provider]]), nativeCodex: {
        run: async (_t, _h, prompt) => { prompts.push(prompt); }, stop: () => {}, state: () => ({ state: "closed" })
    } });
    servers.push(app); await app.ready();
    await vi.waitFor(() => expect(prompts).toEqual(["pending", "legacy"]));
    expect(db.getTask(a.id)?.workStatus).toBe("needs-attention");
});
it("requires an explicit, valid final result to classify success", async () => {
    const { resultStatus } = await import("../server/src/executionQueue");
    for (const text of [undefined, "flag{example}", '{"outcome":"solved","flag":"x"}', '{"outcome":"solved","summary":"x","flag":" "}', '{"outcome":"unresolved","summary":"x","flag":"x"}']) {
        expect(resultStatus(text)).toBe("needs-attention");
    }
    expect(resultStatus('{"outcome":"solved","summary":"recovered from artifact","flag":"flag{x}"}')).toBe("done");
});
it("respects configured parallel capacity and advances after a solver failure", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const f = await fixture(2);
    const a = await f.create("failure"), b = await f.create("second"), c = await f.create("third"), d = await f.create("fourth");
    f.nativeCodex.run.mockRejectedValueOnce(new Error("solver failed"));
    await Promise.all([a,b,c,d].map(task => f.call("POST", `/api/tasks/${task.id}/start`)));
    await until(() => expect(f.turns).toHaveLength(1));
    expect((await f.get(a.id)).workStatus).toBe("failed");
    await vi.advanceTimersByTimeAsync(35_000);
    await until(() => expect(f.turns).toHaveLength(2));
    expect((await f.get(d.id)).status).toBe("queued");
    f.turns[0].done.resolve("");
    await until(() => expect(f.provider.stop).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(35_000);
    await until(() => expect(f.turns).toHaveLength(3));
    expect(f.turns.map(t => t.prompt)).toEqual(["second", "third", "fourth"]);
    f.turns[1].done.resolve(""); f.turns[2].done.resolve("");
});
it("cancels a pending task without ever submitting its prompt", async () => {
    const f = await fixture(); const a = await f.create("first"), b = await f.create("cancelled"), c = await f.create("third");
    for (const t of [a,b,c]) await f.call("POST", `/api/tasks/${t.id}/start`);
    await vi.waitFor(() => expect(f.turns).toHaveLength(1));
    await f.call("POST", `/api/tasks/${b.id}/stop`);
    f.turns[0].done.resolve("");
    await vi.waitFor(() => expect(f.turns).toHaveLength(2));
    expect(f.turns.map(t => t.prompt)).toEqual(["first", "third"]);
    f.turns[1].done.resolve("");
});
it("does not let host execution consume Docker capacity", async () => {
    const f = await fixture(); const a = await f.create("local one");
    f.config.codex.credentialMode = "host-codex-cli";
    const host = await f.create("host");
    f.config.codex.credentialMode = "codex-auth-json";
    const b = await f.create("local two");
    for (const t of [a,host,b]) await f.call("POST", `/api/tasks/${t.id}/start`);
    await vi.waitFor(() => expect(f.turns).toHaveLength(2));
    expect(f.turns.map(t => t.prompt).sort()).toEqual(["host", "local one"]);
    f.turns.find(t => t.id === host.id)!.done.resolve("");
    await vi.waitFor(async () => expect((await f.get(host.id)).status).toBe("idle"));
    expect((await f.get(b.id)).status).toBe("queued");
    f.turns.find(t => t.id === a.id)!.done.resolve("");
    await vi.waitFor(() => expect(f.turns).toHaveLength(3)); f.turns[2].done.resolve("");
});
it("dispatches host work while Docker capacity monitoring is awaiting a response", async () => {
    const f = await fixture();
    const gate = deferred<void>();
    let checkingCapacity = false;
    const capacity = f.provider.getCapacity!.bind(f.provider);
    vi.spyOn(f.provider as Required<Pick<RunnerProvider, "getCapacity">>, "getCapacity").mockImplementation(async () => {
        checkingCapacity = true;
        await gate.promise;
        return capacity();
    });
    try {
        const local = await f.create("local waiting for Docker telemetry");
        await f.call("POST", `/api/tasks/${local.id}/start`);
        await until(() => expect(checkingCapacity).toBe(true));
        f.config.codex.credentialMode = "host-codex-cli";
        const host = await f.create("host runs while Docker is unavailable");
        f.config.codex.credentialMode = "codex-auth-json";
        await f.call("POST", `/api/tasks/${host.id}/start`);
        await until(() => expect(f.turns.map(turn => turn.id)).toEqual([host.id]));
        expect(f.provider.provision).not.toHaveBeenCalled();
        expect(f.db.getTask(local.id)?.status).toBe("queued");
        f.turns[0].done.resolve("");
    } finally { gate.resolve(); }
});
it("does not relabel waiting executions as running when the database reopens", async () => {
    const { WebuiDatabase } = await import("../server/src/db");
    const { createTask } = await import("../server/src/tasks/createTask");
    const config = testConfig(); const db = new WebuiDatabase(config);
    const task = createTask({ prompt: "pending" }, config, db);
    db.updateTaskStatus(task.id, "queued");
    db.db.prepare("INSERT INTO executions(task_id,prompt,state) VALUES (?,?,'pending')").run(task.id, "pending");
    db.db.close();
    const reopened = new WebuiDatabase(config);
    expect(reopened.getTask(task.id)?.workStatus).toBe("not-started");
    expect(reopened.getTask(task.id)?.queueOrder).toBe(1);
    reopened.db.close();
});
