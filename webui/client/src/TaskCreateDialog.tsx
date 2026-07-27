import { useEffect, useRef, useState } from "react";
import { api, type CodexModelOption, type CodexSettings, type Task } from "./api";
import {
    DEFAULT_CODEX_SETTINGS,
    challengeToRequest,
    draftManifest,
    filesToAttachments,
    normalizeCodexSettings,
    validateManifest,
    type ChallengeManifest
} from "./challengeIntake";

export function TaskCreateDialog(props: {
    open: boolean;
    onClose: () => void;
    onCreated: () => void | Promise<void>;
    onSelect: (id: string) => void;
}) {
    const [tab, setTab] = useState<"single" | "batch">("single");
    const [name, setName] = useState("");
    const [prompt, setPrompt] = useState("");
    const [backend, setBackend] = useState<Task["backend"]>("local");
    const [settings, setSettings] = useState<CodexSettings>(DEFAULT_CODEX_SETTINGS);
    const [attachments, setAttachments] = useState<File[]>([]);
    const [manifestText, setManifestText] = useState("");
    const [manifestFiles, setManifestFiles] = useState<File[]>([]);
    const [batchStatus, setBatchStatus] = useState<string>();
    const [progress, setProgress] = useState<string>();
    const [warning, setWarning] = useState<string>();
    const [error, setError] = useState<string>();
    const [models, setModels] = useState<CodexModelOption[]>([]);
    const [modelCatalogSource, setModelCatalogSource] = useState<string>();
    const [modelsLoading, setModelsLoading] = useState(false);
    const [modelsError, setModelsError] = useState<string>();
    const nameRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!props.open) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        nameRef.current?.focus();
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !progress) props.onClose();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => {
            document.body.style.overflow = previousOverflow;
            window.removeEventListener("keydown", onKeyDown);
        };
    }, [props.open, progress, props.onClose]);

    useEffect(() => {
        if (!props.open) return;
        let active = true;
        setModelsLoading(true);
        setModelsError(undefined);
        api.codexModels()
            .then((catalog) => {
                if (active) {
                    if (!Array.isArray(catalog.models)) throw new Error("Codex app-server returned an invalid model catalog");
                    setModels(catalog.models);
                    setModelCatalogSource(catalog.source === "local-runner-app-server"
                        ? `local runner app-server${catalog.runtimeVersion ? ` ${catalog.runtimeVersion}` : ""}`
                        : `host app-server fallback${catalog.runtimeVersion ? ` ${catalog.runtimeVersion}` : ""}`);
                }
            })
            .catch((err) => {
                if (active) setModelsError(err instanceof Error ? err.message : String(err));
            })
            .finally(() => {
                if (active) setModelsLoading(false);
            });
        return () => {
            active = false;
        };
    }, [props.open]);

    if (!props.open) return null;

    function runnerReady(task: Task): boolean {
        return task.bridgeMode === "host-codex-broker" || (task.status === "running" && Boolean(task.activeProvisioningIntentId));
    }

    function resetSingle(): void {
        setPrompt("");
        setName("");
        setAttachments([]);
    }

    function complete(): void {
        setProgress(undefined);
        resetSingle();
        props.onClose();
    }

    async function createDraft() {
        try {
            setError(undefined);
            setWarning(undefined);
            setProgress("Creating draft...");
            const task = await api.createTask({ prompt, name, backend, codexSettings: settings, attachments: await filesToAttachments(attachments) });
            props.onSelect(task.id);
            await props.onCreated();
            complete();
        } catch (err) {
            setProgress(undefined);
            setError(err instanceof Error ? `Creating task failed: ${err.message}` : String(err));
        }
    }

    async function createAndRun() {
        let phase = "Creating task";
        try {
            setError(undefined);
            setWarning(undefined);
            setProgress(`${phase}...`);
            const task = await api.createTask({ prompt, name, backend, codexSettings: settings, attachments: await filesToAttachments(attachments) });
            props.onSelect(task.id);
            await props.onCreated();
            phase = "Starting runner";
            setProgress(`${phase}...`);
            const started = await api.start(task.id);
            await props.onCreated();
            if (!runnerReady(started)) {
                setWarning("Runner is not ready yet; Codex has not been called.");
                setProgress(undefined);
                return;
            }
            phase = "Calling Codex";
            setProgress(`${phase}...`);
            await api.prompt(task.id, prompt);
            await props.onCreated();
            complete();
        } catch (err) {
            setProgress(undefined);
            setError(err instanceof Error ? `${phase} failed: ${err.message}` : String(err));
        }
    }

    function patchSettings(patch: Partial<CodexSettings>) {
        setSettings(normalizeCodexSettings({ ...settings, ...patch }));
    }

    async function refreshModels() {
        try {
            setModelsLoading(true);
            setModelsError(undefined);
            const catalog = await api.codexModels();
            if (!Array.isArray(catalog.models)) throw new Error("Codex app-server returned an invalid model catalog");
            setModels(catalog.models);
            setModelCatalogSource(catalog.source === "local-runner-app-server"
                ? `local runner app-server${catalog.runtimeVersion ? ` ${catalog.runtimeVersion}` : ""}`
                : `host app-server fallback${catalog.runtimeVersion ? ` ${catalog.runtimeVersion}` : ""}`);
        } catch (err) {
            setModelsError(err instanceof Error ? err.message : String(err));
        } finally {
            setModelsLoading(false);
        }
    }

    function draftFromFiles(files: File[]) {
        setManifestFiles(files);
        setManifestText(JSON.stringify(draftManifest(files), null, 2));
        setBatchStatus(`Drafted ${files.length} file${files.length === 1 ? "" : "s"}.`);
    }

    const defaultModel = models.find((model) => model.isDefault);
    const selectedModel = models.find((model) => model.model === settings.model);
    const sandboxHelp = settings.sandbox === "danger-full-access"
        ? "Recommended for local CTF compatibility. The inner Codex sandbox is disabled; Docker is the execution boundary."
        : settings.sandbox === "workspace-write"
            ? "Adds an inner workspace sandbox. It can fail when Docker does not permit nested user namespaces."
            : "Codex can inspect the task but cannot modify its workspace.";

    async function importBatch() {
        try {
            setError(undefined);
            setBatchStatus(undefined);
            setProgress("Importing batch...");
            const manifest = validateManifest(JSON.parse(manifestText)) as ChallengeManifest;
            let created = 0;
            for (const challenge of manifest.challenges) {
                const task = await api.createTask(await challengeToRequest(manifest, challenge, manifestFiles));
                created += 1;
                props.onSelect(task.id);
            }
            await props.onCreated();
            setBatchStatus(`Created ${created} challenge task${created === 1 ? "" : "s"}.`);
            setProgress(undefined);
        } catch (err) {
            setProgress(undefined);
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    return (
        <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !progress && props.onClose()}>
            <section className="task-dialog" role="dialog" aria-modal="true" aria-labelledby="new-task-title">
                <header className="dialog-header">
                    <div>
                        <span className="eyebrow">Task intake</span>
                        <h2 id="new-task-title">New operation</h2>
                    </div>
                    <button className="icon-button" aria-label="Close new task dialog" onClick={props.onClose} disabled={Boolean(progress)}>×</button>
                </header>
                <div className="dialog-tabs" role="tablist" aria-label="Task creation mode">
                    <button role="tab" aria-selected={tab === "single"} className={tab === "single" ? "tab active" : "tab"} onClick={() => setTab("single")}>Single task</button>
                    <button role="tab" aria-selected={tab === "batch"} className={tab === "batch" ? "tab active" : "tab"} onClick={() => setTab("batch")}>Batch import</button>
                </div>
                {tab === "single" ? (
                    <div className="dialog-body" role="tabpanel" aria-label="Single task">
                        <div className="field-grid two-column">
                            <label className="field"><span>Task name</span><input ref={nameRef} value={name} onChange={(event) => setName(event.target.value)} placeholder="Task name" /></label>
                            <label className="field"><span>Runner</span><select value={backend} onChange={(event) => setBackend(event.target.value as Task["backend"])}><option value="local">Local appserver</option><option value="digitalocean">DigitalOcean dry-run</option></select></label>
                        </div>
                        <label className="field"><span>Initial prompt</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Initial prompt" /></label>
                        <fieldset className="settings-panel">
                            <legend>Codex settings</legend>
                            <div className="field-grid two-column">
                                <div className="field model-field">
                                    <span>Model</span>
                                    <div className="model-picker-row">
                                        <select aria-label="Model" value={settings.model ?? ""} onChange={(event) => patchSettings({ model: event.target.value || undefined })}>
                                            <option value="">Codex default{defaultModel ? ` — ${defaultModel.displayName}` : ""}</option>
                                            {models.map((model) => <option key={model.model} value={model.model}>{model.displayName} · {model.model}</option>)}
                                            {settings.model && !selectedModel && <option value={settings.model}>{settings.model} · unavailable in current catalog</option>}
                                        </select>
                                        <button className="icon-button model-refresh" type="button" aria-label="Refresh Codex models" onClick={refreshModels} disabled={modelsLoading}>↻</button>
                                    </div>
                                    <small className={modelsError ? "field-help field-help-error" : "field-help"}>
                                        {modelsLoading ? "Querying the local runner app-server…" : modelsError ? `Discovery unavailable: ${modelsError}. Codex default remains usable.` : selectedModel?.description || `${models.length} models loaded live from the ${modelCatalogSource ?? "Codex app-server"}.`}
                                    </small>
                                </div>
                                <label className="field"><span>Sandbox</span><select value={settings.sandbox} onChange={(event) => patchSettings({ sandbox: event.target.value as CodexSettings["sandbox"] })}><option value="danger-full-access">Docker boundary only · recommended for local CTF</option><option value="workspace-write">Inner workspace sandbox · compatibility varies</option><option value="read-only">Read only</option></select><small className="field-help">{sandboxHelp}</small></label>
                                <label className="field"><span>Approvals</span><select value={settings.approvalPolicy} onChange={(event) => patchSettings({ approvalPolicy: event.target.value as CodexSettings["approvalPolicy"] })}><option value="never">never · non-interactive</option><option value="on-request">on-request</option><option value="untrusted">untrusted</option></select><small className="field-help">Tasks run unattended; “never” does not pause tool actions for confirmation.</small></label>
                                <div className="profile-explainer">
                                    <strong>What happened to Profile?</strong>
                                    <span>A Codex profile is a named <code>$CODEX_HOME/&lt;name&gt;.config.toml</code> override layer. Isolated runners intentionally receive only task settings and authentication—not host profiles, MCP configuration, or profile-specific model catalogs.</span>
                                </div>
                            </div>
                            <label className="checkbox-row"><input type="checkbox" checked={settings.webSearch} onChange={(event) => patchSettings({ webSearch: event.target.checked })} /> Enable web search</label>
                            <div className="runtime-boundary-note">
                                <strong>Docker safeguard summary</strong>
                                <span>Capabilities are dropped, privilege escalation is blocked, resources are capped, and mounts are narrow. The default network is still open and task-local Codex authentication is readable inside the runner. This is a practical CTF baseline, not protection against suspected container escapes or hostile kernel payloads.</span>
                            </div>
                        </fieldset>
                        <label className="file-drop"><span>Attach files</span><small>{attachments.length ? `${attachments.length} file${attachments.length === 1 ? "" : "s"} selected` : "Drop-in artifacts are copied into task storage"}</small><input aria-label="Attach files" type="file" multiple onChange={(event) => setAttachments(Array.from(event.target.files ?? []))} /></label>
                        <div className="dialog-actions"><button onClick={props.onClose} disabled={Boolean(progress)}>Cancel</button><button onClick={createDraft} disabled={Boolean(progress)}>Create Draft</button><button className="button-primary" onClick={createAndRun} disabled={Boolean(progress) || !prompt.trim()}>Create &amp; Run</button></div>
                    </div>
                ) : (
                    <div className="dialog-body" role="tabpanel" aria-label="Batch import">
                        <div className="batch-pickers">
                            <label className="file-drop"><span>Draft from challenge folders</span><small>Generate one manifest entry per top-level folder</small><input aria-label="Draft from challenge folders" type="file" multiple {...{ webkitdirectory: "" }} onChange={(event) => draftFromFiles(Array.from(event.target.files ?? []))} /></label>
                            <label className="file-drop"><span>Companion files</span><small>Files referenced by an existing manifest</small><input aria-label="Companion files" type="file" multiple {...{ webkitdirectory: "" }} onChange={(event) => setManifestFiles(Array.from(event.target.files ?? []))} /></label>
                            <label className="file-drop"><span>Load manifest JSON</span><small>Version 1 challenge manifest</small><input aria-label="Load manifest JSON" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; file?.text().then(setManifestText).catch((err) => setError(String(err))); }} /></label>
                        </div>
                        <label className="field"><span>Manifest JSON</span><textarea className="manifest-editor" value={manifestText} onChange={(event) => setManifestText(event.target.value)} placeholder="Batch manifest JSON" /></label>
                        <div className="dialog-actions"><button onClick={props.onClose} disabled={Boolean(progress)}>Close</button><button className="button-primary" onClick={importBatch} disabled={Boolean(progress) || !manifestText.trim()}>Import Batch</button></div>
                        {batchStatus && <div className="success-message">{batchStatus}</div>}
                    </div>
                )}
                {progress && <div className="dialog-status">{progress}</div>}
                {warning && <div className="warning">{warning}</div>}
                {error && <div className="error">{error}</div>}
            </section>
        </div>
    );
}
