import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import YAML from "yaml";
import { validateNetworkMode } from "../config.js";
import type { WebuiDatabase } from "../db.js";
import type { CodexTask, NetworkEnforcement, NetworkMode, WebuiConfig } from "../types.js";
import { isDeniedHostPath } from "../utils/paths.js";

export interface TaskPermissions {
    version: 1;
    network: {
        mode: NetworkMode;
        enforcement: NetworkEnforcement;
        allow: string[];
    };
    mounts: Array<{
        label: string;
        source: string;
        target: string;
        mode: "ro" | "rw" | "rx" | "rwx";
    }>;
}

export function defaultPermissions(config: WebuiConfig): TaskPermissions {
    return {
        version: 1,
        network: {
            mode: config.network.mode,
            enforcement: config.network.enforcement,
            allow: [...config.network.allow]
        },
        mounts: []
    };
}

export function validatePermissions(permissions: TaskPermissions, config: WebuiConfig): void {
    if (!permissions || typeof permissions !== "object" || permissions.version !== 1) {
        throw new Error("permissions.version must be 1");
    }
    if (!permissions.network || typeof permissions.network !== "object"
        || !["open", "none", "codex-only", "proxy-allowlist"].includes(permissions.network.mode)
        || !["open-warning", "docker-none", "sidecar-proxy", "host-firewall", "broker"].includes(permissions.network.enforcement)
        || !Array.isArray(permissions.network.allow) || permissions.network.allow.some((entry) => typeof entry !== "string")) {
        throw new Error("permissions.network must contain a supported mode, enforcement, and string allow list");
    }
    validateNetworkMode(permissions.network.mode, permissions.network.enforcement);
    if (!Array.isArray(permissions.mounts)) {
        throw new Error("permissions.mounts must be an array");
    }
    const labels = new Set<string>();
    const targets = new Set<string>();
    for (const mount of permissions.mounts) {
        if (!mount || typeof mount !== "object" || typeof mount.label !== "string"
            || !/^[a-zA-Z0-9_-]+$/.test(mount.label)) {
            throw new Error("invalid mount label");
        }
        if (labels.has(mount.label)) {
            throw new Error(`duplicate mount label: ${mount.label}`);
        }
        labels.add(mount.label);
        if (typeof mount.source !== "string" || !mount.source || /[:\0\r\n]/.test(mount.source)
            || typeof mount.target !== "string" || /[:\0\r\n]/.test(mount.target)
            || !["ro", "rw", "rx", "rwx"].includes(mount.mode)) {
            throw new Error("mount must contain valid source, target, and mode values");
        }
        const source = path.resolve(mount.source.replace(/^~(?=$|\/)/, process.env.HOME ?? ""));
        if (isDeniedHostPath(source, config.security.denyHostMounts)) {
            throw new Error(`mount source is denied: ${mount.source}`);
        }
        if (!fs.existsSync(source)) {
            throw new Error(`mount source does not exist: ${mount.source}`);
        }
        const realDeniedPaths = config.security.denyHostMounts.map((entry) => {
            const expanded = path.resolve(entry.replace(/^~(?=$|\/)/, process.env.HOME ?? ""));
            return fs.existsSync(expanded) ? fs.realpathSync(expanded) : expanded;
        });
        if (isDeniedHostPath(fs.realpathSync(source), realDeniedPaths)) {
            throw new Error(`mount source is denied: ${mount.source}`);
        }
        if (!mount.target.startsWith("/mnt/extra/") || mount.target === "/mnt/extra/"
            || path.posix.normalize(mount.target) !== mount.target) {
            throw new Error("extra mounts must target /mnt/extra/<label>");
        }
        if (targets.has(mount.target)) {
            throw new Error(`duplicate mount target: ${mount.target}`);
        }
        targets.add(mount.target);
    }
}

export function supportedNetworkModes(task: Pick<CodexTask, "backend" | "codexRuntime">): NetworkMode[] {
    return task.backend === "local" && task.codexRuntime === "container" ? ["open", "none"] : ["open"];
}

