import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveFromRepoRoot } from "./config.js";
import type {
    Backend,
    CodexTask,
    ProvisioningIntent,
    ProvisioningIntentStatus,
    ProvisioningPlan,
    RunnerHandle,
    TaskStatus,
    WorkStatus,
    WebuiConfig
} from "./types.js";

type Row = Record<string, unknown>;

function json(value: unknown): string {
    return JSON.stringify(value ?? null);
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "string" || value.length === 0) {
        return undefined;
    }
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
}

function taskFromRow(row: Row): CodexTask {
    const providerSpec = parseJsonObject(row.provider_spec) ?? {};
    return {
        id: String(row.id),
        name: String(row.name),
        backend: row.backend as Backend,
        status: row.status as TaskStatus,
        workStatus: row.work_status as WorkStatus,
        createdAt: String(row.created_at),
        startedAt: row.started_at ? String(row.started_at) : undefined,
        finishedAt: row.finished_at ? String(row.finished_at) : undefined,
        initialPromptPath: String(row.initial_prompt_path),
        storagePath: String(row.storage_path),
        controlPath: String(row.control_path),
        codexHomePath: String(row.codex_home_path),
        logsPath: String(row.logs_path),
        outputPath: String(row.output_path),
        providerSpec,
        providerState: parseJsonObject(row.provider_state),
        activeProvisioningIntentId: row.active_provisioning_intent_id ? String(row.active_provisioning_intent_id) : undefined,
        idleTtlMinutes: Number(row.idle_ttl_minutes),
        hardTtlMinutes: Number(row.hard_ttl_minutes),
        localConcurrencySlot: row.local_concurrency_slot === null || row.local_concurrency_slot === undefined ? undefined : Number(row.local_concurrency_slot),
        credentialMode: row.credential_mode as CodexTask["credentialMode"],
        codexHomeRetention: row.codex_home_retention as CodexTask["codexHomeRetention"],
        codexRuntime: row.codex_runtime as CodexTask["codexRuntime"],
        bridgeMode: row.bridge_mode as CodexTask["bridgeMode"],
        networkMode: row.network_mode as CodexTask["networkMode"],
        networkEnforcement: row.network_enforcement as CodexTask["networkEnforcement"],
        codexSettings: providerSpec.codexSettings as CodexTask["codexSettings"]
    };
}

function intentFromRow(row: Row): ProvisioningIntent {
    return {
        id: String(row.id),
        taskId: String(row.task_id),
        backend: row.backend as Backend,
        expectedResourceName: String(row.expected_resource_name),
        createdAt: String(row.created_at),
        reaperGraceUntil: String(row.reaper_grace_until),
        status: row.status as ProvisioningIntentStatus
    };
}

export class WebuiDatabase {
    readonly db: DatabaseSync;
    readonly dbPath: string;

    constructor(config: WebuiConfig) {
        this.dbPath = resolveFromRepoRoot(config.sqlite.path);
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        this.db = new DatabaseSync(this.dbPath);
        this.db.exec(`PRAGMA busy_timeout = ${config.sqlite.busyTimeoutMs}`);
        this.db.exec("PRAGMA foreign_keys = ON");
        if (config.sqlite.wal) {
            this.db.exec("PRAGMA journal_mode = WAL");
        }
        this.migrate();
    }

    migrate(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                backend TEXT NOT NULL,
                status TEXT NOT NULL,
                work_status TEXT NOT NULL DEFAULT 'not-started',
                created_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT,
                initial_prompt_path TEXT NOT NULL,
                storage_path TEXT NOT NULL,
                control_path TEXT NOT NULL,
                codex_home_path TEXT NOT NULL,
                logs_path TEXT NOT NULL,
                output_path TEXT NOT NULL,
                provider_spec TEXT NOT NULL,
                provider_state TEXT,
                active_provisioning_intent_id TEXT,
                idle_ttl_minutes INTEGER NOT NULL,
                hard_ttl_minutes INTEGER NOT NULL,
                local_concurrency_slot INTEGER,
                credential_mode TEXT NOT NULL,
                codex_home_retention TEXT NOT NULL,
                codex_runtime TEXT NOT NULL,
                bridge_mode TEXT NOT NULL,
                network_mode TEXT NOT NULL,
                network_enforcement TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS provisioning_intents (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                backend TEXT NOT NULL,
                expected_resource_name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                reaper_grace_until TEXT NOT NULL,
                status TEXT NOT NULL,
                plan_json TEXT NOT NULL,
                handle_json TEXT
            );
        `);
        const taskColumns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
        if (!taskColumns.some((column) => column.name === "work_status")) {
            this.db.exec("ALTER TABLE tasks ADD COLUMN work_status TEXT NOT NULL DEFAULT 'not-started'");
        }
        this.db.exec(`
            UPDATE tasks
            SET work_status = 'running'
            WHERE status IN ('queued', 'provisioning', 'running') AND work_status = 'not-started';

            UPDATE tasks
            SET work_status = 'failed'
            WHERE status = 'failed' AND work_status = 'not-started';
        `);
    }

    withTransaction<T>(fn: () => T): T {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = fn();
            this.db.exec("COMMIT");
            return result;
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }

    insertTask(task: CodexTask): void {
        this.db.prepare(`
            INSERT INTO tasks (
                id, name, backend, status, work_status, created_at, started_at, finished_at,
                initial_prompt_path, storage_path, control_path, codex_home_path,
                logs_path, output_path, provider_spec, provider_state,
                active_provisioning_intent_id, idle_ttl_minutes, hard_ttl_minutes,
                local_concurrency_slot, credential_mode, codex_home_retention,
                codex_runtime, bridge_mode, network_mode, network_enforcement
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            task.id,
            task.name,
            task.backend,
            task.status,
            task.workStatus,
            task.createdAt,
            task.startedAt ?? null,
            task.finishedAt ?? null,
            task.initialPromptPath,
            task.storagePath,
            task.controlPath,
            task.codexHomePath,
            task.logsPath,
            task.outputPath,
            json(task.providerSpec),
            task.providerState ? json(task.providerState) : null,
            task.activeProvisioningIntentId ?? null,
            task.idleTtlMinutes,
            task.hardTtlMinutes,
            task.localConcurrencySlot ?? null,
            task.credentialMode,
            task.codexHomeRetention,
            task.codexRuntime,
            task.bridgeMode,
            task.networkMode,
            task.networkEnforcement
        );
    }

