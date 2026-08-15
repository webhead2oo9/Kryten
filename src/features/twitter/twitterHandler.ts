import { AttachmentBuilder, ChannelType, Message, TextChannel, Webhook } from "discord.js";
import { KrytenClient } from "../../classes/client";
import { downloadBounded } from "../../utils/boundedDownload";
import { markInternalMessageDelete } from "../messageLogging/messageLogger";

const WEBHOOK_NAME = "Link Fixer";
// Case-insensitive: Discord embeds (and browsers) accept HTTPS://X.COM/... too.
// Optional `www.` so desktop/share-sheet links (https://www.x.com/…) are fixed,
// not silently ignored. The subdomain is non-capturing, so the host stays group 1
// and the path stays group 2 for the replace callback below.
const URL_PATTERN = /https?:\/\/(?:www\.)?(twitter\.com|x\.com)\/(\S+)/gi;
const DOWNLOAD_TIMEOUT_MS = 30_000;
// Memory bound for re-uploaded attachments (each is buffered whole). 50 MiB
// covers boost-tier-2 uploads; a bigger attachment aborts the repost instead of
// silently dropping it, since the original message gets deleted afterwards.
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_MESSAGE_LENGTH = 2000;

/**
 * Boolean mask over `content` marking characters inside fenced code blocks,
 * inline code spans, or spoilers — regions where a Twitter/X link is quoted
 * text, not something to rewrite. Applied in priority order (fences first) and
 * a span starting inside an already-marked region is skipped, so nested markup
 * can't double-count. Erring toward over-marking is safe: it only causes a link
 * to be left alone.
 */
export function protectedRanges(content: string): boolean[] {
    const mask = new Array<boolean>(content.length).fill(false);
    const apply = (pattern: RegExp): void => {
        for (const m of content.matchAll(pattern)) {
            const start = m.index ?? 0;
            if (mask[start]) continue;
            for (let i = start; i < start + m[0].length && i < content.length; i++) mask[i] = true;
        }
    };
    apply(/```[\s\S]*?```/g); // fenced code blocks
    apply(/`[^`\n]*`/g); // inline code
    apply(/\|\|[\s\S]*?\|\|/g); // spoilers
    return mask;
}

/**
 * Detect Twitter/X links in enabled channels and repost them via a webhook
 * (as the original author) using an embed-friendly domain, then delete the
 * original. Requires the Manage Webhooks permission in the channel. Errors
 * propagate to the feature registry, which routes them to logError.
 */
export async function handleTwitterLinks(message: Message, client: KrytenClient): Promise<void> {
    const cfg = client.config.twitter;
    if (!cfg?.enabled) return;
    if (!(cfg.enabled_channels ?? []).includes(message.channelId)) return;

    const service = cfg.embed_service ?? "vxtwitter.com";
    // Don't rewrite links the user deliberately quoted inside code or a spoiler
    // — reposting + deleting the original there mangles content they never asked
    // to "fix". Over-marking only skips a rewrite (safe direction).
    const masked = protectedRanges(message.content);
    const modified = message.content.replace(
        URL_PATTERN,
        (match: string, _host: string, path: string, offset: number) =>
            masked[offset] ? match : `https://${service}/${path}`,
    );
    if (modified === message.content) return;

    // Rewriting lengthens each link (x.com → vxtwitter.com), so a near-limit
    // message can exceed 2000 chars — webhook.send would throw and the original
    // would be left alone anyway, just with an error logged every time.
    if (modified.length > MAX_MESSAGE_LENGTH) return;

    if (message.channel.type !== ChannelType.GuildText) return;
    const channel = message.channel as TextChannel;

    const webhook = await getOrCreateWebhook(channel);
    if (!webhook) return;

    // If any attachment can't be re-uploaded (timeout, too large), leave the
    // original message alone — reposting without it and then deleting the
    // original would destroy the user's attachment.
    const files = await downloadAttachments(message);
    if (files === null) return;
    try {
        await webhook.send({
            content: modified,
            username: sanitizeWebhookUsername(message.member?.displayName ?? message.author.username),
            avatarURL: message.member?.displayAvatarURL() ?? message.author.displayAvatarURL(),
            files,
            // Webhook posts ignore the original author's permissions, so suppress all
            // mentions — otherwise a member without Mention-Everyone could smuggle an
            // @everyone/role ping through the reposted copy.
            allowedMentions: { parse: [] },
        });
    } catch (error) {
        // A webhook execute failure (a still-unforeseen username rejection, a
        // transient 5xx) must not throw before we decide whether to delete the
        // original — bail WITHOUT deleting so the user's message + attachments
        // survive. console (not logError) so a repeatedly-tripping user doesn't
        // spam the staff error channel on every link.
        console.error("Twitter link fixer: webhook send failed; leaving the original message intact:", error);
        return;
    }
    // Deleting another user's message needs Manage Messages (separate from the
    // Manage Webhooks this feature assumes); don't re-throw on failure or every
    // link would error out the pipeline after the copy was already posted. Log it
    // (no Discord alert — this is a per-channel setup issue, not a per-message
    // anomaly) so a missing Manage Messages permission is at least diagnosable
    // rather than leaving a silent duplicate.
    const clearDeleteMarker = markInternalMessageDelete(client, message.id, "twitter link fixer");
    await message.delete().catch(err => {
        clearDeleteMarker();
        console.error(`Twitter link fixer: failed to delete original in #${channel.name}:`, err);
    });
}

