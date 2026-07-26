import type { CodexSettings, CodexSandbox, WebuiConfig } from "../types.js";

export const DEFAULT_CODEX_SETTINGS: CodexSettings = {
    model: "gpt-5.5",
    sandbox: "workspace-write",
    approvalPolicy: "never",
    webSearch: false
};

const SANDBOXES = new Set<CodexSandbox>(["read-only", "workspace-write", "danger-full-access"]);
const APPROVAL_POLICIES = new Set(["untrusted", "on-request", "never"]);

export function normalizeCodexSettings(input: Partial<CodexSettings> | undefined): CodexSettings | undefined {
    if (!input) {
        return undefined;
    }
    const sandbox = input.sandbox ?? DEFAULT_CODEX_SETTINGS.sandbox;
    const approvalPolicy = input.approvalPolicy ?? DEFAULT_CODEX_SETTINGS.approvalPolicy;
    if (!SANDBOXES.has(sandbox)) {
        throw new Error(`Unsupported Codex sandbox: ${sandbox}`);
    }
    if (!APPROVAL_POLICIES.has(approvalPolicy)) {
        throw new Error(`Unsupported Codex approval policy: ${approvalPolicy}`);
    }
    return {
        model: input.model?.trim() || DEFAULT_CODEX_SETTINGS.model,
        profile: input.profile?.trim() || undefined,
        sandbox,
        approvalPolicy,
        webSearch: input.webSearch ?? DEFAULT_CODEX_SETTINGS.webSearch
    };
}

export function taskCodexSettings(task: { codexSettings?: CodexSettings }, config: WebuiConfig): CodexSettings {
    const approvalPolicy = config.codex.hostCliApprovalPolicy === "on-failure" ? "never" : config.codex.hostCliApprovalPolicy;
    return task.codexSettings ?? {
        sandbox: config.codex.hostCliSandbox,
        approvalPolicy,
        webSearch: false
    };
}

export function nativeCodexSettings(task: { codexSettings?: CodexSettings }): CodexSettings {
    return task.codexSettings ?? {
        sandbox: "danger-full-access",
        approvalPolicy: "never",
        webSearch: false
    };
}

export function codexConfigArgs(settings: CodexSettings): string[] {
    const args: string[] = [];
    if (settings.model) {
        args.push("-m", settings.model);
    }
    if (settings.profile) {
        args.push("-p", settings.profile);
    }
    args.push("-c", `web_search=${settings.webSearch ? '"live"' : '"disabled"'}`);
    return args;
}

export function codexSandboxPolicy(settings: CodexSettings): Record<string, unknown> {
    if (settings.sandbox === "danger-full-access") {
        return { type: "dangerFullAccess" };
    }
    if (settings.sandbox === "read-only") {
        return { type: "readOnly" };
    }
    return { type: "workspaceWrite" };
}
