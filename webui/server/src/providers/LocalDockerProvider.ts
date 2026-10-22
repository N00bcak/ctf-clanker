import { PassThrough } from "node:stream";
import path from "node:path";
import { REPO_ROOT } from "../config.js";
import { prepareTaskCodexAuth } from "../codex/auth.js";
import type { CodexTask, ProvisioningIntent, ProvisioningPlan, RunnerHandle, RunnerResources, TaskEvent, WebuiConfig } from "../types.js";
import { assertTaskPermissions, permissionsFingerprint, readPermissions } from "../tasks/permissions.js";
import type { RunnerCapacity, RunnerProvider, RunnerUsage, ShellTerminal } from "./Provider.js";
import { detectDockerRuntime, docker, dockerSpawn } from "./docker.js";

function isMissingContainerError(error: unknown): boolean {
    const detail = [
        error instanceof Error ? error.message : String(error),
        typeof error === "object" && error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : ""
    ].join("\n");
    return /No such container|No such object|not found/i.test(detail);
}

interface ContainerInspection {
    Id?: string;
    Name?: string;
    Config?: { Labels?: Record<string, string> };
    HostConfig?: { NanoCpus?: number; CpuQuota?: number; CpuPeriod?: number; Memory?: number };
    State?: { Running?: boolean };
}

function assertManagedContainer(container: ContainerInspection, handle: Pick<RunnerHandle, "taskId" | "intentId">): void {
    const labels = container.Config?.Labels;
    if (labels?.["managed-by"] !== "mecha-webui" || labels.task_id !== handle.taskId || labels.intent_id !== handle.intentId) {
        throw new Error("Refusing to control a container with mismatched task labels");
    }
}

function resourceLimits(container: ContainerInspection): { cpuLimit: number; memoryLimitMb: number } {
    const config = container.HostConfig;
    const cpuLimit = config?.NanoCpus ? config.NanoCpus / 1e9
        : config?.CpuQuota && config.CpuQuota > 0 && config.CpuPeriod && config.CpuPeriod > 0
            ? config.CpuQuota / config.CpuPeriod : 0;
    const memoryLimitMb = (config?.Memory ?? 0) / 1024 ** 2;
    if (!Number.isFinite(cpuLimit) || cpuLimit < 0 || !Number.isFinite(memoryLimitMb) || memoryLimitMb < 0) {
        throw new Error("Docker returned invalid container resource limits");
    }
    return { cpuLimit, memoryLimitMb };
}

function validateResources(resources: RunnerResources): void {
    if (!Number.isFinite(resources.cpu) || resources.cpu <= 0 || !Number.isSafeInteger(resources.memoryMb) || resources.memoryMb <= 0) {
        throw new Error("Container resources require positive CPU and an integer RAM limit in MB");
    }
}

function memoryUsageMb(value: string): number {
    const match = value.trim().match(/^([\d.]+)\s*(B|[kMGT]i?B)$/i);
    if (!match) throw new Error("Docker returned invalid memory usage");
    const unit = match[2]!.toLowerCase();
    const exponent = unit === "b" ? 0 : "kmgt".indexOf(unit[0]!) + 1;
    const bytes = Number(match[1]) * (unit.includes("i") ? 1024 : 1000) ** exponent;
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error("Docker returned invalid memory usage");
    return bytes / 1024 ** 2;
}

export class LocalDockerProvider implements RunnerProvider {
    constructor(private readonly config: WebuiConfig) {}

    async getCapacity(): Promise<RunnerCapacity> {
        const result = await docker(["info", "--format", "{{json .}}"], { timeoutMs: 10_000 });
        const info = JSON.parse(result.stdout) as { NCPU?: number; MemTotal?: number };
        if (!Number.isFinite(info.NCPU) || info.NCPU! <= 0 || !Number.isFinite(info.MemTotal) || info.MemTotal! <= 0) {
            throw new Error("Docker returned invalid daemon capacity");
        }
        return { cpuCount: info.NCPU!, memoryMb: info.MemTotal! / 1024 ** 2 };
    }

