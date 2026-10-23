/**
 * @vitest-environment jsdom
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TaskList } from "../client/src/TaskList";
import { TaskCreateDialog } from "../client/src/TaskCreateDialog";
import { TaskView } from "../client/src/TaskView";
import { SteeringPane } from "../client/src/SteeringPane";
import { EventLog } from "../client/src/EventLog";
import { FileBrowser } from "../client/src/FileBrowser";
import { PermissionsEditor } from "../client/src/PermissionsEditor";
import { sanitizeCodexTranscript, TerminalPane } from "../client/src/TerminalPane";
import { App } from "../client/src/main";
import { SchedulerStatus } from "../client/src/SchedulerStatus";
import type { PermissionsState, SchedulerStatus as SchedulerState, Task } from "../client/src/api";

const { FakeFitAddon, FakeTerminal } = vi.hoisted(() => {
    class FakeFitAddon {
        static instances: FakeFitAddon[] = [];
        fit = vi.fn();

        constructor() {
            FakeFitAddon.instances.push(this);
        }
    }
    class FakeTerminal {
        static instances: FakeTerminal[] = [];
        open = vi.fn();
        writeln = vi.fn();
        write = vi.fn();
        onData = vi.fn();
        dispose = vi.fn();
        loadAddon = vi.fn();
        options: unknown;

        constructor(options?: unknown) {
            this.options = options;
            FakeTerminal.instances.push(this);
        }
    }
    return { FakeFitAddon, FakeTerminal };
});

class FakeResizeObserver {
    static instances: FakeResizeObserver[] = [];
    observe = vi.fn();
    disconnect = vi.fn();

    constructor(readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.instances.push(this);
    }

    trigger(): void {
        this.callback([], this as unknown as ResizeObserver);
    }
}

vi.mock("@xterm/xterm", () => ({
    Terminal: FakeTerminal
}));

vi.mock("@xterm/addon-fit", () => ({
    FitAddon: FakeFitAddon
}));

class FakeWebSocket {
    static instances: FakeWebSocket[] = [];
    static OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    sent: string[] = [];

    constructor(readonly url: string) {
        FakeWebSocket.instances.push(this);
    }

    send(data: string): void {
        this.sent.push(data);
    }

    close(): void {
        this.onclose?.();
    }
}

function task(overrides: Partial<Task> = {}): Task {
    return {
        id: "task_1",
        name: "Native task",
        backend: "local",
        status: "running",
        workStatus: "running",
        createdAt: new Date().toISOString(),
        storagePath: "/tmp/task/storage",
        credentialMode: "codex-auth-json",
        codexRuntime: "container",
        bridgeMode: "native-codex-app-server",
        networkMode: "open",
        networkEnforcement: "open-warning",
        ...overrides
    };
}

function schedulerStatus(overrides: Partial<SchedulerState> = {}): SchedulerState {
    return {
        maxWorkers: 8, activeWorkers: 2, cpuBudget: 6, cpuAllocated: 2.5, cpuUsage: 0,
        memoryBudgetMb: 8192, effectiveMemoryMb: 6809, memoryReservedMb: 4096, memoryUsageMb: 1024,
        workerMemoryMb: 2048, effectiveMaxWorkers: 3, state: "ready", workers: [], waiting: [],
        ...overrides
    };
}

function mockFetch(handler: (url: string, init?: RequestInit) => unknown, scheduler: () => unknown = schedulerStatus): void {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url) === "/api/scheduler") return { ok: true, json: async () => scheduler() };
        if (String(url) === "/api/codex/models") {
            return {
                ok: true,
                json: async () => ({
                    source: "local-runner-app-server",
                    runtimeVersion: "0.144.5",
                    queriedAt: new Date().toISOString(),
                    models: [
                        { model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "Frontier coding model", isDefault: true },
                        { model: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", description: "Fast coding model", isDefault: false }
                    ]
                })
            };
        }
        return {
            ok: true,
            json: async () => handler(String(url), init)
        };
    }));
}

function permissionState(mode = "open", editable = true, reason?: string): PermissionsState {
    return {
        permissions: { version: 1, network: { mode, enforcement: mode === "none" ? "docker-none" : "open-warning", allow: [] }, mounts: [] },
        supportedNetworkModes: ["open", "none"], editable, reason
    };
}

function mockViewport(initialWidth: number) {
    let width = initialWidth;
    const queries: Array<{ query: string; media: MediaQueryList; listeners: Set<() => void> }> = [];
    vi.stubGlobal("matchMedia", vi.fn((query: string) => {
        const listeners = new Set<() => void>();
        const media = {
            get matches() { return width <= Number(query.match(/max-width:\s*(\d+)/)?.[1] ?? 0); },
            media: query,
            addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
            removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener)
        } as unknown as MediaQueryList;
        queries.push({ query, media, listeners });
        return media;
    }));
    return (nextWidth: number) => {
        width = nextWidth;
        for (const item of queries) for (const listener of item.listeners) listener();
    };
}

describe("client smoke tests", () => {
    beforeEach(() => {
        FakeWebSocket.instances = [];
        FakeTerminal.instances = [];
        FakeFitAddon.instances = [];
        FakeResizeObserver.instances = [];
        const storage = new Map<string, string>();
        Object.defineProperty(window, "localStorage", {
            configurable: true,
            value: {
                getItem: vi.fn((key: string) => storage.get(key) ?? null),
                setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
                removeItem: vi.fn((key: string) => storage.delete(key)),
                clear: vi.fn(() => storage.clear())
            }
        });
        vi.stubGlobal("WebSocket", FakeWebSocket);
        vi.stubGlobal("ResizeObserver", FakeResizeObserver);
        Object.assign(FakeWebSocket, { OPEN: 1 });
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("renders configured and effective scheduler capacity with measured usage", () => {
        render(<SchedulerStatus status={schedulerStatus()} />);
        const panel = screen.getByRole("region", { name: "Local Docker scheduler" });
        expect(panel.textContent).toContain("2 active / 3 effective (8 max)");
        expect(panel.textContent).toContain("0 used");
        expect(panel.textContent).toContain("2.5 allocated / 6 budget");
        expect(panel.textContent).toContain("1 GiB used");
        expect(panel.textContent).toContain("4 GiB reserved / 6.65 GiB effective");
        expect(panel.textContent).toContain("8 GiB budget · 2 GiB per worker");
    });

    it("distinguishes unavailable scheduler telemetry from zero usage and shows blocking reasons", () => {
        render(<SchedulerStatus status={schedulerStatus({
            state: "recovering", cpuUsage: undefined, memoryUsageMb: undefined,
            reason: "Docker telemetry is stale; new admissions are suspended."
        })} />);
        expect(screen.getAllByText("Usage unavailable")).toHaveLength(2);
        expect(screen.getByRole("status").textContent).toContain("Docker telemetry is stale");
        expect(screen.queryByText("0 used")).toBeNull();
    });

    it("shows local worker allocations and per-task waiting reasons in the queue", () => {
        const running = task({ id: "running", name: "Running task" });
        const queued = task({ id: "queued", name: "Waiting task", status: "queued", workStatus: "not-started" });
        render(<TaskList tasks={[running, queued]} onSelect={vi.fn()} scheduler={schedulerStatus({
            workers: [{ taskId: "running", cpu: 1.5, memoryMb: 2048 }],
            waiting: [{ taskId: "queued", reason: "Waiting for 2048 MiB RAM" }]
        })} />);
        expect(screen.getByRole("button", { name: /Running task/ }).textContent).toContain("1.5 CPU · 2 GiB reserved");
        expect(screen.getByRole("button", { name: /Waiting task/ }).textContent).toContain("Waiting for 2048 MiB RAM");
    });

    it("refreshes tasks independently when the scheduler API fails and recovers on the next poll", async () => {
        vi.useFakeTimers();
        let schedulerCalls = 0;
        mockFetch((url) => url === "/api/tasks" ? [task({ name: "Available operation" })] : [], () => {
            if (++schedulerCalls === 1) throw new Error("Docker unavailable");
            return schedulerStatus();
        });
        render(<App />);
        await act(async () => { await vi.advanceTimersByTimeAsync(0); });
        expect(screen.getByRole("heading", { name: "Available operation" })).toBeTruthy();
        expect(screen.getByRole("status").textContent).toContain("Scheduler unavailable: Docker unavailable");
        expect(screen.queryByRole("alert")).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(schedulerCalls).toBe(2);
        expect(screen.getByText("2.5 allocated / 6 budget")).toBeTruthy();
        expect(screen.queryByText(/Scheduler unavailable:/)).toBeNull();
    });

    it("keeps polling tasks without overlapping a slow scheduler request", async () => {
        vi.useFakeTimers();
        let taskCalls = 0;
        let schedulerCalls = 0;
        let resolveScheduler: (value: SchedulerState) => void = () => undefined;
        mockFetch((url) => {
            if (url === "/api/tasks") { taskCalls += 1; return []; }
            return [];
        }, () => {
            schedulerCalls += 1;
            return new Promise<SchedulerState>((resolve) => { resolveScheduler = resolve; });
        });
        const { unmount } = render(<App />);
        await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
        expect(taskCalls).toBe(4);
        expect(schedulerCalls).toBe(1);
        await act(async () => resolveScheduler(schedulerStatus()));
        expect(screen.getByText("2.5 allocated / 6 budget")).toBeTruthy();
        unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
        expect(taskCalls).toBe(4);
        expect(schedulerCalls).toBe(1);
    });

    it("creates and accepts one run without client prompting or waiting for refresh", async () => {
        let accept!: (value: Task) => void;
        const accepted = new Promise<Task>(resolve => { accept = resolve; });
        const onClose = vi.fn();
        const onCreated = vi.fn(() => new Promise<void>(() => {}));
        const onSelect = vi.fn();
        const requests: Array<{ url: string; body: unknown }> = [];
        mockFetch((url, init) => {
            requests.push({ url, body: JSON.parse(String(init?.body)) });
            return url.endsWith("/start") ? accepted : task({ id: "accepted", status: "draft" });
        });
        render(<TaskCreateDialog open onClose={onClose} onCreated={onCreated} onSelect={onSelect} />);
        fireEvent.change(screen.getByPlaceholderText("Task name"), { target: { value: "Accepted" } });
        fireEvent.change(screen.getByPlaceholderText("Initial prompt"), { target: { value: "solve later" } });
        fireEvent.click(screen.getByText("Create & Run"));

        await waitFor(() => expect(requests.map(({ url }) => url)).toEqual(["/api/tasks", "/api/tasks/accepted/start"]));
        expect(requests[0].body).toMatchObject({ name: "Accepted", prompt: "solve later", backend: "local" });
        expect(onSelect).toHaveBeenCalledWith("accepted");
        expect(onClose).not.toHaveBeenCalled();
        await act(async () => accept(task({ id: "accepted", status: "queued" })));
        expect(onClose).toHaveBeenCalledOnce();
        expect(requests.map(({ url }) => url)).toEqual(["/api/tasks", "/api/tasks/accepted/start"]);
    });

    it("preserves form data after failed acceptance and retries the saved task once", async () => {
        let attempts = 0;
        const onClose = vi.fn();
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
            if (url.endsWith("/start") && ++attempts === 1) return { ok: false, json: async () => ({ error: "temporary failure" }) };
            return { ok: true, json: async () => task({ id: "retry", status: "queued" }) };
        }));
        render(<TaskCreateDialog open onClose={onClose} onCreated={vi.fn()} onSelect={vi.fn()} />);
        fireEvent.change(screen.getByPlaceholderText("Task name"), { target: { value: "Retry" } });
        fireEvent.change(screen.getByPlaceholderText("Initial prompt"), { target: { value: "one task" } });
        fireEvent.click(screen.getByText("Create & Run"));

        expect(await screen.findByText("Accepting run failed: temporary failure")).toBeTruthy();
        expect(screen.getByDisplayValue("Retry")).toBeTruthy();
        expect(screen.getByDisplayValue("one task")).toBeTruthy();
        expect(onClose).not.toHaveBeenCalled();
        fireEvent.click(screen.getByText("Create & Run"));
        await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
        expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual([
            "/api/codex/models", "/api/tasks", "/api/tasks/retry/start", "/api/tasks/retry/start"
        ]);
    });

    it("creates a selected cloud draft with settings and attachments without starting it", async () => {
        const created = task({ id: "uploaded", name: "Uploaded" });
        const onCreated = vi.fn();
        const requests: Array<{ url: string; body: unknown }> = [];
        const onSelect = vi.fn();
        const onClose = vi.fn();
        mockFetch((url, init) => {
            requests.push({ url, body: JSON.parse(String(init?.body)) });
            return created;
        });

        const { container } = render(<TaskCreateDialog open onClose={onClose} onCreated={onCreated} onSelect={onSelect} />);
        fireEvent.change(screen.getByDisplayValue("Local appserver"), { target: { value: "digitalocean" } });
        fireEvent.change(screen.getByPlaceholderText("Task name"), { target: { value: "Uploaded" } });
        fireEvent.change(screen.getByPlaceholderText("Initial prompt"), { target: { value: "Solve this" } });
        await screen.findByRole("option", { name: "GPT-5.6 Sol · gpt-5.6-sol" });
        fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5.6-sol" } });
        fireEvent.change(container.querySelector("input[type='file']")!, {
            target: { files: [new File(["flag"], "flag.txt")] }
        });
        fireEvent.click(screen.getByText("Create Draft"));

        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(requests.map(({ url }) => url)).toEqual(["/api/tasks"]);
        expect(onSelect).toHaveBeenCalledWith("uploaded");
        expect(onClose).toHaveBeenCalledOnce();
        expect(requests[0].body).toMatchObject({
            name: "Uploaded",
            prompt: "Solve this",
            backend: "digitalocean",
            codexSettings: { model: "gpt-5.6-sol", sandbox: "danger-full-access", approvalPolicy: "never", webSearch: false },
            attachments: [{ path: "attachments/flag.txt", contentBase64: "ZmxhZw==" }]
        });
    });

    it("drafts and imports a batch manifest with fake files", async () => {
        const created = task({ id: "batch", name: "batch" });
        const onCreated = vi.fn();
        const requests: unknown[] = [];
        mockFetch((_url, init) => {
            requests.push(JSON.parse(String(init?.body)));
            return created;
        });

        const { container } = render(<TaskCreateDialog open onClose={vi.fn()} onCreated={onCreated} onSelect={vi.fn()} />);
        fireEvent.click(screen.getByText("Batch import"));
        const fileInputs = container.querySelectorAll("input[type='file']");
        const file = new File(["print(1)"], "chal.py");
        Object.defineProperty(file, "webkitRelativePath", { value: "pwn-001/chal.py" });
        fireEvent.change(fileInputs[0], { target: { files: [file] } });

        await waitFor(() => expect(screen.getByDisplayValue(/pwn-001/)).toBeTruthy());
        fireEvent.click(screen.getByText("Import Batch"));

        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(requests[0]).toMatchObject({
            name: "pwn-001",
            backend: "local",
            codexSettings: { sandbox: "danger-full-access", approvalPolicy: "never", webSearch: false },
            attachments: [{ path: "attachments/pwn-001/chal.py", contentBase64: "cHJpbnQoMSk=" }]
        });
    });

    it("shows queued tasks in server admission order ahead of drafts", () => {
        const { container } = render(<TaskList tasks={[
            task({ id: "draft", name: "Draft", status: "draft", workStatus: "not-started" }),
            task({ id: "later", name: "Later", status: "queued", workStatus: "not-started", queueOrder: 9 }),
            task({ id: "earlier", name: "Earlier", status: "queued", workStatus: "not-started", queueOrder: 4 })
        ]} onSelect={vi.fn()} />);
        expect(Array.from(container.querySelectorAll(".task-row strong")).map(node => node.textContent)).toEqual(["Earlier", "Later", "Draft"]);
    });

    it("groups the task queue by attention priority and filters by search and status", () => {
        const tasks = [
            task({ id: "done-1", name: "Done challenge", workStatus: "done" }),
            task({ id: "run-1", name: "Running challenge", workStatus: "running" }),
            task({ id: "attention-1", name: "Needs eyes", workStatus: "needs-attention" }),
            task({ id: "ready-1", name: "Ready challenge", workStatus: "not-started" }),
            task({ id: "failed-1", name: "Failed challenge", workStatus: "failed" })
        ];
        const { container } = render(<TaskList tasks={tasks} selectedId="run-1" onSelect={vi.fn()} />);

        expect(Array.from(container.querySelectorAll(".task-row strong")).map((node) => node.textContent)).toEqual([
            "Needs eyes",
            "Failed challenge",
            "Running challenge",
            "Ready challenge",
            "Done challenge"
        ]);

        fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "ready-1" } });
        expect(screen.getByText("Ready challenge")).toBeTruthy();
        expect(screen.queryByText("Running challenge")).toBeNull();

        fireEvent.change(screen.getByLabelText("Search tasks"), { target: { value: "" } });
        fireEvent.click(screen.getByRole("button", { name: "Attention 2" }));
        expect(screen.getByText("Needs eyes")).toBeTruthy();
        expect(screen.getByText("Failed challenge")).toBeTruthy();
        expect(screen.queryByText("Ready challenge")).toBeNull();
    });

    it("marks creation and workspace tabs with their selected state", () => {
        render(<TaskCreateDialog open onClose={vi.fn()} onCreated={vi.fn()} onSelect={vi.fn()} />);
        expect(screen.getByRole("tab", { name: "Single task" }).getAttribute("aria-selected")).toBe("true");
        fireEvent.click(screen.getByRole("tab", { name: "Batch import" }));
        expect(screen.getByRole("tab", { name: "Batch import" }).getAttribute("aria-selected")).toBe("true");

        cleanup();
        mockFetch((url) => url.includes("/files") ? [] : task());
        render(<TaskView task={task()} onChanged={vi.fn()} />);
        expect(screen.getByRole("tab", { name: "Codex" }).getAttribute("aria-selected")).toBe("true");
        expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe("true");
    });

    it("loads live Codex models and explains profiles and the Docker boundary", async () => {
        mockFetch(() => task());
        render(<TaskCreateDialog open onClose={vi.fn()} onCreated={vi.fn()} onSelect={vi.fn()} />);

        expect(await screen.findByRole("option", { name: "GPT-5.6 Sol · gpt-5.6-sol" })).toBeTruthy();
        expect(screen.getByRole("option", { name: "Codex default — GPT-5.6 Sol" })).toBeTruthy();
        expect(screen.getByText(/local runner app-server 0.144.5/)).toBeTruthy();
        expect(screen.getByText("What happened to Profile?")).toBeTruthy();
        expect(screen.getByText("$CODEX_HOME/<name>.config.toml")).toBeTruthy();
        expect(screen.getByText(/practical CTF baseline, not protection against suspected container escapes/i)).toBeTruthy();
        expect(screen.queryByPlaceholderText("Profile")).toBeNull();
    });

    it("renders TaskView native and host-mode warnings", () => {
        mockFetch((url) => url.includes("/files") ? [] : task());
        const { rerender } = render(<TaskView task={task()} onChanged={vi.fn()} />);

        expect(screen.getByText(/Codex sandboxing is disabled inside the runner/)).toBeTruthy();
        expect(screen.getByText(/Open network permits/)).toBeTruthy();
        rerender(<TaskView task={task({
            bridgeMode: "host-codex-broker",
            codexRuntime: "host",
            credentialMode: "host-codex-cli"
        })} onChanged={vi.fn()} />);
        expect(screen.getByText(/Host broker uses the host Codex CLI/)).toBeTruthy();
    });

    it("sends a prompt with Command-Enter while leaving plain Enter to the textarea", async () => {
        const calls: Array<{ url: string; body?: unknown }> = [];
        mockFetch((url, init) => {
            calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            if (url.includes("/codex-session")) return { state: "active" };
            if (url.includes("/files")) return [];
            return task({ activeProvisioningIntentId: "intent-1" });
        });
        render(<TaskView task={task({ status: "idle", activeProvisioningIntentId: "intent-1" })} onChanged={vi.fn()} />);
        const composer = screen.getByLabelText("Prompt Codex");
        fireEvent.change(composer, { target: { value: "continue analysis" } });
        fireEvent.keyDown(composer, { key: "Enter" });
        expect(calls.some((call) => call.url.endsWith("/prompt"))).toBe(false);
        fireEvent.keyDown(composer, { key: "Enter", metaKey: true });

        await waitFor(() => expect(calls).toContainEqual({
            url: "/api/tasks/task_1/prompt",
            body: { prompt: "continue analysis" }
        }));
    });

    it("accepts queued Start with exactly one request and no initial-prompt fetch or client prompt", async () => {
        const calls: string[] = [];
        const changed = vi.fn();
        mockFetch((url) => {
            calls.push(url);
            if (url === "/api/tasks/task_1/files?path=") return [];
            if (url === "/api/tasks/task_1/start") return task({ status: "queued", activeProvisioningIntentId: undefined });
            return task();
        });

        render(<TaskView task={task({ status: "draft" })} onChanged={changed} />);
        fireEvent.click(screen.getByText("Start"));

        await waitFor(() => expect(changed).toHaveBeenCalledOnce());
        expect(calls.filter(url => /\/(start|initial-prompt|prompt)$/.test(url))).toEqual(["/api/tasks/task_1/start"]);
    });

    it("applies action button states by task status", () => {
        mockFetch((url) => url.includes("/files") ? [] : task());
        const { rerender } = render(<TaskView task={task({ status: "draft" })} onChanged={vi.fn()} />);
        expect(screen.getByText("Start").className).toContain("action-yellow");
        expect(screen.getByText("Stop")).toHaveProperty("disabled", true);
        expect(screen.getByText("Destroy").className).toContain("button-danger-quiet");

        rerender(<TaskView task={task({ status: "running", activeProvisioningIntentId: "intent-1" })} onChanged={vi.fn()} />);
        expect(screen.getByText("Start").className).toContain("action-green");
        expect(screen.getByText("Stop").className).toContain("action-yellow");
        expect(screen.getByText("Destroy").className).toContain("button-danger-quiet");

        rerender(<TaskView task={task({ status: "finished", activeProvisioningIntentId: "intent-1" })} onChanged={vi.fn()} />);
        expect(screen.getByText("Start")).toHaveProperty("disabled", true);
        expect(screen.getByText("Stop")).toHaveProperty("disabled", true);
        expect(screen.getByText("Destroy")).toHaveProperty("disabled", false);
        expect(screen.getByText("Destroy").className).toContain("button-danger-quiet");
    });

    it("opens a read-only native transcript before the runner starts", async () => {
        mockFetch((url) => url.includes("/codex-session") ? { state: "not-started" } : []);
        render(<TerminalPane task={task({ status: "draft" })} />);

        await waitFor(() => expect(FakeWebSocket.instances.map((ws) => ws.url)).toContain("/ws/tasks/task_1/events"));
        expect(FakeWebSocket.instances.map((ws) => ws.url)).not.toContain("/ws/tasks/task_1/terminal");
        expect(FakeTerminal.instances).toHaveLength(1);
        expect(FakeTerminal.instances[0].onData).not.toHaveBeenCalled();
    });

    it("opens an explicit runner shell only when the Shell tab is selected", async () => {
        mockFetch((url) => {
            if (url.includes("/codex-session")) return { state: "not-started" };
            return url.includes("/files") ? [] : task();
        });
        render(<TaskView task={task({ status: "running", activeProvisioningIntentId: "intent-1" })} onChanged={vi.fn()} />);

        await waitFor(() => expect(FakeWebSocket.instances.map((ws) => ws.url)).toContain("/ws/tasks/task_1/events"));

        fireEvent.click(screen.getByText("Shell"));

        expect(FakeWebSocket.instances.map((ws) => ws.url)).toContain("/ws/tasks/task_1/shell");
    });

    it("does not show the Shell tab for host-broker tasks", () => {
        mockFetch((url) => url.includes("/files") ? [] : task());
        render(<TaskView task={task({
            bridgeMode: "host-codex-broker",
            codexRuntime: "host",
            credentialMode: "host-codex-cli",
            status: "idle"
        })} onChanged={vi.fn()} />);

        expect(screen.getByText("Codex")).toBeTruthy();
        expect(screen.queryByText("Shell")).toBeNull();
    });

    it("renders Codex session state copy", async () => {
        let state: "not-started" | "active" | "closed" = "active";
        mockFetch((url) => url.includes("/codex-session") ? { state } : []);
        const { rerender } = render(<TerminalPane task={task({ status: "running", activeProvisioningIntentId: "intent-1" })} />);

        await waitFor(() => expect(FakeTerminal.instances.at(-1)?.writeln).toHaveBeenCalledWith("\r\nCodex session active."));

        state = "closed";
        rerender(<TerminalPane task={task({ id: "task_2", status: "running", activeProvisioningIntentId: "intent-2" })} />);

        await waitFor(() => expect(FakeTerminal.instances.at(-1)?.writeln).toHaveBeenCalledWith("\r\nCodex session closed. Send a prompt to start a fresh session."));
    });

    it("updates Codex session copy from live events without recreating the terminal", async () => {
        mockFetch((url) => url.includes("/codex-session") ? { state: "not-started" } : []);
        render(<TerminalPane task={task({ status: "running", activeProvisioningIntentId: "intent-1" })} />);

        await waitFor(() => expect(FakeTerminal.instances.at(-1)?.writeln).toHaveBeenCalledWith("\r\nCodex session not started. Send a prompt to begin or continue."));
        const terminalCount = FakeTerminal.instances.length;
        const eventSocket = FakeWebSocket.instances.find((ws) => ws.url === "/ws/tasks/task_1/events");
        expect(eventSocket).toBeTruthy();

        act(() => eventSocket?.onmessage?.({ data: "{\"type\":\"codex.session.started\"}" }));
        expect(FakeTerminal.instances).toHaveLength(terminalCount);
        expect(FakeTerminal.instances.at(-1)?.writeln).toHaveBeenCalledWith("\r\nCodex session active.");

        act(() => eventSocket?.onmessage?.({ data: "{\"type\":\"codex.session.closed\"}" }));
        expect(FakeTerminal.instances).toHaveLength(terminalCount);
        expect(FakeTerminal.instances.at(-1)?.writeln).toHaveBeenCalledWith("\r\nCodex session closed. Send a prompt to start a fresh session.");
    });

    it("marks a task done and reopens it through work status controls", async () => {
        const changed = vi.fn();
        const calls: Array<{ url: string; body?: unknown }> = [];
        mockFetch((url, init) => {
            calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            if (url.includes("/files")) return [];
            return task({ workStatus: "done" });
        });

        const { rerender } = render(<TaskView task={task({ workStatus: "running" })} onChanged={changed} />);
        expect(screen.getByText("RUNNING")).toBeTruthy();

        fireEvent.click(screen.getByText("Mark Done"));

        await waitFor(() => expect(calls).toContainEqual({
            url: "/api/tasks/task_1/status",
            body: { workStatus: "done" }
        }));

        rerender(<TaskView task={task({ workStatus: "done" })} onChanged={changed} />);
        expect(screen.getByText("DONE")).toBeTruthy();
        fireEvent.click(screen.getByText("Reopen"));

        await waitFor(() => expect(calls).toContainEqual({
            url: "/api/tasks/task_1/status",
            body: { workStatus: "needs-attention" }
        }));
    });

    it("renders host-broker Codex output as a read-only terminal transcript", async () => {
        let resolveTranscript: (value: string) => void = () => undefined;
        let transcriptRequested = false;
        vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
            const path = String(url);
            if (path === "/api/tasks/task_1/logs/codex") {
                return {
                    ok: true,
                    text: async () => new Promise<string>((resolve) => {
                        transcriptRequested = true;
                        resolveTranscript = resolve;
                    })
                };
            }
            return { ok: true, json: async () => [] };
        }));

        render(<TerminalPane task={task({
            bridgeMode: "host-codex-broker",
            codexRuntime: "host",
            credentialMode: "host-codex-cli",
            status: "idle"
        })} />);

        await waitFor(() => expect(transcriptRequested).toBe(true));
        expect(FakeWebSocket.instances).toHaveLength(0);
        act(() => resolveTranscript("{\"text\":\"past output\\n\"}\n{\"text\":\"past stderr\\n\"}\n"));
        await waitFor(() => expect(FakeTerminal.instances[0].write).toHaveBeenCalledWith("past output\n"));
        expect(FakeTerminal.instances[0].write).toHaveBeenCalledWith("past stderr\n");
        expect(FakeWebSocket.instances).toHaveLength(1);
        expect(FakeWebSocket.instances[0].url).toBe("/ws/tasks/task_1/events");

        act(() => FakeWebSocket.instances[0].onmessage?.({ data: "{\"type\":\"codex.output\",\"text\":\"live output\\n\"}" }));

        expect(FakeTerminal.instances[0].write).toHaveBeenCalledWith("live output\n");
        expect(FakeTerminal.instances[0].onData).not.toHaveBeenCalled();
    });

    it("resizes and persists the sidebar width", async () => {
        mockFetch((url) => url === "/api/tasks" ? [task()] : []);
        const { container } = render(<App />);
        await waitFor(() => expect(screen.getAllByText("Native task").length).toBeGreaterThan(0));
        const resizer = screen.getByLabelText("Resize task queue");

        fireEvent.mouseDown(resizer, { clientX: 320 });
        fireEvent.mouseMove(window, { clientX: 500 });
        fireEvent.mouseUp(window);

        expect(container.querySelector(".app")?.getAttribute("style")).toContain("--sidebar-width: 500px");
        expect(window.localStorage.getItem("mecha-webui-sidebar-width")).toBe("500");
    });

    it("collapses and restores the task queue", async () => {
        mockFetch((url) => url === "/api/tasks" ? [task()] : []);
        const { container } = render(<App />);
        await waitFor(() => expect(screen.getAllByText("Native task").length).toBeGreaterThan(0));

        fireEvent.click(screen.getByLabelText("Collapse task queue"));
        expect(container.querySelector(".app")?.classList.contains("sidebar-collapsed")).toBe(true);
        expect(window.localStorage.getItem("mecha-webui-sidebar-open")).toBe("false");

        fireEvent.click(screen.getByLabelText("Expand task queue"));
        expect(container.querySelector(".app")?.classList.contains("sidebar-collapsed")).toBe(false);
    });

    it("collapses, resizes, and persists the inspector", async () => {
        mockFetch((url) => url.includes("/files?path=") ? [] : task());
        const { container } = render(<TaskView task={task()} onChanged={vi.fn()} />);
        const resizer = screen.getByLabelText("Resize inspector");

        fireEvent.mouseDown(resizer, { clientX: 900 });
        fireEvent.mouseMove(window, { clientX: 400 });
        fireEvent.mouseUp(window);

        expect(container.querySelector(".cockpit-workspace")?.getAttribute("style")).toContain("--inspector-width: 560px");
        expect(window.localStorage.getItem("mecha-webui-inspector-width")).toBe("560");

        fireEvent.click(screen.getByText("Hide Inspector"));
        expect(container.querySelector(".cockpit-workspace")?.classList.contains("inspector-collapsed")).toBe(true);
        expect(window.localStorage.getItem("mecha-webui-inspector-open")).toBe("false");
        expect(screen.getByText("Show Inspector")).toBeTruthy();
        expect(screen.queryByLabelText("Task inspector")).toBeNull();
        expect(screen.queryByLabelText("Resize inspector")).toBeNull();
    });

    it("fits the compact terminal when its container resizes", () => {
        render(<TerminalPane task={task()} />);
        expect(FakeTerminal.instances.at(-1)?.options).toMatchObject({ fontSize: 12, lineHeight: 1.1, letterSpacing: 0 });
        expect(FakeTerminal.instances.at(-1)?.loadAddon).toHaveBeenCalledWith(FakeFitAddon.instances.at(-1));
        expect(FakeFitAddon.instances.at(-1)?.fit).toHaveBeenCalledTimes(1);

        FakeResizeObserver.instances.at(-1)?.trigger();
        expect(FakeFitAddon.instances.at(-1)?.fit).toHaveBeenCalledTimes(2);
    });

    it("removes terminal control sequences from the read-only Codex transcript", () => {
        expect(sanitizeCodexTranscript("\u001b[31mred\u001b[0m\rnext\u0008!\u001b]0;title\u0007"))
            .toBe("red\nnext!");
    });

    it("refreshes after destroy and selects the next available task", async () => {
        const first = task({ id: "task_delete", name: "Delete me", status: "running", activeProvisioningIntentId: "intent-delete" });
        const second = task({ id: "task_keep", name: "Keep me", status: "draft" });
        let destroyed = false;
        mockFetch((url) => {
            if (url === "/api/tasks") return destroyed ? [second] : [first, second];
            if (url === "/api/tasks/task_delete/files?path=" || url === "/api/tasks/task_keep/files?path=") return [];
            if (url === "/api/tasks/task_delete/destroy") {
                destroyed = true;
                return { ok: true, id: "task_delete" };
            }
            return task();
        });

        render(<App />);
        await waitFor(() => expect(screen.getAllByText("Delete me").length).toBeGreaterThan(0));
        fireEvent.click(screen.getByText("Destroy"));
        fireEvent.change(screen.getByLabelText("Confirm task name"), { target: { value: "Delete me" } });
        fireEvent.click(screen.getByText("Destroy Task"));

        await waitFor(() => expect(screen.queryAllByText("Delete me")).toHaveLength(0));
        expect(screen.getAllByText("Keep me").length).toBeGreaterThan(0);
    });

    it("renders SteeringPane and sends a mocked prompt", async () => {
        mockFetch(() => task({ status: "idle" }));
        const { container } = render(<SteeringPane task={task()} />);

        expect(screen.getByText(/Prompts are sent into the live Codex terminal session/)).toBeTruthy();
        expect(container.querySelector("pre")).toBeNull();
        fireEvent.change(screen.getByPlaceholderText("Follow-up instruction"), { target: { value: "continue" } });
        fireEvent.click(screen.getByText("Send Prompt"));

        await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/tasks/task_1/prompt", expect.objectContaining({ method: "POST" })));
    });

    it("renders EventLog and appends mocked websocket events", async () => {
        render(<EventLog task={task()} />);
        const socket = FakeWebSocket.instances.at(-1)!;

        act(() => socket.onmessage?.({ data: "{\"type\":\"task.status\"}" }));

        expect(await screen.findByText(/task.status/)).toBeTruthy();
    });

    it("resets FileBrowser state when switching tasks", async () => {
        mockFetch((url) => {
            if (url === "/api/tasks/task_1/files?path=") {
                return [{ name: "folder", path: "folder", type: "directory", size: 0 }];
            }
            if (url === "/api/tasks/task_1/files?path=folder") {
                return [{ name: "nested.txt", path: "folder/nested.txt", type: "file", size: 4 }];
            }
            if (url === "/api/tasks/task_2/files?path=") {
                return [{ name: "other.txt", path: "other.txt", type: "file", size: 5 }];
            }
            return [];
        });
        const { rerender } = render(<FileBrowser task={task()} />);

        fireEvent.click(await screen.findByText("folder"));
        expect(await screen.findByText("Parent directory")).toBeTruthy();
        expect(screen.getByRole("navigation", { name: "Storage path" }).textContent).toContain("folder");

        rerender(<FileBrowser task={task({ id: "task_2", name: "Second" })} />);

        expect(await screen.findByText("other.txt")).toBeTruthy();
        expect(screen.queryByText("Parent directory")).toBeNull();
    });

    it("resets PermissionsEditor state when switching tasks", async () => {
        mockFetch((_url, init) => init?.method === "PATCH" ? JSON.parse(String(init.body)) : permissionState());
        const { rerender } = render(<PermissionsEditor task={task({ networkMode: "open" })} />);

        await waitFor(() => expect(screen.getByText("Save Permissions")).toHaveProperty("disabled", false));
        fireEvent.change(screen.getByLabelText("Network mode"), { target: { value: "none" } });
        fireEvent.click(screen.getByText("Save Permissions"));
        expect(await screen.findByText("Saved; applies to the next run.")).toBeTruthy();

        rerender(<PermissionsEditor task={task({ id: "task_2", networkMode: "open" })} />);

        await waitFor(() => expect(screen.getByLabelText("Network mode")).toHaveProperty("value", "open"));
        expect(screen.queryByText("Saved; applies to the next run.")).toBeNull();
    });

    it("finishes draft creation even when its refresh callback rejects", async () => {
        const created = task({ id: "saved", status: "draft" });
        const onClose = vi.fn();
        const onCreated = vi.fn(async () => { throw new Error("refresh unavailable"); });
        mockFetch(() => created);
        render(<TaskCreateDialog open onClose={onClose} onCreated={onCreated} onSelect={vi.fn()} />);
        fireEvent.change(screen.getByPlaceholderText("Initial prompt"), { target: { value: "solve" } });
        fireEvent.click(screen.getByText("Create Draft"));
        await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
        expect(onCreated).toHaveBeenCalledWith([created]);
        expect(vi.mocked(fetch).mock.calls.filter(([url]) => url === "/api/tasks")).toHaveLength(1);
        expect(screen.queryByText(/Creating task failed/)).toBeNull();
    });

    it("starts a fresh form after closing a saved task whose Start failed", async () => {
        const onCreated = vi.fn();
        vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/start")
            ? { ok: false, json: async () => ({ error: "enqueue unavailable" }) }
            : { ok: true, json: async () => url.endsWith("/models") ? { models: [] } : task({ id: "saved", status: "draft" }) }));
        const props = { open: true, onClose: vi.fn(), onCreated, onSelect: vi.fn() };
        const { rerender } = render(<TaskCreateDialog {...props} />);
        fireEvent.change(screen.getByPlaceholderText("Task name"), { target: { value: "Original" } });
        fireEvent.change(screen.getByPlaceholderText("Initial prompt"), { target: { value: "original prompt" } });
        fireEvent.click(screen.getByText("Create & Run"));
        await screen.findByText(/enqueue unavailable/);
        expect(screen.getByPlaceholderText("Initial prompt")).toHaveProperty("disabled", true);
        expect(onCreated).toHaveBeenCalledWith([expect.objectContaining({ id: "saved" })]);
        rerender(<TaskCreateDialog {...props} open={false} />);
        rerender(<TaskCreateDialog {...props} />);
        expect(screen.getByPlaceholderText("Initial prompt")).toHaveProperty("disabled", false);
        expect(screen.getByPlaceholderText("Initial prompt")).toHaveProperty("value", "");
        expect(screen.getByPlaceholderText("Task name")).toHaveProperty("value", "");
        expect(screen.getByText("Create Draft")).toHaveProperty("disabled", false);
    });

    it("keeps the returned created task when refresh fails and ignores an older list response", async () => {
        let resolveOld: (value: Task[]) => void = () => undefined;
        let lists = 0;
        const created = task({ id: "new_saved", name: "Saved operation", status: "draft" });
        mockFetch((url, init) => {
            if (url === "/api/tasks" && !init?.method) {
                if (++lists === 1) return new Promise<Task[]>((resolve) => { resolveOld = resolve; });
                throw new Error("list unavailable");
            }
            if (url === "/api/tasks") return created;
            if (url.includes("/codex-session")) return { state: "not-started" };
            return [];
        });
        render(<App />);
        fireEvent.click(screen.getAllByRole("button", { name: /New Task/ })[0]);
        fireEvent.change(screen.getByPlaceholderText("Initial prompt"), { target: { value: "solve" } });
        fireEvent.click(screen.getByText("Create Draft"));
        expect(await screen.findByRole("heading", { name: "Saved operation" })).toBeTruthy();
        expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Refreshing tasks failed: list unavailable");
        expect(screen.queryByRole("dialog", { name: "New operation" })).toBeNull();
        await act(async () => resolveOld([]));
        expect(screen.getByRole("heading", { name: "Saved operation" })).toBeTruthy();
    });

    it("ignores errors from an older task-list request after a newer refresh succeeds", async () => {
        vi.useFakeTimers();
        let rejectOld: (error: Error) => void = () => undefined;
        let lists = 0;
        mockFetch((url) => {
            if (url === "/api/tasks") return ++lists === 1
                ? new Promise<Task[]>((_resolve, reject) => { rejectOld = reject; })
                : [task({ name: "Current operation", status: "idle" })];
            return [];
        });
        render(<App />);
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(screen.getByRole("heading", { name: "Current operation" })).toBeTruthy();
        await act(async () => rejectOld(new Error("old request failed")));
        expect(screen.queryByRole("alert")).toBeNull();
    });

    it("polls files without overlapping a slow request and stops after unmount", async () => {
        vi.useFakeTimers();
        let resolveFirst: (value: unknown) => void = () => undefined;
        let calls = 0;
        mockFetch(() => ++calls === 1
            ? new Promise((resolve) => { resolveFirst = resolve; })
            : [{ name: "flag.txt", path: "flag.txt", type: "file", size: 4 }]);
        const { unmount } = render(<FileBrowser task={task()} />);
        expect(screen.queryByText("No files in this directory.")).toBeNull();
        await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
        expect(calls).toBe(1);
        await act(async () => resolveFirst([]));
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(calls).toBe(2);
        expect(screen.getByText("flag.txt")).toBeTruthy();
        unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
        expect(calls).toBe(2);
    });

    it("refreshes files on lifecycle changes and ignores superseded responses", async () => {
        let resolveOld: (value: unknown) => void = () => undefined;
        let calls = 0;
        mockFetch(() => ++calls === 1 ? new Promise((resolve) => { resolveOld = resolve; })
            : [{ name: calls === 2 ? "generated.txt" : "manual.txt", path: "result.txt", type: "file", size: 4 }]);
        const { rerender } = render(<FileBrowser task={task({ status: "running" })} />);
        rerender(<FileBrowser task={task({ status: "idle", workStatus: "done" })} />);
        expect(await screen.findByText("generated.txt")).toBeTruthy();
        await act(async () => resolveOld([{ name: "old.txt", path: "old.txt", type: "file", size: 0 }]));
        expect(screen.queryByText("old.txt")).toBeNull();
        fireEvent.click(screen.getByLabelText("Refresh files"));
        expect(await screen.findByText("manual.txt")).toBeTruthy();
    });

    it("labels live remote snapshots and refreshes after a downloaded generation changes", async () => {
        let calls = 0;
        mockFetch(() => { calls += 1; return []; });
        const sync = { owner: "remote" as const, state: "idle" as const, generation: "one", lastSyncedAt: "2026-10-16T01:00:00Z" };
        const { rerender } = render(<FileBrowser task={task({ workspaceSync: sync })} />);
        expect(await screen.findByText(/Live remote task; displayed files are a provisional snapshot/)).toBeTruthy();
        expect(screen.getByRole("status").textContent).toContain("Last synced:");
        await waitFor(() => expect(calls).toBe(1));
        rerender(<FileBrowser task={task({ workspaceSync: { ...sync, generation: "two" } })} />);
        await waitFor(() => expect(calls).toBe(2));
        rerender(<FileBrowser task={task({ workspaceSync: { ...sync, state: "error", error: "download failed" } })} />);
        expect(screen.getByRole("status").textContent).toContain("Displayed files may be stale.");
    });

    it("loads saved permissions independently of task metadata and preserves mounts when saving", async () => {
        const saved = permissionState("none");
        saved.permissions.mounts = [{ label: "data", source: "/tmp/data", target: "/mnt/extra/data", mode: "ro" }];
        const changed = vi.fn();
        mockFetch((_url, init) => init?.method === "PATCH" ? JSON.parse(String(init.body)) : saved);
        render(<PermissionsEditor task={task({ networkMode: "open" })} onChanged={changed} />);
        await waitFor(() => expect(screen.getByLabelText("Network mode")).toHaveProperty("value", "none"));
        expect(screen.getByRole("option", { name: "codex-only" })).toHaveProperty("disabled", true);
        expect(screen.getByRole("option", { name: "proxy-allowlist" })).toHaveProperty("disabled", true);
        expect(screen.getByText("Supported network modes for this runtime: open, none.")).toBeTruthy();
        fireEvent.change(screen.getByLabelText("Network mode"), { target: { value: "open" } });
        fireEvent.click(screen.getByText("Save Permissions"));
        await screen.findByText("Saved; applies to the next run.");
        const patch = vi.mocked(fetch).mock.calls.find(([_url, init]) => init?.method === "PATCH");
        expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({ mounts: saved.permissions.mounts, network: { mode: "open", enforcement: "open-warning" } });
        expect(changed).toHaveBeenCalledOnce();
    });

    it("disables permission changes using the backend reason", async () => {
        mockFetch(() => permissionState("open", false, "Stop the active run before editing permissions."));
        render(<PermissionsEditor task={task()} />);
        expect(await screen.findByText("Stop the active run before editing permissions.")).toBeTruthy();
        expect(screen.getByLabelText("Network mode")).toHaveProperty("disabled", true);
        expect(screen.getByText("Save Permissions")).toHaveProperty("disabled", true);
    });

    it("keeps an unsaved permission selection when task status refreshes", async () => {
        mockFetch(() => permissionState("open"));
        const { rerender } = render(<PermissionsEditor task={task({ status: "draft" })} />);
        await waitFor(() => expect(screen.getByText("Save Permissions")).toHaveProperty("disabled", false));
        fireEvent.change(screen.getByLabelText("Network mode"), { target: { value: "none" } });
        rerender(<PermissionsEditor task={task({ status: "idle" })} />);
        await waitFor(() => expect(screen.getByText("Save Permissions")).toHaveProperty("disabled", false));
        expect(screen.getByLabelText("Network mode")).toHaveProperty("value", "none");
    });

    it("reports an invalid permissions response without rendering editable controls", async () => {
        mockFetch(() => ({ ok: true }));
        render(<PermissionsEditor task={task()} />);
        expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Server returned an invalid permissions response");
        expect(screen.getByText("Save Permissions")).toHaveProperty("disabled", true);
        expect(screen.getByText("Retry permissions")).toBeTruthy();
    });

    it("uses a transient mobile queue and restores focus on Escape without changing desktop preferences", async () => {
        const resize = mockViewport(390);
        window.localStorage.setItem("mecha-webui-sidebar-open", "true");
        window.localStorage.setItem("mecha-webui-sidebar-width", "560");
        mockFetch((url) => url === "/api/tasks" ? [task()] : []);
        const { container } = render(<App />);
        await screen.findByRole("heading", { name: "Native task" });
        const toggle = screen.getByLabelText("Expand task queue");
        toggle.focus();
        fireEvent.click(toggle);
        expect(screen.getByRole("dialog", { name: "Task queue drawer" })).toBeTruthy();
        expect(document.activeElement).toBe(screen.getByLabelText("Search tasks"));
        fireEvent.keyDown(window, { key: "Escape" });
        expect(screen.queryByRole("dialog", { name: "Task queue drawer" })).toBeNull();
        expect(document.activeElement).toBe(toggle);
        expect(window.localStorage.getItem("mecha-webui-sidebar-open")).toBe("true");
        act(() => resize(1400));
        expect(container.querySelector(".app")?.classList.contains("sidebar-collapsed")).toBe(false);
        expect(container.querySelector(".app")?.getAttribute("style")).toContain("560px");
    });

    it("closes an inspector overlay with Escape and restores focus to its opener", async () => {
        mockViewport(390);
        mockFetch(() => []);
        render(<TaskView task={task()} onChanged={vi.fn()} />);
        const toggle = screen.getByLabelText("Show inspector");
        toggle.focus();
        fireEvent.click(toggle);
        expect(screen.getByRole("dialog", { name: "Task inspector" })).toBeTruthy();
        fireEvent.keyDown(window, { key: "Escape" });
        expect(screen.queryByRole("dialog", { name: "Task inspector" })).toBeNull();
        expect(document.activeElement).toBe(toggle);
    });

    it("restores New Task focus and traps keyboard navigation inside its modal", () => {
        mockFetch(() => []);
        const { rerender } = render(<><button>Open task</button><TaskCreateDialog open={false} onClose={vi.fn()} onCreated={vi.fn()} onSelect={vi.fn()} /></>);
        const opener = screen.getByText("Open task");
        opener.focus();
        rerender(<><button>Open task</button><TaskCreateDialog open onClose={vi.fn()} onCreated={vi.fn()} onSelect={vi.fn()} /></>);
        const last = screen.getByText("Create & Run");
        fireEvent.change(screen.getByPlaceholderText("Initial prompt"), { target: { value: "solve" } });
        last.focus();
        fireEvent.keyDown(window, { key: "Tab" });
        expect(document.activeElement).toBe(screen.getByLabelText("Close new task dialog"));
        rerender(<><button>Open task</button><TaskCreateDialog open={false} onClose={vi.fn()} onCreated={vi.fn()} onSelect={vi.fn()} /></>);
        expect(document.activeElement).toBe(opener);
    });
});
