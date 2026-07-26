import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { api, type Task } from "./api";
import { TaskCreateDialog } from "./TaskCreateDialog";
import { TaskList } from "./TaskList";
import { TaskView } from "./TaskView";

const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 560;
const SIDEBAR_DEFAULT = 320;
const SIDEBAR_WIDTH_KEY = "mecha-webui-sidebar-width";
const SIDEBAR_OPEN_KEY = "mecha-webui-sidebar-open";

function clampSidebarWidth(value: number): number {
    return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, value));
}

export function App() {
    const [tasks, setTasks] = useState<Task[]>([]);
    const [selectedId, setSelectedId] = useState<string | undefined>();
    const [createOpen, setCreateOpen] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [sidebarOpen, setSidebarOpen] = useState(() => window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false");
    const [sidebarWidth, setSidebarWidth] = useState(() => {
        const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
        return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : SIDEBAR_DEFAULT;
    });
    const selected = useMemo(() => tasks.find((task) => task.id === selectedId) ?? tasks[0], [tasks, selectedId]);
    const attentionCount = tasks.filter((task) => task.workStatus === "needs-attention" || task.workStatus === "failed").length;
    const runningCount = tasks.filter((task) => task.workStatus === "running").length;

    async function refresh() {
        const next = await api.tasks();
        setTasks(next);
        setSelectedId((current) => current && next.some((task) => task.id === current) ? current : next[0]?.id);
        setError(undefined);
    }

    function startSidebarResize(event: React.MouseEvent<HTMLDivElement>): void {
        event.preventDefault();
        const onMove = (moveEvent: MouseEvent) => {
            const width = clampSidebarWidth(moveEvent.clientX);
            setSidebarWidth(width);
            window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
        };
        const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
    }

    function toggleSidebar(): void {
        setSidebarOpen((current) => {
            const open = !current;
            window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(open));
            return open;
        });
    }

    useEffect(() => {
        refresh().catch((err) => setError(err.message));
        const interval = setInterval(() => refresh().catch((err) => setError(err.message)), 5000);
        return () => clearInterval(interval);
    }, []);

    return (
        <main className={sidebarOpen ? "app" : "app sidebar-collapsed"} style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
            <header className="app-bar">
                <div className="brand-lockup">
                    <span className="brand-mark" aria-hidden="true">M</span>
                    <div><strong>MECHA</strong><span>OPERATIONS CONSOLE</span></div>
                    <button className="icon-button sidebar-toggle" aria-label={sidebarOpen ? "Collapse task queue" : "Expand task queue"} aria-expanded={sidebarOpen} onClick={toggleSidebar}>{sidebarOpen ? "‹" : "›"}</button>
                </div>
                <div className="fleet-status" aria-label="Fleet status">
                    <span><i className="status-light status-light-running" />{runningCount} running</span>
                    <span><i className="status-light status-light-attention" />{attentionCount} attention</span>
                    <span>{tasks.length} total</span>
                </div>
                <button className="button-primary new-task-button" onClick={() => setCreateOpen(true)}><span aria-hidden="true">＋</span> New Task</button>
            </header>
            <aside className="sidebar">
                <div className="sidebar-heading"><span className="eyebrow">Task fleet</span><strong>Operations queue</strong></div>
                {error && <div className="error">{error}</div>}
                <TaskList tasks={tasks} selectedId={selected?.id} onSelect={setSelectedId} />
            </aside>
            <div aria-label="Resize task queue" aria-orientation="vertical" className="sidebar-resizer" role="separator" onMouseDown={startSidebarResize} />
            <section className="workspace">
                {selected ? <TaskView task={selected} onChanged={refresh} /> : (
                    <div className="empty-state">
                        <span className="brand-mark large" aria-hidden="true">M</span>
                        <h1>No active operation</h1>
                        <p>Create a single task or import a CTF batch to begin.</p>
                        <button className="button-primary" onClick={() => setCreateOpen(true)}>New Task</button>
                    </div>
                )}
            </section>
            <TaskCreateDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={refresh} onSelect={setSelectedId} />
        </main>
    );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
