import type { WebuiDatabase } from "./db.js";
import type { RunnerProvider } from "./providers/Provider.js";
import type { CodexTask, RunnerHandle, SchedulerStatus, WebuiConfig } from "./types.js";

const SAMPLE_MS = 5_000;
const WINDOW_MS = 30_000;
const STALE_MS = 12_000;
const EPSILON = 0.00001;
type Reservation = { id: number; task_id: string; cpu: number | null; memory_mb: number | null; error: string | null; resource_error: string | null };
type Usage = { cpu: number; memoryMb: number };

/** Local admission and CPU controls share the durable active-execution reservations. */
export class LocalResources {
    private capacity?: { cpuCount: number; memoryMb: number };
    private sampledAt?: number;
    private attemptedAt?: number;
    private attemptedWorkers?: string;
    private healthySince?: number;
    private lastAdmission?: number;
    private failure?: string;
    private samples = new Map<string, Array<{ at: number; cpu: number }>>();
    private usage = new Map<string, Usage>();

    constructor(private db: WebuiDatabase, private config: WebuiConfig, private provider: RunnerProvider | undefined,
        private handleFor: (task: CodexTask) => RunnerHandle | undefined, private now = Date.now) {}

    private get cpuBudget(): number { return this.config.local.cpuBudget ?? this.config.local.concurrency * this.config.local.defaultCpu; }
    private get memoryBudget(): number { return this.config.local.memoryBudgetMb ?? this.config.local.concurrency * this.config.local.defaultMemoryMb; }
    private get cpuCapacity(): number { return Math.min(this.cpuBudget, this.capacity?.cpuCount ?? this.cpuBudget); }
    private get floor(): number { return Math.min(0.25, this.cpuCapacity / this.config.local.concurrency); }
    private get memoryCapacity(): number | undefined {
        return this.capacity && Math.max(0, Math.min(this.memoryBudget, this.capacity.memoryMb - 1024));
    }
    private active(): Reservation[] {
        return this.db.db.prepare(`SELECT e.* FROM executions e JOIN tasks t ON t.id=e.task_id
            WHERE e.state='active' AND t.backend='local' AND t.codex_runtime!='host' ORDER BY e.id`).all() as Reservation[];
    }
    private demand(row: Reservation): number {
        const history = (this.samples.get(row.task_id) ?? []).filter(sample => sample.at >= this.now() - WINDOW_MS);
        return Math.max(this.floor, history.length ? Math.max(...history.map(sample => sample.cpu)) * 1.25 : row.cpu ?? this.config.local.defaultCpu);
    }
    private blocked(rows = this.active()): string | undefined {
        if (!this.config.local.enabled) return "Local Docker execution is disabled";
        if (rows.some(row => row.error)) return "Worker cleanup is pending; retry Stop to release its reservation";
        if (this.failure) return this.failure;
        if (!this.capacity || this.sampledAt === undefined) return "Waiting for Docker resource telemetry";
        if (this.now() - this.sampledAt > STALE_MS) return "Docker resource telemetry is stale; admissions are paused";
        if (rows.some(row => row.resource_error)) return "A worker resource update is unconfirmed; admissions are paused";
        if (rows.some(row => row.cpu == null || row.memory_mb == null)) return "Recovering an unconfirmed resource reservation";
        if (rows.some(row => {
            const task = this.db.getTask(row.task_id)!;
            return task.status !== "running" || task.providerState?.pendingCompletion;
        })) return "Waiting for worker provisioning or cleanup to finish";
        return undefined;
    }
    private waitingReason(rows = this.active()): string | undefined {
        const blocked = this.blocked(rows);
        if (blocked) return blocked;
        if (rows.length >= this.config.local.concurrency) return "Worker limit reached";
        const reserved = rows.reduce((sum, row) => sum + (row.memory_mb ?? 0), 0);
        if (reserved + this.config.local.defaultMemoryMb > this.memoryCapacity!) {
            return `Waiting for ${this.config.local.defaultMemoryMb} MB RAM; ${Math.max(0, Math.floor(this.memoryCapacity! - reserved))} MB is unreserved`;
        }
        if (rows.length && rows.reduce((sum, row) => sum + this.demand(row), 0) + this.floor > this.cpuCapacity + EPSILON) {
            return "Observing spare CPU capacity; existing worker demand takes priority";
        }
        if (rows.length && (this.healthySince === undefined || this.now() - this.healthySince < WINDOW_MS
            || this.lastAdmission !== undefined && this.now() - this.lastAdmission < WINDOW_MS)) {
            return "Observing sustained spare CPU capacity before starting another worker";
        }
        return undefined;
    }