    async getUsage(handles: RunnerHandle[]): Promise<RunnerUsage[]> {
        if (!handles.length) return [];
        const names = handles.map((handle) => {
            if (!handle.containerName) throw new Error("container name missing");
            return handle.containerName;
        });
        const result = await docker(["inspect", ...names], { timeoutMs: 10_000 });
        const containers = JSON.parse(result.stdout) as ContainerInspection[];
        if (!Array.isArray(containers) || containers.length !== handles.length) throw new Error("Incomplete Docker container inspection");
        const usages = containers.map((container, index): RunnerUsage => {
            const handle = handles[index]!;
            assertManagedContainer(container, handle);
            if (typeof container.State?.Running !== "boolean") throw new Error("Docker returned invalid container state");
            return { taskId: handle.taskId, cpu: 0, memoryMb: 0, ...resourceLimits(container), running: container.State.Running };
        });
        const runningNames = names.filter((_name, index) => usages[index]!.running);
        if (!runningNames.length) return usages;
        const stats = await docker(["stats", "--no-stream", "--no-trunc", "--format", "{{json .}}", ...runningNames], { timeoutMs: 10_000 });
        const rows = stats.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as { Name?: string; CPUPerc?: string; MemUsage?: string });
        for (let index = 0; index < usages.length; index++) {
            const usage = usages[index]!;
            if (!usage.running) continue;
            const name = containers[index]!.Name?.replace(/^\//, "") ?? names[index];
            const row = rows.find((candidate) => candidate.Name === name);
            if (!row || typeof row.CPUPerc !== "string" || !/^\d+(?:\.\d+)?%$/.test(row.CPUPerc) || typeof row.MemUsage !== "string") {
                throw new Error(`Missing or invalid Docker telemetry for ${names[index]}`);
            }
            usage.cpu = Number(row.CPUPerc.slice(0, -1)) / 100;
            if (!Number.isFinite(usage.cpu)) throw new Error("Docker returned invalid CPU usage");
            usage.memoryMb = memoryUsageMb(row.MemUsage.split("/")[0]!);
        }
        return usages;
    }

    async setResources(task: CodexTask, handle: RunnerHandle, resources: RunnerResources): Promise<void> {
        validateResources(resources);
        if (handle.taskId !== task.id) throw new Error("Runner task mismatch");
        if (!handle.containerName) throw new Error("container name missing");
        const container = await this.inspectManagedContainer(handle);
        const limits = resourceLimits(container);
        if (container.State?.Running && limits.memoryLimitMb !== resources.memoryMb) {
            throw new Error("Cannot change RAM limits while a task container is running");
        }
        const args = ["update", "--cpus", String(resources.cpu)];
        if (!container.State?.Running) {
            // Docker defaults to twice the RAM limit for RAM + swap. Normalize both
            // while stopped so a retained container can safely accept a new RAM limit.
            args.push("--memory", `${resources.memoryMb}m`, "--memory-swap", `${resources.memoryMb * 2}m`);
        }
        args.push(handle.containerName);
        await docker(args);
        const applied = resourceLimits(await this.inspectManagedContainer(handle));
        if (Math.abs(applied.cpuLimit - resources.cpu) > 1e-6 || applied.memoryLimitMb !== resources.memoryMb) {
            throw new Error("Docker resource update could not be verified");
        }
    }

    private async inspectManagedContainer(handle: RunnerHandle): Promise<ContainerInspection> {
        if (!handle.containerName) throw new Error("container name missing");
        const result = await docker(["inspect", handle.containerName], { timeoutMs: 10_000 });
        const containers = JSON.parse(result.stdout) as ContainerInspection[];
        if (!Array.isArray(containers) || containers.length !== 1 || !containers[0]) throw new Error("Incomplete Docker container inspection");
        assertManagedContainer(containers[0], handle);
        if (typeof containers[0].State?.Running !== "boolean") throw new Error("Docker returned invalid container state");
        return containers[0];
    }

    describeProvisioning(task: CodexTask): ProvisioningPlan {
        return {
            backend: "local",
            expectedResourceName: `mecha-task-${task.id}`,
            labels: {
                "managed-by": "mecha-webui",
                task_id: task.id
            }
        };
    }

