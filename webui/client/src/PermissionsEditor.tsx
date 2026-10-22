import { useEffect, useRef, useState } from "react";
import { api, type PermissionsState, type Task } from "./api";

export function PermissionsEditor({ task, onChanged }: { task: Task; onChanged?: () => void | Promise<void> }) {
    const [state, setState] = useState<PermissionsState>();
    const [mode, setMode] = useState(task.networkMode);
    const [message, setMessage] = useState("");
    const [error, setError] = useState<string>();
    const [saving, setSaving] = useState(false);
    const [retry, setRetry] = useState(0);
    const generation = useRef(0);
    const loadedTaskId = useRef(task.id);
    const dirty = useRef(false);

    useEffect(() => {
        const current = ++generation.current;
        if (loadedTaskId.current !== task.id) {
            loadedTaskId.current = task.id;
            dirty.current = false;
        }
        setState(undefined);
        setMessage("");
        setError(undefined);
        setSaving(false);
        api.permissionState(task.id).then((loaded) => {
            if (current !== generation.current) return;
            if (loaded?.permissions?.version !== 1 || typeof loaded.permissions.network?.mode !== "string"
                || typeof loaded.permissions.network?.enforcement !== "string" || !Array.isArray(loaded.permissions.network.allow)
                || !Array.isArray(loaded.permissions.mounts) || !Array.isArray(loaded.supportedNetworkModes)
                || !loaded.supportedNetworkModes.every((option) => typeof option === "string") || typeof loaded.editable !== "boolean") {
                throw new Error("Server returned an invalid permissions response");
            }
            setState(loaded);
            if (!dirty.current) setMode(loaded.permissions.network.mode);
        }).catch((err) => {
            if (current === generation.current) setError(err instanceof Error ? err.message : String(err));
        });
        return () => { ++generation.current; };
    }, [task.id, task.status, retry]);

    async function save() {
        if (!state?.editable || saving || !state.supportedNetworkModes.includes(mode)) return;
        const current = generation.current;
        setSaving(true);
        setError(undefined);
        setMessage("");
        try {
            const saved = await api.permissions(task.id, {
                ...state.permissions,
                network: { ...state.permissions.network, mode, enforcement: mode === "none" ? "docker-none" : mode === "open" ? "open-warning" : state.permissions.network.enforcement }
            });
            if (current !== generation.current) return;
            setState({ ...state, permissions: saved });
            setMode(saved.network.mode);
            dirty.current = false;
            setMessage("Saved; applies to the next run.");
            try { await onChanged?.(); } catch (err) {
                if (current === generation.current) setError(`Permissions saved; refreshing the task failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        } catch (err) {
            if (current === generation.current) setError(err instanceof Error ? err.message : String(err));
        } finally {
            if (current === generation.current) setSaving(false);
        }
    }

    const modes = Array.from(new Set(["open", "none", "codex-only", "proxy-allowlist", mode]));
    return (
        <section className="pane permissions-pane">
            <header className="pane-heading"><div><span className="eyebrow">Security</span><h2>Permissions</h2></div></header>
            {!state && !error && <p className="field-help">Loading permissions…</p>}
            <label className="field">
                <span>Network mode</span>
                <select value={mode} disabled={!state?.editable || saving} onChange={(event) => { dirty.current = true; setMode(event.target.value); setMessage(""); }}>
                    {modes.map((option) => <option key={option} value={option} disabled={!state?.supportedNetworkModes.includes(option)}>{option}</option>)}
                </select>
            </label>
            <p className="field-help">Saved permissions apply to the next run.</p>
            {state && <p className="field-help">Supported network modes for this runtime: {state.supportedNetworkModes.length ? state.supportedNetworkModes.join(", ") : "none available"}.</p>}
            {state?.reason && <p className="field-help">{state.reason}</p>}
            <button className="button-primary" disabled={!state?.editable || saving || !state.supportedNetworkModes.includes(mode)} onClick={save}>{saving ? "Saving…" : "Save Permissions"}</button>
            {message && <div className="small" role="status">{message}</div>}
            {error && <div className="error" role="alert">{error}</div>}
            {!state && error && <button onClick={() => setRetry((current) => current + 1)}>Retry permissions</button>}
        </section>
    );
}
