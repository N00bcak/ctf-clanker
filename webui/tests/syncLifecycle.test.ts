import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebuiDatabase } from "../server/src/db";
import { buildServer } from "../server/src/main";
import type { RunnerProvider } from "../server/src/providers/Provider";
import { workspaceSnapshotPath } from "../server/src/providers/workspaceTransfer";
import { createTask as createTaskRecord } from "../server/src/tasks/createTask";
import { permissionsFingerprint, readPermissions } from "../server/src/tasks/permissions";
import type { Backend, CodexTask, RunnerHandle, WebuiConfig, WorkspaceCollection } from "../server/src/types";
import { fakeResourceControls, testConfig } from "./helpers";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}

const fixtures: Array<{ app: FastifyInstance; release: Array<() => void> }> = [];

afterEach(async () => {
    vi.useRealTimers();
    for (const fixture of fixtures.splice(0)) {
        for (const release of fixture.release) release();
        await fixture.app.close();
    }
});

async function fixture(options: { initialize?: (db: WebuiDatabase, config: WebuiConfig) => void; collect?: RunnerProvider["collect"] } = {}) {
    const config = testConfig();
    config.codex.credentialMode = "none";
    config.cloud.maxConcurrent = 1;
    const db = new WebuiDatabase(config);
    const operations: string[] = [];
    const uploads: Array<{ id: string; notes: string }> = [];
    const provider = {
        ...fakeResourceControls(config),
        describeProvisioning: (task: CodexTask) => ({ backend: task.backend, expectedResourceName: `fake-${task.id}`, labels: {} }),
        provision: vi.fn<RunnerProvider["provision"]>(async (task, intent) => ({
            provider: task.backend,
            taskId: task.id,
            intentId: intent.id,
            ...(task.backend === "local" ? { containerName: `fake-${task.id}` } : { dropletId: `fake-${task.id}`, sshHost: "192.0.2.1" }),
            createdAt: new Date().toISOString()
        })),
        recover: undefined as RunnerProvider["recover"],
        start: vi.fn<RunnerProvider["start"]>(async (task) => {
            operations.push(`start:${task.id}`);
            uploads.push({ id: task.id, notes: fs.readFileSync(path.join(task.storagePath, "NOTES.md"), "utf8") });
        }),
        stop: vi.fn<RunnerProvider["stop"]>(async (task) => { operations.push(`stop:${task.id}`); }),
        destroy: vi.fn<RunnerProvider["destroy"]>(async () => undefined),
        collect: vi.fn<RunnerProvider["collect"]>(async (task, handle, collectionOptions) => {
            operations.push(`collect:${collectionOptions?.mode}:${task.id}`);
            if (options.collect) return options.collect(task, handle, collectionOptions);
            return { lastSyncedAt: new Date().toISOString() };
        }),
        openTerminal: vi.fn<RunnerProvider["openTerminal"]>(async () => { throw new Error("No real terminals in this fixture"); }),
        openEventStream: vi.fn<RunnerProvider["openEventStream"]>(async () => (async function* () {})()),
        sendPrompt: vi.fn<RunnerProvider["sendPrompt"]>(async () => undefined)
    } satisfies RunnerProvider;
    const turns: Array<{ id: string; prompt: string; done: ReturnType<typeof deferred<string>> }> = [];
    const activeTurns = new Map<string, ReturnType<typeof deferred<string>>>();
    const nativeCodex = {
        run: vi.fn(async (task: CodexTask, _handle: RunnerHandle, prompt: string) => {
            const done = deferred<string>();
            turns.push({ id: task.id, prompt, done });
            activeTurns.set(task.id, done);
            try { return await done.promise; }
            finally { activeTurns.delete(task.id); }
        }),
        stop: vi.fn((id: string) => { activeTurns.get(id)?.resolve(""); }),
        state: (id: string) => ({ state: activeTurns.has(id) ? "active" as const : "closed" as const })
    };
    options.initialize?.(db, config);
    const { app } = await buildServer({ config, db, providers: new Map([["local", provider], ["digitalocean", provider]]), nativeCodex });
    const release: Array<() => void> = [];
    fixtures.push({ app, release });
    await app.ready();
    async function create(backend: Backend = "local", prompt = "sync lifecycle fixture"): Promise<CodexTask> {
        const response = await app.inject({ method: "POST", url: "/api/tasks", payload: { prompt, backend } });
        expect(response.statusCode).toBe(201);
        return response.json<CodexTask>();
    }
    const start = (id: string) => app.inject({ method: "POST", url: `/api/tasks/${id}/start` });
    const stop = (id: string) => app.inject({ method: "POST", url: `/api/tasks/${id}/stop` });
    return { app, db, config, provider, turns, nativeCodex, operations, uploads, release, create, start, stop };
}

