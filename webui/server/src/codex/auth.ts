import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodexTask, WebuiConfig } from "../types.js";

export function expandHome(input: string): string {
    return input.replace(/^~(?=$|\/)/, os.homedir());
}

export function resolveCodexAuthJsonPath(config: WebuiConfig): string {
    return path.resolve(expandHome(config.codex.authJsonPath));
}

export function prepareTaskCodexAuth(task: CodexTask, config: WebuiConfig): void {
    if (task.credentialMode === "none" || task.credentialMode === "host-codex-cli") {
        return;
    }
    if (task.credentialMode !== "codex-auth-json") {
        throw new Error(`Unsupported Codex credential mode: ${task.credentialMode}`);
    }
    const source = resolveCodexAuthJsonPath(config);
    if (!fs.existsSync(source)) {
        throw new Error(`Codex auth.json not found at ${source}; run codex login or set codex.authJsonPath`);
    }
    fs.mkdirSync(task.codexHomePath, { recursive: true, mode: 0o700 });
    fs.chmodSync(task.codexHomePath, 0o700);
    const target = path.join(task.codexHomePath, "auth.json");
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o600);
}

export function scrubTaskCodexHome(task: CodexTask): void {
    if (task.codexHomeRetention !== "purge-after-run") {
        return;
    }
    for (const name of ["sessions", "history.jsonl", "logs", "codex.log"]) {
        fs.rmSync(path.join(task.codexHomePath, name), { recursive: true, force: true });
    }
}
