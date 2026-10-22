import fs from "node:fs";
import path from "node:path";
import type { RunnerProvider } from "./providers/Provider.js";
import { WebuiDatabase } from "./db.js";
import type { CodexTask, RunnerHandle, TaskEvent, WebuiConfig, WorkspaceSync } from "./types.js";
import { EventBus, writeTaskEvent } from "./utils/logs.js";
import type { SecretRedactor } from "./utils/redactor.js";
import { resolveFromRepoRoot } from "./config.js";
import { permissionsFingerprint, readPermissions, reconcileTaskPermissions } from "./tasks/permissions.js";
import { discardWorkspaceSnapshots } from "./providers/workspaceTransfer.js";
import { updateBridgeContext } from "./codex/context.js";

type SnapshotLoop = { timer?: ReturnType<typeof setTimeout>; controller?: AbortController; pending?: Promise<void>; cancelled: boolean };

export class Scheduler {
    private snapshots = new Map<string, SnapshotLoop>();
    private collections = new Map<string, { controller: AbortController; pending: Promise<void> }>();
    constructor(
        private readonly db: WebuiDatabase,
        private readonly providers: Map<string, RunnerProvider>,
        private readonly config: WebuiConfig,
        private readonly events: EventBus,
        private readonly redactor: SecretRedactor,
        private readonly onRunnerClosed: (taskId: string, options?: { suppressExitLog?: boolean }) => void | Promise<void> = () => undefined
    ) {}

    emit(task: CodexTask, type: string, fields: Record<string, unknown> = {}): TaskEvent {
        const event = writeTaskEvent(task.logsPath, {
            ts: new Date().toISOString(),
            taskId: task.id,
            type,
            ...fields
        }, this.config, this.redactor);
        this.events.publish(event);
        return event;
    }

    private providerFor(task: CodexTask): RunnerProvider {
        const provider = this.providers.get(task.backend);
        if (!provider) {
            throw new Error(`No provider for backend ${task.backend}`);
        }
        return provider;
    }

    providerForTask(task: CodexTask): RunnerProvider {
        return this.providerFor(task);
    }

    reconcilePermissions(taskId: string): CodexTask {
        const task = this.db.getTask(taskId);
        if (!task) throw new Error("task not found");
        return reconcileTaskPermissions(task, this.config, this.db);
    }

    refreshContext(task: CodexTask, prompt: string, fallbackExitCode: number): void {
        const exitCode = typeof task.providerState?.lastTurnExitCode === "number" ? task.providerState.lastTurnExitCode : fallbackExitCode;
        updateBridgeContext(task, prompt, exitCode, this.redactor);
    }

    cleanupSnapshots(task: CodexTask): void {
        if (task.codexRuntime === "droplet") discardWorkspaceSnapshots(task, task.workspaceSync?.generation);
    }

    recoverWorkspaceOwnership(task: CodexTask): void {
        if (task.codexRuntime === "droplet" && !task.workspaceSync) {
            const handle = this.getHandle(task) ?? this.db.getLatestAttachedHandleForTask(task.id);
            if (handle?.sshHost) this.workspaceState(task.id, { owner: "remote", state: "idle" });
        }
    }

    private persistHandle(taskId: string, handle: RunnerHandle): void {
        this.db.withTransaction(() => {
            this.db.bindResource(handle.intentId, handle);
            this.db.setActiveIntent(taskId, handle.intentId);
            this.db.mergeProviderState(taskId, handle as unknown as Record<string, unknown>);
        });
    }

    private workspaceState(taskId: string, patch: Partial<WorkspaceSync>): void {
        const task = this.db.getTask(taskId);
        if (!task) return;
        const workspaceSync: WorkspaceSync = { owner: "host", state: "idle", ...task.workspaceSync, ...patch };
        this.db.mergeProviderState(taskId, { workspaceSync });
    }

