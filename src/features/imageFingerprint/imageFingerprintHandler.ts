/**
 * Scam-image moderation built on shared FingerprintHub fingerprints. Two jobs:
 *
 *  A. Every posted image is pHashed and matched (in-memory, no network) against
 *     the known-bad corpus; a hit deletes the message and kicks/times-out the
 *     poster (honoring dry_run), while hub hit telemetry is controlled separately.
 *  B. When the same image is crossposted across channels by one user, a staff
 *     review card is raised (Approve/Deny). Approve contributes the fingerprint
 *     locally and to the hub, so the whole network learns the new scam image.
 *
 * Never throws out of the pipeline — the messageHandler try/catch is the backstop.
 */
import {
    AttachmentBuilder,
    ButtonInteraction,
    ButtonStyle,
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    Message,
    MessageFlags,
    TextChannel,
    TextDisplayBuilder,
    ActionRowBuilder,
    ButtonBuilder,
} from "discord.js";
import { randomBytes } from "crypto";
import { KrytenClient } from "../../classes/client";
import { channelOrParentListed } from "../../utils/channels";
import { AccentColor, renderFields, resolveCard } from "../../utils/cv2";
import { memberHasStaffRole, messageAuthorHasExemptRole } from "../../utils/staff";
import type { Config } from "../../types";
import { ActionResult, kickMember, timeoutMember } from "../moderation/actions";
import { markInternalMessageDelete } from "../messageLogging/messageLogger";
import { computePhashHex } from "./decode";
import {
    CROSSPOST_REVIEW_PROVENANCE,
    DuplicateFingerprintError,
    FingerprintHit,
    ImageFingerprintStore,
    VALID_CATEGORIES,
    hammingBig,
    phashFromHex,
} from "./store";
import { ImageSource, resolveImageSources } from "./imageSources";

/** Registry gate and settings() share this so the enabled default can't drift. */
export function imageFingerprintEnabled(config: Config): boolean {
    return config.moderation?.image_fingerprint?.enabled ?? false;
}

export const IMGFP_BUTTON_PREFIX = "imgfp:";
const REVIEW_TTL_MS = 24 * 60 * 60 * 1000;
// How often to age out expired review cards independently of new-card activity.
const REVIEW_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
// Hard cap on live review cards. Each is metadata-only once posted (the image
// buffer is released), but bound the count anyway so a flood of distinct
// crosspost clusters can't grow the map (or the O(n) pending-phash scan) without
// limit; the oldest card is evicted when a new one would exceed this.
const MAX_PENDING_REVIEWS = 500;
// Shared empty buffer swapped in for a posted review's image bytes — the
// approve/deny paths never read source.raw again.
const RELEASED_IMAGE_BYTES = Buffer.alloc(0);

interface Candidate {
    phash: bigint;
    phashHex: string;
    source: ImageSource;
}

interface RecentImageEntry {
    channelId: string;
    messageId: string;
    timestamp: number; // seconds
    phash: bigint;
    jumpUrl: string;
}

interface PendingReview {
    token: string;
    phash: bigint;
    phashHex: string;
    source: ImageSource;
    guildId: string | null;
    channelId: string;
    authorId: string;
    authorTag: string;
    jumpUrl: string;
    matchedChannels: number;
    minDistance: number;
    createdAt: number; // ms
}

export interface ImageFingerprintMetrics {
    imagesScanned: number;
    knownBadMatches: number;
    actionsTaken: number;
    reviewsRaised: number;
    contributed: number;
}

interface Settings {
    enabled: boolean;
    dryRun: boolean;
    reportHitsInDryRun: boolean;
    matchTolerance: number;
    duplicateTolerance: number;
    crosspostTolerance: number;
    defaultAction: "kick" | "timeout";
    defaultCategory: string;
    timeoutMinutes: number;
    deleteOnMatch: boolean;
    enforceKnownBad: boolean;
    recentWindowSeconds: number;
    reviewChannelThreshold: number;
    reviewCrossposts: boolean;
    reviewChannelId?: string;
    alertChannelId?: string;
    ignoredChannels: string[];
    whitelistedRoleIds: string[];
}

