import { useMemo, useState } from "react";
import type { Task } from "./api";

type QueueFilter = "all" | "attention" | "running" | "ready" | "done";

const groups: Array<{ key: Exclude<QueueFilter, "all">; label: string; statuses: Task["workStatus"][] }> = [
    { key: "attention", label: "Attention", statuses: ["needs-attention", "failed"] },
    { key: "running", label: "Running", statuses: ["running"] },
    { key: "ready", label: "Ready", statuses: ["not-started"] },
    { key: "done", label: "Done", statuses: ["done"] }
];

export function TaskList(props: {
    tasks: Task[];
    selectedId?: string;
    onSelect: (id: string) => void;
}) {
    const [query, setQuery] = useState("");
    const [filter, setFilter] = useState<QueueFilter>("all");
    const normalizedQuery = query.trim().toLowerCase();
    const counts = useMemo(() => Object.fromEntries(groups.map((group) => [
        group.key,
        props.tasks.filter((task) => group.statuses.includes(task.workStatus)).length
    ])) as Record<Exclude<QueueFilter, "all">, number>, [props.tasks]);
    const visibleTasks = props.tasks.filter((task) => {
        const matchesQuery = !normalizedQuery || task.name.toLowerCase().includes(normalizedQuery) || task.id.toLowerCase().includes(normalizedQuery);
        const group = groups.find((candidate) => candidate.key === filter);
        return matchesQuery && (!group || group.statuses.includes(task.workStatus));
    });

    return (
        <section className="task-queue" aria-label="Task queue">
            <div className="queue-search">
                <span aria-hidden="true">⌕</span>
                <input
                    aria-label="Search tasks"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="Search name or task ID"
                />
            </div>
            <div className="queue-filters" aria-label="Task filters">
                <button className={filter === "all" ? "filter-chip active" : "filter-chip"} onClick={() => setFilter("all")}>All <span>{props.tasks.length}</span></button>
                {groups.map((group) => (
                    <button
                        key={group.key}
                        className={filter === group.key ? "filter-chip active" : "filter-chip"}
                        onClick={() => setFilter(group.key)}
                    >
                        {group.label} <span>{counts[group.key]}</span>
                    </button>
                ))}
            </div>
            <div className="queue-groups">
                {groups.map((group) => {
                    const tasks = visibleTasks.filter((task) => group.statuses.includes(task.workStatus));
                    if (tasks.length === 0) return null;
                    return (
                        <section className="queue-group" key={group.key} aria-labelledby={`queue-${group.key}`}>
                            <header>
                                <h2 id={`queue-${group.key}`}>{group.label}</h2>
                                <span>{tasks.length}</span>
                            </header>
                            <div className="task-list">
                                {tasks.map((task) => (
                                    <button
                                        className={task.id === props.selectedId ? "task-row selected" : "task-row"}
                                        key={task.id}
                                        onClick={() => props.onSelect(task.id)}
                                    >
                                        <span className={`task-dot task-dot-${task.workStatus}`} aria-hidden="true" />
                                        <span className="task-row-copy">
                                            <strong>{task.name}</strong>
                                            <span>{task.status} · {task.codexRuntime}</span>
                                        </span>
                                        <span className="task-backend">{task.backend === "local" ? "LOC" : "DO"}</span>
                                    </button>
                                ))}
                            </div>
                        </section>
                    );
                })}
                {visibleTasks.length === 0 && (
                    <div className="queue-empty">
                        <strong>No matching tasks</strong>
                        <span>Adjust the search or status filter.</span>
                    </div>
                )}
            </div>
        </section>
    );
}