    startSnapshots(taskId: string): void {
        const task = this.db.getTask(taskId);
        if (!task || task.codexRuntime !== "droplet" || task.workspaceSync?.owner !== "remote" || this.snapshots.has(taskId)) return;
        const loop: SnapshotLoop = { cancelled: false };
        this.snapshots.set(taskId, loop);
        const schedule = () => {
            if (!loop.cancelled) {
                loop.timer = setTimeout(tick, 10_000);
                loop.timer.unref();
            }
        };
        const tick = () => {
            loop.controller = new AbortController();
            loop.pending = (async () => {
                const current = this.db.getTask(taskId);
                const handle = current && this.getHandle(current);
                if (!current || !handle || loop.cancelled || current.status === "destroying") return;
                this.workspaceState(taskId, { state: "syncing" });
                try {
                    const result = await this.providerFor(current).collect(current, handle, { mode: "snapshot", signal: loop.controller!.signal });
                    if (loop.cancelled || !this.db.getTask(taskId) || this.db.getTask(taskId)?.status === "destroying") return;
                    if (result) {
                        this.workspaceState(taskId, { owner: "remote", state: "idle", generation: result.generation, lastSyncedAt: result.lastSyncedAt, error: undefined });
                        discardWorkspaceSnapshots(current, result.generation);
                        this.emit(this.db.getTask(taskId)!, "workspace.snapshot", { generation: result.generation });
                    }
                } catch (error) {
                    if (!loop.cancelled) {
                        const event = this.emit(current, "workspace.snapshot_failed", { error: String(error) });
                        this.workspaceState(taskId, { state: "error", error: String(event.error) });
                    }
                }
            })().finally(schedule);
            void loop.pending.catch(() => undefined);
        };
        schedule();
    }

    async cancelSnapshots(taskId: string): Promise<void> {
        const loop = this.snapshots.get(taskId);
        if (!loop) return;
        loop.cancelled = true;
        clearTimeout(loop.timer);
        loop.controller?.abort();
        await loop.pending?.catch(() => undefined);
        this.snapshots.delete(taskId);
    }

    async cancelTransfers(taskId: string): Promise<void> {
        const pendingSnapshots = this.cancelSnapshots(taskId);
        const collection = this.collections.get(taskId);
        collection?.controller.abort();
        await pendingSnapshots;
        await collection?.pending.catch(() => undefined);
    }

    private async collectFinal(task: CodexTask, handle: RunnerHandle): Promise<void> {
        const existing = this.collections.get(task.id);
        if (existing) return existing.pending;
        const controller = new AbortController();
        const pending = (async () => {
            this.workspaceState(task.id, { owner: "remote", state: "syncing" });
            try {
                this.cleanupSnapshots(task);
                const result = await this.providerFor(task).collect(this.db.getTask(task.id)!, handle, { mode: "final", signal: controller.signal });
                if (controller.signal.aborted || this.db.getTask(task.id)?.status === "destroying") return;
                this.workspaceState(task.id, { owner: "host", state: "idle", generation: undefined, lastSyncedAt: result?.lastSyncedAt ?? new Date().toISOString(), error: undefined });
                discardWorkspaceSnapshots(task);
                this.emit(this.db.getTask(task.id)!, "workspace.collected");
            } catch (error) {
                if (this.db.getTask(task.id)?.status !== "destroying") {
                    const event = this.emit(task, "workspace.collection_failed", { error: String(error) });
                    this.workspaceState(task.id, { owner: "remote", state: "error", error: String(event.error) });
                }
                throw error;
            }
        })();
        this.collections.set(task.id, { controller, pending });
        try { await pending; } finally { this.collections.delete(task.id); }
    }

    private runnerReady(task: CodexTask, handle: RunnerHandle): boolean {
        if (task.codexRuntime === "container") {
            return Boolean(handle.containerName);
        }
        if (task.codexRuntime === "droplet") {
            return Boolean(handle.sshHost);
        }
        return true;
    }

    private runnerNotReadyReason(task: CodexTask): string {
        if (task.codexRuntime === "droplet") {
            return "dry-run runner has no ssh host";
        }
        if (task.codexRuntime === "container") {
            return "runner has no container name";
        }
        return "runner not ready";
    }

    private markRunnerReadyOrIdle(taskId: string, handle: RunnerHandle): CodexTask {
        const task = this.db.getTask(taskId)!;
        if (this.runnerReady(task, handle)) {
            this.db.updateTaskStatus(taskId, "running");
            if (task.workStatus !== "done") {
                this.db.updateWorkStatus(taskId, "running");
            }
            const running = this.db.getTask(taskId)!;
            this.emit(running, "runner.ready", handle as unknown as Record<string, unknown>);
            if (running.networkMode === "open") {
                this.emit(running, "security.warning", { message: "network mode open permits outbound exfiltration" });
            }
            return running;
        }
        this.db.updateTaskStatus(taskId, "idle");
        const idle = this.db.getTask(taskId)!;
        this.emit(idle, "runner.not_ready", { reason: this.runnerNotReadyReason(idle), intentId: handle.intentId });
        return idle;
    }

    private markHostReady(taskId: string): CodexTask {
        this.db.updateTaskStatus(taskId, "idle");
        const task = this.db.getTask(taskId)!;
        if (task.workStatus !== "done") {
            this.db.updateWorkStatus(taskId, "running");
        }
        const ready = this.db.getTask(taskId)!;
        this.emit(ready, "codex.ready", { runtime: "host", bridgeMode: ready.bridgeMode });
        return ready;
    }