export class ImageFingerprintHandler {
    readonly store: ImageFingerprintStore;
    private readonly recentImages = new Map<string, RecentImageEntry[]>();
    private readonly pendingReviews = new Map<string, PendingReview>();
    private readonly pendingPhashes = new Set<string>();
    private reviewSweepTimer: NodeJS.Timeout | null = null;
    private readonly metrics: ImageFingerprintMetrics = {
        imagesScanned: 0,
        knownBadMatches: 0,
        actionsTaken: 0,
        reviewsRaised: 0,
        contributed: 0,
    };

    constructor(private readonly client: KrytenClient) {
        const config = client.config.moderation?.image_fingerprint ?? {};
        this.store = new ImageFingerprintStore(config, {
            onError: (context, error) =>
                void this.client.logError(`ImageFingerprint store: ${context}`, String(error)).catch(() => undefined),
        });
    }

    getMetrics(): Readonly<ImageFingerprintMetrics> {
        return this.metrics;
    }

    /** Start the hub sync loop (idempotent; no-op when the hub is inactive). */
    startBackgroundTasks(): void {
        this.store.startSync();
        // Age out ignored review cards on a timer, not only when the next card is
        // posted — otherwise an unclicked review pins its (up to 8 MiB) image
        // buffer and its stale pHash keeps suppressing re-review of that image
        // indefinitely.
        if (!this.reviewSweepTimer) {
            this.reviewSweepTimer = setInterval(() => this.sweepReviews(), REVIEW_SWEEP_INTERVAL_MS);
            this.reviewSweepTimer.unref();
        }
    }

    stop(): void {
        if (this.reviewSweepTimer) {
            clearInterval(this.reviewSweepTimer);
            this.reviewSweepTimer = null;
        }
        this.store.close();
    }

    private settings(): Settings {
        const c = this.client.config.moderation?.image_fingerprint ?? {};
        const matchTolerance = c.match_tolerance ?? 5;
        return {
            enabled: imageFingerprintEnabled(this.client.config),
            dryRun: c.dry_run ?? true,
            reportHitsInDryRun: c.report_hits_in_dry_run ?? true,
            matchTolerance,
            duplicateTolerance: c.duplicate_tolerance ?? matchTolerance,
            crosspostTolerance: c.crosspost_tolerance ?? matchTolerance,
            defaultAction: c.default_action === "timeout" ? "timeout" : "kick",
            // Clamp to a valid category (like default_action above): store.add
            // throws on an unknown category, and since this handler is a singleton
            // a single config typo would make EVERY review approval fail.
            defaultCategory: VALID_CATEGORIES.has(c.default_category ?? "") ? c.default_category! : "scam",
            timeoutMinutes: c.timeout_minutes ?? 30,
            deleteOnMatch: c.delete_on_match ?? true,
            enforceKnownBad: c.enforce_known_bad ?? true,
            recentWindowSeconds: c.recent_window_seconds ?? 900,
            reviewChannelThreshold: c.review_channel_threshold ?? 2,
            reviewCrossposts: c.review_crossposts ?? true,
            reviewChannelId: c.review_channel_id,
            alertChannelId: c.alert_channel_id ?? c.review_channel_id,
            ignoredChannels: c.ignored_channels ?? [],
            whitelistedRoleIds: c.whitelisted_role_ids ?? [],
        };
    }