    async refresh(): Promise<void> {
        const now = this.now();
        const workers = this.active().map(row => {
            const task = this.db.getTask(row.task_id)!;
            return `${row.id}:${task.status}:${Boolean(task.providerState?.pendingCompletion)}`;
        }).join(",");
        if (this.attemptedAt !== undefined && now - this.attemptedAt < SAMPLE_MS && workers === this.attemptedWorkers) return;
        this.attemptedAt = now;
        this.attemptedWorkers = workers;
        if (!this.provider?.getCapacity || !this.provider.getUsage || !this.provider.setResources) {
            this.failure = "Local provider does not support resource monitoring and controls";
            this.healthySince = undefined;
            return;
        }
        try {
            const capacity = await this.provider.getCapacity();
            if (!Number.isFinite(capacity.cpuCount) || capacity.cpuCount <= 0 || !Number.isFinite(capacity.memoryMb) || capacity.memoryMb <= 0) {
                throw new Error("Invalid Docker capacity");
            }
            this.capacity = capacity;
            const allRows = this.active();
            // Other workers continue adapting while provisioning and cleanup retain their fixed reservations.
            const rows = allRows.filter(row => {
                const task = this.db.getTask(row.task_id)!;
                return task.status === "running" && !task.providerState?.pendingCompletion;
            });
            const frozen = allRows.filter(row => !rows.includes(row));
            if (frozen.some(row => row.cpu == null)) throw new Error("Unconfirmed provisioning CPU reservation");
            const controlBudget = this.cpuCapacity - frozen.reduce((sum, row) => sum + row.cpu!, 0);
            if (controlBudget + EPSILON < rows.length * this.floor) throw new Error("Frozen workers retain the CPU budget");
            const tasks = rows.map(row => this.db.getTask(row.task_id)!);
            const handles = tasks.map(task => this.handleFor(task));
            if (handles.some(handle => !handle)) throw new Error("Worker handle is not confirmed");
            const readings = rows.length ? await this.provider.getUsage(handles as RunnerHandle[]) : [];
            const current = this.active();
            // Completion can race a Docker read; use a fresh snapshot on the next tick.
            if (current.length !== allRows.length || current.some((row, i) => row.id !== allRows[i].id)) {
                this.healthySince = undefined;
                return;
            }
            const usage = new Map<string, Usage>();
            for (const row of rows) {
                if (row.resource_error?.startsWith("Worker RAM")) throw new Error("Worker RAM mismatch requires Stop");
                const reading = readings.find(value => value.taskId === row.task_id);
                if (!reading?.running || !Number.isFinite(reading.cpu) || reading.cpu < 0 || !Number.isFinite(reading.memoryMb) || reading.memoryMb < 0
                    || !Number.isFinite(reading.cpuLimit) || reading.cpuLimit <= 0 || !Number.isFinite(reading.memoryLimitMb) || reading.memoryLimitMb <= 0) {
                    throw new Error("Incomplete Docker telemetry");
                }
                if (reading.memoryLimitMb !== row.memory_mb) {
                    this.db.db.prepare("UPDATE executions SET memory_mb=?, resource_error=? WHERE id=? AND state='active'")
                        .run(Math.max(row.memory_mb ?? 0, reading.memoryLimitMb), "Worker RAM limit does not match its reservation", row.id);
                    throw new Error("Worker RAM limit mismatch");
                }
                // An inspected limit resolves an earlier uncertain CPU update; RAM reservations never shrink here.
                this.db.db.prepare("UPDATE executions SET cpu=?,resource_error=NULL WHERE id=? AND state='active'").run(reading.cpuLimit, row.id);
                row.cpu = reading.cpuLimit;
                usage.set(row.task_id, { cpu: reading.cpu, memoryMb: reading.memoryMb });
                const history = (this.samples.get(row.task_id) ?? []).filter(sample => sample.at >= now - WINDOW_MS);
                history.push({ at: now, cpu: reading.cpu });
                this.samples.set(row.task_id, history);
            }
            for (const id of this.samples.keys()) if (!usage.has(id)) this.samples.delete(id);
            const previousSample = this.sampledAt;
            this.sampledAt = now;
            this.usage = usage;
            this.failure = undefined;
            await this.allocate(rows, undefined, controlBudget);
            const allocated = this.active();
            const spare = !frozen.length && [...usage.values()].reduce((sum, value) => sum + value.cpu, 0) < this.cpuCapacity * 0.7
                && allocated.every(row => this.demand(row) <= (row.cpu ?? 0) + EPSILON);
            if (!rows.length || !spare || previousSample === undefined || now - previousSample > STALE_MS) this.healthySince = undefined;
            if (rows.length && spare) this.healthySince ??= now;
        } catch {
            this.failure = "Docker resource monitoring or limit update failed; admissions are paused until verified";
            this.healthySince = undefined;
        }
    }

