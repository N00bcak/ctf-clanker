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
    const segments = path.split("/").filter(Boolean);

    useEffect(() => {
        setPath("");
        setFiles([]);
        setError(undefined);
    }, [task.id]);

    useEffect(() => {
        let disposed = false;
        api.files(task.id, path)
            .then((items) => {
                if (disposed) return;
                setFiles(items);
                setError(undefined);
            })
            .catch((err) => !disposed && setError(err.message));
        return () => { disposed = true; };
    }, [task.id, path]);

    function parentPath(): string {
        return segments.slice(0, -1).join("/");
    }

    return (
        <section className="pane file-pane">
            <header className="pane-heading"><div><span className="eyebrow">Workspace</span><h2>Files</h2></div><span>{files.length} items</span></header>
            <nav className="breadcrumbs" aria-label="Storage path">
                <button onClick={() => setPath("")}>storage</button>
                {segments.map((segment, index) => (
                    <span key={`${segment}-${index}`}><i>/</i><button onClick={() => setPath(segments.slice(0, index + 1).join("/"))}>{segment}</button></span>
                ))}
            </nav>
            {path && <button className="file-row up-row" onClick={() => setPath(parentPath())}><span className="file-icon">↰</span><span><strong>Parent directory</strong><small>{parentPath() || "storage"}</small></span></button>}
            {error && <div className="error">{error}</div>}
            <div className="file-list">
                {files.map((file) => (
                    <button className="file-row" key={file.path} disabled={file.type !== "directory"} onClick={() => setPath(file.path)}>
                        <span className="file-icon" aria-hidden="true">{file.type === "directory" ? "▰" : "▪"}</span>
                        <span><strong>{file.name}</strong><small>{file.type}</small></span>
                        <span className="file-size">{file.type === "directory" ? "—" : formatSize(file.size)}</span>
                    </button>
                ))}
                {!error && files.length === 0 && <div className="pane-empty">No files in this directory.</div>}
            </div>
        </section>
    );
}