/**
 * Discord 400s a webhook username override that contains "discord" or "clyde"
 * (case-insensitive) and caps it at 80 chars. A member whose display name trips
 * either would otherwise throw the whole repost. Neutralize those substrings and
 * clamp; fall back to the generic webhook name if nothing usable remains.
 */
export function sanitizeWebhookUsername(name: string): string {
    // Strip the reserved substrings until none remain: a single pass can REFORM
    // one (e.g. "discordord" → "disc"+"ord"), so loop until stable. Each pass
    // removes ≥1 match and shortens the string, so it terminates.
    let cleaned = name;
    while (/discord|clyde/i.test(cleaned)) {
        cleaned = cleaned.replace(/discord/gi, "").replace(/clyde/gi, "");
    }
    cleaned = cleaned.trim().slice(0, 80);
    return cleaned.length ? cleaned : WEBHOOK_NAME;
}

// Two links arriving together would each fetch-then-create and make duplicate
// "Link Fixer" webhooks. Dedupe concurrent lookups per channel: the second caller
// awaits the first's in-flight promise instead of racing a second createWebhook.
const webhookInFlight = new Map<string, Promise<Webhook | null>>();

async function getOrCreateWebhook(channel: TextChannel): Promise<Webhook | null> {
    const existing = webhookInFlight.get(channel.id);
    if (existing) return existing;
    const promise = (async (): Promise<Webhook | null> => {
        try {
            const webhooks = await channel.fetchWebhooks();
            const found = webhooks.find(w => w.name === WEBHOOK_NAME);
            if (found) return found;
            return await channel.createWebhook({ name: WEBHOOK_NAME, reason: "Twitter/X link fixer" });
        } catch {
            return null;
        }
    })();
    webhookInFlight.set(channel.id, promise);
    try {
        return await promise;
    } finally {
        webhookInFlight.delete(channel.id);
    }
}

/** Download all attachments for re-upload, or null if any one fails. */
async function downloadAttachments(message: Message): Promise<AttachmentBuilder[] | null> {
    const files: AttachmentBuilder[] = [];
    const attachments = [...message.attachments.values()];
    let advertisedTotal = 0;
    for (const attachment of attachments) {
        const advertisedSize = Number.isFinite(attachment.size) ? attachment.size : 0;
        if (advertisedSize > MAX_ATTACHMENT_BYTES) return null;
        advertisedTotal += advertisedSize;
        if (advertisedTotal > MAX_TOTAL_ATTACHMENT_BYTES) return null;
    }

    let totalBytes = 0;
    for (const attachment of attachments) {
        const remainingBytes = MAX_TOTAL_ATTACHMENT_BYTES - totalBytes;
        if (remainingBytes <= 0) return null;
        const buffer = await downloadBounded(attachment.url, {
            timeoutMs: DOWNLOAD_TIMEOUT_MS,
            maxBytes: Math.min(MAX_ATTACHMENT_BYTES, remainingBytes),
        });
        if (!buffer) return null;
        totalBytes += buffer.length;
        if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) return null;
        files.push(new AttachmentBuilder(buffer, { name: attachment.name ?? "file" }));
    }
    return files;
}
