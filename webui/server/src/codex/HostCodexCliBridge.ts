import { spawn } from "node:child_process";
import path from "node:path";
import { appendCapped } from "../utils/logs.js";
import type { SecretRedactor } from "../utils/redactor.js";
import type { CodexTask, WebuiConfig } from "../types.js";
import { appendSteeringLog, buildCodexPrompt, updateBridgeContext } from "./context.js";
import { codexConfigArgs, taskCodexSettings } from "./settings.js";

export function hostCodexCommandArgs(task: CodexTask, config: WebuiConfig): { command: string; args: string[] } {
    const command = config.codex.hostCliPath === "auto" ? "codex" : config.codex.hostCliPath;
    const settings = taskCodexSettings(task, config);
    return {
        command,
        args: [
            "exec",
            ...codexConfigArgs(settings),
            "-C",
            task.storagePath,
            "--sandbox",
            settings.sandbox,
            "--ask-for-approval",
            settings.approvalPolicy,
            "--skip-git-repo-check",
            "-"
        ]
    };
}

export class HostCodexCliBridge {
    constructor(
        private readonly config: WebuiConfig,
        private readonly redactor: SecretRedactor
    ) {}

    async run(task: CodexTask, userPrompt: string, onOutput: (text: string) => void): Promise<void> {
        if (task.storagePath === "/" || task.storagePath.length < 8) {
            throw new Error("refusing to run host Codex with unsafe workspace path");
        }
        const prompt = buildCodexPrompt(
            task,
            userPrompt,
            "Codex is running on the host through the Codex CLI. The task workspace is the Codex working root; do not access paths outside this workspace unless explicitly configured."
        );
        appendSteeringLog(task, userPrompt, this.config, this.redactor);
        const { command, args } = hostCodexCommandArgs(task, this.config);

        await new Promise<void>((resolve, reject) => {
            const child = spawn(command, args, {
                cwd: task.storagePath,
                env: process.env,
                stdio: ["pipe", "pipe", "pipe"]
            });
            child.stdout.on("data", (chunk: Buffer) => {
                const text = this.redactor.redact(chunk.toString());
                appendCapped(path.join(task.logsPath, "codex.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), stream: "stdout", text })}\n`, this.config);
                onOutput(text);
            });
            child.stderr.on("data", (chunk: Buffer) => {
                const text = this.redactor.redact(chunk.toString());
                appendCapped(path.join(task.logsPath, "codex.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), stream: "stderr", text })}\n`, this.config);
                onOutput(text);
            });
            child.on("error", (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") {
                    reject(new Error("Host Codex CLI not found; install Codex or set codex.hostCliPath"));
                    return;
                }
                reject(error);
            });
            child.on("close", (code) => {
                updateBridgeContext(task, userPrompt, code ?? -1, this.redactor);
                if (code === 0) resolve();
                else reject(new Error(`host codex exec exited with ${code}; run 'codex login status' to check authentication`));
            });
            child.stdin.end(prompt);
        });
    }
}
