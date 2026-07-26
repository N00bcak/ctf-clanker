import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { prepareTaskCodexAuth, scrubTaskCodexHome } from "../server/src/codex/auth";
import { WebuiDatabase } from "../server/src/db";
import { createTask } from "../server/src/tasks/createTask";
import { testConfig, tempDir } from "./helpers";

const execFileAsync = promisify(execFile);

describe("Codex auth.json copying", () => {
    it("copies only auth.json into the task-local Codex home with private modes", () => {
        const root = tempDir();
        const config = testConfig(root);
        const sourceDir = path.dirname(config.codex.authJsonPath);
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(config.codex.authJsonPath, JSON.stringify({ token: "secret" }));
        fs.writeFileSync(path.join(sourceDir, "history.jsonl"), "do-not-copy");

        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "auth copy" }, config, db);
        prepareTaskCodexAuth(task, config);

        expect(fs.readFileSync(path.join(task.codexHomePath, "auth.json"), "utf8")).toContain("secret");
        expect(fs.existsSync(path.join(task.codexHomePath, "history.jsonl"))).toBe(false);
        expect((fs.statSync(task.codexHomePath).mode & 0o777).toString(8)).toBe("700");
        expect((fs.statSync(path.join(task.codexHomePath, "auth.json")).mode & 0o777).toString(8)).toBe("600");
    });

    it("fails clearly when auth.json is missing", () => {
        const root = tempDir();
        const config = testConfig(root);
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "missing auth" }, config, db);

        expect(() => prepareTaskCodexAuth(task, config)).toThrow(/Codex auth\.json not found/);
    });

    it("does not copy auth material for host-codex-cli or none modes", () => {
        for (const mode of ["host-codex-cli", "none"] as const) {
            const root = tempDir();
            const config = testConfig(root);
            config.codex.credentialMode = mode;
            const db = new WebuiDatabase(config);
            const task = createTask({ prompt: mode }, config, db);

            prepareTaskCodexAuth(task, config);
            expect(fs.existsSync(path.join(task.codexHomePath, "auth.json"))).toBe(false);
        }
    });

    it("scrubs runtime files while preserving auth.json", () => {
        const root = tempDir();
        const config = testConfig(root);
        const sourceDir = path.dirname(config.codex.authJsonPath);
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(config.codex.authJsonPath, JSON.stringify({ token: "secret" }));
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "scrub" }, config, db);
        prepareTaskCodexAuth(task, config);
        fs.mkdirSync(path.join(task.codexHomePath, "sessions"), { recursive: true });
        fs.writeFileSync(path.join(task.codexHomePath, "sessions", "session.json"), "{}");
        fs.writeFileSync(path.join(task.codexHomePath, "history.jsonl"), "history");
        fs.writeFileSync(path.join(task.codexHomePath, "codex.log"), "log");

        scrubTaskCodexHome(task);

        expect(fs.existsSync(path.join(task.codexHomePath, "auth.json"))).toBe(true);
        expect(fs.existsSync(path.join(task.codexHomePath, "sessions"))).toBe(false);
        expect(fs.existsSync(path.join(task.codexHomePath, "history.jsonl"))).toBe(false);
        expect(fs.existsSync(path.join(task.codexHomePath, "codex.log"))).toBe(false);
    });

    it("generates transport keys under a temporary CODEX_HOME and protects overwrite", async () => {
        const root = tempDir();
        const script = path.resolve("scripts/generate-codex-transport-key.sh");
        const env = { ...process.env, CODEX_HOME: root };
        const keyPath = path.join(root, "mecha-webui", "transport_ed25519");

        await execFileAsync(script, [], { env });
        expect(fs.existsSync(keyPath)).toBe(true);
        expect(fs.existsSync(`${keyPath}.pub`)).toBe(true);
        expect((fs.statSync(path.dirname(keyPath)).mode & 0o777).toString(8)).toBe("700");
        expect((fs.statSync(keyPath).mode & 0o777).toString(8)).toBe("600");

        await expect(execFileAsync(script, [], { env })).rejects.toThrow();
        await execFileAsync(script, ["--force"], { env });
        expect(fs.existsSync(keyPath)).toBe(true);
    });
});