    listTasks(): CodexTask[] {
        return this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC").all().map((row) => taskFromRow(row as Row));
    }

    getTask(id: string): CodexTask | undefined {
        const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
        return row ? taskFromRow(row) : undefined;
    }

    deleteTask(id: string): void {
        this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    }

    updateTaskStatus(id: string, status: TaskStatus): void {
        const now = new Date().toISOString();
        const startedAt = status === "running" ? ", started_at = COALESCE(started_at, ?)" : "";
        const finishedAt = ["finished", "failed"].includes(status) ? ", finished_at = ?" : ", finished_at = NULL";
        const args: unknown[] = [status];
        if (status === "running") args.push(now);
        if (["finished", "failed"].includes(status)) args.push(now);
        args.push(id);
        this.db.prepare(`UPDATE tasks SET status = ?${startedAt}${finishedAt} WHERE id = ?`).run(...(args as string[]));
    }

    updateWorkStatus(id: string, status: WorkStatus): void {
        this.db.prepare("UPDATE tasks SET work_status = ? WHERE id = ?").run(status, id);
    }

    updateProviderState(taskId: string, state: Record<string, unknown> | undefined): void {
        this.db.prepare("UPDATE tasks SET provider_state = ? WHERE id = ?").run(state ? json(state) : null, taskId);
    }

    mergeProviderState(taskId: string, state: Record<string, unknown>): void {
        const task = this.getTask(taskId);
        if (!task) {
            throw new Error("task not found");
        }
        this.updateProviderState(taskId, {
            ...(task.providerState ?? {}),
            ...state
        });
    }

    setActiveIntent(taskId: string, intentId: string | null): void {
        this.db.prepare("UPDATE tasks SET active_provisioning_intent_id = ? WHERE id = ?").run(intentId, taskId);
    }

    countActiveLocalTasks(excludeTaskId?: string): number {
        const row = excludeTaskId
            ? this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE backend = 'local' AND status IN ('provisioning', 'running') AND id != ?").get(excludeTaskId) as Row
            : this.db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE backend = 'local' AND status IN ('provisioning', 'running')").get() as Row;
        return Number(row.count);
    }

    createIntent(task: CodexTask, plan: ProvisioningPlan, graceSeconds: number): ProvisioningIntent {
        const now = new Date();
        const intent: ProvisioningIntent = {
            id: crypto.randomUUID(),
            taskId: task.id,
            backend: task.backend,
            expectedResourceName: plan.expectedResourceName,
            createdAt: now.toISOString(),
            reaperGraceUntil: new Date(now.getTime() + graceSeconds * 1000).toISOString(),
            status: "creating"
        };
        this.db.prepare(`
            INSERT INTO provisioning_intents (
                id, task_id, backend, expected_resource_name, created_at,
                reaper_grace_until, status, plan_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(intent.id, intent.taskId, intent.backend, intent.expectedResourceName, intent.createdAt, intent.reaperGraceUntil, intent.status, json(plan));
        this.setActiveIntent(task.id, intent.id);
        return intent;
    }

    bindResource(intentId: string, handle: RunnerHandle): void {
        this.db.prepare("UPDATE provisioning_intents SET status = 'attached', handle_json = ? WHERE id = ?").run(json(handle), intentId);
    }

    markIntent(intentId: string, status: ProvisioningIntentStatus): void {
        this.db.prepare("UPDATE provisioning_intents SET status = ? WHERE id = ?").run(status, intentId);
    }

    markFailed(intentId: string, error: string): void {
        this.db.prepare("UPDATE provisioning_intents SET status = 'failed', handle_json = ? WHERE id = ?").run(json({ error }), intentId);
    }

    getIntent(id: string): ProvisioningIntent | undefined {
        const row = this.db.prepare("SELECT * FROM provisioning_intents WHERE id = ?").get(id) as Row | undefined;
        return row ? intentFromRow(row) : undefined;
    }

    listOpenIntents(): ProvisioningIntent[] {
        return this.db.prepare("SELECT * FROM provisioning_intents WHERE status IN ('creating', 'attached')").all().map((row) => intentFromRow(row as Row));
    }

    getHandleForIntent(intentId: string): RunnerHandle | undefined {
        const row = this.db.prepare("SELECT handle_json FROM provisioning_intents WHERE id = ? AND status = 'attached'").get(intentId) as Row | undefined;
        return parseJsonObject(row?.handle_json) as RunnerHandle | undefined;
    }

    getLatestAttachedHandleForTask(taskId: string): RunnerHandle | undefined {
        const row = this.db.prepare(`
            SELECT handle_json
            FROM provisioning_intents
            WHERE task_id = ? AND status = 'attached'
            ORDER BY created_at DESC
            LIMIT 1
        `).get(taskId) as Row | undefined;
        return parseJsonObject(row?.handle_json) as RunnerHandle | undefined;
    }
}
