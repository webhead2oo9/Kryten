/**
 * Resolve fingerprintable image attachments from a Discord message and download
 * their bytes: attachments only, image content-type inferred from Discord
 * metadata / filename / URL, and an 8 MiB cap enforced before and during the
 * download.
 */
import { Attachment, Message } from "discord.js";
import { downloadBounded } from "../../utils/boundedDownload";
import { contentTypeFromImageName, isRasterImageContentType, normalizeContentType } from "../../utils/imageTypes";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 15_000;

// The shared imageTypes allowlist intentionally excludes image/svg+xml: an SVG
// declared as image/* would otherwise reach sharp/librsvg — a much larger parser
// attack surface than the raster decoders — and cannot be Hamming-compared with
// the shared corpus anyway.

export interface ImageSource {
    raw: Buffer;
    filename: string;
    url: string;
    contentType: string | null;
    size: number;
}

/** Image content type from Discord metadata, else filename/URL, else null. */
export function inferImageContentType(attachment: Attachment): string | null {
    const declared = normalizeContentType(attachment.contentType);
    if (isRasterImageContentType(declared)) return declared;
    for (const candidate of [attachment.name, attachment.url, attachment.proxyURL]) {
        const inferred = contentTypeFromImageName(candidate);
        if (inferred) return inferred;
    }
    return null;
}

async function imageSourceFromAttachment(attachment: Attachment, maxBytes: number): Promise<ImageSource | null> {
    const contentType = inferImageContentType(attachment);
    if (contentType === null) return null;
    if (attachment.size && attachment.size > maxBytes) return null;

    const raw = await downloadBounded(attachment.url, {
        timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
        maxBytes,
    });
    if (!raw) return null;

    return {
        raw,
        filename: attachment.name || "image.png",
        url: attachment.url || "",
        contentType,
        size: raw.length,
    };
}

/** All fingerprintable image attachments on a message, with bytes downloaded. */
export async function resolveImageSources(
    message: Message,
    maxBytes: number = MAX_IMAGE_BYTES,
): Promise<ImageSource[]> {
    const sources: ImageSource[] = [];
    for (const attachment of message.attachments.values()) {
        const source = await imageSourceFromAttachment(attachment, maxBytes);
        if (source) sources.push(source);
    }
    return sources;
}
