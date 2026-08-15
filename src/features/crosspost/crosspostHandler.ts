import { ContainerBuilder, Message, MessageFlags, PartialMessage, TextChannel, TextDisplayBuilder } from "discord.js";
import { KrytenClient } from "../../classes/client";
import type { Config } from "../../types";
import { ActionResult, deleteMessageById, kickMember, sendModAlert, timeoutMember } from "../moderation/actions";
import { channelOrParentListed } from "../../utils/channels";
import { AccentColor, renderFields } from "../../utils/cv2";
import { messageAuthorHasExemptRole } from "../../utils/staff";
import { markInternalMessageDelete } from "../messageLogging/messageLogger";
import { Comparison, Fingerprint, SimilarityEngine, SimilarityThresholds } from "./similarity";

/** Registry gate and settings() share this so the enabled default can't drift. */
export function crosspostEnabled(config: Config): boolean {
    return config.moderation?.crosspost?.enabled ?? true;
}

const WARNING_COOLDOWN_SECONDS = 300;
const BURST_INCIDENT_COOLDOWN_SECONDS = 60;
const OFFENSE_RESET_SECONDS = 86400;
const UPDATE_LENGTH_RATIO = 1.15;
const SWEEP_INTERVAL_SECONDS = 300;
// How long warning-bookkeeping (and warn cooldowns) are retained before the
// throttled sweep drops them. Well beyond WARNING_COOLDOWN_SECONDS so deletion
// cleanup still works for any realistically-recent message; bounds the maps for
// the common case where a linked message is simply never deleted.
const WARNING_RETENTION_SECONDS = 3600;

interface CrosspostSettings extends SimilarityThresholds {
    enabled: boolean;
    windowSeconds: number;
    newContentRatioThreshold: number;
    dryRun: boolean;
    burstChannelThreshold: number;
    burstTimeoutMinutes: number;
    burstAlertChannelId?: string;
    ignoredChannels: string[];
    whitelistedRoleIds: string[];
}

interface RecentEntry {
    channelId: string;
    fingerprint: Fingerprint;
    timestamp: number; // seconds
    messageId: string;
}

// A matched recent entry plus the comparison that decided the match, when one was
// computed (attachment/exact-content matches short-circuit before comparing).
interface MatchedEntry {
    entry: RecentEntry;
    comparison?: Comparison;
}

interface WarningEntry {
    warningMessage: Message;
    warningChannelId: string;
    duplicateMessageId: string;
    sourceMessageId: string;
    userId: string;
    createdAt: number; // seconds; used by the throttled sweep to expire stale entries
}

interface BurstCooldown {
    handledAt: number;
    offenseCount: number;
}

export interface CrosspostMetrics {
    messagesProcessed: number;
    exactMatches: number;
    similarityMatches: number;
    warningsSent: number;
    warningsSuppressed: number;
    updatesDetected: number;
    burstSpamDetected: number;
    seqTriggered: number;
    charTriggered: number;
    jacTriggered: number;
}

/**
 * Cross-channel duplicate/spam detection. Tracks each user's recent messages,
 * compares incoming messages against them via {@link SimilarityEngine}, warns on
 * 2–3 channel crossposts, and escalates mass crossposting (burst spam) through
 * the shared moderation actions.
 */
export class CrosspostHandler {
    private readonly engine = new SimilarityEngine();
    private readonly recentMessages = new Map<string, RecentEntry[]>();
    private readonly spamWarnings = new Map<string, Map<string, number>>();
    private readonly burstCooldowns = new Map<string, BurstCooldown>();
    // Users with a burst-enforcement pass currently in flight. messageCreate
    // handlers aren't serialized, so this synchronous guard stops the many
    // near-simultaneous messages of one burst from each running full
    // enforcement before the first records its incident cooldown.
    private readonly burstInFlight = new Set<string>();
    private lastSweep = 0;
    private readonly warningMessages = new Map<string, WarningEntry[]>();
    private readonly sourceWarningMessages = new Map<string, WarningEntry[]>();
    private readonly metrics: CrosspostMetrics = {
        messagesProcessed: 0,
        exactMatches: 0,
        similarityMatches: 0,
        warningsSent: 0,
        warningsSuppressed: 0,
        updatesDetected: 0,
        burstSpamDetected: 0,
        seqTriggered: 0,
        charTriggered: 0,
        jacTriggered: 0,
    };

