import { useState } from "react";
import { api, type Task } from "./api";

export function SteeringPane({ task }: { task: Task }) {
    const [prompt, setPrompt] = useState("");
    const [error, setError] = useState<string>();
    const canSend = task.bridgeMode !== "native-codex-app-server" || task.status === "running";

    async function send() {
        try {
            setError(undefined);
            await api.prompt(task.id, prompt);
            setPrompt("");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }

    return (
        <section className="pane">
            <h3>Steering</h3>
            <div className="warning small">
                {task.bridgeMode === "native-codex-app-server"
                    ? "Prompts are sent into the live Codex terminal session."
                    : "`codex exec` is one-shot; follow-ups use compact bridge-owned context."}
            </div>
            <div className="warning small">
                {task.bridgeMode === "native-codex-app-server"
                    ? `Native mode runs Codex inside the ${task.codexRuntime} runner with task-local auth.json.`
                    : "Host broker mode runs the host Codex CLI with workspace-write scope for storage/."}
            </div>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Follow-up instruction" />
            <button onClick={send} disabled={!canSend}>Send Prompt</button>
            {error && <div className="error">{error}</div>}
        </section>
    );
}
