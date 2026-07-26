export type Backend = "local" | "digitalocean";

export type TaskStatus =
    | "draft"
    | "queued"
    | "provisioning"
    | "running"
    | "idle"
    | "collecting"
    | "destroying"
    | "finished"
    | "failed"
    | "orphaned";

export type CredentialMode = "none" | "codex-auth-json" | "host-codex-cli";
export type CodexHomeRetention = "purge-after-run" | "purge-on-finish" | "keep-until-task-delete";
export type CodexRuntime = "container" | "host" | "droplet";
export type BridgeMode = "native-codex-app-server" | "host-codex-broker";
export type NetworkMode = "none" | "open" | "codex-only" | "proxy-allowlist";
export type NetworkEnforcement = "open-warning" | "docker-none" | "sidecar-proxy" | "host-firewall" | "broker";
export type ProvisioningIntentStatus = "creating" | "attached" | "closed" | "abandoned" | "failed";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type WorkStatus = "not-started" | "running" | "needs-attention" | "done" | "failed";

export interface CodexSettings {
    model?: string;
    profile?: string;
    sandbox: CodexSandbox;
    approvalPolicy: CodexApprovalPolicy;
    webSearch: boolean;
}

export interface WebuiConfig {
    server: {
        host: string;
        port: number;
        auth: {
            mode: "none" | "token";
            tokenEnv: string;
        };
    };
    paths: {
        cacheDir: string;
    };
    sqlite: {
        path: string;
        wal: boolean;
        busyTimeoutMs: number;
    };
    codex: {
        credentialMode: CredentialMode;
        authJsonPath: string;
        hostCliPath: string;
        hostCliSandbox: "read-only" | "workspace-write" | "danger-full-access";
        hostCliApprovalPolicy: "untrusted" | "on-failure" | "on-request" | "never";
        allowTerminalCredentialEnv: boolean;
        failIfMissingCredential: boolean;
        codexHomeRetention: CodexHomeRetention;
    };
    network: {
        mode: NetworkMode;
        enforcement: NetworkEnforcement;
        allow: string[];
    };
    limits: {
        attachments: {
            maxFiles: number;
            maxFileBytes: number;
            maxTotalBytes: number;
        };
        taskCacheDirQuotaMb: number;
        quotaEnforcement: "soft";
        maxLogBytesPerFile: number;
    };
    local: {
        enabled: boolean;
        concurrency: number;
        provider: "docker";
        dockerHost: string;
        runnerImage: string;
        defaultCpu: number;
        defaultMemoryMb: number;
        pidsLimit: number;
    };
    cloud: {
        provider: "digitalocean";
        enabled: boolean;
        dryRun: boolean;
        liveEnvGuard: string;
        region: string;
        image: string;
        defaultSize: string;
        maxConcurrent: number;
        idleTtlMinutes: number;
        hardTtlMinutes: number;
        destroyOnFinish: boolean;
        backups: boolean;
        snapshots: boolean;
        sshUser: string;
        sshKeyPath: string;
        sshPublicKeyPath: string;
        sshKeyName: string;
    };
    security: {
        reaperGraceSeconds: number;
        globalOrphanTtlMinutes: number;
        reaperOrphanPolicy: "report" | "destroy";
        denyHostMounts: string[];
        allowRepoAssetMounts: boolean;
    };
}

export interface AttachmentInput {
    path: string;
    contentBase64: string;
}

export interface CreateTaskInput {
    name?: string;
    prompt: string;
    backend?: Backend;
    attachments?: AttachmentInput[];
    codexSettings?: Partial<CodexSettings>;
}

export interface CodexTask {
    id: string;
    name: string;
    backend: Backend;
    status: TaskStatus;
    workStatus: WorkStatus;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    initialPromptPath: string;
    storagePath: string;
    controlPath: string;
    codexHomePath: string;
    logsPath: string;
    outputPath: string;
    providerSpec: Record<string, unknown>;
    providerState?: Record<string, unknown>;
    activeProvisioningIntentId?: string;
    idleTtlMinutes: number;
    hardTtlMinutes: number;
    localConcurrencySlot?: number;
    credentialMode: CredentialMode;
    codexHomeRetention: CodexHomeRetention;
    codexRuntime: CodexRuntime;
    bridgeMode: BridgeMode;
    networkMode: NetworkMode;
    networkEnforcement: NetworkEnforcement;
    codexSettings?: CodexSettings;
}

export interface ProvisioningPlan {
    backend: Backend;
    expectedResourceName: string;
    labels: Record<string, string>;
}

export interface ProvisioningIntent {
    id: string;
    taskId: string;
    backend: Backend;
    expectedResourceName: string;
    createdAt: string;
    reaperGraceUntil: string;
    status: ProvisioningIntentStatus;
}

export interface RunnerHandle {
    provider: Backend;
    taskId: string;
    intentId: string;
    containerName?: string;
    dropletId?: string;
    sshHost?: string;
    providerPayload?: Record<string, unknown>;
    createdAt: string;
}

export interface TaskEvent {
    ts: string;
    taskId: string;
    type: string;
    [key: string]: unknown;
}