    private async allocate(rows: Reservation[], seed?: number, budget = this.cpuCapacity): Promise<void> {
        const demands = rows.map(row => this.demand(row));
        if (seed !== undefined) demands.push(seed);
        const floorTotal = demands.length * this.floor;
        const excess = demands.reduce((sum, demand) => sum + Math.max(0, demand - this.floor), 0);
        const scale = excess ? Math.min(1, Math.max(0, budget - floorTotal) / excess) : 1;
        const allocations = demands.map(demand => Math.floor((this.floor + Math.max(0, demand - this.floor) * scale) * 100_000) / 100_000);
        // The seed is a temporary warmup allocation, included before applying the existing workers' caps.
        this.seedCpu = seed === undefined ? undefined : allocations.pop();
        const updates = rows.map((row, i) => ({ row, cpu: allocations[i] })).filter(({ row, cpu }) => Math.abs(cpu - (row.cpu ?? 0)) > EPSILON)
            .sort((a, b) => (a.cpu - (a.row.cpu ?? 0)) - (b.cpu - (b.row.cpu ?? 0)));
        for (const { row, cpu } of updates) {
            const task = this.db.getTask(row.task_id);
            if (!task || !this.active().some(active => active.id === row.id)) continue;
            const handle = this.handleFor(task);
            if (!handle || task.status !== "running" || task.providerState?.pendingCompletion) throw new Error("Worker lifecycle changed during allocation");
            this.db.db.prepare("UPDATE executions SET cpu=?,resource_error=? WHERE id=? AND state='active'")
                .run(Math.max(row.cpu ?? 0, cpu), "CPU update awaiting verification", row.id);
            await this.provider!.setResources!(task, handle, { cpu, memoryMb: row.memory_mb! });
            this.db.db.prepare("UPDATE executions SET cpu=?,resource_error=NULL WHERE id=? AND state='active'").run(cpu, row.id);
            row.cpu = cpu;
        }
    }
    private seedCpu?: number;

    async admit(executionId: number, task: CodexTask): Promise<boolean> {
        const rows = this.active();
        if (this.waitingReason(rows)) return false;
        try {
            const available = this.cpuCapacity - rows.reduce((sum, row) => sum + this.demand(row), 0);
            await this.allocate(rows, Math.min(available, Math.max(this.floor, this.config.local.defaultCpu)));
            const admitted = this.db.withTransaction(() => {
                const active = this.active();
                if (this.waitingReason(active)) return false;
                const cpu = this.seedCpu!;
                if (active.reduce((sum, row) => sum + (row.cpu ?? 0), 0) + cpu > this.cpuCapacity + EPSILON) return false;
                return this.db.db.prepare("UPDATE executions SET state='active',cpu=?,memory_mb=?,resource_error=NULL WHERE id=? AND task_id=? AND state='pending'")
                    .run(cpu, this.config.local.defaultMemoryMb, executionId, task.id).changes === 1;
            });
            if (admitted) {
                this.lastAdmission = this.now();
                this.healthySince = undefined;
            }
            return admitted;
        } catch {
            this.failure = "Worker CPU update failed; admissions are paused until limits are verified";
            this.healthySince = undefined;
            return false;
        }
    }

    status(): SchedulerStatus {
        const rows = this.active();
        const reason = this.waitingReason(rows);
        const fresh = this.sampledAt !== undefined && this.now() - this.sampledAt <= STALE_MS && !this.failure;
        const observed = fresh && rows.every(row => this.usage.has(row.task_id));
        const waiting = (this.db.db.prepare(`SELECT e.task_id FROM executions e JOIN tasks t ON t.id=e.task_id
            WHERE e.state='pending' AND t.backend='local' AND t.codex_runtime!='host' ORDER BY e.id`).all() as Array<{ task_id: string }>)
            .map(row => ({ taskId: row.task_id, reason: reason ?? "Ready for local admission" }));
        return {
            maxWorkers: this.config.local.concurrency, activeWorkers: rows.length,
            cpuBudget: this.cpuBudget, cpuAllocated: rows.reduce((sum, row) => sum + (row.cpu ?? 0), 0),
            cpuUsage: observed ? rows.reduce((sum, row) => sum + this.usage.get(row.task_id)!.cpu, 0) : undefined,
            memoryBudgetMb: this.memoryBudget, effectiveMemoryMb: this.memoryCapacity,
            memoryReservedMb: rows.reduce((sum, row) => sum + (row.memory_mb ?? 0), 0),
            memoryUsageMb: observed ? rows.reduce((sum, row) => sum + this.usage.get(row.task_id)!.memoryMb, 0) : undefined,
            workerMemoryMb: this.config.local.defaultMemoryMb,
            effectiveMaxWorkers: this.memoryCapacity === undefined ? undefined : Math.min(this.config.local.concurrency, Math.floor(this.memoryCapacity / this.config.local.defaultMemoryMb)),
            state: reason?.startsWith("Observing ") ? "observing" : reason ? "blocked" : "ready",
            reason, sampledAt: this.sampledAt === undefined ? undefined : new Date(this.sampledAt).toISOString(),
            workers: rows.map(row => ({ taskId: row.task_id, cpu: row.cpu ?? 0, memoryMb: row.memory_mb ?? 0,
                cpuUsage: fresh ? this.usage.get(row.task_id)?.cpu : undefined, memoryUsageMb: fresh ? this.usage.get(row.task_id)?.memoryMb : undefined })),
            waiting
        };
    }
}
