import { describe, expect, it } from "vitest";
import { validateNetworkMode, validateServerExposure } from "../server/src/config";
import { testConfig } from "./helpers";

describe("config guards", () => {
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
