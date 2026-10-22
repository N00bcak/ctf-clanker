import type { CodexTask, ProvisioningIntent, ProvisioningPlan, RunnerHandle, TaskEvent, WorkspaceCollection } from "../types.js";

export interface ShellTerminal {
    stream: NodeJS.ReadWriteStream;
    dispose(): void;
}

export interface RunnerProvider {
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
