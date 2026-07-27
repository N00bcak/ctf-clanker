import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
    CodexModelCatalog,
    type ModelAppServerProcess
} from "../server/src/codex/modelCatalog";
import { testConfig } from "./helpers";

class FakeModelAppServer extends EventEmitter implements ModelAppServerProcess {
    readonly stdin = new PassThrough();
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    killed = false;
    requests: Array<Record<string, unknown>> = [];
    private input = "";

    constructor() {
        super();
        this.stdin.on("data", (chunk) => {
            this.input += chunk.toString();
            const lines = this.input.split("\n");
            this.input = lines.pop() ?? "";
            for (const line of lines) {
                if (!line.trim()) continue;
                const message = JSON.parse(line) as Record<string, unknown>;
                this.requests.push(message);
                this.respond(message);
            }
        });
    }

    kill(): boolean {
        this.killed = true;
        return true;
    }

    private respond(message: Record<string, unknown>): void {
        if (message.method === "initialize") {
            this.stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: "mecha-test/0.144.5 (Linux)" } })}\n`);
            return;
        }
        if (message.method !== "model/list") return;
        const params = message.params as { cursor?: string };
        const result = params.cursor ? {
            data: [{
                model: "gpt-5.6-luna",
                displayName: "GPT-5.6 Luna",
                description: "Fast coding model",
                hidden: false,
                isDefault: false
            }, {
                model: "internal-hidden",
                displayName: "Hidden",
                description: "",
                hidden: true,
                isDefault: false
            }],
            nextCursor: null
        } : {
            data: [{
                model: "gpt-5.6-sol",
                displayName: "GPT-5.6 Sol",
                description: "Frontier coding model",
                hidden: false,
                isDefault: true
            }],
            nextCursor: "page-2"
        };
        this.stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
    }
}

describe("Codex model catalog", () => {
    it("initializes app-server and returns all visible model/list pages", async () => {
        const process = new FakeModelAppServer();
        const catalog = new CodexModelCatalog(testConfig(), () => ({
            process,
            source: "local-runner-app-server"
        }), 1000);

        const result = await catalog.listModels();

        expect(result.models).toEqual([
            { model: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", description: "Frontier coding model", isDefault: true },
            { model: "gpt-5.6-luna", displayName: "GPT-5.6 Luna", description: "Fast coding model", isDefault: false }
        ]);
        expect(result.source).toBe("local-runner-app-server");
        expect(result.runtimeVersion).toBe("0.144.5");
        expect(process.requests.map((request) => request.method)).toEqual([
            "initialize",
            "initialized",
            "model/list",
            "model/list"
        ]);
        expect(process.killed).toBe(true);
    });

    it("uses a clearly labeled host fallback when runner discovery fails", async () => {
        const process = new FakeModelAppServer();
        const catalog = new CodexModelCatalog(
            testConfig(),
            () => {
                throw new Error("runner unavailable");
            },
            1000,
            () => ({ process, source: "host-app-server-fallback" })
        );

        const result = await catalog.listModels();

        expect(result.source).toBe("host-app-server-fallback");
        expect(result.runtimeVersion).toBe("0.144.5");
        expect(result.models[0]?.model).toBe("gpt-5.6-sol");
    });
});
