import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebuiDatabase } from "../server/src/db";
import { createTask } from "../server/src/tasks/createTask";
import { permissionsFingerprint, readPermissions, writePermissions } from "../server/src/tasks/permissions";
import { testConfig, tempDir } from "./helpers";
import type { RunnerHandle } from "../server/src/types";

vi.mock("../server/src/providers/docker", () => ({
    docker: vi.fn(),
    dockerSpawn: vi.fn(),
    detectDockerRuntime: vi.fn()
}));

const { detectDockerRuntime, docker, dockerSpawn } = await import("../server/src/providers/docker");
const { LocalDockerProvider } = await import("../server/src/providers/LocalDockerProvider");

beforeEach(() => vi.resetAllMocks());

describe("LocalDockerProvider", () => {
    it("mounts only the local CTF family as Codex skills", async () => {
        const root = tempDir();
        const config = testConfig(root);
        fs.mkdirSync(path.dirname(config.codex.authJsonPath), { recursive: true });
        fs.writeFileSync(config.codex.authJsonPath, "{}");
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "solve" }, config, db);
        vi.mocked(detectDockerRuntime).mockResolvedValueOnce({ ok: true, detail: "docker" });
        vi.mocked(docker).mockResolvedValueOnce({ stdout: "", stderr: "" });

        await new LocalDockerProvider(config).provision(task, {
            id: "intent",
            taskId: task.id,
            backend: "local",
            expectedResourceName: `mecha-task-${task.id}`,
            createdAt: new Date().toISOString(),
            reaperGraceUntil: new Date().toISOString(),
            status: "creating"
        });

        const args = vi.mocked(docker).mock.calls[0]?.[0] ?? [];
        const skillMount = args.find((arg) => arg.endsWith(":/etc/codex/skills:ro"));
        expect(skillMount).toMatch(/families[/\\]ctf:\/etc\/codex\/skills:ro$/);
        expect(args.some((arg) => arg.includes("/mecha/"))).toBe(false);
    });

    it("propagates Docker destroy failures but ignores verified missing containers", async () => {
        const config = testConfig(tempDir());
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "destroy" }, config, db);
        const handle: RunnerHandle = {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: `fake-${task.id}`,
            createdAt: new Date().toISOString()
        };
        const provider = new LocalDockerProvider(config);
        const dockerMock = vi.mocked(docker);

        dockerMock.mockRejectedValueOnce(Object.assign(new Error("permission denied"), { stderr: "permission denied" }));
        await expect(provider.destroy(task, handle)).rejects.toThrow(/permission denied/);

        dockerMock.mockRejectedValueOnce(Object.assign(new Error("No such container"), { stderr: "No such container" }));
        await expect(provider.destroy(task, handle)).resolves.toBeUndefined();
    });

    it("provisions from saved permissions and records their fingerprint without removing task files", async () => {
        const config = testConfig();
        config.codex.credentialMode = "none";
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "offline" }, config, db);
        const permissionsPath = path.join(path.dirname(task.storagePath), "permissions.yaml");
        const permissions = readPermissions(permissionsPath, config);
        permissions.network = { mode: "none", enforcement: "docker-none", allow: [] };
        writePermissions(permissionsPath, permissions, config);
        fs.writeFileSync(path.join(task.storagePath, "retained.txt"), "workspace");
        fs.mkdirSync(path.join(task.codexHomePath, "sessions"));
        fs.writeFileSync(path.join(task.codexHomePath, "sessions", "retained.jsonl"), "session");
        const provider = new LocalDockerProvider(config);
        const intent = db.createIntent(task, provider.describeProvisioning(task), 120);
        vi.mocked(detectDockerRuntime).mockResolvedValueOnce({ ok: true, detail: "docker" });
        vi.mocked(docker).mockResolvedValueOnce({ stdout: "", stderr: "" });

        const handle = await provider.provision(task, intent);

        const args = vi.mocked(docker).mock.calls[0]![0];
        expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual(["--network", "none"]);
        expect(task.networkMode).toBe("open");
        expect(handle.permissionsFingerprint).toBe(permissionsFingerprint(permissions));
        expect(args).toContain(`permissions_fingerprint=${handle.permissionsFingerprint}`);
        expect(args).toContain(`${task.storagePath}:/workspace:rw`);
        expect(args).toContain(`${task.codexHomePath}:/root/.codex:rw`);
        expect(fs.readFileSync(path.join(task.storagePath, "retained.txt"), "utf8")).toBe("workspace");
        expect(fs.readFileSync(path.join(task.codexHomePath, "sessions", "retained.jsonl"), "utf8")).toBe("session");
    });

    it("rejects unsupported runtime permissions before checking Docker or copying credentials", async () => {
        const config = testConfig();
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "restricted" }, config, db);
        const permissionsPath = path.join(path.dirname(task.storagePath), "permissions.yaml");
        const permissions = readPermissions(permissionsPath, config);
        permissions.network = { mode: "codex-only", enforcement: "sidecar-proxy", allow: [] };
        writePermissions(permissionsPath, permissions, config);
        const provider = new LocalDockerProvider(config);
        const intent = db.createIntent(task, provider.describeProvisioning(task), 120);

        await expect(provider.provision(task, intent)).rejects.toThrow(/unsupported/);

        expect(detectDockerRuntime).not.toHaveBeenCalled();
        expect(docker).not.toHaveBeenCalled();
        expect(fs.existsSync(path.join(task.codexHomePath, "auth.json"))).toBe(false);
    });

    it("recovers the permissions fingerprint from container labels", async () => {
        const config = testConfig();
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "recover" }, config, db);
        const provider = new LocalDockerProvider(config);
        const intent = db.createIntent(task, provider.describeProvisioning(task), 120);
        const fingerprint = "f".repeat(64);
        vi.mocked(docker).mockResolvedValueOnce({ stdout: JSON.stringify([{ Config: { Labels: {
            task_id: task.id, intent_id: intent.id, permissions_fingerprint: fingerprint
        } } }]), stderr: "" });

        expect((await provider.recover(task, intent))?.permissionsFingerprint).toBe(fingerprint);
    });

    it("kills the underlying docker exec child when a shell terminal is disposed", async () => {
        const config = testConfig(tempDir());
        const db = new WebuiDatabase(config);
        const task = createTask({ prompt: "shell" }, config, db);
        const handle: RunnerHandle = {
            provider: "local",
            taskId: task.id,
            intentId: "intent",
            containerName: `fake-${task.id}`,
            createdAt: new Date().toISOString()
        };
        const provider = new LocalDockerProvider(config);
        const child = new EventEmitter() as EventEmitter & {
            stdin: PassThrough;
            stdout: PassThrough;
            stderr: PassThrough;
            killed: boolean;
            kill: ReturnType<typeof vi.fn>;
        };
        child.stdin = new PassThrough();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.killed = false;
        child.kill = vi.fn(() => {
            child.killed = true;
            child.emit("close");
            return true;
        });
        vi.mocked(dockerSpawn).mockReturnValueOnce(child as never);

        const terminal = await provider.openTerminal(task, handle);
        terminal.dispose();
        terminal.dispose();

        expect(child.stdin.writableEnded).toBe(true);
        expect(child.kill).toHaveBeenCalledTimes(1);
    });
});

it("recovers interrupted provisioning by task and intent labels, without swallowing Docker failures", async () => {
    const config = testConfig(); const db = new WebuiDatabase(config);
    const task = createTask({ prompt: "recover" }, config, db);
    const provider = new LocalDockerProvider(config);
    const intent = db.createIntent(task, provider.describeProvisioning(task), 120);
    vi.mocked(docker).mockResolvedValueOnce({ stdout: JSON.stringify([{ Config: { Labels: { task_id: task.id, intent_id: intent.id } } }]), stderr: "" });
    const handle = await provider.recover(task, intent);
    expect(handle?.containerName).toBe(`mecha-task-${task.id}`);
    vi.mocked(docker).mockRejectedValueOnce(new Error("daemon unavailable"));
    await expect(provider.stop(task, handle!)).rejects.toThrow("daemon unavailable");
    vi.mocked(docker).mockRejectedValueOnce(new Error("No such container"));
    await expect(provider.stop(task, handle!)).resolves.toBeUndefined();
    vi.mocked(docker).mockResolvedValueOnce({ stdout: JSON.stringify([{ Config: { Labels: { task_id: "other" } } }]), stderr: "" });
    await expect(provider.recover(task, intent)).rejects.toThrow("mismatched task labels");
});
