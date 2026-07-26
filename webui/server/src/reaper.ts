import { WebuiDatabase } from "./db.js";
import type { WebuiConfig } from "./types.js";
import type { Scheduler } from "./scheduler.js";

export class Reaper {
    private timer?: NodeJS.Timeout;

    constructor(
        private readonly db: WebuiDatabase,
        private readonly config: WebuiConfig,
        private readonly scheduler: Scheduler
    ) {}

    start(intervalMs = 60_000): void {
        this.timer = setInterval(() => {
            this.runOnce().catch((error) => {
                console.error("reaper error", error);
            });
        }, intervalMs);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
        }
    }

    async runOnce(): Promise<void> {
        const now = Date.now();
        for (const intent of this.db.listOpenIntents()) {
            if (Date.parse(intent.reaperGraceUntil) > now) {
                continue;
            }
            if (intent.status === "creating") {
                this.db.markIntent(intent.id, "abandoned");
                const task = this.db.getTask(intent.taskId);
                if (task) {
                    this.scheduler.emit(task, "reaper.intent.abandoned", { intentId: intent.id });
                }
            }
        }

        for (const task of this.db.listTasks()) {
            if (!["running", "idle"].includes(task.status)) {
                continue;
            }
            const hardDeadline = Date.parse(task.startedAt ?? task.createdAt) + task.hardTtlMinutes * 60_000;
            if (hardDeadline <= now) {
                this.scheduler.emit(task, "reaper.hard_ttl", { hardTtlMinutes: task.hardTtlMinutes });
                await this.scheduler.destroyTask(task.id);
            }
        }
    }
}