    constructor(private readonly client: KrytenClient) {}

    getMetrics(): Readonly<CrosspostMetrics> {
        return this.metrics;
    }

    /** Resolve effective settings from config each call so /reload_config takes effect. */
    private settings(): CrosspostSettings {
        const c = this.client.config.moderation?.crosspost ?? {};
        return {
            enabled: crosspostEnabled(this.client.config),
            windowSeconds: c.window_seconds ?? 900,
            sequenceRatioThreshold: c.sequence_ratio_threshold ?? 0.85,
            jaccardThreshold: c.jaccard_threshold ?? 0.65,
            charCosineThreshold: c.char_cosine_threshold ?? 0.88,
            minNormalizedLength: c.min_normalized_length ?? 80,
            lengthRatioThreshold: c.length_ratio_threshold ?? 1.18,
            newContentRatioThreshold: c.new_content_ratio_threshold ?? 0.3,
            minAlgorithmsToMatch: c.min_algorithms_to_match ?? 2,
            dryRun: c.dry_run ?? true,
            burstChannelThreshold: c.burst_channel_threshold ?? 3,
            burstTimeoutMinutes: c.burst_timeout_minutes ?? 30,
            burstAlertChannelId: c.burst_alert_channel_id,
            ignoredChannels: c.ignored_channels ?? [],
            whitelistedRoleIds: c.whitelisted_role_ids ?? [],
        };
    }

    private attachmentFingerprint(message: Message): string {
        if (message.attachments.size === 0) return "";
        // Name alone is not enough: mobile/paste uploads are routinely named
        // image.png / IMG_0001.png, so two unrelated screenshots would count as
        // an *exact* crosspost (public warning even in dry-run, burst credit).
        // Size makes the fingerprint specific to the actual file.
        return [...message.attachments.values()]
            .map(a => `${a.name ?? ""}:${a.size}`)
            .sort()
            .join("|");
    }

    private messageLink(guildId: string | null, channelId: string, messageId: string): string {
        return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;
    }

    private pushEntry(userId: string, entry: RecentEntry): void {
        const list = this.recentMessages.get(userId);
        if (list) list.push(entry);
        else this.recentMessages.set(userId, [entry]);
    }

    /**
     * Global, throttled prune of recent-message history. Per-message pruning only
     * touches the active user, so entries for users who go quiet would otherwise
     * linger forever; this drops out-of-window entries across all users.
     */
    private sweepRecent(now: number, windowSeconds: number): void {
        if (now - this.lastSweep < SWEEP_INTERVAL_SECONDS) return;
        this.lastSweep = now;
        for (const [userId, entries] of this.recentMessages) {
            const kept = entries.filter(e => now - e.timestamp <= windowSeconds);
            if (kept.length) this.recentMessages.set(userId, kept);
            else this.recentMessages.delete(userId);
        }
        this.sweepWarnings(now);
    }

