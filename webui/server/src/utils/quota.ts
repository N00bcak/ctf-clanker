import fs from "node:fs";
import path from "node:path";
import type { AttachmentInput, WebuiConfig } from "../types.js";

export function decodedAttachmentBytes(attachment: AttachmentInput): Buffer {
    return Buffer.from(attachment.contentBase64, "base64");
}

export function enforceAttachmentLimits(attachments: AttachmentInput[], config: WebuiConfig): void {
    if (attachments.length > config.limits.attachments.maxFiles) {
        throw new Error(`too many attachments; max ${config.limits.attachments.maxFiles}`);
    }
    let total = 0;
    for (const attachment of attachments) {
        const bytes = decodedAttachmentBytes(attachment);
        if (bytes.byteLength > config.limits.attachments.maxFileBytes) {
            throw new Error(`attachment ${attachment.path} exceeds maxFileBytes`);
        }
        total += bytes.byteLength;
        if (total > config.limits.attachments.maxTotalBytes) {
            throw new Error("attachments exceed maxTotalBytes");
        }
    }
}

export function directorySizeBytes(root: string): number {
    if (!fs.existsSync(root)) {
        return 0;
    }
    const stat = fs.lstatSync(root);
    if (stat.isSymbolicLink()) {
        return 0;
    }
    if (stat.isFile()) {
        return stat.size;
    }
    if (!stat.isDirectory()) {
        return 0;
    }
    return fs.readdirSync(root).reduce((total, entry) => total + directorySizeBytes(path.join(root, entry)), 0);
}

export function enforceTaskQuota(taskRoot: string, config: WebuiConfig, incomingBytes = 0): void {
    const limitBytes = config.limits.taskCacheDirQuotaMb * 1024 * 1024;
    const current = directorySizeBytes(taskRoot);
    if (current + incomingBytes > limitBytes) {
        throw new Error(`task cache soft quota exceeded: ${config.limits.taskCacheDirQuotaMb} MiB`);
    }
}
