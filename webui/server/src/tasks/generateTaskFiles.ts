import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { CodexTask, CreateTaskInput, WebuiConfig } from "../types.js";
import { decodedAttachmentBytes } from "../utils/quota.js";
import { resolveSafeChild } from "../utils/paths.js";
import { defaultPermissions } from "./permissions.js";

export interface TaskPaths {
    taskRoot: string;
    initialPromptPath: string;
    storagePath: string;
    controlPath: string;
    codexHomePath: string;
    logsPath: string;
    outputPath: string;
}

export function taskPaths(cacheDir: string, taskId: string): TaskPaths {
    const taskRoot = path.join(cacheDir, taskId);
    return {
        taskRoot,
        initialPromptPath: path.join(taskRoot, "input/prompt.md"),
        storagePath: path.join(taskRoot, "storage"),
        controlPath: path.join(taskRoot, "control"),
        codexHomePath: path.join(taskRoot, "codex-home"),
        logsPath: path.join(taskRoot, "logs"),
        outputPath: path.join(taskRoot, "output")
    };
}

function taskInstructions(): string {
    return `# Mecha task instructions

You are operating inside an isolated task workspace.

Workspace:
- Primary writable workspace: /workspace
- Shared mecha-suit assets: /mecha, read-only
- Attached files: /workspace/attachments

Rules:
- Do not attempt to access paths outside mounted task paths.
- Use available skills when relevant.
- Record important commands and findings in /workspace/NOTES.md.
- Before declaring completion, summarize changed files, commands run, and unresolved risks.
`;
}

function initialContext(task: CodexTask): string {
    const nativeSandbox = task.codexSettings?.sandbox ?? "danger-full-access";
    const runtimeDescription = task.bridgeMode === "host-codex-broker"
        ? `Codex runs one-shot on the host through the Codex CLI against host workspace path ${task.storagePath}.`
        : `Codex runs through the JSON-RPC app-server inside the ${task.codexRuntime} runner with its ${nativeSandbox} sandbox. Docker/droplet isolation is the outer runtime boundary.`;
    return `# Mecha Context

Task: ${task.name}
Task ID: ${task.id}

## Current Goal

Run the user's task in an isolated workspace.

## Decisions

- Bridge mode is ${task.bridgeMode}.
- Runtime: ${runtimeDescription}
- This file is bridge-owned and is not mounted into the task workspace by default.

## Next Action

Read /workspace/AGENTS.md and answer the user's prompt.
`;
}

export function generateTaskFiles(task: CodexTask, input: CreateTaskInput, config: WebuiConfig, cacheDir: string): void {
    const paths = taskPaths(cacheDir, task.id);
    fs.mkdirSync(path.join(paths.taskRoot, "input/attachments"), { recursive: true });
    fs.mkdirSync(path.join(paths.storagePath, "attachments"), { recursive: true });
    fs.mkdirSync(path.join(paths.storagePath, ".agents/skills"), { recursive: true });
    fs.mkdirSync(paths.controlPath, { recursive: true });
    fs.mkdirSync(paths.codexHomePath, { recursive: true });
    fs.mkdirSync(paths.logsPath, { recursive: true });
    fs.mkdirSync(paths.outputPath, { recursive: true });

    fs.writeFileSync(paths.initialPromptPath, input.prompt);
    fs.writeFileSync(path.join(paths.storagePath, "AGENTS.md"), taskInstructions());
    fs.writeFileSync(path.join(paths.storagePath, "NOTES.md"), "# Notes\n\n");
    fs.writeFileSync(path.join(paths.controlPath, "MECHA_CONTEXT.md"), initialContext(task));
    fs.writeFileSync(path.join(paths.taskRoot, "permissions.yaml"), YAML.stringify(defaultPermissions(config)));
    fs.writeFileSync(path.join(paths.taskRoot, "task.yaml"), YAML.stringify({
        id: task.id,
        name: task.name,
        backend: task.backend,
        status: task.status,
        credentialMode: task.credentialMode,
        codexHomeRetention: task.codexHomeRetention,
        codexRuntime: task.codexRuntime,
        bridgeMode: task.bridgeMode,
        workspaceHostPath: task.storagePath,
        workspaceContainerPath: "/workspace",
        networkMode: task.networkMode,
        networkEnforcement: task.networkEnforcement,
        ...(task.codexSettings ? { codexSettings: task.codexSettings } : {}),
        createdAt: task.createdAt
    }));
    fs.writeFileSync(path.join(paths.logsPath, "events.jsonl"), "");
    fs.writeFileSync(path.join(paths.logsPath, "terminal.log"), "");
    fs.writeFileSync(path.join(paths.logsPath, "codex.jsonl"), "");
    fs.writeFileSync(path.join(paths.logsPath, "steering.jsonl"), "");

    for (const attachment of input.attachments ?? []) {
        const bytes = decodedAttachmentBytes(attachment);
        const inputPath = resolveSafeChild(path.join(paths.taskRoot, "input/attachments"), attachment.path);
        const workspacePath = resolveSafeChild(paths.storagePath, attachment.path);
        fs.mkdirSync(path.dirname(inputPath), { recursive: true });
        fs.mkdirSync(path.dirname(workspacePath), { recursive: true });
        fs.writeFileSync(inputPath, bytes);
        fs.writeFileSync(workspacePath, bytes);
    }
}