export function assertTaskPermissions(task: CodexTask, permissions: TaskPermissions, config: WebuiConfig): void {
    validatePermissions(permissions, config);
    if (!supportedNetworkModes(task).includes(permissions.network.mode)) {
        throw new Error(`network mode ${permissions.network.mode} is unsupported for ${task.codexRuntime} tasks; supported modes: ${supportedNetworkModes(task).join(", ")}`);
    }
    if (permissions.mounts.length && (task.backend !== "local" || task.codexRuntime !== "container")) {
        throw new Error("extra mounts are supported only for local Docker tasks");
    }
}

export function permissionsFingerprint(permissions: TaskPermissions): string {
    const normalized = {
        version: permissions.version,
        network: {
            mode: permissions.network.mode,
            enforcement: permissions.network.enforcement,
            allow: [...permissions.network.allow].sort()
        },
        mounts: permissions.mounts.map((mount) => ({
            label: mount.label,
            source: mount.source,
            target: mount.target,
            mode: mount.mode
        })).sort((left, right) => left.label < right.label ? -1 : left.label > right.label ? 1 : 0)
    };
    return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function readPermissions(filePath: string, config: WebuiConfig): TaskPermissions {
    const permissions = YAML.parse(fs.readFileSync(filePath, "utf8")) as TaskPermissions;
    validatePermissions(permissions, config);
    return permissions;
}

export function writePermissions(filePath: string, permissions: TaskPermissions, config: WebuiConfig): void {
    validatePermissions(permissions, config);
    atomicWrite(filePath, YAML.stringify(permissions));
}

function atomicWrite(filePath: string, content: string | Buffer): void {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
        fs.writeFileSync(temporaryPath, content, { flag: "wx", mode: 0o600 });
        fs.renameSync(temporaryPath, filePath);
    } finally {
        fs.rmSync(temporaryPath, { force: true });
    }
}

function persistTaskPermissions(task: CodexTask, permissions: TaskPermissions, config: WebuiConfig, db: WebuiDatabase, saveManifest: boolean): CodexTask {
    assertTaskPermissions(task, permissions, config);
    const root = path.dirname(task.storagePath);
    const permissionsPath = path.join(root, "permissions.yaml");
    const taskPath = path.join(root, "task.yaml");
    const previousPermissions = fs.readFileSync(permissionsPath);
    const previousTask = fs.readFileSync(taskPath);
    const manifest: unknown = YAML.parse(previousTask.toString("utf8"));
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error("task.yaml must contain a task object");
    }
    if (!saveManifest && task.networkMode === permissions.network.mode
        && task.networkEnforcement === permissions.network.enforcement
        && "networkMode" in manifest && manifest.networkMode === permissions.network.mode
        && "networkEnforcement" in manifest && manifest.networkEnforcement === permissions.network.enforcement) {
        return task;
    }
    try {
        return db.withTransaction(() => {
            if (saveManifest) writePermissions(permissionsPath, permissions, config);
            atomicWrite(taskPath, YAML.stringify({
                ...manifest,
                networkMode: permissions.network.mode,
                networkEnforcement: permissions.network.enforcement
            }));
            db.updateTaskNetwork(task.id, permissions.network.mode, permissions.network.enforcement);
            const updated = db.getTask(task.id);
            if (!updated) throw new Error(`task no longer exists: ${task.id}`);
            return updated;
        });
    } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (const [filePath, content] of [[permissionsPath, previousPermissions], [taskPath, previousTask]] as const) {
            if (filePath === permissionsPath && !saveManifest) continue;
            try {
                atomicWrite(filePath, content);
            } catch (rollbackError) {
                rollbackErrors.push(rollbackError);
            }
        }
        if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "Saving permissions failed and restoring task manifests failed");
        throw error;
    }
}

export function saveTaskPermissions(task: CodexTask, permissions: TaskPermissions, config: WebuiConfig, db: WebuiDatabase): CodexTask {
    return persistTaskPermissions(task, permissions, config, db, true);
}

export function reconcileTaskPermissions(task: CodexTask, config: WebuiConfig, db: WebuiDatabase): CodexTask {
    const permissions = readPermissions(path.join(path.dirname(task.storagePath), "permissions.yaml"), config);
    return persistTaskPermissions(task, permissions, config, db, false);
}
