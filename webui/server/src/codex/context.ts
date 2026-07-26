import fs from "node:fs";
import path from "node:path";
import type { CodexTask, WebuiConfig } from "../types.js";
import { appendCapped } from "../utils/logs.js";
import type { SecretRedactor } from "../utils/redactor.js";

export function buildCodexPrompt(task: CodexTask, userPrompt: string, runtimeNote: string, persistenceNote?: string): string {
    const contextPath = path.join(task.controlPath, "MECHA_CONTEXT.md");
    const context = fs.existsSync(contextPath) ? fs.readFileSync(contextPath, "utf8") : "";
    return `${context}

## New User Instruction

${userPrompt}

## Runtime Boundary

${runtimeNote}

	${persistenceNote ?? "Remember: this is a one-shot invocation. Update NOTES.md with important findings, commands, changed files, risks, and next actions."}`;
}

export function buildNativePtyPrompt(task: CodexTask, userPrompt: string, includeFullContext: boolean): string {
    if (includeFullContext) {
        return buildCodexPrompt(
            task,
            userPrompt,
            `Codex is running as a live terminal session inside the ${task.codexRuntime} task runner. The runner is the isolation boundary; Codex sandboxing is disabled inside the runner. Work inside /workspace and task-local mounted paths.`,
            "This live PTY session may persist across prompts while the runner stays active. Update NOTES.md with important findings, commands, changed files, risks, and next actions."
        );
    }
    return `## New User Instruction

${userPrompt}

## Task Reminder

Task: ${task.name}
Task ID: ${task.id}
Workspace: /workspace
Codex is still running in the selected task runner. Keep NOTES.md current with important findings, commands, changed files, risks, and next actions.`;
}

export function appendSteeringLog(task: CodexTask, userPrompt: string, config: WebuiConfig, redactor: SecretRedactor): void {
    appendCapped(path.join(task.logsPath, "steering.jsonl"), `${JSON.stringify({
        ts: new Date().toISOString(),
        prompt: redactor.redact(userPrompt),
        bridgeMode: task.bridgeMode,
        codexRuntime: task.codexRuntime
    })}\n`, config);
}

export function updateBridgeContext(task: CodexTask, userPrompt: string, exitCode: number, redactor: SecretRedactor): void {
    const notesPath = path.join(task.storagePath, "NOTES.md");
    const notes = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, "utf8").slice(-4000) : "";
    const context = `# Mecha Context

Task: ${task.name}
Task ID: ${task.id}

## Workspace

Host path: ${task.storagePath}
Container path: /workspace
Bridge mode: ${task.bridgeMode}
Codex runtime: ${task.codexRuntime}

## Last User Instruction

${redactor.redact(userPrompt).slice(0, 2000)}

## Last Exit Status

${exitCode}

## Recent Task Notes

${redactor.redact(notes)}

## Next Action

Use this compact context plus the next user instruction. Do not assume persistent conversational memory.
`;
    fs.writeFileSync(path.join(task.controlPath, "MECHA_CONTEXT.md"), context);
}
