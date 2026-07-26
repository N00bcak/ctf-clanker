import path from "node:path";
import { randomBytes } from "node:crypto";
import type { CodexTask, CreateTaskInput, WebuiConfig } from "../types.js";
import { resolveFromRepoRoot } from "../config.js";
import { WebuiDatabase } from "../db.js";
import { enforceAttachmentLimits, enforceTaskQuota } from "../utils/quota.js";
import { generateTaskFiles, taskPaths } from "./generateTaskFiles.js";
import { normalizeCodexSettings } from "../codex/settings.js";

function taskId(): string {
    return `task_${randomBytes(8).toString("hex")}`;
}

function safeName(input: CreateTaskInput): string {
    return (input.name?.trim() || input.prompt.trim().split(/\s+/).slice(0, 6).join(" ") || "Untitled task").slice(0, 80);
}

function codexRuntimeFor(input: CreateTaskInput, config: WebuiConfig): Pick<CodexTask, "codexRuntime" | "bridgeMode"> {
    if (config.codex.credentialMode === "host-codex-cli") {
        return {
            codexRuntime: "host",
            bridgeMode: "host-codex-broker"
        };
    }
    if (config.codex.credentialMode === "codex-auth-json") {
        return {
            codexRuntime: (input.backend ?? "local") === "digitalocean" ? "droplet" : "container",
            bridgeMode: "native-codex-app-server"
        };
    }
    if (config.codex.credentialMode === "none") {
        return {
            codexRuntime: (input.backend ?? "local") === "digitalocean" ? "droplet" : "container",
            bridgeMode: "native-codex-app-server"
        };
    }
    throw new Error(`Unsupported Codex credential mode: ${String(config.codex.credentialMode)}`);
}

export function createTask(input: CreateTaskInput, config: WebuiConfig, db: WebuiDatabase): CodexTask {
    if (!input.prompt || input.prompt.trim().length === 0) {
        throw new Error("prompt is required");
    }
    const attachments = input.attachments ?? [];
    const codexSettings = normalizeCodexSettings(input.codexSettings);
    enforceAttachmentLimits(attachments, config);

    const cacheDir = resolveFromRepoRoot(config.paths.cacheDir);
    const id = taskId();
    const paths = taskPaths(cacheDir, id);
    const now = new Date().toISOString();
    const task: CodexTask = {
        id,
        name: safeName(input),
        backend: input.backend ?? "local",
        status: "draft",
        workStatus: "not-started",
        createdAt: now,
        initialPromptPath: paths.initialPromptPath,
        storagePath: paths.storagePath,
        controlPath: paths.controlPath,
        codexHomePath: paths.codexHomePath,
        logsPath: paths.logsPath,
        outputPath: paths.outputPath,
        providerSpec: {
            backend: input.backend ?? "local",
            ...(codexSettings ? { codexSettings } : {})
        },
        idleTtlMinutes: config.cloud.idleTtlMinutes,
        hardTtlMinutes: config.cloud.hardTtlMinutes,
        credentialMode: config.codex.credentialMode,
        codexHomeRetention: config.codex.codexHomeRetention,
        ...codexRuntimeFor(input, config),
        networkMode: config.network.mode,
        networkEnforcement: config.network.enforcement,
        codexSettings
    };

    db.withTransaction(() => {
        generateTaskFiles(task, { ...input, attachments }, config, cacheDir);
        enforceTaskQuota(path.dirname(task.storagePath), config);
        db.insertTask(task);
    });

    return task;
}
