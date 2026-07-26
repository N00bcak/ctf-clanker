import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { validateNetworkMode } from "../config.js";
import type { NetworkEnforcement, NetworkMode, WebuiConfig } from "../types.js";
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
            allow: config.network.allow
        },
        mounts: []
    };
}

export function validatePermissions(permissions: TaskPermissions, config: WebuiConfig): void {
    validateNetworkMode(permissions.network.mode, permissions.network.enforcement);
    for (const mount of permissions.mounts) {
        if (!/^[a-zA-Z0-9_-]+$/.test(mount.label)) {
            throw new Error(`invalid mount label: ${mount.label}`);
        }
        const source = path.resolve(mount.source.replace(/^~(?=$|\/)/, process.env.HOME ?? ""));
        if (isDeniedHostPath(source, config.security.denyHostMounts)) {
            throw new Error(`mount source is denied: ${mount.source}`);
        }
        if (!fs.existsSync(source)) {
            throw new Error(`mount source does not exist: ${mount.source}`);
        }
        if (!mount.target.startsWith("/mnt/extra/")) {
            throw new Error("extra mounts must target /mnt/extra/<label>");
        }
    }
}

export function readPermissions(filePath: string, config: WebuiConfig): TaskPermissions {
    const permissions = YAML.parse(fs.readFileSync(filePath, "utf8")) as TaskPermissions;
    validatePermissions(permissions, config);
    return permissions;
}

export function writePermissions(filePath: string, permissions: TaskPermissions, config: WebuiConfig): void {
    validatePermissions(permissions, config);
    fs.writeFileSync(filePath, YAML.stringify(permissions));
}