    /**
     * Drop stale warning bookkeeping. These maps are otherwise only cleaned when
     * a linked message is deleted (messageDelete) — not guaranteed (bot offline,
     * uncached, never deleted) — so without this they leak over uptime.
     */
    private sweepWarnings(now: number): void {
        for (const [key, entries] of this.warningMessages) {
            const kept = entries.filter(e => now - e.createdAt <= WARNING_RETENTION_SECONDS);
            if (kept.length) this.warningMessages.set(key, kept);
            else this.warningMessages.delete(key);
        }
        for (const [key, entries] of this.sourceWarningMessages) {
            const kept = entries.filter(e => now - e.createdAt <= WARNING_RETENTION_SECONDS);
            if (kept.length) this.sourceWarningMessages.set(key, kept);
            else this.sourceWarningMessages.delete(key);
        }
        for (const [userId, channelMap] of this.spamWarnings) {
            for (const [channelId, warnedAt] of channelMap) {
                if (now - warnedAt > WARNING_RETENTION_SECONDS) channelMap.delete(channelId);
            }
            if (channelMap.size === 0) this.spamWarnings.delete(userId);
        }
    }

    async process(message: Message): Promise<void> {
        if (message.author.bot) return;
        const s = this.settings();
        if (!s.enabled) return;
        // Thread-aware: a message in a thread carries the thread's own id, so the
        // bare include would miss threads under an ignored channel (matches the
        // moderation blacklist behavior).
        if (channelOrParentListed(message.channel, message.channelId, s.ignoredChannels)) return;

        // Staff + whitelist exemption; null = member unresolvable, fail closed.
        if ((await messageAuthorHasExemptRole(message, this.client.config, s.whitelistedRoleIds)) !== false) return;

        const attachmentFingerprint = this.attachmentFingerprint(message);
        const hasText = message.content.trim().length > 0;
        if (!hasText && !attachmentFingerprint) return;

        this.metrics.messagesProcessed++;
        const now = Date.now() / 1000;
        this.sweepRecent(now, s.windowSeconds);
        const userId = message.author.id;
        const channelId = message.channelId;
        const fp = this.engine.fingerprint(message.content, attachmentFingerprint);

        const pruned = (this.recentMessages.get(userId) ?? []).filter(e => now - e.timestamp <= s.windowSeconds);
        this.recentMessages.set(userId, pruned);

        // Reset burst offense counts after 24h.
        for (const [uid, info] of this.burstCooldowns) {
            if (now - info.handledAt > OFFENSE_RESET_SECONDS) this.burstCooldowns.delete(uid);
        }

        // Burst spam (mass crossposting) takes priority.
        const allMatching = this.getMatchingEntries(pruned, channelId, fp, s);
        if (allMatching.length) {
            const channels = new Set(allMatching.map(m => m.entry.channelId));
            channels.add(channelId);
            if (channels.size > s.burstChannelThreshold) {
                const handled = await this.handleBurstSpam(
                    message,
                    allMatching.map(m => m.entry),
                    s,
                );
                if (handled) {
                    // In dry-run the message still exists, so keep tracking it.
                    // In enforcement mode it was just deleted and the history
                    // cleared — re-inserting it would leave a ghost entry that
                    // later matches (and links to) a nonexistent message.
                    if (s.dryRun) {
                        this.pushEntry(userId, { channelId, fingerprint: fp, timestamp: now, messageId: message.id });
                    }
                    return;
                }
            }
        }

        // Normal detection: first matching entry in another channel wins.
        // getMatchingEntries already scanned `pruned` in order with the same
        // skip/match rules, so allMatching[0] is exactly the entry the per-entry
        // scan would have stopped on — reuse it instead of comparing every entry
        // a second time (the comparison is the pipeline's heaviest op).
        let matchedEntry: RecentEntry | null = null;
        let isExact = false;
        let isUpdate = false;
        const firstMatch = allMatching[0];
        if (firstMatch) {
            matchedEntry = firstMatch.entry;
            const entryFp = firstMatch.entry.fingerprint;
            const isAttachmentMatch =
                !!attachmentFingerprint &&
                !!entryFp.attachmentFingerprint &&
                attachmentFingerprint === entryFp.attachmentFingerprint;
            const isIdentical = !!fp.content && !!entryFp.content && fp.content === entryFp.content;
            isExact = isIdentical || isAttachmentMatch;

            // Reuse the comparison getMatchingEntries already computed for the
            // similarity path; only the attachment/exact short-circuits lack one.
            const c: Comparison =
                isAttachmentMatch && !fp.content
                    ? { sequenceRatio: 1, jaccard: 1, charCosine: 1, confidence: 1, lengthRatio: 1, newContentRatio: 0 }
                    : (firstMatch.comparison ?? this.engine.compare(fp, entryFp));

            if (isExact) {
                this.metrics.exactMatches++;
            } else {
                this.metrics.similarityMatches++;
                if (c.sequenceRatio >= s.sequenceRatioThreshold) this.metrics.seqTriggered++;
                if (c.charCosine >= s.charCosineThreshold) this.metrics.charTriggered++;
                if (c.jaccard >= s.jaccardThreshold) this.metrics.jacTriggered++;
            }

            // Directional expansion test: an "update" is the CURRENT message being
            // a longer elaboration of the prior one. c.lengthRatio is symmetric
            // (max/min), so it fires even when the current message is SHORTER —
            // letting a shorter reworded crosspost suppress enforcement. Compare
            // current-vs-prior length directly so only a genuine expansion counts.
            const expandedRatio = fp.normalized.length / Math.max(1, entryFp.normalized.length);
            isUpdate =
                !isIdentical && c.newContentRatio >= s.newContentRatioThreshold && expandedRatio >= UPDATE_LENGTH_RATIO;
            if (isUpdate) this.metrics.updatesDetected++;
        }

        if (matchedEntry) {
            const lastWarn = this.spamWarnings.get(userId)?.get(channelId);
            if (lastWarn !== undefined && now - lastWarn < WARNING_COOLDOWN_SECONDS) {
                this.metrics.warningsSuppressed++;
                this.pushEntry(userId, { channelId, fingerprint: fp, timestamp: now, messageId: message.id });
                return;
            }

            const shouldWarn = isExact || (!s.dryRun && !isUpdate);
            if (shouldWarn) {
                try {
                    const link = this.messageLink(message.guildId, matchedEntry.channelId, matchedEntry.messageId);
                    const container = new ContainerBuilder()
                        .setAccentColor(AccentColor.Yellow)
                        .addTextDisplayComponents(
                            new TextDisplayBuilder().setContent("## Cross-Channel Spam Warning"),
                            new TextDisplayBuilder().setContent(
                                `Hey ${message.author}, I noticed you sent the same message in multiple channels. ` +
                                    "Please keep discussions to one channel to avoid confusion.\n\n" +
                                    `[Click here to view the original message](${link})`,
                            ),
                        );
                    const warningMsg = await (message.channel as TextChannel).send({
                        components: [container],
                        flags: MessageFlags.IsComponentsV2,
                        allowedMentions: { parse: [] },
                    });
                    this.metrics.warningsSent++;
                    this.storeWarningEntry(message.id, matchedEntry.messageId, warningMsg, channelId, userId, now);
                    if (!this.spamWarnings.has(userId)) this.spamWarnings.set(userId, new Map());
                    this.spamWarnings.get(userId)!.set(channelId, now);
                } catch (error) {
                    console.error("Failed to send cross-channel spam warning:", error);
                }
            }
        }

        this.pushEntry(userId, { channelId, fingerprint: fp, timestamp: now, messageId: message.id });
    }

