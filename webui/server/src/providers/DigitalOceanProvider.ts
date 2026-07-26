import { PassThrough } from "node:stream";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT } from "../config.js";
import { expandHome, prepareTaskCodexAuth } from "../codex/auth.js";
import type { CodexTask, ProvisioningIntent, ProvisioningPlan, RunnerHandle, TaskEvent, WebuiConfig } from "../types.js";
import type { RunnerProvider, ShellTerminal } from "./Provider.js";

const execFileAsync = promisify(execFile);
const DO_API = "https://api.digitalocean.com/v2";

interface DigitalOceanSshKey {
    id?: number;
    fingerprint?: string;
    name?: string;
}

interface DigitalOceanDroplet {
    id: number;
    name: string;
    status?: string;
    networks?: {
        v4?: Array<{ ip_address: string; type: string }>;
    };
}

function token(): string {
    const value = process.env.DIGITALOCEAN_TOKEN ?? process.env.DO_API_TOKEN;
    if (!value) {
        throw new Error("DigitalOcean live calls require host-side DIGITALOCEAN_TOKEN or DO_API_TOKEN");
    }
    return value;
}

async function doRequest<T>(endpoint: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${DO_API}${endpoint}`, {
        ...init,
        headers: {
            "authorization": `Bearer ${token()}`,
            "content-type": "application/json",
            ...(init.headers ?? {})
        }
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`DigitalOcean API ${endpoint} failed: ${response.status} ${body.slice(0, 500)}`);
    }
    return response.json() as Promise<T>;
}

export function digitalOceanDropletPayload(task: CodexTask, config: WebuiConfig, sshKey: string | number): Record<string, unknown> {
    return {
        name: `mecha-task-${task.id}`,
        region: config.cloud.region,
        size: config.cloud.defaultSize,
        image: config.cloud.image,
        ssh_keys: [sshKey],
        backups: config.cloud.backups,
        tags: ["mecha-webui", `task:${task.id}`],
        user_data: [
            "#cloud-config",
            "package_update: true",
            "packages:",
            "  - git",
            "  - curl",
            "  - ca-certificates",
            "  - nodejs",
            "  - npm",
            "runcmd:",
            "  - mkdir -p /workspace /mecha/families /mecha/templates /mecha/shared /root/.codex",
            "  - chmod 700 /root/.codex",
            "  - npm install -g @openai/codex"
        ].join("\n")
    };
}

export function assertDigitalOceanMetadataId(actual: string, expected: string): void {
    if (actual.trim() !== expected) {
        throw new Error(`DigitalOcean metadata id mismatch: expected ${expected}, got ${actual.trim()}`);
    }
}

export class DigitalOceanProvider implements RunnerProvider {
    constructor(private readonly config: WebuiConfig) {}

    describeProvisioning(task: CodexTask): ProvisioningPlan {
        return {
            backend: "digitalocean",
            expectedResourceName: `mecha-task-${task.id}`,
            labels: {
                "mecha-webui": "true",
                task_id: task.id
            }
        };
    }

    private assertLiveAllowed(): void {
        if (this.config.cloud.dryRun) {
            return;
        }
        if (!this.config.cloud.enabled || process.env[this.config.cloud.liveEnvGuard] !== "1") {
            throw new Error("DigitalOcean live calls require enabled cloud config and live env guard");
        }
        token();
    }

    async provision(task: CodexTask, intent: ProvisioningIntent): Promise<RunnerHandle> {
        this.assertLiveAllowed();
        const keyRef = this.config.cloud.sshPublicKeyPath ? expandHome(this.config.cloud.sshPublicKeyPath) : "";
        const payload = digitalOceanDropletPayload(task, this.config, keyRef || this.config.cloud.sshKeyName);
        const handle: RunnerHandle = {
            provider: "digitalocean",
            taskId: task.id,
            intentId: intent.id,
            dropletId: this.config.cloud.dryRun ? `dry-run-${task.id}` : undefined,
            sshHost: undefined,
            providerPayload: {
                droplet: payload,
                snapshots: this.config.cloud.snapshots
            },
            createdAt: new Date().toISOString()
        };
        return handle;
    }

    async start(task: CodexTask, handle: RunnerHandle): Promise<void> {
        if (this.config.cloud.dryRun) {
            return;
        }
        if (handle.sshHost && handle.dropletId) {
            return;
        }
        prepareTaskCodexAuth(task, this.config);
        const sshKey = await this.ensureSshKey();
        const payload = digitalOceanDropletPayload(task, this.config, sshKey.fingerprint ?? sshKey.id ?? this.config.cloud.sshKeyName);
        const created = await doRequest<{ droplet: DigitalOceanDroplet }>("/droplets", {
            method: "POST",
            body: JSON.stringify(payload)
        });
        handle.dropletId = String(created.droplet.id);
        const droplet = await this.waitForDroplet(created.droplet.id);
        const host = this.publicIpv4(droplet);
        if (!host) {
            throw new Error("DigitalOcean droplet did not expose a public IPv4 address");
        }
        handle.sshHost = host;
        await this.waitForSsh(host);
        await this.verifyDropletMetadata(host, String(created.droplet.id));
        await this.remoteExec(host, "mkdir -p /workspace /mecha/families /mecha/templates /mecha/shared /root/.codex && chmod 700 /root/.codex");
        await this.scpDirectory(path.join(task.storagePath, "."), `${this.config.cloud.sshUser}@${host}:/workspace/`);
        await this.scpDirectory(path.join(REPO_ROOT, "families", "."), `${this.config.cloud.sshUser}@${host}:/mecha/families/`);
        await this.scpDirectory(path.join(REPO_ROOT, "templates", "."), `${this.config.cloud.sshUser}@${host}:/mecha/templates/`);
        await this.scpDirectory(path.join(REPO_ROOT, "shared", "."), `${this.config.cloud.sshUser}@${host}:/mecha/shared/`);
        await this.scpFile(path.join(task.codexHomePath, "auth.json"), `${this.config.cloud.sshUser}@${host}:/root/.codex/auth.json`);
        await this.remoteExec(host, "chmod 600 /root/.codex/auth.json && chmod -R a-w /mecha");
    }

    private async ensureSshKey(): Promise<DigitalOceanSshKey> {
        const publicKeyPath = expandHome(this.config.cloud.sshPublicKeyPath);
        if (!fs.existsSync(publicKeyPath)) {
            throw new Error(`DigitalOcean SSH public key not found at ${publicKeyPath}; run webui/scripts/generate-codex-transport-key.sh`);
        }
        const publicKey = fs.readFileSync(publicKeyPath, "utf8").trim();
        const listed = await doRequest<{ ssh_keys: DigitalOceanSshKey[] }>("/account/keys?per_page=200");
        const existing = listed.ssh_keys.find((key) => key.name === this.config.cloud.sshKeyName || key.fingerprint === publicKey);
        if (existing) {
            return existing;
        }
        const created = await doRequest<{ ssh_key: DigitalOceanSshKey }>("/account/keys", {
            method: "POST",
            body: JSON.stringify({ name: this.config.cloud.sshKeyName, public_key: publicKey })
        });
        return created.ssh_key;
    }

    private async waitForDroplet(id: number): Promise<DigitalOceanDroplet> {
        for (let attempt = 0; attempt < 60; attempt += 1) {
            const result = await doRequest<{ droplet: DigitalOceanDroplet }>(`/droplets/${id}`);
            const host = this.publicIpv4(result.droplet);
            if (result.droplet.status === "active" && host) {
                return result.droplet;
            }
            await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        throw new Error(`DigitalOcean droplet ${id} did not become active`);
    }

    private publicIpv4(droplet: DigitalOceanDroplet): string | undefined {
        return droplet.networks?.v4?.find((network) => network.type === "public")?.ip_address;
    }

    private sshArgs(host: string, extra: string[] = []): string[] {
        return [
            "-i",
            expandHome(this.config.cloud.sshKeyPath),
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "UserKnownHostsFile=~/.ssh/known_hosts",
            ...extra,
            `${this.config.cloud.sshUser}@${host}`
        ];
    }

    private async waitForSsh(host: string): Promise<void> {
        for (let attempt = 0; attempt < 60; attempt += 1) {
            try {
                await this.remoteExec(host, "true");
                return;
            } catch {
                await new Promise((resolve) => setTimeout(resolve, 5000));
            }
        }
        throw new Error(`SSH did not become ready for ${host}`);
    }

    private async verifyDropletMetadata(host: string, dropletId: string): Promise<void> {
        const result = await this.remoteExec(host, "curl -fsS http://169.254.169.254/metadata/v1/id");
        assertDigitalOceanMetadataId(result, dropletId);
    }

    private async remoteExec(host: string, command: string): Promise<string> {
        const result = await execFileAsync("ssh", [...this.sshArgs(host), command], { maxBuffer: 20 * 1024 * 1024 });
        return result.stdout;
    }

    private async scpFile(source: string, destination: string): Promise<void> {
        await execFileAsync("scp", [
            "-i",
            expandHome(this.config.cloud.sshKeyPath),
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "UserKnownHostsFile=~/.ssh/known_hosts",
            source,
            destination
        ], { maxBuffer: 20 * 1024 * 1024 });
    }

    private async scpDirectory(source: string, destination: string): Promise<void> {
        await execFileAsync("scp", [
            "-r",
            "-i",
            expandHome(this.config.cloud.sshKeyPath),
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "UserKnownHostsFile=~/.ssh/known_hosts",
            source,
            destination
        ], { maxBuffer: 20 * 1024 * 1024 });
    }

    async openTerminal(_task: CodexTask, handle: RunnerHandle): Promise<ShellTerminal> {
        if (!this.config.cloud.dryRun && handle.sshHost) {
            const child = spawn("ssh", [...this.sshArgs(handle.sshHost), "cd /workspace && exec bash"], { stdio: ["pipe", "pipe", "pipe"] });
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
        const stream = new PassThrough() as NodeJS.ReadWriteStream;
        let disposed = false;
        queueMicrotask(() => {
            if (disposed) return;
            stream.emit("data", Buffer.from("DigitalOcean dry-run terminal is not live.\n"));
            stream.emit("close");
        });
        return {
            stream,
            dispose: () => {
                disposed = true;
                stream.end();
            }
        };
    }

    async openEventStream(): Promise<AsyncIterable<TaskEvent>> {
        return (async function* () {})();
    }

    async sendPrompt(): Promise<void> {
        throw new Error("Codex app-server bridge handles prompts for DigitalOcean tasks");
    }

    async collect(): Promise<void> {
        return;
    }

    async stop(_task: CodexTask, handle: RunnerHandle): Promise<void> {
        if (!this.config.cloud.dryRun && handle.sshHost) {
            await this.remoteExec(handle.sshHost, "pkill -f 'codex app-server' || true").catch(() => undefined);
        }
    }

    async destroy(_task: CodexTask, handle: RunnerHandle): Promise<void> {
        if (!this.config.cloud.dryRun && handle.dropletId) {
            await doRequest(`/droplets/${handle.dropletId}`, { method: "DELETE" });
        }
    }
}
