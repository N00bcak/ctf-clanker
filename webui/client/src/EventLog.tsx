import { useEffect, useState } from "react";
import type { Task } from "./api";

export function EventLog({ task }: { task: Task }) {
    const [events, setEvents] = useState<string[]>([]);

    useEffect(() => {
        setEvents([]);
        const ws = new WebSocket(`/ws/tasks/${task.id}/events`);
        ws.onmessage = (event) => setEvents((items) => [...items.slice(-200), event.data]);
        return () => ws.close();
    }, [task.id]);

    return (
        <section className="pane event-pane">
            <header className="pane-heading"><div><span className="eyebrow">Live stream</span><h2>Events</h2></div><span>{events.length}</span></header>
            <pre>{events.join("\n")}</pre>
        </section>
    );
}