    async provision(task: CodexTask, intent: ProvisioningIntent): Promise<RunnerHandle> {
        const permissions = readPermissions(path.join(path.dirname(task.storagePath), "permissions.yaml"), this.config);
        assertTaskPermissions(task, permissions, this.config);
        const fingerprint = permissionsFingerprint(permissions);
        const resources = task.resources ?? { cpu: this.config.local.defaultCpu, memoryMb: this.config.local.defaultMemoryMb };
        validateResources(resources);
        const runtime = await detectDockerRuntime();
        if (!runtime.ok) {
            throw new Error(runtime.detail);
        }
        prepareTaskCodexAuth(task, this.config);
        const containerName = `mecha-task-${task.id}`;
        const args = [
            "run",
            "-d",
            "--name",
            containerName,
            "--label",
            "managed-by=mecha-webui",
            "--label",
            `task_id=${task.id}`,
            "--label",
            `intent_id=${intent.id}`,
            "--label",
            `permissions_fingerprint=${fingerprint}`,
            "--cpus",
            String(resources.cpu),
            "--memory",
            `${resources.memoryMb}m`,
            "--pids-limit",
            String(this.config.local.pidsLimit),
            "--security-opt",
            "no-new-privileges",
            "--cap-drop",
            "ALL",
            "-w",
            "/workspace"
        ];
        if (permissions.network.mode === "none") {
            args.push("--network", "none");
        }
        args.push(
            "-v",
            `${task.storagePath}:/workspace:rw`,
            "-v",
            `${task.codexHomePath}:/root/.codex:rw`,
            "-v",
            `${path.join(REPO_ROOT, "families", "ctf")}:/etc/codex/skills:ro`
        );
        for (const mount of permissions.mounts) {
            const source = path.resolve(mount.source.replace(/^~(?=$|\/)/, process.env.HOME ?? ""));
            args.push("-v", `${source}:${mount.target}:${mount.mode.includes("w") ? "rw" : "ro"}`);
        }
        args.push(this.config.local.runnerImage);
        await docker(args, { timeoutMs: 120_000 });
        return {
            provider: "local",
            taskId: task.id,
            intentId: intent.id,
            containerName,
            permissionsFingerprint: fingerprint,
            createdAt: new Date().toISOString()
        };
    }

    async recover(task: CodexTask, intent: ProvisioningIntent): Promise<RunnerHandle | undefined> {
        try {
            const result = await docker(["inspect", intent.expectedResourceName]);
            const [container] = JSON.parse(result.stdout);
            if (container.Config?.Labels?.task_id !== task.id || container.Config?.Labels?.intent_id !== intent.id) {
                throw new Error("Refusing to recover a container with mismatched task labels");
            }
            const fingerprint = container.Config?.Labels?.permissions_fingerprint;
            return { provider: "local", taskId: task.id, intentId: intent.id,
                containerName: intent.expectedResourceName, createdAt: intent.createdAt,
                permissionsFingerprint: typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : undefined };
        } catch (error) {
            if (isMissingContainerError(error)) return undefined;
            throw error;
        }
    }

    async start(task: CodexTask, handle: RunnerHandle): Promise<void> {
        if (handle.taskId !== task.id) throw new Error("Runner task mismatch");
        const container = await this.inspectManagedContainer(handle);
        const resources = task.resources ?? { cpu: this.config.local.defaultCpu, memoryMb: this.config.local.defaultMemoryMb };
        const limits = resourceLimits(container);
        if (!container.State?.Running || Math.abs(limits.cpuLimit - resources.cpu) > 1e-6 || limits.memoryLimitMb !== resources.memoryMb) {
            await this.setResources(task, handle, resources);
        }
        if (!container.State?.Running) await docker(["start", handle.containerName!]);
    }

    async openTerminal(_task: CodexTask, handle: RunnerHandle): Promise<ShellTerminal> {
        if (!handle.containerName) {
            throw new Error("container name missing");
        }
        const child = dockerSpawn(["exec", "-i", "-w", "/workspace", handle.containerName, "/bin/bash"]);
        const stream = new PassThrough() as NodeJS.ReadWriteStream;
        let closed = false;
        let disposed = false;
        stream.write = child.stdin.write.bind(child.stdin) as typeof stream.write;
        child.stdout.on("data", (chunk) => stream.emit("data", chunk));
        child.stderr.on("data", (chunk) => stream.emit("data", chunk));
        child.on("close", () => {
            closed = true;
            stream.emit("close");
        });
        return {
            stream,
            dispose: () => {
                if (disposed) return;
                disposed = true;
                try {
                    child.stdin.end();
                } catch {
                    // Process teardown is best-effort after the user closes the shell socket.
                }
                if (!closed && !child.killed) {
                    child.kill();
                }
            }
        };
    }

    async openEventStream(): Promise<AsyncIterable<TaskEvent>> {
        return (async function* () {})();
    }

    async sendPrompt(): Promise<void> {
        throw new Error("Codex bridge handles prompts for local Docker tasks");
    }

    async collect(): Promise<void> {
        return;
    }

    async stop(_task: CodexTask, handle: RunnerHandle): Promise<void> {
        if (handle.containerName) {
            try {
                await docker(["stop", handle.containerName]);
            } catch (error) {
                if (!isMissingContainerError(error)) throw error;
            }
        }
    }

    async destroy(_task: CodexTask, handle: RunnerHandle): Promise<void> {
        if (handle.containerName) {
            try {
                await docker(["rm", "-f", handle.containerName]);
            } catch (error) {
                if (!isMissingContainerError(error)) {
                    throw error;
                }
            }
        }
    }
}