async function settle() {
    for (let index = 0; index < 8; index++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function until(assertion: () => void) {
    for (let index = 0; index < 100; index++) {
        try { assertion(); return; }
        catch { await settle(); }
    }
    assertion();
}

const offline = { version: 1, network: { mode: "none", enforcement: "docker-none", allow: [] }, mounts: [] };

describe("UI/API synchronization lifecycle", () => {
    it("releases local reservations on shutdown while preserving pending work", async () => {
        const f = await fixture();
        const active = await f.create("local", "active during shutdown");
        const pending = await f.create("local", "pending after shutdown");
        await f.start(active.id); await f.start(pending.id);
        await until(() => expect(f.turns).toHaveLength(1));
        expect(f.db.getTask(active.id)?.resources).toMatchObject({ memoryMb: 1024 });
        await f.app.close();
        expect(f.provider.stop).toHaveBeenCalledTimes(1);
        expect(f.db.hasOpenExecution(active.id)).toBe(false);
        expect(f.db.getTask(active.id)?.resources).toBeUndefined();
        expect(f.db.getTask(pending.id)?.status).toBe("queued");
        expect(f.db.hasOpenExecution(pending.id)).toBe(true);
        expect(f.turns.map(turn => turn.prompt)).toEqual(["active during shutdown"]);
    });

    it("persists local reservations when shutdown cleanup fails", async () => {
        const f = await fixture();
        const task = await f.create("local", "cleanup must stay reserved");
        await f.start(task.id); await until(() => expect(f.turns).toHaveLength(1));
        const reservation = f.db.getTask(task.id)?.resources;
        f.provider.stop.mockRejectedValueOnce(new Error("Docker stop uncertain during shutdown"));
        await f.app.close();
        expect(f.db.hasOpenExecution(task.id)).toBe(true);
        expect(f.db.getTask(task.id)?.resources).toEqual(reservation);
        expect(f.db.getTask(task.id)?.executionError).toContain("Retry Stop");
    });

    it("returns saved permission capabilities and persists updates in both manifests and the database", async () => {
        const f = await fixture();
        const local = await f.create();
        const cloud = await f.create("digitalocean");
        f.config.codex.credentialMode = "host-codex-cli";
        const host = await f.create();
        f.config.codex.credentialMode = "none";
        const localRead = await f.app.inject({ method: "GET", url: `/api/tasks/${local.id}/permissions` });
        expect(localRead.json()).toMatchObject({ supportedNetworkModes: ["open", "none"], editable: true, permissions: { network: { mode: "open" } } });
        const cloudRead = await f.app.inject({ method: "GET", url: `/api/tasks/${cloud.id}/permissions` });
        expect(cloudRead.json()).toMatchObject({ supportedNetworkModes: ["open"], editable: true });
        const hostRead = await f.app.inject({ method: "GET", url: `/api/tasks/${host.id}/permissions` });
        expect(hostRead.json()).toMatchObject({ supportedNetworkModes: ["open"], editable: true });

        const saved = await f.app.inject({ method: "PATCH", url: `/api/tasks/${local.id}/permissions`, payload: offline });
        expect(saved.statusCode).toBe(200);
        expect(saved.json()).toEqual(offline);
        expect(f.db.getTask(local.id)).toMatchObject({ networkMode: "none", networkEnforcement: "docker-none" });
        const taskManifest = YAML.parse(fs.readFileSync(path.join(path.dirname(local.storagePath), "task.yaml"), "utf8"));
        expect(taskManifest).toMatchObject({ id: local.id, networkMode: "none", networkEnforcement: "docker-none" });
        expect((await f.app.inject({ method: "GET", url: `/api/tasks/${local.id}/permissions` })).json()).toMatchObject({ permissions: offline });
        expect((await f.app.inject({ method: "PATCH", url: `/api/tasks/${cloud.id}/permissions`, payload: offline })).statusCode).toBe(400);
        expect((await f.app.inject({ method: "PATCH", url: `/api/tasks/${host.id}/permissions`, payload: offline })).statusCode).toBe(400);
        expect(f.provider.provision).not.toHaveBeenCalled();
    });

    it("locks permissions for queued and active tasks until Stop finishes", async () => {
        const f = await fixture();
        const running = await f.create();
        const queued = await f.create();
        await f.start(running.id);
        await until(() => expect(f.turns).toHaveLength(1));
        await f.start(queued.id);
        expect(f.db.getTask(queued.id)?.status).toBe("queued");
        for (const task of [running, queued]) {
            const read = await f.app.inject({ method: "GET", url: `/api/tasks/${task.id}/permissions` });
            expect(read.json()).toMatchObject({ editable: false, reason: expect.stringContaining("Stop") });
            expect((await f.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}/permissions`, payload: offline })).statusCode).toBe(409);
        }
        await f.stop(queued.id);
        await f.stop(running.id);
        expect((await f.app.inject({ method: "PATCH", url: `/api/tasks/${running.id}/permissions`, payload: offline })).statusCode).toBe(200);
    });

    it.each(["changed", "unknown"] as const)("recreates stopped local runners with %s fingerprints while preserving workspace and sessions", async (mode) => {
        const f = await fixture();
        const task = await f.create();
        fs.writeFileSync(path.join(task.storagePath, "retained.txt"), "workspace");
        fs.mkdirSync(path.join(task.codexHomePath, "sessions"));
        const sessionPath = path.join(task.codexHomePath, "sessions", "retained.jsonl");
        fs.writeFileSync(sessionPath, "session");
        await f.start(task.id);
        await until(() => expect(f.turns).toHaveLength(1));
        expect((await f.stop(task.id)).statusCode).toBe(200);
        const previous = f.db.getLatestAttachedHandleForTask(task.id)!;
        if (mode === "changed") {
            expect((await f.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}/permissions`, payload: offline })).statusCode).toBe(200);
        } else {
            f.db.bindResource(previous.intentId, { ...previous, permissionsFingerprint: undefined });
        }

        await f.start(task.id);
        await until(() => expect(f.turns).toHaveLength(2));

        expect(f.provider.provision).toHaveBeenCalledTimes(2);
        expect(f.provider.destroy).toHaveBeenCalledTimes(1);
        expect(f.db.getIntent(previous.intentId)?.status).toBe("closed");
        const current = f.db.getLatestAttachedHandleForTask(task.id)!;
        expect(current.permissionsFingerprint).toBe(permissionsFingerprint(readPermissions(path.join(path.dirname(task.storagePath), "permissions.yaml"), f.config)));
        expect(fs.readFileSync(path.join(task.storagePath, "retained.txt"), "utf8")).toBe("workspace");
        expect(fs.readFileSync(sessionPath, "utf8")).toBe("session");
    });

    it("serves only a published cloud generation and rejects writes while the remote owns the workspace", async () => {
        const f = await fixture();
        const task = await f.create("digitalocean");
        fs.writeFileSync(path.join(task.storagePath, "result.txt"), "old host copy");
        await f.start(task.id);
        await until(() => expect(f.turns).toHaveLength(1));
        const generation = randomUUID();
        const snapshot = workspaceSnapshotPath(task, generation);
        fs.mkdirSync(snapshot, { recursive: true });
        fs.writeFileSync(path.join(snapshot, "result.txt"), "published remote result");
        fs.writeFileSync(path.join(snapshot, "new.txt"), "new file");
        f.db.mergeProviderState(task.id, { workspaceSync: { owner: "remote", state: "idle", generation, lastSyncedAt: new Date().toISOString() } });

        const listed = await f.app.inject({ method: "GET", url: `/api/tasks/${task.id}/files` });
        expect(listed.json<Array<{ name: string }>>().map((entry) => entry.name)).toEqual(["new.txt", "result.txt"]);
        expect((await f.app.inject({ method: "GET", url: `/api/tasks/${task.id}/files/result.txt` })).body).toBe("published remote result");
        expect((await f.app.inject({ method: "PUT", url: `/api/tasks/${task.id}/files/result.txt`, headers: { "content-type": "application/octet-stream" }, payload: "overwrite" })).statusCode).toBe(409);
        expect((await f.app.inject({ method: "DELETE", url: `/api/tasks/${task.id}/files/result.txt` })).statusCode).toBe(409);
        expect(fs.readFileSync(path.join(task.storagePath, "result.txt"), "utf8")).toBe("old host copy");
    });

    it("keeps permissions and cloud writes locked throughout final collection", async () => {
        const f = await fixture();
        const task = await f.create("digitalocean");
        const collected = deferred<WorkspaceCollection>();
        f.release.push(() => collected.resolve({ lastSyncedAt: new Date().toISOString() }));
        f.provider.collect.mockImplementationOnce(async () => collected.promise);
        await f.start(task.id);
        await until(() => expect(f.turns).toHaveLength(1));
        f.turns[0]!.done.resolve("");
        await until(() => expect(f.db.getTask(task.id)?.status).toBe("collecting"));
        expect((await f.app.inject({ method: "GET", url: `/api/tasks/${task.id}/permissions` })).json()).toMatchObject({ editable: false });
        expect((await f.app.inject({ method: "PATCH", url: `/api/tasks/${task.id}/permissions`, payload: offline })).statusCode).toBe(409);
        expect((await f.app.inject({ method: "DELETE", url: `/api/tasks/${task.id}/files/NOTES.md` })).statusCode).toBe(409);
        collected.resolve({ lastSyncedAt: new Date().toISOString() });
        await until(() => expect(f.db.hasOpenExecution(task.id)).toBe(false));
        expect((await f.app.inject({ method: "GET", url: `/api/tasks/${task.id}/permissions` })).json()).toMatchObject({ editable: true });
    });

    it("spaces snapshots ten seconds after completion, avoids overlap, and retries stale snapshots", async () => {
        const f = await fixture();
        const task = await f.create("digitalocean");
        const first = deferred<WorkspaceCollection>();
        f.release.push(() => first.resolve({ generation: randomUUID(), lastSyncedAt: new Date().toISOString() }));
        let snapshots = 0;
        const generation = randomUUID();
        f.provider.collect.mockImplementation(async (_task, _handle, options) => {
            if (options?.mode === "final") return { lastSyncedAt: new Date().toISOString() };
            snapshots++;
            if (snapshots === 1) return first.promise;
            if (snapshots === 2) throw new Error("temporary snapshot failure");
            return { generation: randomUUID(), lastSyncedAt: new Date().toISOString() };
        });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        await f.start(task.id);
        await until(() => expect(f.turns).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(9_999);
        expect(snapshots).toBe(0);
        await vi.advanceTimersByTimeAsync(1);
        expect(snapshots).toBe(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(snapshots).toBe(1);
        first.resolve({ generation, lastSyncedAt: new Date().toISOString() });
        await settle();
        await vi.advanceTimersByTimeAsync(9_999);
        expect(snapshots).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(snapshots).toBe(2);
        expect(f.db.getTask(task.id)?.workspaceSync).toMatchObject({ owner: "remote", state: "error", generation, error: expect.stringContaining("temporary snapshot failure") });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(snapshots).toBe(3);
        expect(f.db.getTask(task.id)?.workspaceSync).toMatchObject({ owner: "remote", state: "idle" });
        expect(f.db.getTask(task.id)?.workspaceSync?.error).toBeUndefined();
        expect(f.turns).toHaveLength(1);
        await f.stop(task.id);
    });

    it("cancels in-flight snapshots without publishing late generations", async () => {
        const f = await fixture();
        const task = await f.create("digitalocean");
        const pending = deferred<WorkspaceCollection>();
        const generation = randomUUID();
        f.release.push(() => pending.resolve({ generation, lastSyncedAt: new Date().toISOString() }));
        let signal: AbortSignal | undefined;
        f.provider.collect.mockImplementation(async (_task, _handle, options) => {
            if (options?.mode === "final") return { lastSyncedAt: new Date().toISOString() };
            signal = options?.signal;
            return pending.promise;
        });
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        await f.start(task.id);
        await until(() => expect(f.turns).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(10_000);
        const stopping = f.stop(task.id);
        await until(() => expect(signal?.aborted).toBe(true));
        pending.resolve({ generation, lastSyncedAt: new Date().toISOString() });
        expect((await stopping).statusCode).toBe(200);
        expect(f.db.getTask(task.id)?.workspaceSync).toMatchObject({ owner: "host", state: "idle" });
        expect(f.db.getTask(task.id)?.workspaceSync?.generation).toBeUndefined();
        const events = fs.readFileSync(path.join(task.logsPath, "events.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
        expect(events.filter((event) => event.type === "workspace.snapshot")).toHaveLength(0);
    });

    it("reserves capacity after final collection fails and Stop retries with collected notes before the next task starts", async () => {
        const f = await fixture();
        const first = await f.create("digitalocean", "first cloud prompt");
        const next = await f.create("digitalocean", "next cloud prompt");
        f.provider.collect.mockRejectedValueOnce(new Error("final collection failed"));
        f.provider.collect.mockImplementation(async (task) => {
            fs.writeFileSync(path.join(task.storagePath, "NOTES.md"), "remote notes collected successfully");
            return { lastSyncedAt: new Date().toISOString() };
        });
        await f.start(first.id);
        await f.start(next.id);
        await until(() => expect(f.turns).toHaveLength(1));
        f.turns[0]!.done.resolve('{"outcome":"solved","summary":"Recovered","flag":"flag{fixture}"}');
        await until(() => expect(f.db.getTask(first.id)?.executionError).toContain("Retry Stop"));
        expect(f.db.getTask(first.id)?.workspaceSync).toMatchObject({ owner: "remote", state: "error" });
        expect(f.db.getTask(next.id)?.status).toBe("queued");
        expect(f.turns).toHaveLength(1);

        expect((await f.stop(first.id)).statusCode).toBe(200);
        await until(() => expect(f.turns).toHaveLength(2));
        expect(f.db.getTask(first.id)).toMatchObject({ status: "idle", workStatus: "done", workspaceSync: { owner: "host", state: "idle" } });
        expect(f.db.getTask(first.id)?.executionError).toBeUndefined();
        const context = fs.readFileSync(path.join(first.controlPath, "MECHA_CONTEXT.md"), "utf8");
        expect(context).toContain("remote notes collected successfully");
        expect(context).toContain("first cloud prompt");
    });

    it("uploads host edits before each follow-up cloud turn without creating another droplet", async () => {
        const f = await fixture();
        const task = await f.create("digitalocean");
        await f.start(task.id);
        await until(() => expect(f.turns).toHaveLength(1));
        expect(f.uploads).toHaveLength(1);
        f.turns[0]!.done.resolve("");
        await until(() => expect(f.db.hasOpenExecution(task.id)).toBe(false));
        expect((await f.app.inject({ method: "PUT", url: `/api/tasks/${task.id}/files/NOTES.md`, headers: { "content-type": "application/octet-stream" }, payload: "host edits for follow-up" })).statusCode).toBe(200);

        expect((await f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/prompt`, payload: { prompt: "follow up" } })).statusCode).toBe(202);
        await until(() => expect(f.turns).toHaveLength(2));
        expect(f.uploads[1]).toEqual({ id: task.id, notes: "host edits for follow-up" });
        expect(f.provider.provision).toHaveBeenCalledTimes(1);
        expect(f.turns[1]!.prompt).toBe("follow up");
    });

    it("destroys cloud resources without SSH Stop or collection and retains records when deletion fails", async () => {
        const f = await fixture();
        const task = await f.create("digitalocean");
        await f.start(task.id);
        await until(() => expect(f.turns).toHaveLength(1));
        f.provider.stop.mockRejectedValue(new Error("SSH is unreachable"));
        f.provider.collect.mockRejectedValue(new Error("collection is unreachable"));
        f.provider.destroy.mockRejectedValueOnce(new Error("cloud deletion failed"));

        const failed = await f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/destroy` });
        expect(failed.statusCode).toBe(400);
        expect(failed.json()).toEqual({ error: "cloud deletion failed" });
        expect(f.db.getTask(task.id)).toBeDefined();
        expect(f.db.getLatestAttachedHandleForTask(task.id)?.dropletId).toBe(`fake-${task.id}`);
        expect(fs.existsSync(task.storagePath)).toBe(true);
        expect(f.provider.stop).not.toHaveBeenCalled();
        expect(f.provider.collect).not.toHaveBeenCalled();

        const deleted = await f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/destroy` });
        expect(deleted.statusCode).toBe(200);
        expect(f.db.getTask(task.id)).toBeUndefined();
        expect(fs.existsSync(path.dirname(task.storagePath))).toBe(false);
        expect(f.provider.stop).not.toHaveBeenCalled();
        expect(f.provider.collect).not.toHaveBeenCalled();
    });

    it("retries final collection after concurrent Destroy cancellation and failed resource deletion", async () => {
        const f = await fixture();
        const task = await f.create("digitalocean", "finish before deleting");
        const queued = await f.create("digitalocean", "waiting for capacity");
        const collection = deferred<WorkspaceCollection>();
        f.release.push(() => collection.resolve({ lastSyncedAt: new Date().toISOString() }));
        let signal: AbortSignal | undefined;
        f.provider.collect.mockImplementationOnce(async (_task, _handle, options) => {
            signal = options?.signal;
            return collection.promise;
        });
        f.provider.collect.mockImplementation(async (current) => {
            fs.writeFileSync(path.join(current.storagePath, "NOTES.md"), "collected after failed deletion");
            return { lastSyncedAt: new Date().toISOString() };
        });
        await f.start(task.id);
        await f.start(queued.id);
        await until(() => expect(f.turns).toHaveLength(1));
        f.turns[0]!.done.resolve('{"outcome":"solved","summary":"Recovered","flag":"flag{fixture}"}');
        await until(() => expect(f.db.getTask(task.id)?.status).toBe("collecting"));
        f.provider.destroy.mockRejectedValueOnce(new Error("resource deletion unavailable"));

        const destroying = f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/destroy` });
        await until(() => expect(signal?.aborted).toBe(true));
        collection.resolve({ lastSyncedAt: new Date().toISOString() });
        expect((await destroying).statusCode).toBe(400);
        expect(f.db.getTask(task.id)?.workspaceSync?.owner).toBe("remote");
        expect(f.db.hasOpenExecution(task.id)).toBe(true);
        expect(f.db.getTask(queued.id)?.status).toBe("queued");
        expect(f.provider.collect).toHaveBeenCalledTimes(1);

        expect((await f.stop(task.id)).statusCode).toBe(200);
        await until(() => expect(f.turns).toHaveLength(2));
        expect(f.provider.collect).toHaveBeenCalledTimes(2);
        expect(f.db.hasOpenExecution(task.id)).toBe(false);
        expect(f.db.getTask(task.id)).toMatchObject({ status: "idle", workStatus: "done", workspaceSync: { owner: "host", state: "idle" } });
        expect(fs.readFileSync(path.join(task.controlPath, "MECHA_CONTEXT.md"), "utf8")).toContain("collected after failed deletion");
        expect(f.turns[1]!.id).toBe(queued.id);
    });

    it.each(["recovered", "unavailable", "error"] as const)("requires confirmed resource recovery before deleting an unbound provisioning intent: %s", async (recovery) => {
        const f = await fixture();
        const task = await f.create("digitalocean");
        const intent = f.db.createIntent(task, f.provider.describeProvisioning(task), 120);
        f.db.updateTaskStatus(task.id, "provisioning");
        const handle: RunnerHandle = { provider: "digitalocean", taskId: task.id, intentId: intent.id, dropletId: "interrupted-vm", sshHost: "192.0.2.1", createdAt: new Date().toISOString() };
        const recover = vi.fn<NonNullable<RunnerProvider["recover"]>>(async () => handle);
        if (recovery === "error") recover.mockRejectedValue(new Error("resource lookup unavailable"));
        if (recovery !== "unavailable") f.provider.recover = recover;
        f.provider.destroy.mockImplementationOnce(async (_task, recovered) => {
            expect(recovered.dropletId).toBe("interrupted-vm");
            expect(f.db.getHandleForIntent(intent.id)?.dropletId).toBe("interrupted-vm");
            expect(fs.existsSync(task.storagePath)).toBe(true);
        });

        const response = await f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/destroy` });

        if (recovery === "recovered") {
            expect(response.statusCode).toBe(200);
            expect(recover).toHaveBeenCalledWith(expect.objectContaining({ id: task.id }), expect.objectContaining({ id: intent.id }));
            expect(f.provider.destroy).toHaveBeenCalledTimes(1);
            expect(f.db.getTask(task.id)).toBeUndefined();
            expect(fs.existsSync(path.dirname(task.storagePath))).toBe(false);
        } else {
            expect(response.statusCode).toBe(400);
            expect(response.json().error).toMatch(recovery === "error" ? /resource lookup unavailable/ : /confirmed resource recovery/);
            expect(f.db.getTask(task.id)?.status).toBe("provisioning");
            expect(f.db.getIntent(intent.id)?.status).toBe("creating");
            expect(fs.existsSync(task.storagePath)).toBe(true);
            expect(f.provider.destroy).not.toHaveBeenCalled();
        }
    });

    it("collects a persisted active cloud turn after restart before releasing capacity without replaying its prompt", async () => {
        let interrupted!: CodexTask;
        let pending!: CodexTask;
        let database!: WebuiDatabase;
        let published!: string;
        let strayStage!: string;
        const f = await fixture({
            initialize(db, config) {
                database = db;
                interrupted = createTaskRecord({ backend: "digitalocean", prompt: "interrupted prompt must not replay" }, config, db);
                pending = createTaskRecord({ backend: "digitalocean", prompt: "persisted pending prompt" }, config, db);
                const intent = db.createIntent(interrupted, { backend: "digitalocean", expectedResourceName: "persisted-vm", labels: {} }, 120);
                const handle: RunnerHandle = { provider: "digitalocean", taskId: interrupted.id, intentId: intent.id, dropletId: "persisted-vm", sshHost: "192.0.2.1", createdAt: new Date().toISOString() };
                db.bindResource(intent.id, handle);
                const generation = randomUUID();
                published = workspaceSnapshotPath(interrupted, generation);
                strayStage = workspaceSnapshotPath(interrupted, randomUUID());
                for (const directory of [published, strayStage]) {
                    fs.mkdirSync(directory, { recursive: true });
                    fs.writeFileSync(path.join(directory, "NOTES.md"), "older snapshot notes");
                }
                fs.writeFileSync(path.join(interrupted.storagePath, "NOTES.md"), "stale host notes");
                db.mergeProviderState(interrupted.id, { ...handle, workspaceSync: { owner: "remote", state: "syncing", generation, lastSyncedAt: new Date().toISOString() } });
                db.updateTaskStatus(interrupted.id, "running");
                db.updateWorkStatus(interrupted.id, "running");
                db.updateTaskStatus(pending.id, "queued");
                db.db.prepare("INSERT INTO executions(task_id,prompt,state) VALUES (?,?,'active')").run(interrupted.id, "interrupted prompt must not replay");
                db.db.prepare("INSERT INTO executions(task_id,prompt,state) VALUES (?,?,'pending')").run(pending.id, "persisted pending prompt");
            },
            async collect(task, handle, options) {
                expect(options?.mode).toBe("final");
                if (task.id === interrupted.id) {
                    expect(handle.dropletId).toBe("persisted-vm");
                    expect(database.hasOpenExecution(interrupted.id)).toBe(true);
                    expect(database.getTask(pending.id)?.status).toBe("queued");
                    expect(fs.existsSync(published)).toBe(true);
                    expect(fs.existsSync(strayStage)).toBe(false);
                    fs.writeFileSync(path.join(task.storagePath, "NOTES.md"), "fresh notes recovered after restart");
                }
                return { lastSyncedAt: new Date().toISOString() };
            }
        });

        await until(() => expect(f.turns).toHaveLength(1));

        expect(f.operations.slice(0, 3)).toEqual([`stop:${interrupted.id}`, `collect:final:${interrupted.id}`, `start:${pending.id}`]);
        expect(f.turns.map((turn) => turn.prompt)).toEqual(["persisted pending prompt"]);
        expect(f.nativeCodex.stop).toHaveBeenCalledWith(interrupted.id);
        expect(f.db.hasOpenExecution(interrupted.id)).toBe(false);
        expect(f.db.getTask(interrupted.id)).toMatchObject({ status: "idle", workspaceSync: { owner: "host", state: "idle" } });
        expect(f.db.getTask(interrupted.id)?.workspaceSync?.generation).toBeUndefined();
        expect(fs.readFileSync(path.join(interrupted.controlPath, "MECHA_CONTEXT.md"), "utf8")).toContain("fresh notes recovered after restart");
        expect(fs.existsSync(published)).toBe(false);
        expect(fs.existsSync(strayStage)).toBe(false);
    });

    it("recovers an idle legacy cloud workspace before accepting host file edits", async () => {
        let legacy!: CodexTask;
        let database!: WebuiDatabase;
        const f = await fixture({
            initialize(db, config) {
                database = db;
                legacy = createTaskRecord({ backend: "digitalocean", prompt: "legacy task" }, config, db);
                const intent = db.createIntent(legacy, { backend: "digitalocean", expectedResourceName: "legacy-idle-vm", labels: {} }, 120);
                db.bindResource(intent.id, { provider: "digitalocean", taskId: legacy.id, intentId: intent.id, dropletId: "legacy-idle-vm", sshHost: "192.0.2.1", createdAt: legacy.createdAt });
                db.updateTaskStatus(legacy.id, "idle");
                fs.writeFileSync(path.join(legacy.storagePath, "NOTES.md"), "old host snapshot");
            },
            async collect(task, _handle, options) {
                expect(options?.mode).toBe("final");
                expect(database.getTask(task.id)?.workspaceSync?.owner).toBe("remote");
                expect(database.hasOpenExecution(task.id)).toBe(true);
                fs.writeFileSync(path.join(task.storagePath, "NOTES.md"), "legacy remote artifacts retained");
                return { lastSyncedAt: new Date().toISOString() };
            }
        });
        expect(f.provider.collect).toHaveBeenCalledTimes(1);
        expect(f.provider.start).not.toHaveBeenCalled();
        expect(f.nativeCodex.run).not.toHaveBeenCalled();
        expect(f.db.getTask(legacy.id)).toMatchObject({ status: "idle", workspaceSync: { owner: "host", state: "idle" } });
        expect(fs.readFileSync(path.join(legacy.storagePath, "NOTES.md"), "utf8")).toBe("legacy remote artifacts retained");
        expect(fs.readFileSync(path.join(legacy.controlPath, "MECHA_CONTEXT.md"), "utf8")).toContain("legacy remote artifacts retained");
        const edited = await f.app.inject({ method: "PUT", url: `/api/tasks/${legacy.id}/files/after-recovery.txt`, headers: { "content-type": "application/octet-stream" }, payload: "new host edit" });
        expect(edited.statusCode).toBe(200);
    });

    it("aborts legacy pre-start collection on Destroy before uploading the host workspace", async () => {
        const f = await fixture();
        const task = await f.create("digitalocean");
        const intent = f.db.createIntent(task, f.provider.describeProvisioning(task), 120);
        f.db.bindResource(intent.id, { provider: "digitalocean", taskId: task.id, intentId: intent.id, dropletId: "legacy-vm", sshHost: "192.0.2.1", createdAt: new Date().toISOString() });
        const collection = deferred<WorkspaceCollection>();
        f.release.push(() => collection.resolve({ lastSyncedAt: new Date().toISOString() }));
        let signal: AbortSignal | undefined;
        f.provider.collect.mockImplementationOnce(async (_task, _handle, options) => {
            signal = options?.signal;
            return collection.promise;
        });
        await f.start(task.id);
        await until(() => expect(f.provider.collect).toHaveBeenCalledTimes(1));

        const destroying = f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/destroy` });
        await until(() => expect(signal?.aborted).toBe(true));
        collection.resolve({ lastSyncedAt: new Date().toISOString() });

        expect((await destroying).statusCode).toBe(200);
        expect(f.provider.start).not.toHaveBeenCalled();
        expect(f.nativeCodex.run).not.toHaveBeenCalled();
        expect(f.provider.destroy).toHaveBeenCalledTimes(1);
        expect(f.db.getTask(task.id)).toBeUndefined();
    });

    it("collects legacy cloud handles before uploading a stale host workspace", async () => {
        const f = await fixture();
        const task = await f.create("digitalocean");
        fs.writeFileSync(path.join(task.storagePath, "NOTES.md"), "stale host notes");
        const intent = f.db.createIntent(task, f.provider.describeProvisioning(task), 120);
        const handle: RunnerHandle = { provider: "digitalocean", taskId: task.id, intentId: intent.id, dropletId: "legacy-vm", sshHost: "192.0.2.1", createdAt: new Date().toISOString() };
        f.db.bindResource(intent.id, handle);
        f.db.mergeProviderState(task.id, { ...handle });
        f.provider.collect.mockImplementation(async (current, _handle, options) => {
            f.operations.push(`collect:${options?.mode}:${current.id}`);
            fs.writeFileSync(path.join(current.storagePath, "NOTES.md"), "retained remote notes");
            return { lastSyncedAt: new Date().toISOString() };
        });

        await f.start(task.id);
        await until(() => expect(f.turns).toHaveLength(1));

        expect(f.operations).toEqual([`stop:${task.id}`, `collect:final:${task.id}`, `start:${task.id}`]);
        expect(f.uploads[0]).toEqual({ id: task.id, notes: "retained remote notes" });
        expect(f.provider.provision).not.toHaveBeenCalled();
    });
});
