import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { buildServer } from "../server/src/main";
import { testConfig } from "./helpers";
import type { FastifyInstance } from "fastify";
import type { CodexTask, ProvisioningIntent } from "../server/src/types";
import type { RunnerProvider } from "../server/src/providers/Provider";

const servers: FastifyInstance[] = [];
afterEach(async () => { for (const app of servers.splice(0)) await app.close(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(concurrency = 1) {
    const config = testConfig();
    config.local.concurrency = concurrency;
    const turns: Array<{ id: string; prompt: string; done: ReturnType<typeof deferred<string>> }> = [];
    const provider = {
        describeProvisioning: (t: CodexTask) => ({ backend: "local", expectedResourceName: t.id, labels: {} }),
        provision: vi.fn(async (t: CodexTask, i: ProvisioningIntent) => ({ provider: "local", taskId: t.id, intentId: i.id, containerName: t.id, createdAt: new Date().toISOString() })),
        start: vi.fn(async () => {}), stop: vi.fn(async () => {}), destroy: vi.fn(async () => {})
    } as unknown as RunnerProvider;
    const nativeCodex = {
        run: vi.fn(async (t: CodexTask, _h: unknown, prompt: string) => { const done = deferred<string>(); turns.push({ id: t.id, prompt, done }); return done.promise; }),
        stop: vi.fn(), state: () => ({ state: "closed" as const })
    };
    const { app } = await buildServer({ config, providers: new Map([["local", provider]]), nativeCodex,
        hostCodex: { run: (task, prompt) => nativeCodex.run(task, undefined, prompt), stop: vi.fn() }
    });
    servers.push(app);
    const call = async (method: "POST" | "GET" | "PATCH", url: string, payload?: Record<string, unknown>) => app.inject({ method, url, payload });
    const create = async (prompt: string) => (await call("POST", "/api/tasks", { prompt })).json();
    const get = async (id: string) => (await call("GET", `/api/tasks/${id}`)).json();
    return { app, config, provider, nativeCodex, turns, call, create, get };
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
    const f = await fixture(2);
    const a = await f.create("failure"), b = await f.create("second"), c = await f.create("third"), d = await f.create("fourth");
    f.nativeCodex.run.mockRejectedValueOnce(new Error("solver failed"));
    await Promise.all([a,b,c,d].map(task => f.call("POST", `/api/tasks/${task.id}/start`)));
    await vi.waitFor(() => expect(f.turns).toHaveLength(2));
    expect((await f.get(a.id)).workStatus).toBe("failed");
    expect((await f.get(d.id)).status).toBe("queued");
    f.turns[0].done.resolve("");
    await vi.waitFor(() => expect(f.turns).toHaveLength(3));
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
