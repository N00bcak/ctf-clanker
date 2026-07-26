import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { api, type CodexSessionState, type Task } from "./api";

export function sanitizeCodexTranscript(text: string): string {
    return text
        .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
        .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\u001B[@-_]/g, "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function codexSessionLine(state: CodexSessionState["state"]): string {
    if (state === "active") {
        return "Codex session active.";
    }
    if (state === "closed") {
        return "Codex session closed. Send a prompt to start a fresh session.";
    }
    return "Codex session not started. Send a prompt to begin or continue.";
}

export function TerminalPane({ task, mode = "codex" }: { task: Task; mode?: "codex" | "shell" }) {
    const ref = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const [sessionState, setSessionState] = useState<CodexSessionState["state"] | "loading">("loading");
    const codexTranscript = mode === "codex";
    const shellConnectable = mode === "shell" && task.codexRuntime !== "host" && task.status === "running" && Boolean(task.activeProvisioningIntentId);
    const connectable = codexTranscript || shellConnectable;

    useEffect(() => {
        let disposed = false;
        if (mode !== "codex" || task.bridgeMode !== "native-codex-app-server") {
            return;
        }
        setSessionState("loading");
        api.codexSession(task.id)
            .then((state) => {
                if (!disposed) {
                    setSessionState(state.state);
                }
            })
            .catch(() => {
                if (!disposed) {
                    setSessionState("not-started");
                }
            });
        return () => {
            disposed = true;
        };
    }, [task.id, task.bridgeMode, mode]);

    useEffect(() => {
        if (mode !== "codex" || task.bridgeMode !== "native-codex-app-server") {
            return;
        }
        const ws = new WebSocket(`/ws/tasks/${task.id}/events`);
        ws.onmessage = (event) => {
            try {
                const parsed = JSON.parse(event.data) as { type?: unknown };
                if (parsed.type === "codex.session.started") {
                    setSessionState("active");
                }
                if (parsed.type === "codex.session.closed") {
                    setSessionState("closed");
                }
            } catch {
                // Ignore non-JSON event payloads.
            }
        };
        return () => {
            ws.close();
        };
    }, [task.id, task.bridgeMode, mode]);

    useEffect(() => {
        if (mode === "codex" && task.bridgeMode === "native-codex-app-server" && sessionState !== "loading") {
            terminalRef.current?.writeln(`\r\n${codexSessionLine(sessionState)}`);
        }
    }, [mode, task.bridgeMode, sessionState]);

    useEffect(() => {
        if (!ref.current || !connectable) return;
        const terminal = new Terminal({
            cursorBlink: true,
            convertEol: true,
            fontSize: 12,
            lineHeight: 1.1,
            letterSpacing: 0
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminalRef.current = terminal;
        terminal.open(ref.current);
        const fit = () => {
            if (ref.current?.isConnected) fitAddon.fit();
        };
        fit();
        const resizeObserver = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(fit);
        resizeObserver?.observe(ref.current);
        if (!resizeObserver) window.addEventListener("resize", fit);
        const disposeTerminal = () => {
            resizeObserver?.disconnect();
            if (!resizeObserver) window.removeEventListener("resize", fit);
            if (terminalRef.current === terminal) {
                terminalRef.current = null;
            }
            terminal.dispose();
        };
        if (mode === "shell") {
            terminal.writeln("Runner shell session is not logged as Codex output.");
            const ws = new WebSocket(`/ws/tasks/${task.id}/shell`);
            terminal.onData((data) => ws.readyState === WebSocket.OPEN && ws.send(data));
            ws.onmessage = (event) => terminal.write(event.data);
            ws.onclose = () => terminal.writeln("\r\n[shell closed]");
            return () => {
                ws.close();
                disposeTerminal();
            };
        }
        if (codexTranscript) {
            let disposed = false;
            let ws: WebSocket | undefined;
            terminal.writeln(task.bridgeMode === "host-codex-broker"
                ? "Host Codex transcript is read-only and logged."
                : "Native Codex app-server transcript is read-only and logged.");
            fetch(`/api/tasks/${task.id}/logs/codex`)
                .then((response) => response.ok ? response.text() : "")
                .then((body) => {
                    if (disposed) return;
                    for (const line of body.split("\n")) {
                        if (!line.trim()) continue;
                        try {
                            const entry = JSON.parse(line) as { text?: unknown };
                            if (typeof entry.text === "string") {
                                terminal.write(sanitizeCodexTranscript(entry.text));
                            }
                        } catch {
                            terminal.writeln(sanitizeCodexTranscript(line));
                        }
                    }
                    if (disposed) return;
                    ws = new WebSocket(`/ws/tasks/${task.id}/events`);
                    ws.onmessage = (event) => {
                        try {
                            const parsed = JSON.parse(event.data) as { type?: unknown; text?: unknown };
                            if (parsed.type === "codex.output" && typeof parsed.text === "string") {
                                terminal.write(sanitizeCodexTranscript(parsed.text));
                            }
                        } catch {
                            // Ignore non-JSON event payloads.
                        }
                    };
                    ws.onclose = () => terminal.writeln("\r\n[transcript closed]");
                })
                .catch((error: Error) => {
                    if (!disposed) {
                        terminal.writeln(`\r\n[transcript replay failed: ${error.message}]`);
                        ws = new WebSocket(`/ws/tasks/${task.id}/events`);
                        ws.onmessage = (event) => {
                            try {
                                const parsed = JSON.parse(event.data) as { type?: unknown; text?: unknown };
                                if (parsed.type === "codex.output" && typeof parsed.text === "string") {
                                    terminal.write(sanitizeCodexTranscript(parsed.text));
                                }
                            } catch {
                                // Ignore non-JSON event payloads.
                            }
                        };
                        ws.onclose = () => terminal.writeln("\r\n[transcript closed]");
                    }
                });
            return () => {
                disposed = true;
                ws?.close();
                disposeTerminal();
            };
        }
        return undefined;
    }, [task.id, task.status, task.activeProvisioningIntentId, task.bridgeMode, connectable, codexTranscript, mode]);

    const title = mode === "shell" ? "Shell" : "Codex Transcript";
    const waiting = mode === "shell"
        ? task.codexRuntime === "host"
            ? "Shell unavailable for host mode."
            : "Runner not ready for shell."
        : "Codex transcript waiting.";

    return (
        <section className="console-pane" aria-label={title}>
            <span className="sr-only">{title}</span>
            {connectable ? <div ref={ref} className="terminal" aria-label="Terminal input" /> : <div className="terminal terminal-waiting">{waiting}</div>}
        </section>
    );
}