    /** Message-pipeline entry point. Returns true when enforcement handled it. */
    async process(message: Message): Promise<boolean> {
        const s = this.settings();
        if (!s.enabled) return false;
        if (message.author.bot || !message.guild) return false;
        if (channelOrParentListed(message.channel, message.channelId, s.ignoredChannels)) return false;
        if (message.attachments.size === 0) return false;
        // Never scan or action a whitelisted or staff member's images. null =
        // member unresolvable: fail closed rather than risk enforcement.
        if ((await messageAuthorHasExemptRole(message, this.client.config, s.whitelistedRoleIds)) !== false)
            return false;

        // Keep the store's sync-upsert action hint aligned with live config.
        this.store.defaultAction = s.defaultAction;

        const candidates = await this.hashImages(message);
        if (!candidates.length) return false;
        this.metrics.imagesScanned += candidates.length;

        const now = Date.now() / 1000;
        this.cleanupRecent(now, s.recentWindowSeconds);

        // A. Known-bad match takes priority.
        for (const candidate of candidates) {
            const hit = this.store.match(candidate.phash, s.matchTolerance);
            if (hit) return this.handleKnownBadMatch(message, candidate, hit, s);
        }

        // B. Otherwise track for image-crosspost review.
        for (const candidate of candidates) {
            if (s.reviewCrossposts) await this.maybeRequestReview(message, candidate, s);
            this.rememberImage(message, candidate, now);
        }
        return false;
    }

    private async hashImages(message: Message): Promise<Candidate[]> {
        const sources = await resolveImageSources(message);
        const candidates: Candidate[] = [];
        for (const source of sources) {
            try {
                const phashHex = await computePhashHex(source.raw);
                candidates.push({ phash: phashFromHex(phashHex), phashHex, source });
            } catch {
                // Malformed uploads are common; skip silently.
            }
        }
        return candidates;
    }

    private async handleKnownBadMatch(
        message: Message,
        candidate: Candidate,
        hit: FingerprintHit,
        s: Settings,
    ): Promise<boolean> {
        this.metrics.knownBadMatches++;
        const guildId = message.guild?.id ?? undefined;
        const hitCount = this.store.incrementHit(hit.rowId, {
            guildId,
            distance: hit.distance,
            reportToHub: !s.dryRun || s.reportHitsInDryRun,
        });

        let actionTaken = "dry-run";
        let deleted = false;
        if (s.dryRun) {
            console.info(
                `[DRY RUN] Known scam image: user=${message.author.id} row=${hit.rowId} distance=${hit.distance} action=${s.defaultAction}`,
            );
        } else {
            if (s.deleteOnMatch) {
                const clearDeleteMarker = markInternalMessageDelete(
                    this.client,
                    message.id,
                    "known-bad image fingerprint",
                );
                deleted = await message.delete().then(
                    () => true,
                    () => {
                        clearDeleteMarker();
                        return false;
                    },
                );
            }
            if (s.enforceKnownBad) {
                const result = await this.applyMemberAction(message, s, hit);
                actionTaken = result.detail;
                // Count only actions that actually landed — a bot missing Kick
                // Members must not inflate the dashboard's moderation metric.
                if (result.ok) this.metrics.actionsTaken++;
            } else {
                actionTaken = s.deleteOnMatch
                    ? deleted
                        ? "message deleted"
                        : "message delete failed"
                    : "no action (enforcement and deletion disabled)";
            }
        }

        await this.sendKnownBadAlert(message, candidate, hit, actionTaken, hitCount, s);
        // Stop the message pipeline only when the message is actually gone —
        // in dry-run (or if deletion is disabled/failed) later features still
        // see a real message.
        return deleted;
    }

    private async applyMemberAction(message: Message, s: Settings, hit: FingerprintHit): Promise<ActionResult> {
        const member = message.member ?? (await message.guild?.members.fetch(message.author.id).catch(() => null));
        if (!member) return { ok: false, detail: `${s.defaultAction} failed - member not cached` };
        const reason = `Known scam image fingerprint match (row=${hit.rowId}, distance=${hit.distance}, category=${hit.category})`;
        return s.defaultAction === "kick"
            ? kickMember(member, reason)
            : timeoutMember(member, s.timeoutMinutes, reason);
    }

