import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { WebuiConfig } from "../server/src/types";

export function tempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "mecha-webui-test-"));
}

export function testConfig(root = tempDir()): WebuiConfig {
    return {
        server: {
            host: "127.0.0.1",
            port: 8787,
            auth: { mode: "none", tokenEnv: "WEBUI_AUTH_TOKEN" }
        },
        paths: { cacheDir: root },
        sqlite: { path: path.join(root, "webui.sqlite3"), wal: true, busyTimeoutMs: 5000 },
        codex: {
            credentialMode: "codex-auth-json",
            authJsonPath: path.join(root, "host-codex", "auth.json"),
            hostCliPath: "auto",
            hostCliSandbox: "workspace-write",
            hostCliApprovalPolicy: "never",
            allowTerminalCredentialEnv: false,
            failIfMissingCredential: true,
            codexHomeRetention: "purge-after-run"
        },
        network: { mode: "open", enforcement: "open-warning", allow: [] },
        limits: {
            attachments: {
                maxFiles: 2,
                maxFileBytes: 8,
                maxTotalBytes: 12
            },
            taskCacheDirQuotaMb: 8,
            quotaEnforcement: "soft",
            maxLogBytesPerFile: 1024 * 1024
        },
        local: {
            enabled: true,
            concurrency: 1,
            provider: "docker",
            dockerHost: "auto",
            runnerImage: "mecha-codex-runner:base",
            defaultCpu: 1,
            defaultMemoryMb: 1024,
            pidsLimit: 512
        },
        cloud: {
            provider: "digitalocean",
            enabled: false,
            dryRun: true,
            liveEnvGuard: "WEBUI_CLOUD_LIVE",
            region: "nyc3",
            image: "ubuntu-24-04-x64",
            defaultSize: "s-1vcpu-1gb",
            maxConcurrent: 3,
            idleTtlMinutes: 15,
            hardTtlMinutes: 240,
            destroyOnFinish: true,
            backups: false,
            snapshots: false,
            sshUser: "root",
            sshKeyPath: path.join(root, "transport_ed25519"),
            sshPublicKeyPath: path.join(root, "transport_ed25519.pub"),
            sshKeyName: "mecha-webui-test"
        },
        security: {
            reaperGraceSeconds: 120,
            globalOrphanTtlMinutes: 30,
            reaperOrphanPolicy: "report",
            denyHostMounts: ["/", "~", "~/.ssh", "~/.codex", "~/.config", "~/.aws", "~/.docker"],
            allowRepoAssetMounts: true
        }
    };
}
