import fs from "node:fs";
import path from "node:path";
import type { TaskEvent, WebuiConfig } from "../types.js";
import type { SecretRedactor } from "./redactor.js";

export class EventBus {
    private readonly subscribers = new Map<string, Set<(event: TaskEvent) => void>>();

    subscribe(taskId: string, onEvent: (event: TaskEvent) => void): () => void {
        const set = this.subscribers.get(taskId) ?? new Set();
        set.add(onEvent);
        this.subscribers.set(taskId, set);
        return () => set.delete(onEvent);
    }

    publish(event: TaskEvent): void {
        for (const subscriber of this.subscribers.get(event.taskId) ?? []) {
            subscriber(event);
        }
    }
}

export function appendCapped(filePath: string, text: string, config: WebuiConfig): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath) && fs.statSync(filePath).size + Buffer.byteLength(text) > config.limits.maxLogBytesPerFile) {
        fs.renameSync(filePath, `${filePath}.${Date.now()}.old`);
    }
    fs.appendFileSync(filePath, text);
}

export function writeTaskEvent(taskLogsPath: string, event: TaskEvent, config: WebuiConfig, redactor: SecretRedactor): TaskEvent {
    const redacted = redactor.redactJson(event);
    appendCapped(path.join(taskLogsPath, "events.jsonl"), `${JSON.stringify(redacted)}\n`, config);
    return redacted;
}
