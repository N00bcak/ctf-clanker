import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebuiDatabase } from "../server/src/db";
import { createTask } from "../server/src/tasks/createTask";
import { directorySizeBytes } from "../server/src/utils/quota";
import { discardWorkspaceSnapshots, runWorkspaceCommand, validateWorkspaceTree, WorkspaceTransfer, workspaceSnapshotPath, type WorkspaceCommand } from "../server/src/providers/workspaceTransfer";
import type { RunnerHandle } from "../server/src/types";
import { testConfig } from "./helpers";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
    const config = testConfig(); const db = new WebuiDatabase(config);
    cleanup.push(() => { db.db.close(); fs.rmSync(config.paths.cacheDir, { recursive: true, force: true }); });
    const task = createTask({ prompt: "workspace fixture", backend: "digitalocean" }, config, db);
    const handle: RunnerHandle = { provider: "digitalocean", taskId: task.id, intentId: "fixture", sshHost: "203.0.113.42", dropletId: "42", createdAt: task.createdAt };
    const remote = path.join(config.paths.cacheDir, "remote-fixture"); fs.mkdirSync(remote);
    const localRsync: WorkspaceCommand = async (command, args, options) => {
        if (command !== "rsync") return { stdout: "" };
        const local = [...args]; const ssh = local.indexOf("-e"); if (ssh >= 0) local.splice(ssh, 2);
        for (let index = 0; index < local.length; index++) if (local[index].endsWith(":/workspace/")) local[index] = `${remote}/`;
        return runWorkspaceCommand(command, local, options);
    };
    return { config, task, handle, remote, transfer: new WorkspaceTransfer(config, localRsync) };
}