    async startTask(taskId: string): Promise<CodexTask> {
        let original = this.db.getTask(taskId);
        if (!original) {
            throw new Error("task not found");
        }
        if (["provisioning", "running"].includes(original.status)) {
            return original;
        }
        if (original.status === "destroying") throw new Error("task is being deleted");
        original = this.reconcilePermissions(taskId);
        if (original.bridgeMode === "host-codex-broker" || original.codexRuntime === "host") {
            return this.markHostReady(taskId);
        }
        if (original.backend === "local" && this.db.countActiveLocalTasks(taskId) >= this.config.local.concurrency) {
            this.db.updateTaskStatus(taskId, "queued");
            const queued = this.db.getTask(taskId)!;
            this.emit(queued, "task.queued", { concurrency: this.config.local.concurrency });
            return queued;
        }

        const provider = this.providerFor(original);
        let existingHandle = this.getHandle(original) ?? this.db.getLatestAttachedHandleForTask(taskId);
        const fingerprint = original.codexRuntime === "container"
            ? permissionsFingerprint(readPermissions(path.join(path.dirname(original.storagePath), "permissions.yaml"), this.config))
            : undefined;
        if (existingHandle && fingerprint && existingHandle.permissionsFingerprint !== fingerprint) {
            await provider.stop(original, existingHandle);
            await provider.destroy(original, existingHandle);
            this.db.withTransaction(() => {
                this.db.markIntent(existingHandle!.intentId, "closed");
                this.db.setActiveIntent(taskId, null);
            });
            existingHandle = undefined;
        }
        if (original.codexRuntime === "droplet" && existingHandle?.sshHost && !original.workspaceSync) {
            this.workspaceState(taskId, { owner: "remote", state: "idle" });
            original = this.db.getTask(taskId)!;
        }
        if (original.workspaceSync?.owner === "remote" && existingHandle) {
            await provider.stop(original, existingHandle);
            if (this.db.getTask(taskId)?.status === "destroying") throw new Error("task is being deleted");
            await this.collectFinal(original, existingHandle);
            original = this.db.getTask(taskId)!;
        }
        const start = async (task: CodexTask, handle: RunnerHandle) => {
            if (this.db.getTask(taskId)?.status === "destroying") throw new Error("task is being deleted");
            if (task.codexRuntime === "droplet") this.workspaceState(taskId, { owner: "host", state: "uploading", error: undefined });
            await provider.start(this.db.getTask(taskId)!, handle, updated => this.persistHandle(taskId, updated));
            if (fingerprint) handle.permissionsFingerprint = fingerprint;
            this.persistHandle(taskId, handle);
            if (task.codexRuntime === "droplet" && handle.sshHost) {
                this.workspaceState(taskId, { owner: "remote", state: "idle", error: undefined });
            } else if (task.codexRuntime === "droplet") {
                this.workspaceState(taskId, { owner: "host", state: "idle" });
            }
            const current = this.db.getTask(taskId)!;
            return current.status === "destroying" ? current : this.markRunnerReadyOrIdle(taskId, handle);
        };
        if (existingHandle) {
            return start(original, existingHandle);
        }

        const plan = provider.describeProvisioning(original);
        const intent = this.db.withTransaction(() => {
            this.db.updateTaskStatus(taskId, "provisioning");
            const refreshed = this.db.getTask(taskId)!;
            return this.db.createIntent(refreshed, plan, this.config.security.reaperGraceSeconds);
        });
        const provisioningTask = this.db.getTask(taskId)!;
        this.emit(provisioningTask, "task.status", { to: "provisioning", intentId: intent.id });

        try {
            const handle = await provider.provision(provisioningTask, intent);
            if (fingerprint) handle.permissionsFingerprint = fingerprint;
            this.persistHandle(taskId, handle);
            const attached = this.db.getTask(taskId)!;
            return await start(attached, handle);
        } catch (error) {
            this.db.withTransaction(() => {
                if (!this.db.getHandleForIntent(intent.id)) this.db.markFailed(intent.id, String(error));
                if (this.db.getTask(taskId)?.status !== "destroying") this.db.updateTaskStatus(taskId, "failed");
                this.db.updateWorkStatus(taskId, "failed");
            });
            const failed = this.db.getTask(taskId)!;
            this.emit(failed, "task.failed", { error: String(error) });
            throw error;
        }
    }

    getHandle(task: CodexTask): RunnerHandle | undefined {
        if (!task.activeProvisioningIntentId) {
            return undefined;
        }
        return this.db.getHandleForIntent(task.activeProvisioningIntentId);
    }

