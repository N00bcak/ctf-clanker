import type { CodexTask, ProvisioningIntent, ProvisioningPlan, RunnerHandle, TaskEvent } from "../types.js";

export interface ShellTerminal {
    stream: NodeJS.ReadWriteStream;
    dispose(): void;
}

export interface RunnerProvider {
    describeProvisioning(task: CodexTask): ProvisioningPlan;
    provision(task: CodexTask, intent: ProvisioningIntent): Promise<RunnerHandle>;
    start(task: CodexTask, handle: RunnerHandle): Promise<void>;
    openTerminal(task: CodexTask, handle: RunnerHandle): Promise<ShellTerminal>;
    openEventStream(task: CodexTask, handle: RunnerHandle): Promise<AsyncIterable<TaskEvent>>;
    sendPrompt(task: CodexTask, handle: RunnerHandle, prompt: string): Promise<void>;
    collect(task: CodexTask, handle: RunnerHandle): Promise<void>;
    stop(task: CodexTask, handle: RunnerHandle): Promise<void>;
    destroy(task: CodexTask, handle: RunnerHandle): Promise<void>;
}
