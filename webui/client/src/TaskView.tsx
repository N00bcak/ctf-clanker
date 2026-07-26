import { useEffect, useState } from "react";
import { api, type Task } from "./api";
import { EventLog } from "./EventLog";
import { FileBrowser } from "./FileBrowser";
import { PermissionsEditor } from "./PermissionsEditor";
import { TerminalPane } from "./TerminalPane";

const INSPECTOR_OPEN_KEY = "mecha-webui-inspector-open";
const INSPECTOR_WIDTH_KEY = "mecha-webui-inspector-width";
const INSPECTOR_MIN = 280;
const INSPECTOR_MAX = 560;
const INSPECTOR_DEFAULT = 360;

function clampInspectorWidth(value: number): number {
    return Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, value));
}

export function TaskView({ task, onChanged }: { task: Task; onChanged: () => void | Promise<void> }) {
    const [error, setError] = useState<string>();
    const [warning, setWarning] = useState<string>();
    const [progress, setProgress] = useState<string>();
    const [prompt, setPrompt] = useState("");
    const [consoleTab, setConsoleTab] = useState<"codex" | "shell">("codex");
    const [toolTab, setToolTab] = useState<"files" | "permissions" | "events" | "context">("files");
    const [inspectorOpen, setInspectorOpen] = useState(() => window.localStorage.getItem(INSPECTOR_OPEN_KEY) !== "false");
    const [inspectorWidth, setInspectorWidth] = useState(() => {
        const stored = Number(window.localStorage.getItem(INSPECTOR_WIDTH_KEY));
        return Number.isFinite(stored) && stored > 0 ? clampInspectorWidth(stored) : INSPECTOR_DEFAULT;
    });
    const [destroyOpen, setDestroyOpen] = useState(false);
    const [destroyName, setDestroyName] = useState("");
    const shellAvailable = task.codexRuntime !== "host";

    useEffect(() => {
        if (!shellAvailable && consoleTab === "shell") setConsoleTab("codex");
    }, [shellAvailable, consoleTab]);

    useEffect(() => {
        setDestroyOpen(false);
        setDestroyName("");
    }, [task.id]);

    function runnerReady(candidate: Task): boolean {
        return candidate.bridgeMode === "host-codex-broker" || (candidate.status === "running" && Boolean(candidate.activeProvisioningIntentId));
    }

    async function action(fn: () => Promise<unknown>) {
        try {
            setError(undefined);
            setWarning(undefined);
            setProgress(undefined);
            await fn();
            await onChanged();
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
            setProgress(undefined);
        }
    }

    async function startTask() {
        let phase = "Starting runner";
        try {
            setError(undefined);
            setWarning(undefined);
            setProgress(`${phase}...`);
            const started = await api.start(task.id);
            await onChanged();
            if (!runnerReady(started)) {
                setWarning("Runner is not ready yet; Codex has not been called.");
                setProgress(undefined);
                return;
            }
            if (task.status === "draft") {
                phase = "Calling Codex";
                setProgress(`${phase}...`);
                const initial = await api.initialPrompt(task.id);
                await api.prompt(task.id, initial.prompt);
                await onChanged();
            }
            setProgress(undefined);
        } catch (err) {
            setError(err instanceof Error ? `${phase} failed: ${err.message}` : String(err));
            setProgress(undefined);
        }
    }

    async function sendPrompt() {
        if (!prompt.trim()) return;
        try {
            setError(undefined);
            setWarning(undefined);
            setProgress("Calling Codex...");
            await api.prompt(task.id, prompt);
            setPrompt("");
            setProgress(undefined);
            await onChanged();
        } catch (err) {
            setError(err instanceof Error ? `Calling Codex failed: ${err.message}` : String(err));
            setProgress(undefined);
        }
    }

    function toggleInspector(open: boolean) {
        setInspectorOpen(open);
        window.localStorage.setItem(INSPECTOR_OPEN_KEY, String(open));
    }

    function startInspectorResize(event: React.MouseEvent<HTMLDivElement>): void {
        event.preventDefault();
        const onMove = (moveEvent: MouseEvent) => {
            const width = clampInspectorWidth(window.innerWidth - moveEvent.clientX);
            setInspectorWidth(width);
            window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(width));
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }

    async function destroyTask() {
        await action(() => api.destroy(task.id));
        setDestroyOpen(false);
        setDestroyName("");
    }

    const status = task.status;
    const disabled = {
        start: ["queued", "provisioning", "destroying", "finished", "orphaned"].includes(status) || Boolean(progress),
        stop: ["draft", "idle", "failed", "destroying", "finished", "orphaned"].includes(status) || Boolean(progress),
        destroy: ["destroying", "orphaned"].includes(status) || Boolean(progress)
    };
    const startClass = status === "running" ? "action-button action-green" : disabled.start ? "action-button action-disabled" : "action-button action-yellow";
    const stopClass = disabled.stop ? "action-button action-disabled" : "action-button action-yellow";
    const workStatusLabel: Record<Task["workStatus"], string> = { "not-started": "READY", running: "RUNNING", "needs-attention": "ATTENTION", done: "DONE", failed: "FAILED" };
    const canSend = task.bridgeMode !== "native-codex-app-server" || runnerReady(task);
    const nativeSandbox = task.codexSettings?.sandbox ?? "danger-full-access";
    const risks = [
        task.networkMode === "open" ? "Open network permits outbound exfiltration from readable task data." : undefined,
        task.bridgeMode === "native-codex-app-server" && nativeSandbox === "danger-full-access"
            ? "Codex sandboxing is disabled inside the runner; Docker/droplet isolation is the boundary."
            : task.bridgeMode === "native-codex-app-server"
                ? `Codex uses its ${nativeSandbox} sandbox inside the runner; Docker/droplet isolation remains the outer boundary.`
                : undefined,
        task.bridgeMode === "host-codex-broker" ? "Host broker uses the host Codex CLI with workspace-write access to task storage." : undefined
    ].filter((risk): risk is string => Boolean(risk));

    return (
        <div className="task-view">
            <header className="task-header">
                <div className="task-identity">
                    <div className={`work-status work-status-${task.workStatus}`}><i />{workStatusLabel[task.workStatus]}</div>
                    <div><h1>{task.name}</h1><p className="task-id">{task.id}</p></div>
                    <span className="runner-chip">RUNNER · {task.status.toUpperCase()}</span>
                </div>
                <div className="header-actions">
                    <div className="actions runtime-actions">
                        <button className={startClass} disabled={disabled.start} onClick={startTask}>Start</button>
                        <button className={stopClass} disabled={disabled.stop} onClick={() => action(() => api.stop(task.id))}>Stop</button>
                    </div>
                    <div className="actions work-actions">
                        <button disabled={task.workStatus === "done" || Boolean(progress)} onClick={() => action(() => api.workStatus(task.id, "done"))}>Mark Done</button>
                        <button disabled={task.workStatus !== "done" || Boolean(progress)} onClick={() => action(() => api.workStatus(task.id, "running"))}>Reopen</button>
                        <button className="button-danger-quiet" disabled={disabled.destroy} onClick={() => setDestroyOpen(true)}>Destroy</button>
                    </div>
                    <button className="inspector-toggle" aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"} aria-expanded={inspectorOpen} onClick={() => toggleInspector(!inspectorOpen)}>{inspectorOpen ? "Hide Inspector" : "Show Inspector"}</button>
                </div>
            </header>
            <div className="task-feedback" aria-live="polite">
                {progress && <div className="progress-message"><span className="spinner" />{progress}</div>}
                {warning && <div className="warning">{warning}</div>}
                {error && <div className="error">{error}</div>}
            </div>
            {risks.length > 0 && (
                <details className="risk-panel">
                    <summary><span className="risk-icon" aria-hidden="true">!</span><strong>{risks.length} security notice{risks.length === 1 ? "" : "s"}</strong><span>Review execution boundaries</span></summary>
                    <ul>{risks.map((risk) => <li key={risk}>{risk}</li>)}</ul>
                </details>
            )}
            <div className={inspectorOpen ? "cockpit-workspace" : "cockpit-workspace inspector-collapsed"} style={{ "--inspector-width": `${inspectorWidth}px` } as React.CSSProperties}>
                <section className="console-workspace" aria-label="Task console">
                    <div className="console-toolbar">
                        <div className="console-tabs" role="tablist" aria-label="Console tabs">
                            <button role="tab" aria-selected={consoleTab === "codex"} className={consoleTab === "codex" ? "tab active" : "tab"} onClick={() => setConsoleTab("codex")}>Codex</button>
                            {shellAvailable && <button role="tab" aria-selected={consoleTab === "shell"} className={consoleTab === "shell" ? "tab active" : "tab"} onClick={() => setConsoleTab("shell")}>Shell</button>}
                        </div>
                        <span className="connection-label"><i className={runnerReady(task) ? "connected" : ""} />{runnerReady(task) ? "CONNECTED" : "WAITING"}</span>
                    </div>
                    <div className="console-content" role="tabpanel" aria-label={`${consoleTab} console`}><TerminalPane task={task} mode={consoleTab} /></div>
                    <section className="prompt-composer">
                        <textarea
                            aria-label="Prompt Codex"
                            value={prompt}
                            onChange={(event) => setPrompt(event.target.value)}
                            onKeyDown={(event) => {
                                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                                    event.preventDefault();
                                    void sendPrompt();
                                }
                            }}
                            placeholder="Steer Codex…"
                        />
                        <div className="composer-actions"><span><kbd>⌘</kbd><kbd>↵</kbd> to send</span><button className="button-primary" onClick={sendPrompt} disabled={!canSend || !prompt.trim() || Boolean(progress)}>Send</button></div>
                    </section>
                </section>
                {inspectorOpen && <>
                    <div aria-label="Resize inspector" aria-orientation="vertical" className="inspector-resizer" role="separator" onMouseDown={startInspectorResize} />
                    <aside className="inspector-panel open" aria-label="Task inspector">
                        <div className="inspector-header"><div><span className="eyebrow">Selected task</span><strong>Inspector</strong></div><button className="icon-button inspector-close" aria-label="Close inspector" onClick={() => toggleInspector(false)}>×</button></div>
                        <div className="tool-tabs" role="tablist" aria-label="Task tools">
                            {(["files", "permissions", "events", "context"] as const).map((tab) => (
                                <button key={tab} role="tab" aria-selected={toolTab === tab} className={toolTab === tab ? "tab active" : "tab"} onClick={() => setToolTab(tab)}>{tab[0].toUpperCase() + tab.slice(1)}</button>
                            ))}
                        </div>
                        <div className="tool-panel" role="tabpanel" aria-label={`${toolTab} inspector`}>
                            {toolTab === "files" && <FileBrowser task={task} />}
                            {toolTab === "permissions" && <PermissionsEditor task={task} />}
                            {toolTab === "events" && <EventLog task={task} />}
                            {toolTab === "context" && (
                                <section className="pane context-pane">
                                    <h2>Runtime context</h2>
                                    <dl>
                                        <div><dt>Workspace</dt><dd>{task.storagePath}</dd></div>
                                        <div><dt>Backend</dt><dd>{task.backend}</dd></div>
                                        <div><dt>Runtime</dt><dd>{task.codexRuntime}</dd></div>
                                        <div><dt>Bridge</dt><dd>{task.bridgeMode}</dd></div>
                                        <div><dt>Credential</dt><dd>{task.credentialMode}</dd></div>
                                        <div><dt>Network</dt><dd>{task.networkMode} · {task.networkEnforcement}</dd></div>
                                        <div><dt>Created</dt><dd>{new Date(task.createdAt).toLocaleString()}</dd></div>
                                    </dl>
                                </section>
                            )}
                        </div>
                    </aside>
                    <button className="inspector-scrim" aria-label="Close inspector overlay" onClick={() => toggleInspector(false)} />
                </>}
            </div>
            {destroyOpen && (
                <div className="dialog-backdrop danger-backdrop" role="presentation">
                    <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="destroy-title">
                        <span className="danger-symbol" aria-hidden="true">!</span>
                        <h2 id="destroy-title">Destroy {task.name}?</h2>
                        <p>This removes the runner and task storage. Type <strong>{task.name}</strong> to confirm.</p>
                        <input autoFocus aria-label="Confirm task name" value={destroyName} onChange={(event) => setDestroyName(event.target.value)} />
                        <div className="dialog-actions"><button onClick={() => { setDestroyOpen(false); setDestroyName(""); }}>Cancel</button><button className="button-danger" disabled={destroyName !== task.name} onClick={destroyTask}>Destroy Task</button></div>
                    </section>
                </div>
            )}
        </div>
    );
}
