import type { Backend, CodexSettings, CreateTaskRequest } from "./api";

export const DEFAULT_CODEX_SETTINGS: CodexSettings = {
    model: undefined,
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    webSearch: false
};

export interface ManifestAttachment {
    path: string;
    source: string;
}

export interface ManifestChallenge {
    name: string;
    prompt: string;
    backend?: Backend;
    codexSettings?: Partial<CodexSettings>;
    attachments?: ManifestAttachment[];
}

export interface ChallengeManifest {
    version: 1;
    defaults?: {
        backend?: Backend;
        codexSettings?: Partial<CodexSettings>;
    };
    challenges: ManifestChallenge[];
}

export function fileSource(file: File): string {
    return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
}

export function workspacePath(source: string): string {
    return `attachments/${source.replace(/^\/+/, "")}`;
}

export function normalizeCodexSettings(input?: Partial<CodexSettings>): CodexSettings {
    return {
        ...DEFAULT_CODEX_SETTINGS,
        ...input,
        model: input?.model?.trim() || DEFAULT_CODEX_SETTINGS.model,
        profile: input?.profile?.trim() || undefined
    };
}

export function validateManifest(value: unknown): ChallengeManifest {
    const manifest = value as ChallengeManifest;
    if (!manifest || typeof manifest !== "object") {
        throw new Error("manifest must be an object");
    }
    if (manifest.version !== 1) {
        throw new Error("manifest version must be 1");
    }
    if (!Array.isArray(manifest.challenges) || manifest.challenges.length === 0) {
        throw new Error("manifest requires at least one challenge");
    }
    manifest.challenges.forEach((challenge, index) => {
        if (!challenge.name?.trim()) {
            throw new Error(`challenge ${index + 1} is missing name`);
        }
        if (!challenge.prompt?.trim()) {
            throw new Error(`challenge ${challenge.name} is missing prompt`);
        }
        for (const attachment of challenge.attachments ?? []) {
            if (!attachment.path?.trim() || !attachment.source?.trim()) {
                throw new Error(`challenge ${challenge.name} has an invalid attachment`);
            }
        }
    });
    return manifest;
}

export function draftManifest(files: File[]): ChallengeManifest {
    const groups = groupFiles(files);
    return {
        version: 1,
        defaults: {
            backend: "local",
            codexSettings: DEFAULT_CODEX_SETTINGS
        },
        challenges: Array.from(groups.entries()).map(([name, groupedFiles]) => ({
            name,
            prompt: "Solve this challenge. Start by inspecting the attached files.",
            attachments: groupedFiles.map((file) => {
                const source = fileSource(file);
                return { source, path: workspacePath(source) };
            })
        }))
    };
}

export async function filesToAttachments(files: File[]): Promise<Array<{ path: string; contentBase64: string }>> {
    return Promise.all(files.map(async (file) => ({
        path: workspacePath(fileSource(file)),
        contentBase64: await fileToBase64(file)
    })));
}

export async function challengeToRequest(
    manifest: ChallengeManifest,
    challenge: ManifestChallenge,
    files: File[]
): Promise<CreateTaskRequest> {
    const fileMap = new Map(files.map((file) => [fileSource(file), file]));
    return {
        name: challenge.name,
        prompt: challenge.prompt,
        backend: challenge.backend ?? manifest.defaults?.backend ?? "local",
        codexSettings: normalizeCodexSettings({
            ...manifest.defaults?.codexSettings,
            ...challenge.codexSettings
        }),
        attachments: await Promise.all((challenge.attachments ?? []).map(async (attachment) => {
            const file = fileMap.get(attachment.source) ?? fileMap.get(attachment.source.replace(/^\.?\//, ""));
            if (!file) {
                throw new Error(`missing companion file: ${attachment.source}`);
            }
            return {
                path: attachment.path,
                contentBase64: await fileToBase64(file)
            };
        }))
    };
}

function groupFiles(files: File[]): Map<string, File[]> {
    const byFolder = new Map<string, File[]>();
    for (const file of files) {
        const source = fileSource(file);
        const parts = source.split("/").filter(Boolean);
        const name = parts.length > 1 ? parts[0] : source.replace(/\.[^.]+$/, "");
        byFolder.set(name, [...(byFolder.get(name) ?? []), file]);
    }
    return byFolder;
}

async function fileToBase64(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();
    let binary = "";
    for (const byte of new Uint8Array(buffer)) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}
