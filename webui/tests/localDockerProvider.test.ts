import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { WebuiDatabase } from "../server/src/db";
import { createTask } from "../server/src/tasks/createTask";
import { testConfig, tempDir } from "./helpers";
import type { RunnerHandle } from "../server/src/types";

vi.mock("../server/src/providers/docker", () => ({
    docker: vi.fn(),
    dockerSpawn: vi.fn(),
    detectDockerRuntime: vi.fn()
}));

const { docker, dockerSpawn } = await import("../server/src/providers/docker");
const { LocalDockerProvider } = await import("../server/src/providers/LocalDockerProvider");

describe("LocalDockerProvider", () => {
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
