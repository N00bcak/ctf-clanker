import type { FastifyRequest } from "fastify";
import type { AttachmentInput, CreateTaskInput, WebuiConfig } from "../types.js";

// Multipart uses one JSON `task` field and file parts named by workspace path.
export async function readTaskInput(request: FastifyRequest, config: WebuiConfig): Promise<CreateTaskInput> {
    if (!request.isMultipart()) return request.body as CreateTaskInput;
    const attachments: AttachmentInput[] = [];
    const paths = new Set<string>();
    let input: CreateTaskInput | undefined;
    let total = 0;
    const limits = config.limits.attachments;
    for await (const part of request.parts({ limits: {
        files: limits.maxFiles, fileSize: limits.maxFileBytes,
        fields: 1, fieldSize: 1024 * 1024, parts: limits.maxFiles + 1
    } })) {
        if (part.type === "field") {
            if (part.fieldname !== "task" || input || part.valueTruncated || typeof part.value !== "string") {
                throw new Error("expected one non-truncated task JSON field");
            }
            input = JSON.parse(part.value) as CreateTaskInput;
            if (!input || typeof input !== "object" || Array.isArray(input) || input.attachments !== undefined) {
                throw new Error("multipart task must be an object without inline attachments");
            }
        } else {
            if (!/^attachments\/[a-zA-Z0-9_./-]+$/.test(part.fieldname)
                || part.fieldname.split("/").some((segment) => !segment || segment === "." || segment === "..")
                || paths.has(part.fieldname)) throw new Error("invalid or duplicate attachment path");
            paths.add(part.fieldname);
            const chunks: Buffer[] = [];
            for await (const chunk of part.file) {
                total += chunk.length;
                if (total > limits.maxTotalBytes) throw new Error("attachments exceed maxTotalBytes");
                chunks.push(chunk);
            }
            if (part.file.truncated) throw new Error("attachment exceeds maxFileBytes");
            attachments.push({ path: part.fieldname, contentBase64: Buffer.concat(chunks).toString("base64") });
        }
    }
    if (!input) throw new Error("missing task JSON field");
    return { ...input, attachments };
}