    private getMatchingEntries(
        recent: RecentEntry[],
        channelId: string,
        fp: Fingerprint,
        s: CrosspostSettings,
    ): MatchedEntry[] {
        const matching: MatchedEntry[] = [];
        for (const entry of recent) {
            if (entry.channelId === channelId) continue;
            const entryFp = entry.fingerprint;

            if (
                fp.attachmentFingerprint &&
                entryFp.attachmentFingerprint &&
                fp.attachmentFingerprint === entryFp.attachmentFingerprint
            ) {
                matching.push({ entry });
                continue;
            }
            if (!fp.content || !entryFp.content) continue;
            if (fp.content === entryFp.content) {
                matching.push({ entry });
                continue;
            }

            // Retain the comparison so the normal-detection path can reuse it
            // instead of recomputing this (the pipeline's heaviest op) on the winner.
            const c = this.engine.compare(fp, entryFp);
            if (this.engine.meetsSimilarityThresholds(fp, entryFp, c, s)) matching.push({ entry, comparison: c });
        }
        return matching;
    }

    private async handleBurstSpam(message: Message, matched: RecentEntry[], s: CrosspostSettings): Promise<boolean> {
        const userId = message.author.id;
        const now = Date.now() / 1000;
        const channels = new Set(matched.map(e => e.channelId));
        channels.add(message.channelId);
        if (channels.size <= s.burstChannelThreshold) return false;

        // Concurrent messages of the same burst reach here before the first has
        // recorded its cooldown (all the state below is set only after awaits).
        // Bail synchronously — just delete and count it as handled — so we don't
        // fire duplicate mod alerts or race two kicks on a repeat offender.
        if (this.burstInFlight.has(userId)) {
            if (!s.dryRun) {
                const clearDeleteMarker = markInternalMessageDelete(this.client, message.id, "crosspost burst cleanup");
                await message.delete().catch(() => clearDeleteMarker());
            }
            return true;
        }
        this.burstInFlight.add(userId);
        try {
            const existing = this.burstCooldowns.get(userId);
            if (existing && now - existing.handledAt < BURST_INCIDENT_COOLDOWN_SECONDS) {
                if (!s.dryRun) {
                    const clearDeleteMarker = markInternalMessageDelete(
                        this.client,
                        message.id,
                        "crosspost burst cooldown cleanup",
                    );
                    await message.delete().catch(() => clearDeleteMarker());
                }
                return true;
            }

            this.metrics.burstSpamDetected++;

            if (s.dryRun) {
                console.info(
                    `[DRY RUN] Burst spam: user=${userId} channels=${channels.size} would_delete=${matched.length + 1} would_timeout=${s.burstTimeoutMinutes}min`,
                );
                // Record the incident (without escalating the offense count) so the
                // cooldown above groups the rest of the burst into one incident —
                // otherwise the metric counts every message of a burst and the
                // dry-run numbers used for threshold tuning overstate incidents.
                this.burstCooldowns.set(userId, { handledAt: now, offenseCount: existing?.offenseCount ?? 0 });
                return true;
            }

            // 1. Delete all crossposted messages (matched + current).
            let deleted = 0;
            for (const entry of matched) {
                if (await deleteMessageById(this.client, entry.channelId, entry.messageId)) deleted++;
            }
            const clearDeleteMarker = markInternalMessageDelete(this.client, message.id, "crosspost burst enforcement");
            if (
                await message
                    .delete()
                    .then(() => true)
                    .catch(() => {
                        clearDeleteMarker();
                        return false;
                    })
            )
                deleted++;

            // 2. Escalate: first offense → timeout, repeat → kick. Fetch the member
            //    when uncached (mirrors the whitelist path) — a cache miss during a
            //    real burst must not reduce enforcement to delete-only.
            const offenseCount = (existing?.offenseCount ?? 0) + 1;
            const member = message.member ?? (await message.guild?.members.fetch(userId).catch(() => null)) ?? null;
            let action: ActionResult;
            if (offenseCount >= 2) {
                action = member
                    ? await kickMember(member, "Repeat cross-channel spam")
                    : { ok: false, detail: "Kick failed - member not cached" };
            } else {
                action = member
                    ? await timeoutMember(member, s.burstTimeoutMinutes, "Cross-channel spam")
                    : { ok: false, detail: "Timeout failed - member not cached" };
            }

            // 3. Alert moderators (fall back to the general alert channel if no
            //    dedicated burst-alert channel is configured).
            const alertChannelId = s.burstAlertChannelId ?? this.client.config.moderation?.alert_channel_id;
            if (alertChannelId) {
                const container = new ContainerBuilder().setAccentColor(AccentColor.Red).addTextDisplayComponents(
                    new TextDisplayBuilder().setContent("## Crosspost Spam Detected"),
                    new TextDisplayBuilder().setContent(
                        renderFields([
                            { name: "User", value: `${message.author} (${userId})` },
                            { name: "Channels", value: String(channels.size) },
                            { name: "Messages Deleted", value: String(deleted) },
                            { name: "Offense #", value: String(offenseCount) },
                            { name: "Action Taken", value: `Messages deleted, ${action.detail}` },
                        ]),
                    ),
                );
                await sendModAlert(this.client, alertChannelId, container);
            }

            // 4. Track incident and clear recent history to avoid re-processing deleted messages.
            this.burstCooldowns.set(userId, { handledAt: now, offenseCount });
            this.recentMessages.set(userId, []);
            return true;
        } finally {
            this.burstInFlight.delete(userId);
        }
    }

