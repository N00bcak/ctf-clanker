import { describe, expect, it } from "vitest";
import { loadConfig, validateLocalResources, validateNetworkMode, validateServerExposure } from "../server/src/config";
import { testConfig } from "./helpers";

describe("config guards", () => {
    it("sets omitted local resource budgets from configured worker defaults", () => {
        const config = testConfig();
        config.local.concurrency = 3;
        config.local.defaultCpu = 0.5;
        config.local.defaultMemoryMb = 2048;
        validateLocalResources(config);
        expect(config.local.cpuBudget).toBe(1.5);
        expect(config.local.memoryBudgetMb).toBe(6144);
    });

    it("ships the agreed local ceilings", () => {
        expect(loadConfig().local).toMatchObject({ concurrency: 8, defaultMemoryMb: 2048, memoryBudgetMb: 8192, defaultCpu: 1, cpuBudget: 6 });
    });

    it("rejects invalid local resource settings", () => {
        for (const key of ["concurrency", "defaultCpu", "defaultMemoryMb", "cpuBudget", "memoryBudgetMb"] as const) {
            for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
                const config = testConfig();
                config.local[key] = value;
                expect(() => validateLocalResources(config)).toThrow();
            }
        }
        const config = testConfig();
        config.local.concurrency = 1.5;
        expect(() => validateLocalResources(config)).toThrow(/integer/);
        config.local.concurrency = 1;
        config.local.defaultMemoryMb = 2048.5;
        expect(() => validateLocalResources(config)).toThrow(/integer/);
    });
    it("allows loopback without auth", () => {
        expect(() => validateServerExposure(testConfig(), {})).not.toThrow();
    });

    it("rejects non-loopback without token auth", () => {
        const config = testConfig();
        config.server.host = "0.0.0.0";
        expect(() => validateServerExposure(config, {})).toThrow(/requires token auth/);
    });

    it("allows non-loopback with token auth and token env", () => {
        const config = testConfig();
        config.server.host = "0.0.0.0";
        config.server.auth.mode = "token";
        expect(() => validateServerExposure(config, { WEBUI_AUTH_TOKEN: "token" })).not.toThrow();
    });

    it("fails closed for unenforced codex-only and proxy allowlist modes", () => {
        expect(() => validateNetworkMode("codex-only", "open-warning")).toThrow(/requires real/);
        expect(() => validateNetworkMode("proxy-allowlist", "open-warning")).toThrow(/requires sidecar/);
    });
});
