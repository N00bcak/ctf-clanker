import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigitalOceanProvider } from "../server/src/providers/DigitalOceanProvider";
import type { WorkspaceCommand } from "../server/src/providers/workspaceTransfer";
import { WebuiDatabase } from "../server/src/db";
import { createTask } from "../server/src/tasks/createTask";
import type { RunnerHandle } from "../server/src/types";
import { testConfig } from "./helpers";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); vi.unstubAllEnvs(); });

function fixture() {
    const config = testConfig();
    const db = new WebuiDatabase(config);
    cleanup.push(() => { db.db.close(); fs.rmSync(config.paths.cacheDir, { recursive: true, force: true }); });
    const task = createTask({ prompt: "cloud fixture", backend: "digitalocean" }, config, db);
    fs.mkdirSync(path.dirname(config.codex.authJsonPath), { recursive: true });
    fs.writeFileSync(config.codex.authJsonPath, '{"fixture":true}');
    const handle: RunnerHandle = { provider: "digitalocean", taskId: task.id, intentId: "fixture-intent", createdAt: task.createdAt };
    const calls: Array<{ url: string; method: string }> = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET" });
        if (String(url).includes("/account/keys")) return Response.json({ ssh_keys: [{ id: 1, name: config.cloud.sshKeyName }] });
        if (String(url).includes("/droplets?")) return Response.json({ droplets: [] });
        return Response.json({ droplet: { id: 42, status: "active", networks: { v4: [{ type: "public", ip_address: "203.0.113.42" }] } } });
    });
    const run = vi.fn<WorkspaceCommand>(async (_command, args) => ({ stdout: args.at(-1)?.includes("metadata/v1/id") ? "42\n" : "" }));
    const provider = new DigitalOceanProvider(config, { fetch: fetcher as typeof fetch, runCommand: run });
    const live = () => {
        config.cloud.dryRun = false; config.cloud.enabled = true;
        vi.stubEnv(config.cloud.liveEnvGuard, "1"); vi.stubEnv("DIGITALOCEAN_TOKEN", "fixture-token");
        fs.writeFileSync(config.cloud.sshPublicKeyPath, "ssh-ed25519 fixture");
    };
    return { config, task, handle, calls, fetcher, run, provider, live };
}

