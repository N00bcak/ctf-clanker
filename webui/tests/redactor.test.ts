import { describe, expect, it } from "vitest";
import { SecretRedactor } from "../server/src/utils/redactor";

describe("SecretRedactor", () => {
    it("redacts configured literal values", () => {
        const redactor = new SecretRedactor({ CODEX_API_KEY: "sk-test-secret" }, ["CODEX_API_KEY"]);
        expect(redactor.redact("value sk-test-secret")).toBe("value [REDACTED]");
    });

    it("redacts headers and env assignments", () => {
        const redactor = new SecretRedactor({}, []);
        expect(redactor.redact("Authorization: Bearer abc123")).toContain("[REDACTED]");
        expect(redactor.redact("CODEX_API_KEY=abc123")).toBe("CODEX_API_KEY=[REDACTED]");
    });

    it("redacts private key blocks", () => {
        const redactor = new SecretRedactor({}, []);
        const text = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
        expect(redactor.redact(text)).toBe("[REDACTED_PRIVATE_KEY]");
    });
});
