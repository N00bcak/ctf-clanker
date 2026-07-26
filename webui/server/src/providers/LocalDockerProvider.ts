import { PassThrough } from "node:stream";
import path from "node:path";
import { REPO_ROOT } from "../config.js";
import { prepareTaskCodexAuth } from "../codex/auth.js";
import type { CodexTask, ProvisioningIntent, ProvisioningPlan, RunnerHandle, TaskEvent, WebuiConfig } from "../types.js";
import { readPermissions } from "../tasks/permissions.js";
import type { RunnerProvider, ShellTerminal } from "./Provider.js";
import { detectDockerRuntime, docker, dockerSpawn } from "./docker.js";

function isMissingContainerError(error: unknown): boolean {
    const detail = [
        error instanceof Error ? error.message : String(error),
        typeof error === "object" && error && "stderr" in error ? String((error as { stderr?: unknown }).stderr ?? "") : ""
    ].join("\n");
    return /No such container|No such object|not found/i.test(detail);
}

export class LocalDockerProvider implements RunnerProvider {
    constructor(private readonly config: WebuiConfig) {}

    describeProvisioning(task: CodexTask): ProvisioningPlan {
        return {
            backend: "local",
            expectedResourceName: `mecha-task-${task.id}`,
            labels: {
                "managed-by": "mecha-webui",
                task_id: task.id
            }
        };
    }

    async provision(task: CodexTask, intent: ProvisioningIntent): Promise<RunnerHandle> {
        const runtime = await detectDockerRuntime();
        if (!runtime.ok) {
            throw new Error(runtime.detail);
        }
        prepareTaskCodexAuth(task, this.config);
        const permissions = readPermissions(path.join(path.dirname(task.storagePath), "permissions.yaml"), this.config);
        const containerName = `mecha-task-${task.id}`;
        const args = [
            "run",
            "-d",
            "--name",
            containerName,
            "--label",
            "managed-by=mecha-webui",
            "--label",
            `task_id=${task.id}`,
            "--label",
            `intent_id=${intent.id}`,
            "--cpus",
            String(this.config.local.defaultCpu),
            "--memory",
            `${this.config.local.defaultMemoryMb}m`,
            "--pids-limit",
            String(this.config.local.pidsLimit),
            "--security-opt",
            "no-new-privileges",
            "--cap-drop",
            "ALL",
            "-w",
            "/workspace"
        ];
        if (permissions.network.mode === "none") {
            args.push("--network", "none");
        }
        args.push(
            "-v",
            `${task.storagePath}:/workspace:rw`,
            "-v",
            `${task.codexHomePath}:/root/.codex:rw`,
            "-v",
            `${path.join(REPO_ROOT, "shared")}:/mecha/shared:ro`,
            "-v",
            `${path.join(REPO_ROOT, "templates")}:/mecha/templates:ro`,
            "-v",
            `${path.join(REPO_ROOT, "families")}:/mecha/families:ro`
        );
        for (const mount of permissions.mounts) {
            args.push("-v", `${mount.source}:${mount.target}:${mount.mode.includes("w") ? "rw" : "ro"}`);
        }
        args.push(this.config.local.runnerImage);
        await docker(args);
        return {
            provider: "local",
            taskId: task.id,
            intentId: intent.id,
            containerName,
            createdAt: new Date().toISOString()
        };
    }

    async start(_task: CodexTask, handle: RunnerHandle): Promise<void> {
        if (handle.containerName) {
            const state = await docker(["inspect", "-f", "{{.State.Running}}", handle.containerName]);
            if (state.stdout.trim() !== "true") {
                await docker(["start", handle.containerName]);
            }
        }
    }

    async openTerminal(_task: CodexTask, handle: RunnerHandle): Promise<ShellTerminal> {
        if (!handle.containerName) {
            throw new Error("container name missing");
        }
        const child = dockerSpawn(["exec", "-i", "-w", "/workspace", handle.containerName, "/bin/bash"]);
        const stream = new PassThrough() as NodeJS.ReadWriteStream;
        let closed = false;
        let disposed = false;
        stream.write = child.stdin.write.bind(child.stdin) as typeof stream.write;
        child.stdout.on("data", (chunk) => stream.emit("data", chunk));
        child.stderr.on("data", (chunk) => stream.emit("data", chunk));
        child.on("close", () => {
            closed = true;
            stream.emit("close");
        });
        return {
            stream,
            dispose: () => {
                if (disposed) return;
                disposed = true;
                try {
                    child.stdin.end();
                } catch {
                    // Process teardown is best-effort after the user closes the shell socket.
                }
                if (!closed && !child.killed) {
                    child.kill();
                }
            }
        };
    }

    async openEventStream(): Promise<AsyncIterable<TaskEvent>> {
        return (async function* () {})();
    }

    async sendPrompt(): Promise<void> {
        throw new Error("Codex bridge handles prompts for local Docker tasks");
    }

    async collect(): Promise<void> {
        return;
    }

    async stop(_task: CodexTask, handle: RunnerHandle): Promise<void> {
        if (handle.containerName) {
            await docker(["stop", handle.containerName]).catch(() => undefined);
        }
    }

    async destroy(_task: CodexTask, handle: RunnerHandle): Promise<void> {
        if (handle.containerName) {
            try {
                await docker(["rm", "-f", handle.containerName]);
            } catch (error) {
                if (!isMissingContainerError(error)) {
                    throw error;
                }
            }
        }
    }
}