    private async sendKnownBadAlert(
        message: Message,
        candidate: Candidate,
        hit: FingerprintHit,
        actionTaken: string,
        hitCount: number | null,
        s: Settings,
    ): Promise<void> {
        if (!s.alertChannelId) return;
        const channel = await this.client.channels.fetch(s.alertChannelId).catch(() => null);
        if (!channel || !channel.isTextBased()) return;

        const filename = safeFilename(candidate.source.filename);
        const file = new AttachmentBuilder(candidate.source.raw, { name: filename });
        const container = new ContainerBuilder()
            .setAccentColor(AccentColor.Red)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent("## Known Scam Image Detected"),
                new TextDisplayBuilder().setContent(
                    renderFields([
                        { name: "User", value: `${message.author} (\`${message.author.id}\`)` },
                        { name: "Action", value: actionTaken },
                        {
                            name: "Fingerprint",
                            value: `Incoming: \`${candidate.phashHex}\`\nMatched: \`${hit.phashHex}\`\nDistance: \`${hit.distance}\``,
                        },
                        {
                            name: "Source",
                            value:
                                `Row: \`${hit.rowId}\`` +
                                (hit.hubFingerprintId ? ` / Hub: \`${hit.hubFingerprintId}\`` : "") +
                                `\nCategory: \`${hit.category}\`\nHits: \`${hitCount ?? "?"}\``,
                        },
                        { name: "Message", value: message.url },
                    ]),
                ),
            )
            .addMediaGalleryComponents(
                new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${filename}`)),
            );

        await (channel as TextChannel)
            .send({
                components: [container],
                files: [file],
                flags: MessageFlags.IsComponentsV2,
                allowedMentions: { parse: [] },
            })
            .catch(() => undefined);
    }

    // ---- capability B: image crosspost review ------------------------------

    private async maybeRequestReview(message: Message, candidate: Candidate, s: Settings): Promise<void> {
        if (!s.reviewChannelId) return;
        // Already known-bad-ish? then there's nothing to review.
        if (s.duplicateTolerance > s.matchTolerance && this.store.match(candidate.phash, s.duplicateTolerance)) return;
        if (this.hasPendingReviewNear(candidate.phash, s.crosspostTolerance)) return;

        const matches = this.matchingRecentEntries(message, candidate, s);
        if (!matches.length) return;
        const channels = new Set(matches.map(m => m.channelId));
        channels.add(message.channelId);
        if (channels.size < s.reviewChannelThreshold) return;

        const minDistance = Math.min(...matches.map(m => hammingBig(candidate.phash, m.phash)));
        await this.postReviewCard(
            {
                token: randomBytes(16).toString("hex"),
                phash: candidate.phash,
                phashHex: candidate.phashHex,
                source: candidate.source,
                guildId: message.guildId,
                channelId: message.channelId,
                authorId: message.author.id,
                authorTag: message.author.tag,
                jumpUrl: message.url,
                matchedChannels: channels.size,
                minDistance,
                createdAt: Date.now(),
            },
            s,
        );
    }

    /**
     * A review within crosspost tolerance is already pending: near-identical
     * variants (recompressed copies a few bits apart) match the same crosspost
     * cluster and would raise a redundant second card for staff.
     */
    private hasPendingReviewNear(phash: bigint, tolerance: number): boolean {
        for (const hex of this.pendingPhashes) {
            if (hammingBig(phash, phashFromHex(hex)) <= tolerance) return true;
        }
        return false;
    }

    private matchingRecentEntries(message: Message, candidate: Candidate, s: Settings): RecentImageEntry[] {
        const entries = this.recentImages.get(message.author.id) ?? [];
        return entries.filter(
            e => e.channelId !== message.channelId && hammingBig(candidate.phash, e.phash) <= s.crosspostTolerance,
        );
    }

    private async postReviewCard(review: PendingReview, s: Settings): Promise<void> {
        this.pendingPhashes.add(review.phashHex);
        const channel = await this.client.channels.fetch(s.reviewChannelId!).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            this.pendingPhashes.delete(review.phashHex);
            return;
        }

        const filename = safeFilename(review.source.filename);
        const file = new AttachmentBuilder(review.source.raw, { name: filename });
        const container = buildReviewContainer(review, filename).addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                    .setCustomId(`${IMGFP_BUTTON_PREFIX}approve:${review.token}`)
                    .setLabel("Approve")
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`${IMGFP_BUTTON_PREFIX}deny:${review.token}`)
                    .setLabel("Deny")
                    .setStyle(ButtonStyle.Danger),
            ),
        );

        try {
            await (channel as TextChannel).send({
                components: [container],
                files: [file],
                flags: MessageFlags.IsComponentsV2,
                allowedMentions: { parse: [] },
            });
            // The card now carries the image and the approve/deny paths only read
            // phash/url/jumpUrl, so drop the (up to 8 MiB) raw buffer before the
            // review joins the long-lived pending map.
            review.source = { ...review.source, raw: RELEASED_IMAGE_BYTES };
            this.evictOldestReviewIfFull();
            this.pendingReviews.set(review.token, review);
            this.metrics.reviewsRaised++;
            this.sweepReviews();
        } catch {
            this.pendingPhashes.delete(review.phashHex);
        }
    }

    /** Route imgfp: buttons from index.ts. Staff-gated; edits the card in place. */
    async handleButton(interaction: ButtonInteraction): Promise<void> {
        try {
            const parsed = parseImgfpButtonId(interaction.customId);
            if (!parsed) {
                await interaction.deferUpdate().catch(() => undefined);
                return;
            }
            if (!memberHasStaffRole(interaction.member, this.client.config)) {
                await interaction
                    .reply({ content: "Only staff members can resolve this review.", flags: MessageFlags.Ephemeral })
                    .catch(() => undefined);
                return;
            }
            await interaction.deferUpdate().catch(() => undefined);

            const review = this.pendingReviews.get(parsed.token);
            const reviewer = interaction.user.tag;
            if (!review) {
                await annotateCard(interaction, "This review is no longer active (resolved or expired).", 0x808080);
                return;
            }
            if (parsed.action === "deny") {
                this.resolveReview(review);
                await annotateCard(interaction, `Denied by ${reviewer}`, 0x808080);
                return;
            }

            const s = this.settings();
            try {
                const rowId = this.store.add({
                    phash: review.phash,
                    action: s.defaultAction,
                    category: s.defaultCategory,
                    addedBy: `review:${interaction.user.id}`,
                    sourceUrl: review.source.url || null,
                    reason: `Approved via image crosspost review by ${reviewer}. Source: ${review.jumpUrl}`,
                    provenance: CROSSPOST_REVIEW_PROVENANCE,
                    duplicateTolerance: s.duplicateTolerance,
                    sourceGuildId: review.guildId,
                });
                this.resolveReview(review);
                this.metrics.contributed++;
                await annotateCard(interaction, `Approved by ${reviewer} — fingerprint #${rowId}`, 0x2ecc71);
            } catch (error) {
                if (error instanceof DuplicateFingerprintError) {
                    // The fingerprint already exists — this review is terminal.
                    this.resolveReview(review);
                    await annotateCard(
                        interaction,
                        `Skipped by ${reviewer} — overlaps fingerprint #${error.hit.rowId} (distance ${error.hit.distance})`,
                        0x808080,
                    );
                    return;
                }
                // Non-terminal failure (misconfigured category, transient DB error):
                // nothing was saved, so leave the review pending. The card's buttons
                // are still live, so staff can retry instead of losing the review.
                await this.client
                    .logError("ImageFingerprint review approval failed", error instanceof Error ? error : String(error))
                    .catch(() => undefined);
                await interaction
                    .followUp({
                        content: "Failed to save fingerprint. The review is still open — try again.",
                        flags: MessageFlags.Ephemeral,
                    })
                    .catch(() => undefined);
            }
        } catch (error) {
            await this.client
                .logError("ImageFingerprint button failed", error instanceof Error ? error : String(error))
                .catch(() => undefined);
        }
    }

    private resolveReview(review: PendingReview): void {
        this.pendingReviews.delete(review.token);
        this.pendingPhashes.delete(review.phashHex);
    }

    private rememberImage(message: Message, candidate: Candidate, now: number): void {
        const entry: RecentImageEntry = {
            channelId: message.channelId,
            messageId: message.id,
            timestamp: now,
            phash: candidate.phash,
            jumpUrl: message.url,
        };
        const list = this.recentImages.get(message.author.id);
        if (list) list.push(entry);
        else this.recentImages.set(message.author.id, [entry]);
    }

    private cleanupRecent(now: number, windowSeconds: number): void {
        for (const [userId, entries] of this.recentImages) {
            const kept = entries.filter(e => now - e.timestamp <= windowSeconds);
            if (kept.length) this.recentImages.set(userId, kept);
            else this.recentImages.delete(userId);
        }
    }

    /** Drop the oldest pending review when the map is at capacity, before inserting. */
    private evictOldestReviewIfFull(): void {
        if (this.pendingReviews.size < MAX_PENDING_REVIEWS) return;
        let oldestToken: string | undefined;
        let oldestAt = Infinity;
        for (const [token, review] of this.pendingReviews) {
            if (review.createdAt < oldestAt) {
                oldestAt = review.createdAt;
                oldestToken = token;
            }
        }
        if (oldestToken === undefined) return;
        const evicted = this.pendingReviews.get(oldestToken)!;
        this.pendingReviews.delete(oldestToken);
        this.pendingPhashes.delete(evicted.phashHex);
    }

    private sweepReviews(): void {
        const cutoff = Date.now() - REVIEW_TTL_MS;
        for (const [token, review] of this.pendingReviews) {
            if (review.createdAt < cutoff) {
                this.pendingReviews.delete(token);
                this.pendingPhashes.delete(review.phashHex);
            }
        }
    }
}

