import fs from "node:fs";
import path from "node:path";
import type { RunnerProvider } from "./providers/Provider.js";
import { WebuiDatabase } from "./db.js";
import type { CodexTask, RunnerHandle, TaskEvent, WebuiConfig } from "./types.js";
import { EventBus, writeTaskEvent } from "./utils/logs.js";
import type { SecretRedactor } from "./utils/redactor.js";
import { resolveFromRepoRoot } from "./config.js";

export class Scheduler {
    constructor(
        private readonly db: WebuiDatabase,
        private readonly providers: Map<string, RunnerProvider>,
        private readonly config: WebuiConfig,
        private readonly events: EventBus,
        private readonly redactor: SecretRedactor,
        private readonly onRunnerClosed: (taskId: string, options?: { suppressExitLog?: boolean }) => void = () => undefined
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
        const original = this.db.getTask(taskId);
        if (!original) {
            throw new Error("task not found");
        }
        if (original.bridgeMode === "host-codex-broker" || original.codexRuntime === "host") {
            return this.markHostReady(taskId);
        }
        if (["provisioning", "running"].includes(original.status)) {
            return original;
        }
        if (original.backend === "local" && this.db.countActiveLocalTasks(taskId) >= this.config.local.concurrency) {
            this.db.updateTaskStatus(taskId, "queued");
            const queued = this.db.getTask(taskId)!;
            this.emit(queued, "task.queued", { concurrency: this.config.local.concurrency });
            return queued;
        }

        const provider = this.providerFor(original);
        const existingHandle = this.getHandle(original) ?? this.db.getLatestAttachedHandleForTask(taskId);
        if (existingHandle) {
            await provider.start(original, existingHandle);
            this.db.withTransaction(() => {
                this.db.setActiveIntent(taskId, existingHandle.intentId);
                this.db.updateProviderState(taskId, {
                    ...(this.db.getTask(taskId)?.providerState ?? {}),
                    ...(existingHandle as unknown as Record<string, unknown>)
                });
            });
            return this.markRunnerReadyOrIdle(taskId, existingHandle);
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
            this.db.withTransaction(() => {
                this.db.bindResource(intent.id, handle);
                this.db.updateProviderState(taskId, handle as unknown as Record<string, unknown>);
            });
            const attached = this.db.getTask(taskId)!;
            await provider.start(attached, handle);
            this.db.withTransaction(() => {
                this.db.bindResource(intent.id, handle);
                this.db.updateProviderState(taskId, {
                    ...(this.db.getTask(taskId)?.providerState ?? {}),
                    ...(handle as unknown as Record<string, unknown>)
                });
            });
            return this.markRunnerReadyOrIdle(taskId, handle);
        } catch (error) {
            this.db.withTransaction(() => {
                this.db.markFailed(intent.id, String(error));
                this.db.updateTaskStatus(taskId, "failed");
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
        const task = this.db.getTask(taskId);
        if (!task) throw new Error("task not found");
        const handle = this.getHandle(task);
        this.onRunnerClosed(taskId);
        if (handle) {
            await this.providerFor(task).stop(task, handle);
        }
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
            const handle = this.getHandle(task);
            this.onRunnerClosed(taskId, { suppressExitLog: true });
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
