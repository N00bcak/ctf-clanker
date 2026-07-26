/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import {
    challengeToRequest,
    draftManifest,
    fileSource,
    filesToAttachments,
    normalizeCodexSettings,
    validateManifest
} from "../client/src/challengeIntake";

function namedFile(name: string, content: string, relativePath?: string): File {
    const file = new File([content], name);
    if (relativePath) {
        Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
    }
    return file;
}

describe("challenge intake helpers", () => {
    it("normalizes Codex settings with gpt-5.5 defaults", () => {
        expect(normalizeCodexSettings({})).toEqual({
            model: "gpt-5.5",
            profile: undefined,
            sandbox: "workspace-write",
            approvalPolicy: "never",
            webSearch: false
        });
    });

    it("drafts a manifest by grouping selected files by top-level folder", () => {
        const files = [
            namedFile("chal.py", "print(1)", "pwn-001/chal.py"),
            namedFile("README.md", "hint", "pwn-001/README.md"),
            namedFile("server.py", "print(2)", "web-002/server.py")
        ];

        const manifest = draftManifest(files);

        expect(manifest.challenges.map((challenge) => challenge.name)).toEqual(["pwn-001", "web-002"]);
        expect(manifest.challenges[0].attachments).toEqual([
            { source: "pwn-001/chal.py", path: "attachments/pwn-001/chal.py" },
            { source: "pwn-001/README.md", path: "attachments/pwn-001/README.md" }
        ]);
    });

    it("validates manifests and resolves companion files into create-task requests", async () => {
        const file = namedFile("chal.py", "print(1)", "pwn-001/chal.py");
        const manifest = validateManifest({
            version: 1,
            defaults: { backend: "local", codexSettings: { model: "gpt-5.5" } },
            challenges: [{
                name: "pwn-001",
                prompt: "Solve it",
                attachments: [{ source: fileSource(file), path: "challenge/chal.py" }]
            }]
        });

        const request = await challengeToRequest(manifest, manifest.challenges[0], [file]);

        expect(request).toMatchObject({
            name: "pwn-001",
            prompt: "Solve it",
            backend: "local",
            codexSettings: { model: "gpt-5.5", sandbox: "workspace-write", approvalPolicy: "never", webSearch: false },
            attachments: [{ path: "challenge/chal.py" }]
        });
        expect(request.attachments?.[0].contentBase64).toBe("cHJpbnQoMSk=");
    });

    it("encodes ad-hoc attachments for single task creation", async () => {
        const attachments = await filesToAttachments([namedFile("flag.txt", "flag")]);

        expect(attachments).toEqual([{ path: "attachments/flag.txt", contentBase64: "ZmxhZw==" }]);
    });
});