function safeFilename(original: string): string {
    const base = (original || "image.png").replace(/\\/g, "/").split("/").pop() || "image.png";
    return base.replace(/[^A-Za-z0-9._-]/g, "_") || "image.png";
}

function buildReviewContainer(review: PendingReview, filename: string): ContainerBuilder {
    return new ContainerBuilder()
        .setAccentColor(AccentColor.Orange)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## Image Crosspost Review"),
            new TextDisplayBuilder().setContent(
                "A visually similar image was posted by the same user in multiple channels.",
            ),
            new TextDisplayBuilder().setContent(
                renderFields([
                    { name: "User", value: `<@${review.authorId}> (\`${review.authorId}\`)` },
                    { name: "Channels", value: String(review.matchedChannels) },
                    { name: "Closest Distance", value: `\`${review.minDistance}\`` },
                    { name: "Fingerprint", value: `pHash: \`${review.phashHex}\`` },
                    { name: "Message", value: review.jumpUrl },
                ]),
            ),
        )
        .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(`attachment://${filename}`)),
        );
}

export function parseImgfpButtonId(customId: string): { action: "approve" | "deny"; token: string } | null {
    if (!customId.startsWith(IMGFP_BUTTON_PREFIX)) return null;
    const [, action, token] = customId.split(":");
    if ((action !== "approve" && action !== "deny") || !token) return null;
    return { action, token };
}

/** Resolve the review card in place with a Status line (shared CV2 card resolver). */
async function annotateCard(interaction: ButtonInteraction, note: string, color: number): Promise<void> {
    await resolveCard(interaction, `**Status**\n${note}`, color);
}
