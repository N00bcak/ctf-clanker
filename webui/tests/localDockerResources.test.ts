import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WebuiDatabase } from "../server/src/db";
import { createTask } from "../server/src/tasks/createTask";
import type { RunnerHandle } from "../server/src/types";
import { testConfig } from "./helpers";

vi.mock("../server/src/providers/docker", () => ({
    docker: vi.fn(),
    dockerSpawn: vi.fn(),
    detectDockerRuntime: vi.fn()
}));

const { docker, detectDockerRuntime } = await import("../server/src/providers/docker");
const { LocalDockerProvider } = await import("../server/src/providers/LocalDockerProvider");

beforeEach(() => vi.resetAllMocks());

function fixture() {
    const config = testConfig();
    config.codex.credentialMode = "none";
    config.local.defaultMemoryMb = 2048;
    const db = new WebuiDatabase(config);
    const task = createTask({ prompt: "resource control" }, config, db);
    const provider = new LocalDockerProvider(config);
    const intent = db.createIntent(task, provider.describeProvisioning(task), 120);
    const handle: RunnerHandle = {
        provider: "local", taskId: task.id, intentId: intent.id,
        containerName: `mecha-task-${task.id}`, createdAt: intent.createdAt
    };
    return { config, task, provider, intent, handle };
}

function inspection(handle: RunnerHandle, running: boolean, cpu = 1, memoryMb = 2048) {
    return {
        Name: `/${handle.containerName}`,
        Config: { Labels: { "managed-by": "mecha-webui", task_id: handle.taskId, intent_id: handle.intentId } },
        HostConfig: { NanoCpus: cpu * 1e9, Memory: memoryMb * 1024 ** 2 },
        State: { Running: running }
    };
}

function result(value?: unknown) {
    return { stdout: value === undefined ? "" : JSON.stringify(value), stderr: "" };
}

