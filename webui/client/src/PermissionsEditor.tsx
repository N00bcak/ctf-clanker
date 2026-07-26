import { useEffect, useState } from "react";
import { api, type Task } from "./api";

export function PermissionsEditor({ task }: { task: Task }) {
    const [mode, setMode] = useState(task.networkMode);
    const [message, setMessage] = useState("");

    useEffect(() => {
        setMode(task.networkMode);
        setMessage("");
    }, [task.id, task.networkMode]);

    async function save() {
        try {
            await api.permissions(task.id, {
                version: 1,
                network: { mode, enforcement: mode === "none" ? "docker-none" : "open-warning", allow: [] },
                mounts: []
            });
            setMessage("Saved");
        } catch (err) {
            setMessage(err instanceof Error ? err.message : String(err));
        }
    }

    return (
        <section className="pane permissions-pane">
            <header className="pane-heading"><div><span className="eyebrow">Security</span><h2>Permissions</h2></div></header>
            <label className="field">
                <span>Network mode</span>
                <select value={mode} onChange={(event) => setMode(event.target.value)}>
                    <option value="open">open</option>
                    <option value="none">none</option>
                    <option value="codex-only">codex-only</option>
                    <option value="proxy-allowlist">proxy-allowlist</option>
                </select>
            </label>
            <p className="field-help">Permission changes apply to the task manifest and preserve the configured isolation boundary.</p>
            <button className="button-primary" onClick={save}>Save Permissions</button>
            {message && <div className="small">{message}</div>}
        </section>
    );
}