    async stopTask(taskId: string): Promise<CodexTask> {
        await this.cancelSnapshots(taskId);
        let task = this.db.getTask(taskId);
        if (!task) throw new Error("task not found");
        let handle = this.getHandle(task) ?? this.db.getLatestAttachedHandleForTask(taskId);
        if (!handle && task.activeProvisioningIntentId) {
            const intent = this.db.getIntent(task.activeProvisioningIntentId);
            const provider = this.providerFor(task);
            if (intent && provider.recover) {
                handle = await provider.recover(task, intent);
                if (handle) this.db.bindResource(intent.id, handle);
                else this.db.markIntent(intent.id, "closed");
            } else if (intent?.status === "creating") {
                throw new Error("Interrupted provisioning has no confirmed runner handle; resource cleanup must be confirmed before releasing capacity");
            }
        }
        await this.onRunnerClosed(taskId);
        if (this.db.getTask(taskId)?.status === "destroying") return this.db.getTask(taskId)!;
        if (handle) {
            if (task.codexRuntime === "droplet" && handle.sshHost && !task.workspaceSync) {
                this.workspaceState(taskId, { owner: "remote", state: "idle" });
                task = this.db.getTask(taskId)!;
            }
            await this.providerFor(task).stop(task, handle);
            if (this.db.getTask(taskId)?.status === "destroying") return this.db.getTask(taskId)!;
            if (task.codexRuntime === "droplet" && task.workspaceSync?.owner === "remote") {
                this.db.updateTaskStatus(taskId, "collecting");
                await this.collectFinal(task, handle);
            } else if (task.codexRuntime === "droplet") {
                this.workspaceState(taskId, { owner: "host", state: "idle" });
            }
        }
        if (this.db.getTask(taskId)?.status === "destroying") return this.db.getTask(taskId)!;
        this.db.updateTaskStatus(taskId, "idle");
        if (task.workStatus === "running") {
            this.db.updateWorkStatus(taskId, "needs-attention");
        }
        const idle = this.db.getTask(taskId)!;
        this.emit(idle, "task.status", { to: "idle" });
        return idle;
    }

    async destroyTask(taskId: string): Promise<{ ok: true; id: string }> {
        const task = this.db.getTask(taskId);
        if (!task) throw new Error("task not found");
        const taskRoot = this.safeTaskRoot(task);
        this.db.updateTaskStatus(taskId, "destroying");
        try {
            await this.cancelTransfers(taskId);
            let handle = this.getHandle(task) ?? this.db.getLatestAttachedHandleForTask(taskId);
            if (!handle && task.activeProvisioningIntentId) {
                const intent = this.db.getIntent(task.activeProvisioningIntentId);
                const provider = this.providerFor(task);
                if (intent && provider.recover) {
                    handle = await provider.recover(task, intent);
                    if (handle) this.persistHandle(taskId, handle);
                    else this.db.markIntent(intent.id, "closed");
                } else if (intent && ["creating", "abandoned"].includes(intent.status)) {
                    throw new Error("Interrupted provisioning requires confirmed resource recovery before deleting task records");
                }
            }
            await this.onRunnerClosed(taskId, { suppressExitLog: true });
            if (handle) {
                await this.providerFor(task).destroy(task, handle);
                this.db.markIntent(handle.intentId, "closed");
            }
            fs.rmSync(taskRoot, { recursive: true, force: true });
            this.db.deleteTask(taskId);
            return { ok: true, id: taskId };
        } catch (error) {
            if (this.db.getTask(taskId)) {
                this.db.updateTaskStatus(taskId, task.status);
            }
            throw error;
        }
    }

    private safeTaskRoot(task: CodexTask): string {
        const taskRoot = path.dirname(task.storagePath);
        if (path.basename(taskRoot) !== task.id) {
            throw new Error("refusing to delete task root with unexpected name");
        }
        const cacheRoot = resolveFromRepoRoot(this.config.paths.cacheDir);
        const cacheReal = fs.realpathSync(cacheRoot);
        const resolvedRoot = path.resolve(taskRoot);
        const rootForCheck = fs.existsSync(taskRoot) ? fs.realpathSync(taskRoot) : resolvedRoot;
        const relative = path.relative(cacheReal, rootForCheck);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
            throw new Error("refusing to delete task root outside cache directory");
        }
        if (fs.existsSync(taskRoot)) {
            const stat = fs.lstatSync(taskRoot);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
                throw new Error("refusing to delete invalid task root");
            }
        }
        return taskRoot;
    }
}
