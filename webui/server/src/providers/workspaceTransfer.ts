import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { expandHome } from "../codex/auth.js";
import type { CodexTask, RunnerHandle, WebuiConfig, WorkspaceCollection } from "../types.js";
import { enforceTaskQuota } from "../utils/quota.js";

const execFileAsync = promisify(execFile);
const GENERATION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export type WorkspaceCommand = (command: string, args: string[], options?: { signal?: AbortSignal; timeout?: number }) => Promise<{ stdout: string }>;
export const runWorkspaceCommand: WorkspaceCommand = async (command, args, options) => {
    return execFileAsync(command, args, { maxBuffer: 20 * 1024 * 1024, timeout: options?.timeout ?? 60_000, signal: options?.signal });
};

export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

function taskRoot(task: CodexTask): string {
    const root = path.dirname(task.storagePath);
    if (path.basename(root) !== task.id || path.basename(task.storagePath) !== "storage"
        || fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory()) {
        throw new Error("invalid task workspace root");
    }
    return fs.realpathSync(root);
}

function snapshotsRoot(task: CodexTask): string {
    const root = path.join(taskRoot(task), "workspace-snapshots");
    if (fs.existsSync(root) && (fs.lstatSync(root).isSymbolicLink() || !fs.lstatSync(root).isDirectory())) {
        throw new Error("invalid workspace snapshot root");
    }
    return root;
}

export function workspaceSnapshotPath(task: CodexTask, generation: string): string {
    if (!GENERATION.test(generation)) throw new Error("invalid workspace snapshot generation");
    const target = path.join(snapshotsRoot(task), generation);
    if (fs.existsSync(target) && (fs.lstatSync(target).isSymbolicLink() || !fs.lstatSync(target).isDirectory())) {
        throw new Error("invalid workspace snapshot directory");
    }
    return target;
}

export function discardWorkspaceSnapshots(task: CodexTask, keep?: string): void {
    if (keep !== undefined) workspaceSnapshotPath(task, keep);
    const root = snapshotsRoot(task);
    if (!fs.existsSync(root)) return;
    for (const generation of fs.readdirSync(root)) {
        if (GENERATION.test(generation) && generation !== keep) {
            fs.rmSync(workspaceSnapshotPath(task, generation), { recursive: true, force: true });
        }
    }
}

export function validateWorkspaceTree(root: string): void {
    const base = fs.realpathSync(root);
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error("workspace root cannot be a symlink");
    const walk = (directory: string) => {
        for (const name of fs.readdirSync(directory)) {
            const target = path.join(directory, name);
            const stat = fs.lstatSync(target);
            if (stat.isSymbolicLink()) {
                const link = fs.readlinkSync(target);
                const relative = path.relative(base, path.resolve(path.dirname(target), link));
                if (path.isAbsolute(link) || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                    throw new Error(`workspace symlink escapes workspace: ${path.relative(base, target)}`);
                }
            } else if (stat.isDirectory()) walk(target);
            else if (!stat.isFile()) throw new Error(`workspace contains a special file: ${path.relative(base, target)}`);
        }
    };
    walk(base);
}

export class WorkspaceTransfer {
    constructor(private readonly config: WebuiConfig, private readonly run: WorkspaceCommand = runWorkspaceCommand) {}

    sshArgs(host: string): string[] {
        return ["-i", expandHome(this.config.cloud.sshKeyPath), "-o", "StrictHostKeyChecking=accept-new",
            "-o", "UserKnownHostsFile=~/.ssh/known_hosts", "-o", "ConnectTimeout=10", `${this.config.cloud.sshUser}@${host}`];
    }

    async preflight(): Promise<void> {
        try { await this.run("rsync", ["--version"], { timeout: 10_000 }); }
        catch { throw new Error("Cloud workspace synchronization requires rsync on the WebUI host"); }
    }