describe("DigitalOcean lifecycle", () => {
    it("guards reused handles before commands or API requests", async () => {
        const f = fixture(); f.config.cloud.dryRun = false;
        Object.assign(f.handle, { dropletId: "42", sshHost: "203.0.113.42", bootstrapComplete: true });
        await expect(f.provider.start(f.task, f.handle)).rejects.toThrow("enabled cloud config");
        f.config.cloud.enabled = true; vi.stubEnv(f.config.cloud.liveEnvGuard, "");
        await expect(f.provider.start(f.task, f.handle)).rejects.toThrow("live env guard");
        vi.stubEnv(f.config.cloud.liveEnvGuard, "1"); vi.stubEnv("DIGITALOCEAN_TOKEN", ""); vi.stubEnv("DO_API_TOKEN", "");
        await expect(f.provider.start(f.task, f.handle)).rejects.toThrow("host-side DIGITALOCEAN_TOKEN");
        expect(f.fetcher).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
    });

    it("keeps dry-run free of live calls and refuses to forget a saved live resource", async () => {
        const f = fixture(); f.handle.dropletId = `dry-run-${f.task.id}`;
        await f.provider.start(f.task, f.handle); await f.provider.stop(f.task, f.handle); await f.provider.destroy(f.task, f.handle);
        f.handle.dropletId = "42";
        await expect(f.provider.start(f.task, f.handle)).rejects.toThrow("dry-run");
        await expect(f.provider.stop(f.task, f.handle)).rejects.toThrow("record was preserved");
        await expect(f.provider.destroy(f.task, f.handle)).rejects.toThrow("record was preserved");
        await expect(f.provider.collect(f.task, f.handle)).rejects.toThrow("record was preserved");
        expect(f.fetcher).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled();
    });

    it("accepts empty 204 and already-deleted 404 while new cloud starts are disabled", async () => {
        const f = fixture(); f.config.cloud.dryRun = false; f.handle.dropletId = "42";
        vi.stubEnv("DIGITALOCEAN_TOKEN", "fixture-token");
        f.fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
        await expect(f.provider.destroy(f.task, f.handle)).resolves.toBeUndefined();
        f.fetcher.mockResolvedValueOnce(new Response(null, { status: 404 }));
        await expect(f.provider.destroy(f.task, f.handle)).resolves.toBeUndefined();
        f.fetcher.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
        await expect(f.provider.destroy(f.task, f.handle)).rejects.toThrow("503");
        expect(f.run).not.toHaveBeenCalled();
    });

    it("persists creation before failed bootstrap and retries the same droplet", async () => {
        const f = fixture(); f.live();
        const saved: RunnerHandle[] = [];
        let fail = true;
        f.run.mockImplementation(async (command, args) => {
            if (command === "ssh" && args.at(-1)?.startsWith("mkdir -p /workspace") && fail) {
                fail = false; expect(saved.some(handle => handle.dropletId === "42")).toBe(true);
                throw new Error("bootstrap failed");
            }
            return { stdout: args.at(-1)?.includes("metadata/v1/id") ? "42\n" : "" };
        });
        const persist = (handle: RunnerHandle) => saved.push(structuredClone(handle));
        await expect(f.provider.start(f.task, f.handle, persist)).rejects.toThrow("bootstrap failed");
        expect(f.handle.dropletId).toBe("42"); expect(f.handle.bootstrapComplete).not.toBe(true);
        await f.provider.start(f.task, f.handle, persist);
        expect(f.calls.filter(call => call.method === "POST" && call.url.endsWith("/droplets"))).toHaveLength(1);
        expect(saved.at(-1)?.bootstrapComplete).toBe(true);
        const uploads = () => f.run.mock.calls.filter(([command, args]) => command === "rsync" && args.includes("--delay-updates"));
        expect(uploads()).toHaveLength(1);
        await f.provider.start(f.task, f.handle, persist);
        expect(uploads()).toHaveLength(2);
    });

    it("requires host rsync before creating a resource and refuses remote-owned uploads", async () => {
        const f = fixture(); f.live();
        f.run.mockRejectedValueOnce(new Error("ENOENT"));
        await expect(f.provider.start(f.task, f.handle)).rejects.toThrow("requires rsync");
        expect(f.fetcher).not.toHaveBeenCalled();
        f.task.workspaceSync = { owner: "remote", state: "idle" };
        await expect(f.provider.start(f.task, f.handle)).rejects.toThrow("Collect the remote workspace");
        expect(f.fetcher).not.toHaveBeenCalled();
    });

    it("does not create again when a prior creation response was lost", async () => {
        const f = fixture(); f.live();
        f.handle.providerPayload = { creationRequested: true };
        await expect(f.provider.start(f.task, f.handle)).rejects.toThrow("outcome is unknown");
        await expect(f.provider.destroy(f.task, f.handle)).rejects.toThrow("cleanup must be confirmed");
        expect(f.calls.every(call => call.method === "GET")).toBe(true);
    });

    it("recovers only resources with the matching task and intent tags", async () => {
        const f = fixture(); f.live();
        const droplet = { id: 42, name: `mecha-task-${f.task.id}`, tags: ["mecha-webui", `task:${f.task.id}`, `intent:${f.handle.intentId}`] };
        f.fetcher.mockResolvedValueOnce(Response.json({ droplets: [droplet] }));
        const intent = { id: f.handle.intentId, taskId: f.task.id, backend: "digitalocean" as const, expectedResourceName: droplet.name,
            createdAt: f.task.createdAt, reaperGraceUntil: f.task.createdAt, status: "creating" as const };
        expect((await f.provider.recover(f.task, intent))?.dropletId).toBe("42");
        f.fetcher.mockResolvedValueOnce(Response.json({ droplets: [droplet, { ...droplet, id: 43 }] }));
        await expect(f.provider.recover(f.task, intent)).rejects.toThrow("ambiguous recovery");
    });
});
