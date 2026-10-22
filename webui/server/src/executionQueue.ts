import fs from "node:fs";
import type { WebuiDatabase } from "./db.js";
import type { Scheduler } from "./scheduler.js";
import type { CodexTask, WebuiConfig, WorkStatus } from "./types.js";
import { LocalResources } from "./localResources.js";

type Execution = { id: number; task_id: string; prompt: string; state: string };
type Job = { cancelled: boolean; destroying?: boolean; provisioning?: Promise<CodexTask>; finishing?: Promise<void> };

export function resultStatus(finalText: string | void): WorkStatus {
    if (!finalText) return "needs-attention";
    try {
        const text = finalText.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1");
        const result = JSON.parse(text);
        return result?.outcome === "solved" && typeof result.summary === "string" && result.summary.trim()
            && typeof result.flag === "string" && result.flag.trim() ? "done" : "needs-attention";
    } catch { return "needs-attention"; }
}

export class ExecutionQueue {
    private jobs = new Map<number, Job>();
    private scheduled = false;
    private closed = false;
    private recovering = true;
    private rerun = false;
    private timer?: ReturnType<typeof setInterval>;
    private local: LocalResources;
    private dispatching?: Promise<void>;

    constructor(private db: WebuiDatabase, private scheduler: Scheduler, private config: WebuiConfig,
        private run: (task: CodexTask, prompt: string, isCurrent: () => boolean) => Promise<string | void>) {
        this.local = new LocalResources(db, config, scheduler.localProvider(), task => scheduler.getHandle(task));
    }

    status() {
        const status = this.local.status();
        return this.recovering ? { ...status, state: "recovering" as const, reason: "Recovering interrupted executions before admission" } : status;
    }

    private open(taskId: string): Execution | undefined {
        return this.db.db.prepare("SELECT * FROM executions WHERE task_id = ? AND state != 'terminal'").get(taskId) as Execution | undefined;
    }

    enqueue(taskId: string, prompt?: string): CodexTask {
        if (this.closed) throw new Error("execution queue is shutting down");
        const task = this.db.getTask(taskId);
        if (!task) throw new Error("task not found");
        if (this.open(taskId)) {
            if (prompt !== undefined) throw new Error("task already has a pending or active execution");
            return task;
        }
        if (task.status === "destroying") throw new Error("task is being deleted");
        const input = prompt ?? fs.readFileSync(task.initialPromptPath, "utf8");
        this.db.withTransaction(() => {
            this.db.db.prepare("INSERT INTO executions(task_id, prompt, state) VALUES (?, ?, 'pending')").run(taskId, input);
            this.db.updateTaskStatus(taskId, "queued");
            this.db.updateWorkStatus(taskId, "not-started");
        });
        const queued = this.db.getTask(taskId)!;
        this.scheduler.emit(queued, "task.queued");
        this.wake();
        return queued;
    }

    private wake(): void {
        if (this.closed || this.recovering) return;
        this.dispatchOtherBackends();
        if (this.scheduled) { this.rerun = true; return; }
        this.scheduled = true;
        setImmediate(() => {
            this.dispatching = this.dispatch().catch(error => {
                for (const [id, job] of this.jobs) {
                    const execution = this.db.db.prepare("SELECT state FROM executions WHERE id=?").get(id) as { state: string } | undefined;
                    if (execution?.state === "pending" && !job.cancelled) this.jobs.delete(id);
                }
                const task = this.db.listTasks().find(task => task.status === "queued");
                if (task) this.scheduler.emit(task, "scheduler.failed", { error: String(error) });
            }).finally(() => {
                this.scheduled = false;
                this.dispatching = undefined;
                if (this.rerun) { this.rerun = false; this.wake(); }
            });
        });
    }