    private async rsync(task: CodexTask, handle: RunnerHandle, source: string, destination: string, extra: string[], signal?: AbortSignal): Promise<void> {
        if (!handle.sshHost) throw new Error("cloud workspace synchronization requires an SSH host");
        const ssh = ["ssh", ...this.sshArgs(handle.sshHost).slice(0, -1)].map(shellQuote).join(" ");
        signal?.throwIfAborted();
        const quotaAbort = new AbortController();
        const transferSignal = signal ? AbortSignal.any([signal, quotaAbort.signal]) : quotaAbort.signal;
        const checkQuota = () => enforceTaskQuota(taskRoot(task), this.config);
        const monitor = setInterval(() => {
            try { checkQuota(); } catch (error) { quotaAbort.abort(error); }
        }, 1_000);
        monitor.unref();
        try {
            await this.run("rsync", ["-rltp", "--checksum", "--delay-updates", "--delete-after", "--timeout=30", "-e", ssh,
                ...extra, "--", source, destination], { signal: transferSignal, timeout: 120_000 });
            transferSignal.throwIfAborted();
            checkQuota();
        } catch (error) {
            if (quotaAbort.signal.aborted) throw quotaAbort.signal.reason;
            throw error;
        } finally { clearInterval(monitor); }
    }

    async upload(task: CodexTask, handle: RunnerHandle): Promise<void> {
        if (task.workspaceSync?.owner === "remote") throw new Error("Collect the remote workspace before uploading a host snapshot");
        validateWorkspaceTree(task.storagePath);
        enforceTaskQuota(taskRoot(task), this.config);
        if (!handle.sshHost) throw new Error("cloud workspace upload requires an SSH host");
        const stage = "/workspace-upload";
        const backup = "/workspace-before-upload";
        const remote = (command: string) => this.run("ssh", [...this.sshArgs(handle.sshHost!), command]);
        await remote(`set -e; test ! -L /workspace; test ! -L ${shellQuote(backup)}; if [ -e ${shellQuote(backup)} ]; then if [ -e /workspace ]; then rm -rf ${shellQuote(backup)}; else mv ${shellQuote(backup)} /workspace; fi; fi; mkdir -p /workspace; rm -rf ${shellQuote(stage)}; mkdir -m 700 ${shellQuote(stage)}`);
        try {
            await this.rsync(task, handle, `${task.storagePath}/`, `${this.config.cloud.sshUser}@${handle.sshHost}:${stage}/`, []);
            await remote(`set -e; test ! -L /workspace; mv /workspace ${shellQuote(backup)}; if mv ${shellQuote(stage)} /workspace; then rm -rf ${shellQuote(backup)}; else mv ${shellQuote(backup)} /workspace; exit 1; fi`);
        } finally {
            await remote(`rm -rf ${shellQuote(stage)}`).catch(() => undefined);
        }
    }

    async collect(task: CodexTask, handle: RunnerHandle, options: { mode: "snapshot" | "final"; signal?: AbortSignal }): Promise<WorkspaceCollection> {
        const root = taskRoot(task);
        const backup = path.join(root, "workspace-before-collection");
        if (fs.existsSync(backup)) {
            if (fs.lstatSync(backup).isSymbolicLink() || !fs.lstatSync(backup).isDirectory()) throw new Error("invalid workspace replacement backup");
            if (!fs.existsSync(task.storagePath)) fs.renameSync(backup, task.storagePath);
            else fs.rmSync(backup, { recursive: true, force: true });
        }
        enforceTaskQuota(root, this.config);
        const generation = randomUUID();
        const stage = workspaceSnapshotPath(task, generation);
        const previous = task.workspaceSync?.generation;
        const baseline = previous ? workspaceSnapshotPath(task, previous) : undefined;
        const extra = baseline && fs.existsSync(baseline) ? [`${options.mode === "snapshot" ? "--link-dest" : "--copy-dest"}=${baseline}`] : [];
        fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
        let completed = false;
        try {
            await this.rsync(task, handle, `${this.config.cloud.sshUser}@${handle.sshHost}:/workspace/`, `${stage}/`, extra, options.signal);
            validateWorkspaceTree(stage);
            options.signal?.throwIfAborted();
            enforceTaskQuota(root, this.config);
            if (options.mode === "snapshot") {
                completed = true;
                return { generation, lastSyncedAt: new Date().toISOString() };
            }
            fs.renameSync(task.storagePath, backup);
            try { fs.renameSync(stage, task.storagePath); }
            catch (error) { fs.renameSync(backup, task.storagePath); throw error; }
            fs.rmSync(backup, { recursive: true, force: true });
            return { lastSyncedAt: new Date().toISOString() };
        } finally {
            if (!completed) {
                fs.rmSync(stage, { recursive: true, force: true });
            }
        }
    }
}
