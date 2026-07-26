const SECRET_NAME_PATTERN =
    /(Authorization:\s*Bearer\s+)[^\s\r\n]+|(Bearer\s+)[A-Za-z0-9._~+/-]+=*|((?:OPENAI_API_KEY|CODEX_API_KEY|DIGITALOCEAN_TOKEN|DO_API_TOKEN|api_key|access_token|refresh_token)\s*[=:]\s*)[^\s\r\n"']+/gi;

const PRIVATE_KEY_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class SecretRedactor {
    private readonly values = new Set<string>();

    constructor(env = process.env, secretEnvNames: string[] = []) {
        for (const name of secretEnvNames) {
            const value = env[name];
            if (value) {
                this.registerValue(value);
            }
        }
        for (const [name, value] of Object.entries(env)) {
            if (value && /(TOKEN|KEY|SECRET|PASSWORD|AUTH)/i.test(name)) {
                this.registerValue(value);
            }
        }
    }

    registerValue(value: string | undefined): void {
        if (value && value.length >= 4) {
            this.values.add(value);
        }
    }

    redact(input: unknown): string {
        let text = typeof input === "string" ? input : JSON.stringify(input);
        text = text.replace(PRIVATE_KEY_PATTERN, "[REDACTED_PRIVATE_KEY]");
        text = text.replace(SECRET_NAME_PATTERN, (_match, authPrefix, bearerPrefix, assignmentPrefix) => {
            const prefix = authPrefix ?? bearerPrefix ?? assignmentPrefix ?? "";
            return `${prefix}[REDACTED]`;
        });
        for (const value of this.values) {
            text = text.replace(new RegExp(escapeRegExp(value), "g"), "[REDACTED]");
        }
        return text;
    }

    redactJson<T>(value: T): T {
        return JSON.parse(this.redact(value)) as T;
    }
}
