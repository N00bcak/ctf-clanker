export type Backend = "local" | "digitalocean";

export interface CodexSettings {
    model?: string;
    profile?: string;
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy: "untrusted" | "on-request" | "never";
    webSearch: boolean;
}

export interface CreateTaskRequest {
    source?: { platform: "ctfd"; competition: string; account: string; challengeId: string; contentHash: string };
    name?: string;
    prompt: string;
    backend?: Backend;
    codexSettings?: CodexSettings;
    attachments?: Array<{ path: string; contentBase64: string }>;
}

export interface Task {
    id: string;
    name: string;
    backend: Backend;
    status: string;
    executionError?: string;
    queueOrder?: number;
    workStatus: "not-started" | "running" | "needs-attention" | "done" | "failed";
    createdAt: string;
    storagePath: string;
    activeProvisioningIntentId?: string;
    credentialMode: string;
    codexRuntime: "container" | "host" | "droplet";
    bridgeMode: "native-codex-app-server" | "host-codex-broker";
    networkMode: string;
    networkEnforcement: string;
    codexSettings?: CodexSettings;
    workspaceSync?: {
        owner: "host" | "remote";
        state: "idle" | "uploading" | "syncing" | "error";
        generation?: string;
        lastSyncedAt?: string;
        error?: string;
    };
}

export interface TaskPermissions {
    version: 1;
    network: { mode: string; enforcement: string; allow: string[] };
    mounts: Array<{ label: string; source: string; target: string; mode: "ro" | "rw" | "rx" | "rwx" }>;
}

export interface PermissionsState {
    permissions: TaskPermissions;
    supportedNetworkModes: string[];
    editable: boolean;
    reason?: string;
}

export interface DestroyTaskResult {
    ok: true;
    id: string;
}

export interface CodexSessionState {
    state: "not-started" | "active" | "closed";
}

export interface CodexModelOption {
    model: string;
    displayName: string;
    description: string;
    isDefault: boolean;
}

export interface CodexModelCatalog {
    models: CodexModelOption[];
    source: "local-runner-app-server" | "host-app-server-fallback";
    runtimeVersion?: string;
    queriedAt: string;
}

export interface SchedulerStatus {
    maxWorkers: number;
    activeWorkers: number;
    cpuBudget: number;
    cpuAllocated: number;
    cpuUsage?: number;
    memoryBudgetMb: number;
    effectiveMemoryMb?: number;
    memoryReservedMb: number;
    memoryUsageMb?: number;
    workerMemoryMb: number;
    effectiveMaxWorkers?: number;
    state: "ready" | "observing" | "blocked" | "recovering";
    reason?: string;
    sampledAt?: string;
    workers: Array<{ taskId: string; cpu: number; memoryMb: number; cpuUsage?: number; memoryUsageMb?: number }>;
    waiting: Array<{ taskId: string; reason: string }>;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, {
        ...init,
        headers: {
            "content-type": "application/json",
            ...(init?.headers ?? {})
        }
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(body.error ?? response.statusText);
    }
    return response.json() as Promise<T>;
}

export const api = {
    tasks: () => json<Task[]>("/api/tasks"),
    scheduler: () => json<SchedulerStatus>("/api/scheduler"),
    codexModels: () => json<CodexModelCatalog>("/api/codex/models"),
    createTask: (input: CreateTaskRequest) =>
        json<Task>("/api/tasks", {
            method: "POST",
            body: JSON.stringify(input)
        }),
    start: (id: string) => json<Task>(`/api/tasks/${id}/start`, { method: "POST", body: "{}" }),
    stop: (id: string) => json<Task>(`/api/tasks/${id}/stop`, { method: "POST", body: "{}" }),
    destroy: (id: string) => json<DestroyTaskResult>(`/api/tasks/${id}/destroy`, { method: "POST", body: "{}" }),
    codexSession: (id: string) => json<CodexSessionState>(`/api/tasks/${id}/codex-session`),
    workStatus: (id: string, workStatus: Task["workStatus"]) =>
        json<Task>(`/api/tasks/${id}/status`, { method: "PATCH", body: JSON.stringify({ workStatus }) }),
    initialPrompt: (id: string) => json<{ prompt: string }>(`/api/tasks/${id}/initial-prompt`),
    prompt: (id: string, prompt: string) =>
        json<Task>(`/api/tasks/${id}/prompt`, { method: "POST", body: JSON.stringify({ prompt }) }),
    files: (id: string, path = "", signal?: AbortSignal) => json<Array<{ name: string; path: string; type: string; size: number }>>(`/api/tasks/${id}/files?path=${encodeURIComponent(path)}`, { signal }),
    permissionState: (id: string) => json<PermissionsState>(`/api/tasks/${id}/permissions`),
    permissions: (id: string, permissions: TaskPermissions) =>
        json<TaskPermissions>(`/api/tasks/${id}/permissions`, { method: "PATCH", body: JSON.stringify(permissions) })
};
