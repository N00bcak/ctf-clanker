import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { NetworkEnforcement, NetworkMode, WebuiConfig } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const WEBUI_ROOT = path.resolve(__dirname, "../..");
export const REPO_ROOT = path.resolve(WEBUI_ROOT, "..");

function assertNumber(value: unknown, name: string): asserts value is number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Invalid numeric config value: ${name}`);
    }
}

export function resolveFromRepoRoot(configPath: string): string {
    return path.isAbsolute(configPath) ? configPath : path.resolve(REPO_ROOT, configPath);
}

export function isLoopbackHost(host: string): boolean {
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function validateServerExposure(config: WebuiConfig, env = process.env): void {
    if (isLoopbackHost(config.server.host)) {
        return;
    }
    if (config.server.auth.mode === "token") {
        const token = env[config.server.auth.tokenEnv];
        if (!token) {
            throw new Error(`Non-loopback server host requires non-empty ${config.server.auth.tokenEnv}`);
        }
        return;
    }
    if (env.WEBUI_UNSAFE_ALLOW_NO_AUTH !== "1") {
        throw new Error("Non-loopback server host requires token auth or WEBUI_UNSAFE_ALLOW_NO_AUTH=1");
    }
}

export function validateNetworkMode(mode: NetworkMode, enforcement: NetworkEnforcement): void {
    if (mode === "open" && enforcement === "open-warning") {
        return;
    }
    if (mode === "none" && enforcement === "docker-none") {
        return;
    }
    if (mode === "codex-only" && !["sidecar-proxy", "host-firewall", "broker"].includes(enforcement)) {
        throw new Error("network.mode codex-only requires real egress enforcement");
    }
    if (mode === "proxy-allowlist" && enforcement !== "sidecar-proxy") {
        throw new Error("network.mode proxy-allowlist requires sidecar-proxy enforcement");
    }
}

export function loadConfig(configFile = path.join(WEBUI_ROOT, "config/default.yaml"), env = process.env): WebuiConfig {
    const raw = fs.readFileSync(configFile, "utf8");
    const parsed = YAML.parse(raw) as WebuiConfig;

    assertNumber(parsed.server.port, "server.port");
    assertNumber(parsed.sqlite.busyTimeoutMs, "sqlite.busyTimeoutMs");
    assertNumber(parsed.limits.attachments.maxFiles, "limits.attachments.maxFiles");
    assertNumber(parsed.limits.attachments.maxFileBytes, "limits.attachments.maxFileBytes");
    assertNumber(parsed.limits.attachments.maxTotalBytes, "limits.attachments.maxTotalBytes");
    assertNumber(parsed.limits.taskCacheDirQuotaMb, "limits.taskCacheDirQuotaMb");
    assertNumber(parsed.local.concurrency, "local.concurrency");
    validateServerExposure(parsed, env);
    validateNetworkMode(parsed.network.mode, parsed.network.enforcement);
    return parsed;
}
