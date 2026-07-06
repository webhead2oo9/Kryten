import {
    AttachmentBuilder,
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    Message,
    MessageCreateOptions,
    MessageFlags,
    TextChannel,
} from "discord.js";
import { downloadBoundedResponse } from "./boundedDownload";
import { CV2_MEDIA_GALLERY_ITEM_BUDGET } from "./cv2";
import { imageExtensionForContentType, isRasterImageContentType } from "./imageTypes";

// Re-host the source message's images (rather than linking the originals) so
// the evidence survives the message being deleted or its signed CDN URL
// expiring. Images are held only in memory and streamed straight to the
// upload — never written to disk. The caller lays the items out in a
// Components-V2 MediaGallery (up to 10 items per gallery).
const MAX_GALLERY_IMAGES = CV2_MEDIA_GALLERY_ITEM_BUDGET;
const MAX_DOWNLOAD_ATTEMPTS = 12;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // Discord's per-file upload limit.
// Fixed conservative ceiling: 10 × 10 MB would routinely exceed a non-boosted
// guild's per-message upload limit; the callers' text-only fallback absorbs
// the rejections that still slip through.
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 8_000;
const DISCORD_EXTERNAL_IMAGE_HOST = /^images-ext-\d+\.discordapp\.net$/;

interface ImageCandidate {
    url: string;
    contentType: string | undefined;
}

export interface GalleryResult {
    items: MediaGalleryItemBuilder[];
    files: AttachmentBuilder[];
}

export interface AlertWithGalleryOptions {
    channel: TextChannel;
    sourceMessage: Message;
    filenamePrefix: string;
    buildContainer: () => ContainerBuilder;
    allowedMentions: MessageCreateOptions["allowedMentions"];
    fallbackLogLabel: string;
}

export function isAllowedDiscordMediaUrl(rawUrl: string): boolean {
    try {
        const url = new URL(rawUrl);
        if (url.protocol !== "https:") return false;
        const host = url.hostname.toLowerCase();
        if (host === "cdn.discordapp.com") return url.pathname.startsWith("/attachments/");
        if (host === "media.discordapp.net") {
            return url.pathname.startsWith("/attachments/") || url.pathname.startsWith("/external/");
        }
        return DISCORD_EXTERNAL_IMAGE_HOST.test(host) && url.pathname.startsWith("/external/");
    } catch {
        return false;
    }
}

function collectImageCandidates(message: Message): ImageCandidate[] {
    const candidates: ImageCandidate[] = [];
    const seen = new Set<string>();
    const add = (url: string | null | undefined, contentType: string | null | undefined): void => {
        if (!url || seen.has(url) || !isAllowedDiscordMediaUrl(url)) return;
        seen.add(url);
        candidates.push({ url, contentType: contentType ?? undefined });
    };
    // Uploaded attachments first, then Discord's cached/proxied copies of embeds.
    for (const attachment of message.attachments.values()) {
        if (isRasterImageContentType(attachment.contentType)) {
            add(attachment.proxyURL || attachment.url, attachment.contentType);
        }
    }
    for (const embed of message.embeds) {
        add(embed.image?.proxyURL ?? embed.image?.url, null);
        add(embed.thumbnail?.proxyURL ?? embed.thumbnail?.url, null);
    }
    return candidates;
}

async function downloadImage(
    candidate: ImageCandidate,
    maxBytes: number,
): Promise<{ buffer: Buffer; contentType: string } | null> {
    let contentType = candidate.contentType ?? "";
    const response = await downloadBoundedResponse(candidate.url, {
        timeoutMs: IMAGE_FETCH_TIMEOUT_MS,
        maxBytes,
        redirect: "error",
        validateResponse: res => {
            contentType = res.headers.get("content-type") ?? candidate.contentType ?? "";
            return isRasterImageContentType(contentType);
        },
    });
    if (!response || response.buffer.length === 0) return null;
    return { buffer: response.buffer, contentType };
}

/**
 * Re-host up to 10 of a message's images as media-gallery items. Returns the
 * gallery items plus the in-memory files to attach; an empty `items` array
 * means "no gallery". The caller keeps its container rebuildable so it can
 * fall back to a text-only alert if the upload is rejected (e.g. over the
 * guild's size limit).
 */
export async function buildImageGallery(message: Message, filenamePrefix = "image"): Promise<GalleryResult> {
    const candidates = collectImageCandidates(message).slice(0, MAX_DOWNLOAD_ATTEMPTS);
    if (candidates.length === 0) return { items: [], files: [] };

    const items: MediaGalleryItemBuilder[] = [];
    const files: AttachmentBuilder[] = [];
    let totalBytes = 0;
    for (const candidate of candidates) {
        if (files.length >= MAX_GALLERY_IMAGES) break;
        const remainingBytes = MAX_TOTAL_BYTES - totalBytes;
        if (remainingBytes <= 0) break;

        const downloaded = await downloadImage(candidate, Math.min(MAX_IMAGE_BYTES, remainingBytes));
        if (!downloaded) continue;
        if (totalBytes + downloaded.buffer.length > MAX_TOTAL_BYTES) continue;
        const extension = imageExtensionForContentType(downloaded.contentType);
        if (!extension) continue;
        const name = `${filenamePrefix}-${files.length}.${extension}`;
        files.push(new AttachmentBuilder(downloaded.buffer, { name }));
        totalBytes += downloaded.buffer.length;
        items.push(new MediaGalleryItemBuilder().setURL(`attachment://${name}`));
    }

    return { items, files };
}

export async function sendAlertWithGallery(options: AlertWithGalleryOptions): Promise<void> {
    const { items, files } = await buildImageGallery(options.sourceMessage, options.filenamePrefix);
    const container = options.buildContainer();
    if (items.length > 0) {
        container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(...items));
    }
    try {
        await options.channel.send({
            components: [container],
            files,
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: options.allowedMentions,
        });
    } catch (sendError) {
        if (items.length === 0) throw sendError;
        console.error(`${options.fallbackLogLabel} gallery send failed, retrying text-only:`, sendError);
        await options.channel.send({
            components: [options.buildContainer()],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: options.allowedMentions,
        });
    }
}
