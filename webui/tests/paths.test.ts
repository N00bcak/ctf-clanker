import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspacePath, resolveWorkspaceReadPath, resolveWorkspaceWritePath } from "../server/src/utils/paths";
import { tempDir } from "./helpers";

describe("safe workspace paths", () => {
    it("rejects traversal, encoded traversal, absolute paths, and NUL bytes", () => {
        const root = tempDir();
        expect(() => resolveWorkspacePath(root, "../x")).toThrow(/escapes/);
        expect(() => resolveWorkspacePath(root, "%2e%2e/x")).toThrow(/escapes/);
        expect(() => resolveWorkspacePath(root, "/tmp/x")).toThrow(/absolute/);
        expect(() => resolveWorkspacePath(root, "a\0b")).toThrow(/NUL/);
    });

    it("allows normal nested writes", () => {
        const root = tempDir();
        const file = resolveWorkspaceWritePath(root, "a/b.txt");
        fs.writeFileSync(file, "ok");
        expect(fs.readFileSync(resolveWorkspaceReadPath(root, "a/b.txt"), "utf8")).toBe("ok");
    });

    it("rejects symlink reads that escape the workspace", () => {
        const root = tempDir();
        const outside = tempDir();
        fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
        fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link"));
        expect(() => resolveWorkspaceReadPath(root, "link")).toThrow(/symlink escapes/);
    });
});
