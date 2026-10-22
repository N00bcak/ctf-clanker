import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.js";
import { expandHome, prepareTaskCodexAuth } from "../codex/auth.js";
import type { CodexTask, ProvisioningIntent, ProvisioningPlan, RunnerHandle, TaskEvent, WebuiConfig, WorkspaceCollection } from "../types.js";
import type { RunnerProvider, ShellTerminal } from "./Provider.js";
import { runWorkspaceCommand, WorkspaceTransfer, type WorkspaceCommand } from "./workspaceTransfer.js";

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
    tags?: string[];
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

export function digitalOceanDropletPayload(task: CodexTask, config: WebuiConfig, sshKey: string | number, intentId?: string): Record<string, unknown> {
    return {
        name: `mecha-task-${task.id}`,
        region: config.cloud.region,
        size: config.cloud.defaultSize,
        image: config.cloud.image,
        ssh_keys: [sshKey],
        backups: config.cloud.backups,
        tags: ["mecha-webui", `task:${task.id}`, ...(intentId ? [`intent:${intentId}`] : [])],
        user_data: [
            "#cloud-config",
            "package_update: true",
            "packages:",
            "  - git",
            "  - curl",
            "  - ca-certificates",
            "  - nodejs",
            "  - npm",
            "  - rsync",
            "runcmd:",
            "  - mkdir -p /workspace /etc/codex/skills /root/.codex",
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
    private readonly transfer: WorkspaceTransfer;
    private readonly fetch: typeof fetch;
    private readonly runCommand: WorkspaceCommand;

    constructor(private readonly config: WebuiConfig, dependencies: { fetch?: typeof fetch; runCommand?: WorkspaceCommand } = {}) {
        this.fetch = dependencies.fetch ?? globalThis.fetch;
        this.runCommand = dependencies.runCommand ?? runWorkspaceCommand;
        this.transfer = new WorkspaceTransfer(config, this.runCommand);
    }

    private async doRequest<T>(endpoint: string, init: RequestInit = {}, deleting = false): Promise<T> {
        const response = await this.fetch(`${DO_API}${endpoint}`, {
            ...init,
            headers: { authorization: `Bearer ${token()}`, "content-type": "application/json", ...(init.headers ?? {}) }
        });
        if (deleting && response.status === 404) return undefined as T;
        const body = await response.text();
        if (!response.ok) {
            throw Object.assign(new Error(`DigitalOcean API ${endpoint} failed: ${response.status} ${body.slice(0, 500)}`), { httpStatus: response.status });
        }
        return (body.trim() ? JSON.parse(body) : undefined) as T;
    }

    private realResource(handle: RunnerHandle): boolean {
        return Boolean(handle.sshHost || handle.dropletId && !handle.dropletId.startsWith("dry-run-") || handle.providerPayload?.creationRequested);
    }

    private assertCleanupAllowed(handle: RunnerHandle): boolean {
        if (this.config.cloud.dryRun && this.realResource(handle)) {
            throw new Error("Live runner cleanup is blocked by cloud dry-run; the resource record was preserved");
        }
        return !this.config.cloud.dryRun && this.realResource(handle);
    }

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
        const payload = digitalOceanDropletPayload(task, this.config, keyRef || this.config.cloud.sshKeyName, intent.id);
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

    async start(task: CodexTask, handle: RunnerHandle, persistHandle: (handle: RunnerHandle) => void = () => undefined): Promise<void> {
        if (this.config.cloud.dryRun) {
            if (this.realResource(handle)) throw new Error("Live runner start is blocked by cloud dry-run");
            return;
        }
        this.assertLiveAllowed();
        if (task.workspaceSync?.owner === "remote") throw new Error("Collect the remote workspace before restarting the runner");
        await this.transfer.preflight();
        prepareTaskCodexAuth(task, this.config);
        if (!handle.dropletId || handle.dropletId.startsWith("dry-run-")) {
            const recovered = await this.recover(task, this.intentFor(task, handle));
            if (recovered) Object.assign(handle, recovered);
            else {
                if (handle.providerPayload?.creationRequested) throw new Error("Previous cloud creation outcome is unknown; confirm resource cleanup before retrying");
                const sshKey = await this.ensureSshKey();
                const payload = digitalOceanDropletPayload(task, this.config, sshKey.fingerprint ?? sshKey.id ?? this.config.cloud.sshKeyName, handle.intentId);
                handle.providerPayload = { ...handle.providerPayload, creationRequested: true };
                persistHandle(handle);
                try {
                    const created = await this.doRequest<{ droplet: DigitalOceanDroplet }>("/droplets", { method: "POST", body: JSON.stringify(payload) });
                    handle.dropletId = String(created.droplet.id);
                } catch (error) {
                    if (typeof error === "object" && error && "httpStatus" in error && Number(error.httpStatus) < 500) {
                        handle.providerPayload = { ...handle.providerPayload, creationRequested: false };
                        persistHandle(handle);
                    }
                    throw error;
                }
            }
            persistHandle(handle);
        }
        const droplet = await this.waitForDroplet(Number(handle.dropletId));
        const host = this.publicIpv4(droplet);
        if (!host) {
            throw new Error("DigitalOcean droplet did not expose a public IPv4 address");
        }
        handle.sshHost = host;
        persistHandle(handle);
        await this.waitForSsh(host);
        await this.verifyDropletMetadata(host, handle.dropletId!);
        if (!handle.bootstrapComplete) {
            await this.remoteExec(host, "mkdir -p /workspace /etc/codex/skills /root/.codex && chmod 700 /root/.codex && (command -v rsync >/dev/null || (apt-get update && apt-get install -y rsync))");
            await this.scpDirectory(path.join(REPO_ROOT, "families", "ctf", "."), `${this.config.cloud.sshUser}@${host}:/etc/codex/skills/`);
        }
        await this.scpFile(path.join(task.codexHomePath, "auth.json"), `${this.config.cloud.sshUser}@${host}:/root/.codex/auth.json`);
        await this.remoteExec(host, "chmod 600 /root/.codex/auth.json && chmod -R a-w /etc/codex/skills");
        handle.bootstrapComplete = true;
        persistHandle(handle);
        await this.transfer.upload(task, handle);
    }

    private intentFor(task: CodexTask, handle: RunnerHandle): ProvisioningIntent {
        return { id: handle.intentId, taskId: task.id, backend: "digitalocean", expectedResourceName: `mecha-task-${task.id}`,
            createdAt: handle.createdAt, reaperGraceUntil: handle.createdAt, status: "attached" };
    }

    async recover(task: CodexTask, intent: ProvisioningIntent): Promise<RunnerHandle | undefined> {
        if (this.config.cloud.dryRun) throw new Error("Cannot confirm interrupted live provisioning while cloud dry-run is enabled");
        const matches: DigitalOceanDroplet[] = [];
        for (let page = 1; ; page++) {
            const result = await this.doRequest<{ droplets: DigitalOceanDroplet[] }>(`/droplets?tag_name=${encodeURIComponent(`intent:${intent.id}`)}&per_page=200&page=${page}`);
            matches.push(...result.droplets.filter(droplet => droplet.name === intent.expectedResourceName
                && droplet.tags?.includes("mecha-webui") && droplet.tags.includes(`task:${task.id}`) && droplet.tags.includes(`intent:${intent.id}`)));
            if (result.droplets.length < 200) break;
        }
        if (matches.length > 1) throw new Error("Multiple cloud resources match this task intent; refusing ambiguous recovery");
        const droplet = matches[0];
        return droplet ? { provider: "digitalocean", taskId: task.id, intentId: intent.id, dropletId: String(droplet.id),
            sshHost: this.publicIpv4(droplet), bootstrapComplete: false, createdAt: intent.createdAt } : undefined;
    }

    private async ensureSshKey(): Promise<DigitalOceanSshKey> {
        const publicKeyPath = expandHome(this.config.cloud.sshPublicKeyPath);
        if (!fs.existsSync(publicKeyPath)) {
            throw new Error(`DigitalOcean SSH public key not found at ${publicKeyPath}; run webui/scripts/generate-codex-transport-key.sh`);
        }
        const publicKey = fs.readFileSync(publicKeyPath, "utf8").trim();
        const listed = await this.doRequest<{ ssh_keys: DigitalOceanSshKey[] }>("/account/keys?per_page=200");
        const existing = listed.ssh_keys.find((key) => key.name === this.config.cloud.sshKeyName || key.fingerprint === publicKey);
        if (existing) {
            return existing;
        }
        const created = await this.doRequest<{ ssh_key: DigitalOceanSshKey }>("/account/keys", {
            method: "POST",
            body: JSON.stringify({ name: this.config.cloud.sshKeyName, public_key: publicKey })
        });
        return created.ssh_key;
    }

    private async waitForDroplet(id: number): Promise<DigitalOceanDroplet> {
        for (let attempt = 0; attempt < 60; attempt += 1) {
            const result = await this.doRequest<{ droplet: DigitalOceanDroplet }>(`/droplets/${id}`);
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
        const args = this.transfer.sshArgs(host);
        return [...args.slice(0, -1), ...extra, args.at(-1)!];
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
        const result = await this.runCommand("ssh", [...this.sshArgs(host), command], { timeout: 300_000 });
        return result.stdout;
    }

    private async scpFile(source: string, destination: string): Promise<void> {
        await this.runCommand("scp", [
            "-i",
            expandHome(this.config.cloud.sshKeyPath),
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "UserKnownHostsFile=~/.ssh/known_hosts",
            source,
            destination
        ], { timeout: 120_000 });
    }

    private async scpDirectory(source: string, destination: string): Promise<void> {
        await this.runCommand("scp", [
            "-r",
            "-i",
            expandHome(this.config.cloud.sshKeyPath),
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "UserKnownHostsFile=~/.ssh/known_hosts",
            source,
            destination
        ], { timeout: 120_000 });
    }

    async openTerminal(_task: CodexTask, handle: RunnerHandle): Promise<ShellTerminal> {
        this.assertCleanupAllowed(handle);
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

    async collect(task: CodexTask, handle: RunnerHandle, options: { mode: "snapshot" | "final"; signal?: AbortSignal } = { mode: "final" }): Promise<WorkspaceCollection | void> {
        if (!this.assertCleanupAllowed(handle)) return;
        if (!handle.sshHost) throw new Error("Cannot collect cloud workspace without a confirmed SSH host");
        return this.transfer.collect(task, handle, options);
    }

    async stop(task: CodexTask, handle: RunnerHandle): Promise<void> {
        if (!this.assertCleanupAllowed(handle)) return;
        await this.recoverUncertainHandle(task, handle);
        if (handle.sshHost) {
            await this.remoteExec(handle.sshHost, "pkill -f '[c]odex.*app-server' || true");
        }
    }

    private async recoverUncertainHandle(task: CodexTask, handle: RunnerHandle): Promise<void> {
        if ((!handle.dropletId || handle.dropletId.startsWith("dry-run-")) && handle.providerPayload?.creationRequested) {
            const recovered = await this.recover(task, this.intentFor(task, handle));
            if (!recovered) throw new Error("Cloud creation outcome is unknown; resource cleanup must be confirmed before releasing its record");
            Object.assign(handle, recovered);
        }
    }

    async destroy(task: CodexTask, handle: RunnerHandle): Promise<void> {
        if (!this.assertCleanupAllowed(handle)) return;
        await this.recoverUncertainHandle(task, handle);
        if (handle.dropletId && !handle.dropletId.startsWith("dry-run-")) {
            await this.doRequest(`/droplets/${handle.dropletId}`, { method: "DELETE" }, true);
        }
    }
}
