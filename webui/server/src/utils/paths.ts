import fs from "node:fs";
import path from "node:path";

export function decodeClientPath(requestedPath: string): string {
    try {
        return decodeURIComponent(requestedPath);
    } catch {
        throw new Error("invalid URL encoding");
    }
}

export function resolveSafeChild(root: string, requestedPath: string): string {
    const decoded = decodeClientPath(requestedPath);
    if (decoded.includes("\0")) {
        throw new Error("NUL byte rejected");
    }
    if (path.isAbsolute(decoded)) {
        throw new Error("absolute paths rejected");
    }
    const base = path.resolve(root);
    const resolved = path.resolve(base, decoded);
    const relative = path.relative(base, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("path escapes workspace");
    }
    return resolved;
}

export function assertRealPathUnder(root: string, target: string): void {
    const baseReal = fs.realpathSync(root);
    const targetReal = fs.realpathSync(target);
    const relative = path.relative(baseReal, targetReal);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("symlink escapes workspace");
    }
}

export function resolveWorkspacePath(storageRoot: string, requestedPath: string): string {
    return resolveSafeChild(storageRoot, requestedPath);
}

export function resolveWorkspaceReadPath(storageRoot: string, requestedPath: string): string {
    const resolved = resolveWorkspacePath(storageRoot, requestedPath);
    assertRealPathUnder(storageRoot, resolved);
    return resolved;
}

export function resolveWorkspaceWritePath(storageRoot: string, requestedPath: string): string {
    const resolved = resolveWorkspacePath(storageRoot, requestedPath);
    const parent = path.dirname(resolved);
    fs.mkdirSync(parent, { recursive: true });
    assertRealPathUnder(storageRoot, parent);
    if (fs.existsSync(resolved)) {
        const stat = fs.lstatSync(resolved);
        if (stat.isSymbolicLink()) {
            assertRealPathUnder(storageRoot, resolved);
        }
    }
    return resolved;
}

export function isDeniedHostPath(source: string, denied: string[], home = process.env.HOME ?? ""): boolean {
    const expandedSource = source.replace(/^~(?=$|\/)/, home);
    const sourceReal = path.resolve(expandedSource);
    return denied.some((entry) => {
        const expandedEntry = entry.replace(/^~(?=$|\/)/, home);
        const deniedPath = path.resolve(expandedEntry);
        return sourceReal === deniedPath || sourceReal.startsWith(`${deniedPath}${path.sep}`);
    });
}
