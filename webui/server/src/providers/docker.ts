import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function docker(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string }> {
    const result = await execFileAsync("docker", args, {
        env: options.env ?? process.env,
        maxBuffer: 10 * 1024 * 1024
    });
    return { stdout: result.stdout, stderr: result.stderr };
}

export function dockerSpawn(args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
    return spawn("docker", args, {
        env: options.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"]
    });
}

export async function detectDockerRuntime(): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
    try {
        const result = await docker(["version", "--format", "{{.Server.Version}}"]);
        return { ok: true, detail: `Docker CLI available; server ${result.stdout.trim()}` };
    } catch (error) {
        const sockets = [
            "/var/run/docker.sock",
            path.join(os.homedir(), ".docker/run/docker.sock"),
            path.join(os.homedir(), ".colima/default/docker.sock"),
            path.join(os.homedir(), ".orbstack/run/docker.sock")
        ];
        const present = sockets.filter((socket) => fs.existsSync(socket));
        return {
            ok: false,
            detail: `Docker CLI check failed. Checked common sockets: ${present.length ? present.join(", ") : "none present"}. Error: ${String(error)}`
        };
    }
}