    private storeWarningEntry(
        duplicateMessageId: string,
        sourceMessageId: string,
        warningMessage: Message,
        warningChannelId: string,
        userId: string,
        createdAt: number,
    ): void {
        const entry: WarningEntry = {
            warningMessage,
            warningChannelId,
            duplicateMessageId,
            sourceMessageId,
            userId,
            createdAt,
        };
        this.warningMessages.set(duplicateMessageId, [...(this.warningMessages.get(duplicateMessageId) ?? []), entry]);
        this.sourceWarningMessages.set(sourceMessageId, [
            ...(this.sourceWarningMessages.get(sourceMessageId) ?? []),
            entry,
        ]);
    }

    private removeWarningEntry(entry: WarningEntry): void {
        for (const [store, key] of [
            [this.warningMessages, entry.duplicateMessageId],
            [this.sourceWarningMessages, entry.sourceMessageId],
        ] as const) {
            const entries = store.get(key);
            if (!entries) continue;
            const filtered = entries.filter(stored => stored !== entry);
            if (filtered.length) store.set(key, filtered);
            else store.delete(key);
        }
    }

    private clearWarningCooldown(userId: string, channelId: string): void {
        const userWarnings = this.spamWarnings.get(userId);
        if (!userWarnings || !userWarnings.has(channelId)) return;
        userWarnings.delete(channelId);
        if (userWarnings.size === 0) this.spamWarnings.delete(userId);
    }

