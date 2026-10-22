import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { api, type SchedulerStatus as SchedulerState, type Task } from "./api";
import { SchedulerStatus } from "./SchedulerStatus";
import { TaskCreateDialog } from "./TaskCreateDialog";
import { TaskList } from "./TaskList";
import { TaskView } from "./TaskView";
import { useMediaQuery, useOverlay } from "./useOverlay";

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
    const [selectedId, setSelectedId] = useState<string | undefined>(() => new URLSearchParams(window.location.search).get("task") ?? undefined);
    const [createOpen, setCreateOpen] = useState(false);
    const [error, setError] = useState<string | undefined>();
    const [scheduler, setScheduler] = useState<SchedulerState | undefined>();
    const [schedulerError, setSchedulerError] = useState<string | undefined>();
    const [sidebarOpen, setSidebarOpen] = useState(() => window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false");
    const mobile = useMediaQuery("(max-width: 767px)");
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
    const queueOpen = mobile ? mobileSidebarOpen : sidebarOpen;
    const sidebarRef = useRef<HTMLElement>(null);
    const refreshGeneration = useRef(0);
    const schedulerGeneration = useRef(0);
    const schedulerRefreshing = useRef(false);
    useOverlay(mobile && mobileSidebarOpen && !createOpen, sidebarRef, () => setMobileSidebarOpen(false));
    const [sidebarWidth, setSidebarWidth] = useState(() => {
        const stored = Number(window.localStorage.getItem(SIDEBAR_WIDTH_KEY));
        return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : SIDEBAR_DEFAULT;
    });
    const selected = useMemo(() => tasks.find((task) => task.id === selectedId) ?? tasks[0], [tasks, selectedId]);
    const attentionCount = tasks.filter((task) => task.workStatus === "needs-attention" || task.workStatus === "failed").length;
    const runningCount = tasks.filter((task) => task.workStatus === "running").length;

    async function refresh() {
        const generation = ++refreshGeneration.current;
        try {
            const next = await api.tasks();
            if (generation !== refreshGeneration.current) return;
            setTasks(next);
            setSelectedId((current) => current && next.some((task) => task.id === current) ? current : next[0]?.id);
            setError(undefined);
        } catch (err) {
            if (generation === refreshGeneration.current) setError(err instanceof Error ? err.message : String(err));
        }
    }

    async function refreshScheduler() {
        if (schedulerRefreshing.current) return;
        schedulerRefreshing.current = true;
        const generation = ++schedulerGeneration.current;
        try {
            const next = await api.scheduler();
            if (generation !== schedulerGeneration.current) return;
            setScheduler(next);
            setSchedulerError(undefined);
        } catch (err) {
            if (generation !== schedulerGeneration.current) return;
            setScheduler(undefined);
            setSchedulerError(err instanceof Error ? err.message : String(err));
        } finally {
            schedulerRefreshing.current = false;
        }
    }

    function selectTask(id: string) {
        setSelectedId(id);
        setMobileSidebarOpen(false);
    }

    function createdTasks(created: Task[]) {
        ++refreshGeneration.current;
        setTasks((current) => [...created.slice().reverse(), ...current.filter((task) => !created.some((item) => item.id === task.id))]);
        if (created.length) selectTask(created[created.length - 1].id);
        void refresh();
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
        if (mobile) {
            setMobileSidebarOpen((current) => !current);
            return;
        }
        setSidebarOpen((current) => {
            const open = !current;
            window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(open));
            return open;
        });
    }

    useEffect(() => {
        void refresh();
        void refreshScheduler();
        const interval = setInterval(() => { void refresh(); void refreshScheduler(); }, 5000);
        return () => {
            clearInterval(interval);
            ++refreshGeneration.current;
            ++schedulerGeneration.current;
        };
    }, []);

    return (
        <main className={queueOpen ? "app" : "app sidebar-collapsed"} style={{ "--sidebar-width": `${sidebarWidth}px` } as React.CSSProperties}>
            <header className="app-bar">
                <div className="brand-lockup">
                    <span className="brand-mark" aria-hidden="true">M</span>
                    <div><strong>MECHA</strong><span>OPERATIONS CONSOLE</span></div>
                    <button className="icon-button sidebar-toggle" aria-label={queueOpen ? "Collapse task queue" : "Expand task queue"} aria-expanded={queueOpen} onClick={toggleSidebar}>{queueOpen ? "‹" : "›"}</button>
                </div>
                <div className="fleet-status" aria-label="Fleet status">
                    <span><i className="status-light status-light-running" />{runningCount} running</span>
                    <span><i className="status-light status-light-attention" />{attentionCount} attention</span>
                    <span>{tasks.length} total</span>
                </div>
                <button className="button-primary new-task-button" onClick={() => setCreateOpen(true)}><span aria-hidden="true">＋</span> New Task</button>
            </header>
            <aside ref={sidebarRef} className="sidebar" role={mobile && queueOpen ? "dialog" : undefined} aria-modal={mobile && queueOpen ? true : undefined} aria-label="Task queue drawer" tabIndex={-1}>
                <div className="sidebar-heading"><span className="eyebrow">Task fleet</span><strong>Operations queue</strong></div>
                <SchedulerStatus status={scheduler} error={schedulerError} />
                <TaskList tasks={tasks} scheduler={scheduler} selectedId={selected?.id} onSelect={selectTask} />
            </aside>
            {mobile && queueOpen && <button className="queue-scrim" aria-label="Close task queue overlay" onClick={() => setMobileSidebarOpen(false)} />}
            <div aria-label="Resize task queue" aria-orientation="vertical" className="sidebar-resizer" role="separator" onMouseDown={startSidebarResize} />
            <section className="workspace">
                {error && <div className="error app-error" role="alert">Refreshing tasks failed: {error}</div>}
                {selected ? <TaskView key={selected.id} task={selected} onChanged={refresh} /> : (
                    <div className="empty-state">
                        <span className="brand-mark large" aria-hidden="true">M</span>
                        <h1>No active operation</h1>
                        <p>Create a single task or import a CTF batch to begin.</p>
                        <button className="button-primary" onClick={() => setCreateOpen(true)}>New Task</button>
                    </div>
                )}
            </section>
            <TaskCreateDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={createdTasks} onSelect={selectTask} />
        </main>
    );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
