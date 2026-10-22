import { useEffect, useState } from "react";
import { api, type Task } from "./api";

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileBrowser({ task }: { task: Task }) {
    const [path, setPath] = useState("");
    const [files, setFiles] = useState<Array<{ name: string; path: string; type: string; size: number }>>([]);
    const [error, setError] = useState<string>();
    const [loading, setLoading] = useState(true);
    const [refreshVersion, setRefreshVersion] = useState(0);
    const segments = path.split("/").filter(Boolean);

    useEffect(() => {
        setPath("");
        setFiles([]);
        setError(undefined);
    }, [task.id]);

    useEffect(() => { setFiles([]); }, [task.id, path]);

    useEffect(() => {
        let disposed = false;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        async function load() {
            setLoading(true);
            try {
                const items = await api.files(task.id, path, controller.signal);
                if (disposed) return;
                setFiles(items);
                setError(undefined);
            } catch (err) {
                if (!disposed) setError(err instanceof Error ? err.message : String(err));
            } finally {
                if (!disposed) {
                    setLoading(false);
                    timer = setTimeout(() => void load(), 5000);
                }
            }
        }
        void load();
        return () => {
            disposed = true;
            controller.abort();
            clearTimeout(timer);
        };
    }, [task.id, path, refreshVersion, task.status, task.workStatus, task.workspaceSync?.state, task.workspaceSync?.generation, task.workspaceSync?.lastSyncedAt]);

    function parentPath(): string {
        return segments.slice(0, -1).join("/");
    }

    return (
        <section className="pane file-pane">
            <header className="pane-heading"><div><span className="eyebrow">Workspace</span><h2>Files</h2></div><div className="file-tools"><span>{files.length} items</span><button aria-label="Refresh files" onClick={() => setRefreshVersion((current) => current + 1)}>Refresh</button></div></header>
            {task.workspaceSync?.owner === "remote" && <p className="field-help snapshot-status" role="status">
                {task.workspaceSync.state === "error" ? `Workspace sync failed: ${task.workspaceSync.error ?? "unknown error"}. Displayed files may be stale.`
                    : task.workspaceSync.state === "syncing" ? "Downloading remote workspace; displayed files are provisional."
                        : task.workspaceSync.state === "uploading" ? "Uploading workspace; displayed files are provisional."
                            : ["queued", "provisioning", "running", "collecting"].includes(task.status) ? "Live remote task; displayed files are a provisional snapshot."
                                : "Remote workspace snapshot."}
                {task.workspaceSync.lastSyncedAt ? ` Last synced: ${new Date(task.workspaceSync.lastSyncedAt).toLocaleString()}.` : " No remote snapshot downloaded yet."}
            </p>}
            <nav className="breadcrumbs" aria-label="Storage path">
                <button onClick={() => setPath("")}>storage</button>
                {segments.map((segment, index) => (
                    <span key={`${segment}-${index}`}><i>/</i><button onClick={() => setPath(segments.slice(0, index + 1).join("/"))}>{segment}</button></span>
                ))}
            </nav>
            {path && <button className="file-row up-row" onClick={() => setPath(parentPath())}><span className="file-icon">↰</span><span><strong>Parent directory</strong><small>{parentPath() || "storage"}</small></span></button>}
            {error && <div className="error">{error}</div>}
            <div className="file-list" aria-busy={loading}>
                {files.map((file) => (
                    <button className="file-row" key={file.path} disabled={file.type !== "directory"} onClick={() => setPath(file.path)}>
                        <span className="file-icon" aria-hidden="true">{file.type === "directory" ? "▰" : "▪"}</span>
                        <span><strong>{file.name}</strong><small>{file.type}</small></span>
                        <span className="file-size">{file.type === "directory" ? "—" : formatSize(file.size)}</span>
                    </button>
                ))}
                {loading && files.length === 0 && <div className="pane-empty">Loading files…</div>}
                {!loading && !error && files.length === 0 && <div className="pane-empty">No files in this directory.</div>}
            </div>
        </section>
    );
}
