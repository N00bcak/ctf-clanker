export type Backend = "local" | "digitalocean";

export interface CodexSettings {
    model?: string;
    profile?: string;
    sandbox: "read-only" | "workspace-write" | "danger-full-access";
    approvalPolicy: "untrusted" | "on-request" | "never";
    webSearch: boolean;
}

export interface CreateTaskRequest {
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
}

export interface DestroyTaskResult {
    ok: true;
    id: string;
}

export interface CodexSessionState {
    state: "not-started" | "active" | "closed";
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
    files: (id: string, path = "") => json<Array<{ name: string; path: string; type: string; size: number }>>(`/api/tasks/${id}/files?path=${encodeURIComponent(path)}`),
    permissions: (id: string, permissions: unknown) =>
        json(`/api/tasks/${id}/permissions`, { method: "PATCH", body: JSON.stringify(permissions) })
};
