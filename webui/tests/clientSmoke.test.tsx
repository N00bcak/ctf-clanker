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
import type { Task } from "../client/src/api";

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

function mockFetch(handler: (url: string, init?: RequestInit) => unknown): void {
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
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
        vi.unstubAllGlobals();
    });

    it("sets up a draft task without starting it", async () => {
        const created = task({ id: "created", name: "Created" });
        const onCreated = vi.fn();
        const onSelect = vi.fn();
        const urls: string[] = [];
        mockFetch((url) => {
            urls.push(url);
            return created;
        });

        render(<TaskCreateDialog open onClose={vi.fn()} onCreated={onCreated} onSelect={onSelect} />);
        fireEvent.change(screen.getByPlaceholderText("Task name"), { target: { value: "Created" } });
        fireEvent.change(screen.getByPlaceholderText("Initial prompt"), { target: { value: "Do work" } });
        fireEvent.click(screen.getByText("Create Draft"));

        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(onSelect).toHaveBeenCalledWith("created");
        expect(urls).toEqual(["/api/tasks"]);
    });

    it("runs clanker by creating, starting, and prompting in order", async () => {
        const created = task({ id: "created", name: "Created", status: "draft" });
        const requests: Array<{ url: string; body?: unknown }> = [];
        mockFetch((url, init) => {
            requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            if (url === "/api/tasks") return created;
            if (url === "/api/tasks/created/start") return task({ id: "created", status: "running", activeProvisioningIntentId: "intent-1" });
            if (url === "/api/tasks/created/prompt") return task({ id: "created", status: "idle" });
            return task();
        });

        render(<TaskCreateDialog open onClose={vi.fn()} onCreated={vi.fn()} onSelect={vi.fn()} />);
        fireEvent.change(screen.getByPlaceholderText("Task name"), { target: { value: "Created" } });
        fireEvent.change(screen.getByPlaceholderText("Initial prompt"), { target: { value: "Do work" } });
        fireEvent.click(screen.getByText("Create & Run"));

        await waitFor(() => expect(requests.map((request) => request.url)).toEqual([
            "/api/tasks",
            "/api/tasks/created/start",
            "/api/tasks/created/prompt"
        ]));
        expect(requests[2].body).toEqual({ prompt: "Do work" });
    });

    it("shows a warning and does not prompt when Create & Run returns queued", async () => {
        const requests: string[] = [];
        mockFetch((url) => {
            requests.push(url);
            if (url === "/api/tasks") return task({ id: "queued", status: "draft" });
            if (url === "/api/tasks/queued/start") return task({ id: "queued", status: "queued" });
            return task();
        });

        render(<TaskCreateDialog open onClose={vi.fn()} onCreated={vi.fn()} onSelect={vi.fn()} />);
        fireEvent.change(screen.getByPlaceholderText("Initial prompt"), { target: { value: "Do work" } });
        fireEvent.click(screen.getByText("Create & Run"));

        expect(await screen.findByText("Runner is not ready yet; Codex has not been called.")).toBeTruthy();
        expect(requests).not.toContain("/api/tasks/queued/prompt");
    });

    it("keeps form data and identifies the failed run phase", async () => {
        const created = task({ id: "created", name: "Created", status: "draft" });
        vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
            const path = String(url);
            if (path === "/api/tasks/created/start") {
                return { ok: false, json: async () => ({ error: "docker failed" }) };
            }
            return { ok: true, json: async () => created };
        }));

        render(<TaskCreateDialog open onClose={vi.fn()} onCreated={vi.fn()} onSelect={vi.fn()} />);
        fireEvent.change(screen.getByPlaceholderText("Task name"), { target: { value: "Created" } });
        fireEvent.change(screen.getByPlaceholderText("Initial prompt"), { target: { value: "Do work" } });
        fireEvent.click(screen.getByText("Create & Run"));

        expect(await screen.findByText(/Starting runner failed: docker failed/)).toBeTruthy();
        expect(screen.getByDisplayValue("Created")).toBeTruthy();
        expect(screen.getByDisplayValue("Do work")).toBeTruthy();
    });

    it("sets up a task with settings and uploaded files", async () => {
        const created = task({ id: "uploaded", name: "Uploaded" });
        const onCreated = vi.fn();
        const requests: unknown[] = [];
        mockFetch((_url, init) => {
            requests.push(JSON.parse(String(init?.body)));
            return created;
        });

        const { container } = render(<TaskCreateDialog open onClose={vi.fn()} onCreated={onCreated} onSelect={vi.fn()} />);
        fireEvent.change(screen.getByPlaceholderText("Task name"), { target: { value: "Uploaded" } });
        fireEvent.change(screen.getByPlaceholderText("Initial prompt"), { target: { value: "Solve this" } });
        await screen.findByRole("option", { name: "GPT-5.6 Sol · gpt-5.6-sol" });
        fireEvent.change(screen.getByLabelText("Model"), { target: { value: "gpt-5.6-sol" } });
        fireEvent.change(container.querySelector("input[type='file']")!, {
            target: { files: [new File(["flag"], "flag.txt")] }
        });
        fireEvent.click(screen.getByText("Create Draft"));

        await waitFor(() => expect(onCreated).toHaveBeenCalled());
        expect(requests[0]).toMatchObject({
            name: "Uploaded",
            prompt: "Solve this",
            backend: "local",
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

    it("starts a draft task by starting the runner, reading the stored prompt, and calling Codex", async () => {
        const calls: string[] = [];
        mockFetch((url) => {
            calls.push(url);
            if (url === "/api/tasks/task_1/initial-prompt") return { prompt: "stored setup prompt" };
            if (url === "/api/tasks/task_1/files?path=") return [];
            return task({ status: "running", activeProvisioningIntentId: "intent-1" });
        });

        render(<TaskView task={task({ status: "draft" })} onChanged={vi.fn()} />);
        fireEvent.click(screen.getByText("Start"));

        await waitFor(() => expect(calls.filter((url) => url.includes("/start") || url.includes("/initial-prompt") || url.includes("/prompt"))).toEqual([
            "/api/tasks/task_1/start",
            "/api/tasks/task_1/initial-prompt",
            "/api/tasks/task_1/prompt"
        ]));
    });

    it("sends a prompt with Command-Enter while leaving plain Enter to the textarea", async () => {
        const calls: Array<{ url: string; body?: unknown }> = [];
        mockFetch((url, init) => {
            calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
            if (url.includes("/codex-session")) return { state: "active" };
            if (url.includes("/files")) return [];
            return task({ activeProvisioningIntentId: "intent-1" });
        });
        render(<TaskView task={task({ activeProvisioningIntentId: "intent-1" })} onChanged={vi.fn()} />);
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

    it("shows a warning and does not prompt when draft Start has no runner yet", async () => {
        const calls: string[] = [];
        mockFetch((url) => {
            calls.push(url);
            if (url === "/api/tasks/task_1/files?path=") return [];
            if (url === "/api/tasks/task_1/start") return task({ status: "queued" });
            return task();
        });

        render(<TaskView task={task({ status: "draft" })} onChanged={vi.fn()} />);
        fireEvent.click(screen.getByText("Start"));

        expect(await screen.findByText("Runner is not ready yet; Codex has not been called.")).toBeTruthy();
        expect(calls).not.toContain("/api/tasks/task_1/prompt");
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
            body: { workStatus: "running" }
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

    it("runs clanker for host-broker tasks without requiring a runner handle", async () => {
        const requests: string[] = [];
        mockFetch((url) => {
            requests.push(url);
            if (url === "/api/tasks") return task({
                id: "host",
                bridgeMode: "host-codex-broker",
                codexRuntime: "host",
                credentialMode: "host-codex-cli",
                status: "draft"
            });
            if (url === "/api/tasks/host/start") return task({
                id: "host",
                bridgeMode: "host-codex-broker",
                codexRuntime: "host",
                credentialMode: "host-codex-cli",
                status: "idle"
            });
            if (url === "/api/tasks/host/prompt") return task({
                id: "host",
                bridgeMode: "host-codex-broker",
                codexRuntime: "host",
                credentialMode: "host-codex-cli",
                status: "idle"
            });
            return task();
        });

        render(<TaskCreateDialog open onClose={vi.fn()} onCreated={vi.fn()} onSelect={vi.fn()} />);
        fireEvent.change(screen.getByPlaceholderText("Initial prompt"), { target: { value: "Do host work" } });
        fireEvent.click(screen.getByText("Create & Run"));

        await waitFor(() => expect(requests.filter((url) => url.includes("host") || url === "/api/tasks")).toEqual([
            "/api/tasks",
            "/api/tasks/host/start",
            "/api/tasks/host/prompt"
        ]));
        expect(screen.queryByText("Runner is not ready yet; Codex has not been called.")).toBeNull();
    });

    it("shows a warning and does not prompt when Create & Run DigitalOcean dry-run is not ready", async () => {
        const requests: string[] = [];
        mockFetch((url) => {
            requests.push(url);
            if (url === "/api/tasks") return task({ id: "dry", backend: "digitalocean", status: "draft" });
            if (url === "/api/tasks/dry/start") return task({ id: "dry", backend: "digitalocean", status: "idle", activeProvisioningIntentId: "intent-dry" });
            return task();
        });

        render(<TaskCreateDialog open onClose={vi.fn()} onCreated={vi.fn()} onSelect={vi.fn()} />);
        fireEvent.change(screen.getByDisplayValue("Local appserver"), { target: { value: "digitalocean" } });
        fireEvent.change(screen.getByPlaceholderText("Initial prompt"), { target: { value: "Do work" } });
        fireEvent.click(screen.getByText("Create & Run"));

        expect(await screen.findByText("Runner is not ready yet; Codex has not been called.")).toBeTruthy();
        expect(requests).not.toContain("/api/tasks/dry/prompt");
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

    it("renders PermissionsEditor and saves mocked permissions", async () => {
        mockFetch(() => ({ ok: true }));
        render(<PermissionsEditor task={task()} />);

        fireEvent.change(screen.getByLabelText("Network mode"), { target: { value: "none" } });
        fireEvent.click(screen.getByText("Save Permissions"));

        expect(await screen.findByText("Saved")).toBeTruthy();
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
        mockFetch(() => ({ ok: true }));
        const { rerender } = render(<PermissionsEditor task={task({ networkMode: "open" })} />);

        fireEvent.change(screen.getByLabelText("Network mode"), { target: { value: "none" } });
        fireEvent.click(screen.getByText("Save Permissions"));
        expect(await screen.findByText("Saved")).toBeTruthy();

        rerender(<PermissionsEditor task={task({ id: "task_2", networkMode: "open" })} />);

        expect(screen.getByLabelText("Network mode")).toHaveProperty("value", "open");
        expect(screen.queryByText("Saved")).toBeNull();
    });
});
