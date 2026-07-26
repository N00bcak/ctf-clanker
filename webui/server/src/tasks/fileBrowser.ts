import fs from "node:fs";
import path from "node:path";
import type { CodexTask, WebuiConfig } from "../types.js";
import { enforceTaskQuota } from "../utils/quota.js";
import {
    assertRealPathUnder,
    resolveWorkspacePath,
    resolveWorkspaceReadPath,
    resolveWorkspaceWritePath
} from "../utils/paths.js";

export interface FileEntry {
    name: string;
    path: string;
    type: "file" | "directory" | "symlink" | "other";
    size: number;
}

function entryType(stat: fs.Stats): FileEntry["type"] {
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
}

export function listFiles(task: CodexTask, requestedPath = ""): FileEntry[] {
    const root = task.storagePath;
    const target = requestedPath ? resolveWorkspaceReadPath(root, requestedPath) : root;
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory()) {
        throw new Error("path is not a directory");
    }
    return fs.readdirSync(target).map((name) => {
        const fullPath = path.join(target, name);
        const childStat = fs.lstatSync(fullPath);
        const relative = path.relative(root, fullPath);
        return {
            name,
            path: relative,
            type: entryType(childStat),
            size: childStat.size
        };
    });
}

export function readFile(task: CodexTask, requestedPath: string): Buffer {
    const target = resolveWorkspaceReadPath(task.storagePath, requestedPath);
    const stat = fs.lstatSync(target);
    if (!stat.isFile()) {
        throw new Error("path is not a file");
    }
    return fs.readFileSync(target);
}

export function writeFile(task: CodexTask, requestedPath: string, body: Buffer, config: WebuiConfig): void {
    enforceTaskQuota(path.dirname(task.storagePath), config, body.byteLength);
    const target = resolveWorkspaceWritePath(task.storagePath, requestedPath);
    fs.writeFileSync(target, body);
}

export function deleteFile(task: CodexTask, requestedPath: string): void {
    const target = resolveWorkspacePath(task.storagePath, requestedPath);
    if (target === task.storagePath) {
        throw new Error("cannot delete workspace root");
    }
    const parent = path.dirname(target);
    assertRealPathUnder(task.storagePath, parent);
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) {
        fs.rmdirSync(target);
    } else {
        fs.unlinkSync(target);
    }
}
