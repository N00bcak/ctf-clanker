import type { CodexTask, ProvisioningIntent, ProvisioningPlan, RunnerHandle, RunnerResources, TaskEvent, WorkspaceCollection } from "../types.js";

export interface RunnerCapacity {
    cpuCount: number;
    memoryMb: number;
}

export interface RunnerUsage {
    taskId: string;
    cpu: number;
    memoryMb: number;
    cpuLimit: number;
    memoryLimitMb: number;
    running: boolean;
}

export interface ShellTerminal {
    stream: NodeJS.ReadWriteStream;
    dispose(): void;
}

export interface RunnerProvider {
    getCapacity?(): Promise<RunnerCapacity>;
    getUsage?(handles: RunnerHandle[]): Promise<RunnerUsage[]>;
    setResources?(task: CodexTask, handle: RunnerHandle, resources: RunnerResources): Promise<void>;
    describeProvisioning(task: CodexTask): ProvisioningPlan;
    provision(task: CodexTask, intent: ProvisioningIntent): Promise<RunnerHandle>;
    recover?(task: CodexTask, intent: ProvisioningIntent): Promise<RunnerHandle | undefined>;
    start(task: CodexTask, handle: RunnerHandle, persistHandle?: (handle: RunnerHandle) => void): Promise<void>;
    openTerminal(task: CodexTask, handle: RunnerHandle): Promise<ShellTerminal>;
    openEventStream(task: CodexTask, handle: RunnerHandle): Promise<AsyncIterable<TaskEvent>>;
    sendPrompt(task: CodexTask, handle: RunnerHandle, prompt: string): Promise<void>;
    collect(task: CodexTask, handle: RunnerHandle, options?: { mode: "snapshot" | "final"; signal?: AbortSignal }): Promise<WorkspaceCollection | void>;
    stop(task: CodexTask, handle: RunnerHandle): Promise<void>;
    destroy(task: CodexTask, handle: RunnerHandle): Promise<void>;
}