    /** Remove warning messages (and reset cooldowns) when a linked message is deleted. */
    async handleMessageDeletion(message: Message | PartialMessage): Promise<void> {
        const userId = message.author?.id ?? null;
        const collected = [
            ...(this.warningMessages.get(message.id) ?? []),
            ...(this.sourceWarningMessages.get(message.id) ?? []),
        ];

        const seen = new Set<string>();
        for (const entry of collected) {
            if (seen.has(entry.warningMessage.id)) continue;
            seen.add(entry.warningMessage.id);
            this.removeWarningEntry(entry);
            this.clearWarningCooldown(entry.userId, entry.warningChannelId);
            await entry.warningMessage.delete().catch(() => undefined);
        }

        if (userId) {
            const recent = this.recentMessages.get(userId);
            if (recent) {
                const filtered = recent.filter(entry => entry.messageId !== message.id);
                if (filtered.length) this.recentMessages.set(userId, filtered);
                else this.recentMessages.delete(userId);
            }
        } else {
            // Partial (uncached) deletions carry no author — fall back to a scan
            // so a deleted-then-reposted message doesn't trigger a stale warning.
            for (const [uid, recent] of this.recentMessages) {
                if (!recent.some(entry => entry.messageId === message.id)) continue;
                const filtered = recent.filter(entry => entry.messageId !== message.id);
                if (filtered.length) this.recentMessages.set(uid, filtered);
                else this.recentMessages.delete(uid);
                break;
            }
        }
    }
}