    private dispatchOtherBackends(): void {
        // Keep these synchronous admissions independent of in-flight Docker telemetry/updates.
        const pending = this.db.db.prepare(`SELECT e.* FROM executions e JOIN tasks t ON t.id=e.task_id
            WHERE e.state='pending' AND (t.backend!='local' OR t.codex_runtime='host') ORDER BY e.id`).all() as Execution[];
        for (const execution of pending) {
            const task = this.db.getTask(execution.task_id);
            if (!task || task.status === "destroying" || this.jobs.has(execution.id)) continue;
            const admitted = this.db.withTransaction(() => {
                const active = this.db.db.prepare(`SELECT COUNT(*) AS n FROM executions e JOIN tasks t ON t.id=e.task_id
                    WHERE e.state='active' AND t.backend=? AND t.codex_runtime!='host'`).get(task.backend) as { n: number };
                if (task.codexRuntime !== "host" && active.n >= this.config.cloud.maxConcurrent) return false;
                return this.db.db.prepare("UPDATE executions SET state='active' WHERE id=? AND state='pending'").run(execution.id).changes === 1;
            });
            if (!admitted) continue;
            const job: Job = { cancelled: false };
            this.jobs.set(execution.id, job);
            void this.execute(execution, job).catch(() => { /* Cleanup errors are persisted on the task. */ });
        }
    }

    private async dispatch(): Promise<void> {
        if (this.closed) return;
        await this.local.refresh();
        const executions = this.db.db.prepare(`SELECT e.* FROM executions e JOIN tasks t ON t.id=e.task_id
            WHERE e.state='pending' AND t.backend='local' AND t.codex_runtime!='host' ORDER BY e.id`).all() as Execution[];
        for (const execution of executions) {
            if (this.closed) return;
            const task = this.db.getTask(execution.task_id);
            if (!task || task.status === "destroying" || this.jobs.has(execution.id)) continue;
            // Stop/Destroy must see this same job while admission awaits Docker updates.
            const job: Job = { cancelled: false };
            this.jobs.set(execution.id, job);
            const admitted = await this.local.admit(execution.id, task);
            if (!admitted) {
                if (!job.cancelled) this.jobs.delete(execution.id);
                break;
            }
            if (job.cancelled || this.closed) {
                job.cancelled = true;
                if (!job.destroying) await this.finish(execution, job, "needs-attention");
                continue;
            }
            void this.execute(execution, job).catch(() => { /* Cleanup errors are persisted on the task. */ });
        }
    }

    private async execute(execution: Execution, job: Job): Promise<void> {
        let status: WorkStatus = "needs-attention";
        try {
            job.provisioning = this.scheduler.startTask(execution.task_id);
            const task = await job.provisioning;
            if (job.cancelled) return;
            if (task.codexRuntime !== "host" && task.status !== "running") {
                this.scheduler.emit(task, "execution.not_ready", { message: "Runner is not live; Codex was not called" });
            } else {
                this.db.updateTaskStatus(task.id, "running");
                this.db.updateWorkStatus(task.id, "running");
                if (task.codexRuntime === "droplet") this.db.mergeProviderState(task.id, { lastTurnExitCode: undefined });
                this.scheduler.emit(task, "execution.started", { executionId: execution.id });
                this.scheduler.startSnapshots(task.id);
                status = resultStatus(await this.run(task, execution.prompt, () => !job.cancelled && this.open(task.id)?.id === execution.id));
            }
        } catch (error) {
            status = "failed";
            const task = this.db.getTask(execution.task_id);
            if (task && !job.cancelled) {
                const event = this.scheduler.emit(task, "execution.failed", { error: String(error), executionId: execution.id });
                this.db.db.prepare("UPDATE executions SET error=? WHERE id=?").run(String(event.error), execution.id);
            }
        }
        if (!job.cancelled) await this.finish(execution, job, status);
    }

    private finish(execution: Execution, job: Job, status: WorkStatus): Promise<void> {
        if (job.finishing) return job.finishing;
        this.db.mergeProviderState(execution.task_id, { pendingCompletion: { executionId: execution.id, workStatus: status } });
        job.finishing = (async () => {
            try {
                await this.scheduler.stopTask(execution.task_id);
                if (job.destroying) return;
                const completed = this.db.getTask(execution.task_id);
                if (completed?.codexRuntime === "droplet") this.scheduler.refreshContext(completed, execution.prompt, job.cancelled ? 130 : status === "failed" ? 1 : 0);
                this.db.updateWorkStatus(execution.task_id, status);
                this.db.mergeProviderState(execution.task_id, { pendingCompletion: undefined });
                this.db.db.prepare("UPDATE executions SET state='terminal', error=CASE WHEN ?='failed' THEN error ELSE NULL END WHERE id=?").run(status, execution.id);
                const task = this.db.getTask(execution.task_id);
                if (task) {
                    if (job.cancelled) this.scheduler.emit(task, "codex.session.closed");
                    this.scheduler.emit(task, "execution.completed", { executionId: execution.id, workStatus: status });
                }
                this.jobs.delete(execution.id);
                this.wake();
            } catch (error) {
                if (job.destroying) throw error;
                const task = this.db.getTask(execution.task_id);
                if (task) {
                    this.db.updateTaskStatus(task.id, "running");
                    this.db.updateWorkStatus(task.id, "needs-attention");
                    const event = this.scheduler.emit(task, "execution.cleanup_failed", { error: String(error), message: "Runner cleanup failed. Retry Stop to release capacity." });
                    this.db.db.prepare("UPDATE executions SET error=? WHERE id=?").run(`Retry Stop to release capacity: ${String(event.error)}`, execution.id);
                }
                throw error;
            }
        })();
        void job.finishing.catch(() => { job.finishing = undefined; });
        return job.finishing;
    }