describe("LocalDockerProvider resources", () => {
    it("reads capacity from the Docker daemon in CPUs and MiB", async () => {
        const f = fixture();
        vi.mocked(docker).mockResolvedValueOnce(result({ NCPU: 8, MemTotal: 7833.5 * 1024 ** 2 }));

        expect(await f.provider.getCapacity()).toEqual({ cpuCount: 8, memoryMb: 7833.5 });
        expect(docker).toHaveBeenCalledWith(["info", "--format", "{{json .}}"], { timeoutMs: 10_000 });
    });

    it("rejects invalid daemon capacity", async () => {
        const f = fixture();
        vi.mocked(docker).mockResolvedValueOnce(result({ NCPU: 8, MemTotal: 0 }));

        await expect(f.provider.getCapacity()).rejects.toThrow("invalid daemon capacity");
    });

    it("returns actual limits for every worker and samples only running workers", async () => {
        const f = fixture();
        const stopped = { ...f.handle, taskId: "stopped-task", intentId: "stopped-intent", containerName: "stopped" };
        vi.mocked(docker).mockResolvedValueOnce(result([
            inspection(f.handle, true, 2.5), inspection(stopped, false, 0.25)
        ])).mockResolvedValueOnce(result({ Name: f.handle.containerName, CPUPerc: "125.50%", MemUsage: "1.5GiB / 2GiB" }));

        expect(await f.provider.getUsage([f.handle, stopped])).toEqual([
            { taskId: f.task.id, cpu: 1.255, memoryMb: 1536, cpuLimit: 2.5, memoryLimitMb: 2048, running: true },
            { taskId: stopped.taskId, cpu: 0, memoryMb: 0, cpuLimit: 0.25, memoryLimitMb: 2048, running: false }
        ]);
        expect(vi.mocked(docker).mock.calls[1]?.[0]).toEqual([
            "stats", "--no-stream", "--no-trunc", "--format", "{{json .}}", f.handle.containerName
        ]);
    });

    it("does not sample Docker when no workers are supplied", async () => {
        expect(await fixture().provider.getUsage([])).toEqual([]);
        expect(docker).not.toHaveBeenCalled();
    });

    it("rejects incomplete telemetry so absent samples cannot count as spare CPU", async () => {
        const f = fixture();
        vi.mocked(docker).mockResolvedValueOnce(result([inspection(f.handle, true)])).mockResolvedValueOnce(result());

        await expect(f.provider.getUsage([f.handle])).rejects.toThrow("Missing or invalid Docker telemetry");
    });

    it("rejects telemetry for a container belonging to a different provisioning intent", async () => {
        const f = fixture();
        const container = inspection(f.handle, true);
        container.Config.Labels.intent_id = "another-intent";
        vi.mocked(docker).mockResolvedValueOnce(result([container]));

        await expect(f.provider.getUsage([f.handle])).rejects.toThrow("mismatched task labels");
        expect(docker).toHaveBeenCalledTimes(1);
    });

    it("creates containers with the scheduler reservation instead of static defaults", async () => {
        const f = fixture();
        f.task.resources = { cpu: 0.75, memoryMb: 2048 };
        vi.mocked(detectDockerRuntime).mockResolvedValueOnce({ ok: true, detail: "Docker" });
        vi.mocked(docker).mockResolvedValueOnce(result());

        await f.provider.provision(f.task, f.intent);

        const args = vi.mocked(docker).mock.calls[0]![0];
        expect(args.slice(args.indexOf("--cpus"), args.indexOf("--cpus") + 2)).toEqual(["--cpus", "0.75"]);
        expect(args.slice(args.indexOf("--memory"), args.indexOf("--memory") + 2)).toEqual(["--memory", "2048m"]);
        expect(vi.mocked(docker).mock.calls[0]?.[1]).toEqual({ timeoutMs: 120_000 });
    });

    it("changes and verifies CPU without touching a running worker's RAM", async () => {
        const f = fixture();
        vi.mocked(docker).mockResolvedValueOnce(result([inspection(f.handle, true, 1)]))
            .mockResolvedValueOnce(result())
            .mockResolvedValueOnce(result([inspection(f.handle, true, 0.5)]));

        await f.provider.setResources(f.task, f.handle, { cpu: 0.5, memoryMb: 2048 });

        expect(vi.mocked(docker).mock.calls.map(([args]) => args[0])).toEqual(["inspect", "update", "inspect"]);
        expect(vi.mocked(docker).mock.calls[1]?.[0]).toEqual(["update", "--cpus", "0.5", f.handle.containerName]);
    });

    it("rejects RAM changes on a running container before updating it", async () => {
        const f = fixture();
        vi.mocked(docker).mockResolvedValueOnce(result([inspection(f.handle, true)]));

        await expect(f.provider.setResources(f.task, f.handle, { cpu: 0.5, memoryMb: 1024 })).rejects.toThrow("Cannot change RAM limits");
        expect(docker).toHaveBeenCalledTimes(1);
    });

    it("reconciles and verifies stopped container limits before starting without replacing files", async () => {
        const f = fixture();
        f.task.resources = { cpu: 0.75, memoryMb: 2048 };
        const retained = path.join(f.task.storagePath, "retained.txt");
        fs.writeFileSync(retained, "workspace");
        vi.mocked(docker).mockResolvedValueOnce(result([inspection(f.handle, false, 2, 1024)]))
            .mockResolvedValueOnce(result([inspection(f.handle, false, 2, 1024)]))
            .mockResolvedValueOnce(result())
            .mockResolvedValueOnce(result([inspection(f.handle, false, 0.75, 2048)]))
            .mockResolvedValueOnce(result());

        await f.provider.start(f.task, f.handle);

        expect(vi.mocked(docker).mock.calls.map(([args]) => args[0])).toEqual(["inspect", "inspect", "update", "inspect", "start"]);
        expect(vi.mocked(docker).mock.calls[2]?.[0]).toEqual([
            "update", "--cpus", "0.75", "--memory", "2048m", "--memory-swap", "4096m", f.handle.containerName
        ]);
        expect(fs.readFileSync(retained, "utf8")).toBe("workspace");
    });

    it("does not start a retained worker when the applied resource update cannot be verified", async () => {
        const f = fixture();
        vi.mocked(docker).mockResolvedValueOnce(result([inspection(f.handle, false, 2)]))
            .mockResolvedValueOnce(result([inspection(f.handle, false, 2)]))
            .mockResolvedValueOnce(result())
            .mockResolvedValueOnce(result([inspection(f.handle, false, 2)]));

        await expect(f.provider.start(f.task, f.handle)).rejects.toThrow("could not be verified");
        expect(vi.mocked(docker).mock.calls.some(([args]) => args[0] === "start")).toBe(false);
    });

    it("propagates an uncertain resource-update failure for conservative scheduler accounting", async () => {
        const f = fixture();
        vi.mocked(docker).mockResolvedValueOnce(result([inspection(f.handle, true)]))
            .mockRejectedValueOnce(new Error("Docker update timeout"));

        await expect(f.provider.setResources(f.task, f.handle, { cpu: 0.5, memoryMb: 2048 })).rejects.toThrow("timeout");
    });

    it("refuses resource changes unless task, intent, and managed-by labels match", async () => {
        const f = fixture();
        const container = inspection(f.handle, true);
        container.Config.Labels["managed-by"] = "someone-else";
        vi.mocked(docker).mockResolvedValueOnce(result([container]));

        await expect(f.provider.setResources(f.task, f.handle, { cpu: 0.5, memoryMb: 2048 })).rejects.toThrow("mismatched task labels");
        expect(docker).toHaveBeenCalledTimes(1);
    });
});