describe("cloud workspace generations", () => {
    it("publishes complete generations, preserves earlier bytes and modes, and makes independent final files", async () => {
        const f = fixture(); const source = path.join(f.remote, "result.txt"); fs.writeFileSync(source, "original"); fs.chmodSync(source, 0o644);
        const first = await f.transfer.collect(f.task, f.handle, { mode: "snapshot" });
        const firstRoot = workspaceSnapshotPath(f.task, first.generation!);
        expect(fs.readFileSync(path.join(firstRoot, "result.txt"), "utf8")).toBe("original");
        f.task.workspaceSync = { owner: "remote", state: "idle", ...first };
        fs.chmodSync(source, 0o755);
        const second = await f.transfer.collect(f.task, f.handle, { mode: "snapshot" });
        expect(fs.statSync(path.join(firstRoot, "result.txt")).mode & 0o777).toBe(0o644);
        expect(fs.statSync(path.join(workspaceSnapshotPath(f.task, second.generation!), "result.txt")).mode & 0o777).toBe(0o755);
        f.task.workspaceSync = { owner: "remote", state: "idle", ...second };
        const previousStat = fs.statSync(source);
        fs.writeFileSync(source, "updated!");
        fs.utimesSync(source, previousStat.atime, previousStat.mtime);
        await f.transfer.collect(f.task, f.handle, { mode: "final" });
        expect(fs.readFileSync(path.join(f.task.storagePath, "result.txt"), "utf8")).toBe("updated!");
        fs.writeFileSync(path.join(f.task.storagePath, "result.txt"), "host edit");
        expect(fs.readFileSync(path.join(firstRoot, "result.txt"), "utf8")).toBe("original");
        expect(fs.readFileSync(path.join(workspaceSnapshotPath(f.task, second.generation!), "result.txt"), "utf8")).toBe("original");
    });

    it("reuses only immutable unchanged files with link-dest and counts their data once", async () => {
        const f = fixture(); fs.writeFileSync(path.join(f.remote, "large.bin"), Buffer.alloc(100));
        const first = await f.transfer.collect(f.task, f.handle, { mode: "snapshot" });
        f.task.workspaceSync = { owner: "remote", state: "idle", ...first };
        const second = await f.transfer.collect(f.task, f.handle, { mode: "snapshot" });
        const one = path.join(workspaceSnapshotPath(f.task, first.generation!), "large.bin");
        const two = path.join(workspaceSnapshotPath(f.task, second.generation!), "large.bin");
        expect(fs.statSync(one).ino).toBe(fs.statSync(two).ino);
        expect(directorySizeBytes(path.dirname(workspaceSnapshotPath(f.task, first.generation!)))).toBe(100);
        discardWorkspaceSnapshots(f.task, second.generation);
        expect(fs.existsSync(one)).toBe(false); expect(fs.readFileSync(two)).toHaveLength(100);
    });

    it("preserves safe relative symlinks and rejects escaping links without publishing", async () => {
        const f = fixture(); fs.writeFileSync(path.join(f.remote, "result"), "safe"); fs.symlinkSync("result", path.join(f.remote, "link"));
        const first = await f.transfer.collect(f.task, f.handle, { mode: "snapshot" });
        expect(fs.readlinkSync(path.join(workspaceSnapshotPath(f.task, first.generation!), "link"))).toBe("result");
        fs.symlinkSync("/root/.codex", path.join(f.remote, "credentials"));
        await expect(f.transfer.collect(f.task, f.handle, { mode: "snapshot" })).rejects.toThrow("symlink escapes");
        expect(fs.readdirSync(path.dirname(workspaceSnapshotPath(f.task, first.generation!)))).toEqual([first.generation]);
    });

    it("rejects failed transfers, quota excess and cancelled stages while preserving host data", async () => {
        const f = fixture(); const original = fs.readFileSync(path.join(f.task.storagePath, "NOTES.md"), "utf8");
        const failed = new WorkspaceTransfer(f.config, async (_command, args) => { fs.writeFileSync(path.join(args.at(-1)!, "partial"), "partial"); throw new Error("transfer interrupted"); });
        await expect(failed.collect(f.task, f.handle, { mode: "final" })).rejects.toThrow("transfer interrupted");
        f.config.limits.taskCacheDirQuotaMb = 1;
        const oversized = new WorkspaceTransfer(f.config, async (_command, args) => { fs.writeFileSync(path.join(args.at(-1)!, "huge"), Buffer.alloc(2 * 1024 * 1024)); return { stdout: "" }; });
        await expect(oversized.collect(f.task, f.handle, { mode: "snapshot" })).rejects.toThrow("soft quota exceeded");
        const abort = new AbortController();
        const cancelled = new WorkspaceTransfer(f.config, async () => { abort.abort(); return { stdout: "" }; });
        await expect(cancelled.collect(f.task, f.handle, { mode: "snapshot", signal: abort.signal })).rejects.toThrow();
        expect(fs.readFileSync(path.join(f.task.storagePath, "NOTES.md"), "utf8")).toBe(original);
        expect(fs.readdirSync(path.join(path.dirname(f.task.storagePath), "workspace-snapshots"))).toEqual([]);
    });

    it("rejects unsafe snapshot paths and uploads before invoking a transport", async () => {
        const f = fixture(); expect(() => workspaceSnapshotPath(f.task, "../../outside")).toThrow("invalid workspace snapshot generation");
        fs.symlinkSync("../../outside", path.join(f.task.storagePath, "escape"));
        const run = vi.fn<WorkspaceCommand>(async () => ({ stdout: "" }));
        await expect(new WorkspaceTransfer(f.config, run).upload(f.task, f.handle)).rejects.toThrow("symlink escapes");
        expect(run).not.toHaveBeenCalled();
        fs.unlinkSync(path.join(f.task.storagePath, "escape"));
        f.task.workspaceSync = { owner: "remote", state: "idle" };
        await expect(new WorkspaceTransfer(f.config, run).upload(f.task, f.handle)).rejects.toThrow("Collect the remote workspace");
        expect(run).not.toHaveBeenCalled();
    });

    it("recovers an interrupted final directory swap before retrying", async () => {
        const f = fixture(); const backup = path.join(path.dirname(f.task.storagePath), "workspace-before-collection");
        fs.renameSync(f.task.storagePath, backup); fs.writeFileSync(path.join(f.remote, "recovered"), "complete");
        await f.transfer.collect(f.task, f.handle, { mode: "final" });
        expect(fs.readFileSync(path.join(f.task.storagePath, "recovered"), "utf8")).toBe("complete");
        expect(fs.existsSync(backup)).toBe(false);
        validateWorkspaceTree(f.task.storagePath);
    });
});