    async stop(taskId: string, status: WorkStatus = "needs-attention"): Promise<CodexTask> {
        const execution = this.open(taskId);
        if (execution) {
            const job = this.jobs.get(execution.id) ?? { cancelled: false };
            this.jobs.set(execution.id, job);
            job.cancelled = true;
            await job.provisioning?.catch(() => undefined);
            const completion = this.db.getTask(taskId)?.providerState?.pendingCompletion as { executionId?: number; workStatus?: WorkStatus } | undefined;
            const result = status === "needs-attention" && completion?.executionId === execution.id && completion.workStatus ? completion.workStatus : status;
            await this.finish(execution, job, result);
            status = result;
        } else {
            await this.scheduler.stopTask(taskId);
        }
        this.db.updateWorkStatus(taskId, status);
        this.wake();
        return this.db.getTask(taskId)!;
    }

    async destroy(taskId: string): Promise<{ ok: true; id: string }> {
        const task = this.db.getTask(taskId);
        if (!task) throw new Error("task not found");
        this.db.updateTaskStatus(taskId, "destroying");
        const execution = this.open(taskId);
        const job = execution ? this.jobs.get(execution.id) ?? { cancelled: false } : undefined;
        if (job) {
            job.cancelled = true;
            job.destroying = true;
            this.jobs.set(execution!.id, job);
        }
        try {
            await this.scheduler.cancelTransfers(taskId);
            await job?.provisioning?.catch(() => undefined);
            await this.scheduler.cancelTransfers(taskId);
            await job?.finishing?.catch(() => undefined);
            const result = await this.scheduler.destroyTask(taskId);
            if (execution) this.jobs.delete(execution.id);
            this.wake();
            return result;
        } catch (error) {
            if (job) {
                job.destroying = false;
                job.finishing = undefined;
            }
            if (this.db.getTask(taskId)) this.db.updateTaskStatus(taskId, task.status);
            throw error;
        }
    }

    async recover(): Promise<void> {
        for (const task of this.db.listTasks()) this.scheduler.recoverWorkspaceOwnership(task);
        for (const execution of this.db.db.prepare("SELECT * FROM executions WHERE state='active'").all() as Execution[]) {
            await this.stop(execution.task_id).catch(() => undefined);
        }
        for (const task of this.db.listTasks().reverse()) {
            if (this.open(task.id)) continue;
            if (task.status === "queued") this.enqueue(task.id);
            else if (["running", "provisioning", "collecting"].includes(task.status) || task.workspaceSync?.owner === "remote") {
                // Reserve capacity before attempting cleanup of pre-queue executions.
                this.db.db.prepare("INSERT INTO executions(task_id,prompt,state) VALUES (?, '', 'active')").run(task.id);
                await this.stop(task.id).catch(() => undefined);
            }
        }
        for (const task of this.db.listTasks()) {
            this.scheduler.cleanupSnapshots(task);
            if (["running", "provisioning", "collecting", "destroying"].includes(task.status)) continue;
            try { this.scheduler.reconcilePermissions(task.id); }
            catch (error) { this.scheduler.emit(task, "permissions.invalid", { error: String(error) }); }
        }
        this.recovering = false;
        this.timer = setInterval(() => this.wake(), 5_000);
        this.timer.unref();
        this.wake();
    }

    async close(): Promise<void> {
        this.closed = true;
        clearInterval(this.timer);
        await this.dispatching;
        for (const execution of this.db.db.prepare("SELECT * FROM executions WHERE state='active'").all() as Execution[]) {
            await this.stop(execution.task_id).catch(() => undefined);
        }
    }
}
