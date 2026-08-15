import { randomBytes } from "crypto";
import {
    AttachmentBuilder,
    AuditLogEvent,
    ContainerBuilder,
    FileBuilder,
    Guild,
    GuildAuditLogsEntry,
    MediaGalleryBuilder,
    Message,
    MessageCreateOptions,
    MessageFlags,
    PartialMessage,
    ReadonlyCollection,
    TextDisplayBuilder,
} from "discord.js";
import { KrytenClient } from "../../classes/client";
import { LoggingConfig } from "../../types";
import { channelOrParentListed } from "../../utils/channels";
import { keyFromEnv } from "../../utils/encryptedJson";
import { ellipsize } from "../../utils/format";
import { buildImageGalleryFromCandidates, collectImageCandidates } from "../../utils/imageGallery";
import { AccentColor, CV2_MEDIA_GALLERY_ITEM_BUDGET, CV2_TEXT_BUDGET } from "../../utils/cv2";
import { DeleteAttribution, MessageLogEvent, MessageLoggingMetrics, MessageSnapshot, StoredOutboxEvent } from "./types";
import { MessageLogStore, OUTBOX_CAP, OUTBOX_FIRST_ATTEMPT_MS } from "./store";

const DEFAULT_DB_PATH = "./data/message_logging.db";
const DEFAULT_KEY_ENV = "MESSAGE_LOG_ENCRYPTION_KEY";
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_SNAPSHOTS = 100_000;
const AUDIT_TTL_MS = 10_000;
const AUDIT_MATCH_MS = 5_000;
// Exponential backoff caps out at an hour, so ten attempts span ~85 minutes
// before an event is written off rather than left blocking the outbox head.
const MAX_DELIVERY_ATTEMPTS = 10;
// How recent `edited_timestamp` must be to read as "this update was the edit"
// when there is no stored snapshot to diff against.
const EDIT_STAMP_WINDOW_MS = 60_000;
const EDIT_EXCERPT_CHARS = 1_100;
const DELETE_EXCERPT_CHARS = 2_200;

interface RecentAuditEntry {
    action: AuditLogEvent;
    guildId: string;
    channelId?: string;
    targetId?: string;
    count?: number;
    actorId?: string;
    actorLabel?: string;
    reason?: string;
    createdAtMs: number;
}

interface InternalDelete {
    actorId?: string;
    reason: string;
    expiresAtMs: number;
}

const activeLoggers = new WeakMap<KrytenClient, MessageLogger>();

export function markInternalMessageDelete(client: KrytenClient, messageId: string, reason: string): () => void {
    const logger = activeLoggers.get(client);
    logger?.markInternalDelete(messageId, reason);
    return () => logger?.clearInternalDelete(messageId, reason);
}

function eventId(): string {
    return randomBytes(12).toString("hex");
}

function attachmentKey(snapshot: MessageSnapshot): string {
    return JSON.stringify(snapshot.attachments.map(a => [a.id, a.name, a.contentType, a.size]));
}

function snapshotFromMessage(message: Message): MessageSnapshot {
    const channel = message.channel;
    const parent = channel.isThread() ? channel.parent : null;
    return {
        version: 1,
        messageId: message.id,
        guildId: message.guildId!,
        channelId: message.channelId,
        ...(channel.isThread()
            ? { channelName: channel.name }
            : "name" in channel && typeof channel.name === "string"
              ? { channelName: channel.name }
              : {}),
        ...(parent ? { parentChannelId: parent.id, parentChannelName: parent.name } : {}),
        authorId: message.author.id,
        authorLabel: message.author.tag,
        createdAtMs: message.createdTimestamp,
        ...(message.editedTimestamp ? { editedAtMs: message.editedTimestamp } : {}),
        content: message.content,
        attachments: [...message.attachments.values()].map(attachment => ({
            id: attachment.id,
            name: attachment.name,
            ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
            size: attachment.size,
            url: attachment.url,
            proxyUrl: attachment.proxyURL,
        })),
        imageUrls: collectImageCandidates(message).map(candidate => candidate.url),
        jumpUrl: message.url,
    };
}

function escapeCodeBlock(value: string): string {
    return value.replace(/```/gu, "``\u200b`");
}

function location(snapshot: MessageSnapshot): string {
    const names = snapshot.parentChannelName
        ? `#${snapshot.parentChannelName} / ${snapshot.channelName ?? snapshot.channelId}`
        : `#${snapshot.channelName ?? snapshot.channelId}`;
    return `${names} (${snapshot.channelId})`;
}

function evidenceFile(name: string, value: string): AttachmentBuilder {
    return new AttachmentBuilder(Buffer.from(value || "[empty message content]", "utf8"), { name });
}

function attachmentSummary(snapshot: MessageSnapshot): string {
    return (
        snapshot.attachments
            .map(
                attachment =>
                    `${attachment.name} [${attachment.id}] (${attachment.contentType ?? "unknown type"}, ${attachment.size} bytes)`,
            )
            .join(", ") || "none"
    );
}

export class MessageLogger {
    private store: MessageLogStore | null = null;
    private worker: NodeJS.Timeout | null = null;
    private sweepTimer: NodeJS.Timeout | null = null;
    private inFlight: Promise<boolean> | null = null;
    private deliveryOutage = false;
    private reportedDrops = 0;
    private recentAudit: RecentAuditEntry[] = [];
    private readonly internalDeletes = new Map<string, InternalDelete>();
    private readonly awaitingAttribution = new Map<string, { event: MessageLogEvent; resolveAtMs: number }>();
    private readonly resolvedAttribution = new Map<string, DeleteAttribution>();
    private readonly metrics: Omit<MessageLoggingMetrics, "snapshots" | "pending"> = {
        captured: 0,
        editsQueued: 0,
        deletesQueued: 0,
        bulkDeletesQueued: 0,
        sent: 0,
        retries: 0,
        sendFailures: 0,
        storeErrors: 0,
        dropped: 0,
        unattributed: 0,
    };

    constructor(private readonly client: KrytenClient) {
        activeLoggers.set(client, this);
    }

    async initialize(): Promise<void> {
        await this.reconfigure();
    }

    async reconfigure(previous?: LoggingConfig): Promise<void> {
        const config = this.client.config.logging;
        if (!config || !(config.enabled ?? false)) {
            this.stop();
            while (this.inFlight) await this.inFlight.catch(() => undefined);
            this.store?.close();
            this.store = null;
            this.reportedDrops = 0;
            return;
        }
        const dbPath = config.db_path ?? DEFAULT_DB_PATH;
        const keyEnv = config.encryption_key_env ?? DEFAULT_KEY_ENV;
        if (this.store && previous?.enabled) {
            const previousPath = previous.db_path ?? DEFAULT_DB_PATH;
            const previousKeyEnv = previous.encryption_key_env ?? DEFAULT_KEY_ENV;
            if (dbPath !== previousPath || keyEnv !== previousKeyEnv) {
                throw new Error("logging.db_path and logging.encryption_key_env changes require a restart");
            }
            this.store.reconfigure(this.retentionMs(config), config.max_snapshots ?? DEFAULT_MAX_SNAPSHOTS);
        } else if (!this.store) {
            this.store = new MessageLogStore(
                dbPath,
                keyFromEnv(keyEnv),
                this.retentionMs(config),
                config.max_snapshots ?? DEFAULT_MAX_SNAPSHOTS,
            );
            this.reportedDrops = 0;
        }
        this.startTimers();
    }

    private retentionMs(config: LoggingConfig): number {
        return (config.retention_days ?? DEFAULT_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
    }

    private startTimers(): void {
        if (!this.worker) {
            this.worker = setInterval(() => {
                this.resolveDueAttributions();
                this.reportDrops();
                void this.deliverNext();
            }, 1_000);
            this.worker.unref();
        }
        if (!this.sweepTimer) {
            this.sweepTimer = setInterval(() => this.safeStore(() => this.store?.sweep()), 60 * 60 * 1000);
            this.sweepTimer.unref();
        }
    }

    stop(): void {
        if (this.worker) clearInterval(this.worker);
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        this.worker = null;
        this.sweepTimer = null;
    }

    async drain(): Promise<void> {
        // A worker tick can still be mid-send when shutdown calls this. Await it
        // first: a clean return here is what licenses close() to shut the SQLite
        // handle, and doing that under a live send is exactly what must not happen.
        while (this.inFlight) await this.inFlight.catch(() => undefined);
        // Resolve everything still queued so the drained cards keep their
        // attribution instead of shipping as "unknown".
        this.resolveDueAttributions(Number.MAX_SAFE_INTEGER);
        while (this.store?.pendingCount()) {
            const delivered = await this.deliverNext(true);
            if (!delivered) break;
        }
    }

    close(): void {
        this.stop();
        this.store?.close();
        this.store = null;
        this.reportedDrops = 0;
    }

    getMetrics(): MessageLoggingMetrics {
        return {
            ...this.metrics,
            dropped: this.metrics.dropped + (this.store?.droppedCount() ?? 0),
            snapshots: this.store?.snapshotCount() ?? 0,
            pending: this.store?.pendingCount() ?? 0,
        };
    }

    isEnabled(): boolean {
        return !!this.store && (this.client.config.logging?.enabled ?? false);
    }

    private ignoredIds(): string[] {
        const config = this.client.config.logging;
        return [
            ...(this.client.config.moderation?.channel_blacklist ?? []),
            ...(config?.ignored_channel_ids ?? []),
            ...(config?.default_channel_id ? [config.default_channel_id] : []),
            ...(config?.message_channel_id ? [config.message_channel_id] : []),
        ];
    }

    private excluded(message: Message | PartialMessage): boolean {
        const config = this.client.config.logging;
        if (!this.isEnabled() || !config?.guild_id || message.guildId !== config.guild_id) return true;
        return channelOrParentListed(message.channel, message.channelId, this.ignoredIds());
    }

    private snapshotExcluded(snapshot: MessageSnapshot): boolean {
        if (snapshot.guildId !== this.client.config.logging?.guild_id) return true;
        const ignored = this.ignoredIds();
        return (
            ignored.includes(snapshot.channelId) ||
            (!!snapshot.parentChannelId && ignored.includes(snapshot.parentChannelId))
        );
    }

    async capture(message: Message): Promise<void> {
        if (this.excluded(message) || message.author.bot || message.webhookId || message.system) return;
        this.safeStore(() => this.store!.saveSnapshot(snapshotFromMessage(message)));
        this.metrics.captured++;
    }

    async captureEdit(oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage): Promise<void> {
        if (this.excluded(newMessage)) return;
        let full: Message;
        try {
            full = newMessage.partial ? await newMessage.fetch() : newMessage;
        } catch {
            return;
        }
        if (full.author.bot || full.webhookId || full.system) return;
        const after = snapshotFromMessage(full);
        const before =
            this.store?.getSnapshot(full.id) ?? (!oldMessage.partial ? snapshotFromMessage(oldMessage) : null);
        if (before && before.content === after.content && attachmentKey(before) === attachmentKey(after)) {
            this.safeStore(() => this.store!.saveSnapshot(after));
            return;
        }
        // messageUpdate also fires for pins, embed resolution and flag changes.
        // With no snapshot to diff against there is nothing to compare, so fall
        // back to edited_timestamp: only a real content edit stamps it, and only
        // this update's own edit stamps it recently.
        if (!before && (!full.editedTimestamp || Date.now() - full.editedTimestamp > EDIT_STAMP_WINDOW_MS)) {
            this.safeStore(() => this.store!.saveSnapshot(after));
            return;
        }
        const event: MessageLogEvent = {
            version: 1,
            eventId: eventId(),
            kind: "edit",
            occurredAtMs: Date.now(),
            ...(before ? { before } : {}),
            after,
        };
        this.safeStore(() => this.store!.commitEvent(event, after, []));
        this.metrics.editsQueued++;
    }

    async captureDelete(message: Message | PartialMessage): Promise<void> {
        if (this.excluded(message)) return;
        if (!message.partial && (message.author.bot || message.webhookId || message.system)) return;
        const snapshot =
            this.store?.getSnapshot(message.id) ?? (!message.partial ? snapshotFromMessage(message) : null);
        if (!snapshot || this.snapshotExcluded(snapshot) || snapshot.authorId === this.client.user?.id) return;
        const event: MessageLogEvent = {
            version: 1,
            eventId: eventId(),
            kind: "delete",
            occurredAtMs: Date.now(),
            snapshot,
        };
        this.safeStore(() => this.store!.commitEvent(event, null, [message.id]));
        this.queueAttribution(event);
        this.metrics.deletesQueued++;
    }

    async captureBulk(messages: ReadonlyCollection<string, Message | PartialMessage>): Promise<void> {
        const first = messages.first();
        if (!first || this.excluded(first)) return;
        const snapshots: MessageSnapshot[] = [];
        const missingMessageIds: string[] = [];
        for (const message of messages.values()) {
            const stored = this.store?.getSnapshot(message.id);
            if (stored) {
                if (!this.snapshotExcluded(stored) && stored.authorId !== this.client.user?.id) snapshots.push(stored);
                continue;
            }
            if (!message.partial) {
                if (message.author.bot || message.webhookId || message.system) continue;
                snapshots.push(snapshotFromMessage(message));
            } else if (!message.author?.bot) {
                // A partial almost never carries an author, so anything we can't
                // positively identify as a bot is counted: the total has to match
                // the audit entry's `count` for the purge to be attributable.
                missingMessageIds.push(message.id);
            }
        }
        if (snapshots.length === 0 && missingMessageIds.length === 0) return;
        const event: MessageLogEvent = {
            version: 1,
            eventId: eventId(),
            kind: "bulk-delete",
            occurredAtMs: Date.now(),
            guildId: first.guildId!,
            channelId: first.channelId,
            snapshots,
            missingMessageIds,
        };
        this.safeStore(() => this.store!.commitEvent(event, null, [...messages.keys()]));
        this.queueAttribution(event);
        this.metrics.bulkDeletesQueued++;
    }

    recordAudit(entry: GuildAuditLogsEntry, guild: Guild): void {
        if (!this.isEnabled() || guild.id !== this.client.config.logging?.guild_id) return;
        if (entry.action !== AuditLogEvent.MessageDelete && entry.action !== AuditLogEvent.MessageBulkDelete) return;
        const extra = entry.extra as { channel?: { id?: string }; count?: number } | null;
        // The two actions carry the channel in different places: MessageDelete
        // targets the author and names the channel in `extra`, MessageBulkDelete
        // targets the channel itself and puts only `count` in `extra`.
        const channelId = entry.action === AuditLogEvent.MessageBulkDelete ? entry.targetId : extra?.channel?.id;
        this.recentAudit.push({
            action: entry.action,
            guildId: guild.id,
            ...(channelId ? { channelId } : {}),
            ...(entry.targetId ? { targetId: entry.targetId } : {}),
            ...(extra?.count ? { count: extra.count } : {}),
            ...(entry.executorId ? { actorId: entry.executorId } : {}),
            ...(entry.executor?.tag ? { actorLabel: entry.executor.tag } : {}),
            ...(entry.reason ? { reason: entry.reason } : {}),
            createdAtMs: entry.createdTimestamp,
        });
        this.pruneAttribution();
    }

    markInternalDelete(messageId: string, reason: string): void {
        if (!this.isEnabled()) return;
        this.pruneAttribution();
        this.internalDeletes.set(messageId, {
            ...(this.client.user?.id ? { actorId: this.client.user.id } : {}),
            reason,
            expiresAtMs: Date.now() + AUDIT_TTL_MS,
        });
    }

    clearInternalDelete(messageId: string, reason: string): void {
        const marker = this.internalDeletes.get(messageId);
        if (marker?.reason === reason) this.internalDeletes.delete(messageId);
    }

    private queueAttribution(event: MessageLogEvent): void {
        this.awaitingAttribution.set(event.eventId, { event, resolveAtMs: Date.now() + OUTBOX_FIRST_ATTEMPT_MS });
    }

    /**
     * Attribution reads two volatile sources — the audit-log feed and the
     * internal-delete markers — that both expire after AUDIT_TTL_MS, while the
     * outbox ships one event per second. Resolving at delivery time would leave
     * anything past the tenth message of a purge unattributable, so every queued
     * event is resolved once on the same schedule as its first delivery attempt
     * and the verdict is held until it ships.
     */
    private resolveDueAttributions(now = Date.now()): void {
        for (const [id, pending] of this.awaitingAttribution) {
            if (pending.resolveAtMs > now) continue;
            this.awaitingAttribution.delete(id);
            const resolved = this.attribution(pending.event);
            if (resolved) this.resolvedAttribution.set(id, resolved);
        }
        // Verdicts are consumed on delivery; during an outage they accumulate
        // alongside the outbox, so they inherit its cap.
        while (this.resolvedAttribution.size > OUTBOX_CAP) {
            const oldest = this.resolvedAttribution.keys().next();
            if (oldest.done) break;
            this.resolvedAttribution.delete(oldest.value);
        }
    }

    /**
     * Non-consuming: a failed send is retried for up to ~85 minutes, long after
     * a re-derived verdict would have decayed to "unknown". The entry is dropped
     * only once the event leaves the outbox.
     */
    private attributionFor(event: MessageLogEvent): DeleteAttribution | null {
        const resolved = this.resolvedAttribution.get(event.eventId);
        if (resolved) return resolved;
        // No verdict yet: an event restored from the outbox across a restart,
        // where the volatile sources are gone and "unknown" is the honest answer.
        this.awaitingAttribution.delete(event.eventId);
        const verdict = this.attribution(event);
        if (verdict) this.resolvedAttribution.set(event.eventId, verdict);
        return verdict;
    }

    private attribution(event: MessageLogEvent): DeleteAttribution | null {
        if (event.kind === "edit") return null;
        this.pruneAttribution();
        if (event.kind === "delete") {
            const internal = this.internalDeletes.get(event.snapshot.messageId);
            if (internal) {
                return {
                    kind: "internal",
                    ...(internal.actorId ? { actorId: internal.actorId } : {}),
                    reason: internal.reason,
                };
            }
        }
        const guildId = event.kind === "delete" ? event.snapshot.guildId : event.guildId;
        const channelId = event.kind === "delete" ? event.snapshot.channelId : event.channelId;
        const matches = this.recentAudit.filter(candidate => {
            if (candidate.guildId !== guildId || candidate.channelId !== channelId) return false;
            if (Math.abs(candidate.createdAtMs - event.occurredAtMs) > AUDIT_MATCH_MS) return false;
            if (event.kind === "delete") {
                return (
                    candidate.action === AuditLogEvent.MessageDelete && candidate.targetId === event.snapshot.authorId
                );
            }
            return (
                candidate.action === AuditLogEvent.MessageBulkDelete &&
                candidate.count === event.snapshots.length + event.missingMessageIds.length
            );
        });
        if (matches.length !== 1) {
            this.metrics.unattributed++;
            return { kind: "unknown" };
        }
        const match = matches[0]!;
        return {
            kind: "moderator",
            ...(match.actorId ? { actorId: match.actorId } : {}),
            ...(match.actorLabel ? { actorLabel: match.actorLabel } : {}),
            ...(match.reason ? { reason: match.reason } : {}),
        };
    }

    private pruneAttribution(): void {
        const cutoff = Date.now() - AUDIT_TTL_MS;
        this.recentAudit = this.recentAudit.filter(entry => entry.createdAtMs >= cutoff);
        for (const [id, marker] of this.internalDeletes) {
            if (marker.expiresAtMs <= Date.now()) this.internalDeletes.delete(id);
        }
    }

    private async deliverNext(force = false): Promise<boolean> {
        if (this.inFlight) return false;
        const store = this.store;
        if (!store) return false;
        const stored = store.nextDue(force ? Number.MAX_SAFE_INTEGER : Date.now());
        if (!stored) return false;
        const attempt = this.deliver(store, stored);
        this.inFlight = attempt;
        try {
            return await attempt;
        } finally {
            this.inFlight = null;
        }
    }

    /** `store` stays stable for the whole attempt, including its bookkeeping. */
    private async deliver(store: MessageLogStore, stored: StoredOutboxEvent): Promise<boolean> {
        const { eventId: id } = stored.event;
        try {
            await this.send(stored.event, this.attributionFor(stored.event));
            this.safeStore(() => store.markSent(id));
            this.resolvedAttribution.delete(id);
            this.metrics.sent++;
            this.deliveryOutage = false;
            return true;
        } catch (error) {
            this.metrics.sendFailures++;
            const attempts = stored.attempts + 1;
            if (attempts >= MAX_DELIVERY_ATTEMPTS) {
                // Nothing has worked in ~85 minutes of backoff; leaving the event
                // at the head of the outbox would stall everything behind it.
                this.safeStore(() => store.markSent(id));
                this.resolvedAttribution.delete(id);
                this.metrics.dropped++;
                await this.client
                    .logError(
                        `Message logging discarded event ${id} after ${attempts} delivery attempts`,
                        error instanceof Error ? error : String(error),
                    )
                    .catch(() => undefined);
                return false;
            }
            const delay = Math.min(60 * 60 * 1000, 5_000 * 2 ** Math.min(attempts - 1, 10));
            this.safeStore(() => store.retry(id, attempts, Date.now() + delay + Math.floor(Math.random() * 1_000)));
            this.metrics.retries++;
            if (!this.deliveryOutage) {
                this.deliveryOutage = true;
                await this.client
                    .logError("Message logging delivery failed", error instanceof Error ? error : String(error))
                    .catch(() => undefined);
            }
            return false;
        }
    }

    /** Edge-triggered alert for outbox overflow, which is otherwise silent data loss. */
    private reportDrops(): void {
        const dropped = this.store?.droppedCount() ?? 0;
        if (dropped <= this.reportedDrops) return;
        const lost = dropped - this.reportedDrops;
        this.reportedDrops = dropped;
        void this.client
            .logError(
                "Message logging outbox overflowed",
                `${lost} undelivered event(s) were discarded to stay under the ${OUTBOX_CAP}-event cap`,
            )
            .catch(() => undefined);
    }

    private async send(event: MessageLogEvent, attribution: DeleteAttribution | null): Promise<void> {
        const config = this.client.config.logging!;
        const eventGuildId =
            event.kind === "edit"
                ? event.after.guildId
                : event.kind === "delete"
                  ? event.snapshot.guildId
                  : event.guildId;
        if (!config.guild_id || eventGuildId !== config.guild_id) {
            throw new Error(
                `Message logging event belongs to guild ${eventGuildId}, not configured guild ${config.guild_id ?? "none"}`,
            );
        }
        const destinationId = config.message_channel_id ?? config.default_channel_id;
        if (!destinationId) throw new Error("No message logging destination is configured");
        const channel = await this.client.channels.fetch(destinationId);
        if (!channel?.isSendable() || !("guildId" in channel) || channel.guildId !== config.guild_id) {
            throw new Error("Message logging destination is missing, not sendable, or belongs to another guild");
        }
        try {
            await channel.send(await this.render(event, attribution, true));
        } catch (error) {
            if (!(config.rehost_images ?? true)) throw error;
            await channel.send(await this.render(event, attribution, false));
        }
    }

    private async render(
        event: MessageLogEvent,
        attribution: DeleteAttribution | null,
        includeImages: boolean,
    ): Promise<MessageCreateOptions> {
        const files: AttachmentBuilder[] = [];
        let body: string;
        let color: number;
        let images: string[] = [];
        if (event.kind === "edit") {
            color = AccentColor.Amber;
            const before = event.before?.content ?? "[previous content unavailable]";
            body = `## Message edited\n**Author** ${event.after.authorLabel} (${event.after.authorId})\n**Location** ${location(event.after)}\n**Message** ${event.after.messageId}\n**Time** <t:${Math.floor(event.occurredAtMs / 1000)}:F>\n**Jump** ${event.after.jumpUrl}\n\n**Before**\n\`\`\`\n${escapeCodeBlock(ellipsize(before || "[empty]", EDIT_EXCERPT_CHARS))}\n\`\`\`\n**After**\n\`\`\`\n${escapeCodeBlock(ellipsize(event.after.content || "[empty]", EDIT_EXCERPT_CHARS))}\n\`\`\``;
            const beforeAttachments = event.before ? attachmentSummary(event.before) : "unavailable";
            const afterAttachments = attachmentSummary(event.after);
            body += `\n**Attachments before** ${beforeAttachments}\n**Attachments after** ${afterAttachments}`;
            if (before.length > EDIT_EXCERPT_CHARS)
                files.push(evidenceFile(`message-${event.after.messageId}-before.txt`, before));
            if (event.after.content.length > EDIT_EXCERPT_CHARS) {
                files.push(evidenceFile(`message-${event.after.messageId}-after.txt`, event.after.content));
            }
            images = event.after.imageUrls;
        } else if (event.kind === "delete") {
            color = AccentColor.Red;
            const actor =
                attribution?.kind === "moderator"
                    ? `${attribution.actorLabel ?? "Moderator"}${attribution.actorId ? ` (${attribution.actorId})` : ""}`
                    : attribution?.kind === "internal"
                      ? `Kryten${attribution.reason ? ` — ${attribution.reason}` : ""}`
                      : "Author or unknown";
            body = `## Message deleted\n**Author** ${event.snapshot.authorLabel} (${event.snapshot.authorId})\n**Location** ${location(event.snapshot)}\n**Message** ${event.snapshot.messageId}\n**Deleted by** ${actor}\n**Time** <t:${Math.floor(event.occurredAtMs / 1000)}:F>\n\n**Content**\n\`\`\`\n${escapeCodeBlock(ellipsize(event.snapshot.content || "[empty]", DELETE_EXCERPT_CHARS))}\n\`\`\``;
            if (attribution?.reason) body += `\n**Reason** ${ellipsize(attribution.reason, 500)}`;
            const attachments = attachmentSummary(event.snapshot);
            body += `\n**Attachments** ${attachments}`;
            if (event.snapshot.content.length > DELETE_EXCERPT_CHARS) {
                files.push(evidenceFile(`message-${event.snapshot.messageId}-deleted.txt`, event.snapshot.content));
            }
            images = event.snapshot.imageUrls;
        } else {
            color = AccentColor.Red;
            const count = event.snapshots.length + event.missingMessageIds.length;
            const actor =
                attribution?.kind === "moderator"
                    ? `${attribution.actorLabel ?? "Moderator"}${attribution.actorId ? ` (${attribution.actorId})` : ""}`
                    : "Unknown";
            body = `## Bulk message deletion\n**Channel** ${event.channelId}\n**Messages** ${count}\n**Recovered** ${event.snapshots.length}\n**Deleted by** ${actor}\n**Time** <t:${Math.floor(event.occurredAtMs / 1000)}:F>\n\nA UTF-8 evidence manifest is attached.`;
            if (attribution?.reason) body += `\n**Reason** ${ellipsize(attribution.reason, 500)}`;
            const manifest = event.snapshots
                .map(snapshot =>
                    [
                        `MESSAGE ${snapshot.messageId}`,
                        `AUTHOR ${snapshot.authorLabel} (${snapshot.authorId})`,
                        `CREATED ${new Date(snapshot.createdAtMs).toISOString()}`,
                        `ATTACHMENTS ${attachmentSummary(snapshot)}`,
                        "CONTENT",
                        snapshot.content || "[empty]",
                        "",
                    ].join("\n"),
                )
                .join("\n---\n");
            const missing = event.missingMessageIds.length
                ? `\nUNRECOVERED MESSAGE IDS\n${event.missingMessageIds.join("\n")}`
                : "";
            files.push(evidenceFile(`bulk-delete-${event.eventId}.txt`, manifest + missing));
            images = event.snapshots.flatMap(snapshot => snapshot.imageUrls);
        }

        const container = new ContainerBuilder()
            .setAccentColor(color)
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(ellipsize(body, CV2_TEXT_BUDGET)));
        for (const file of files) {
            if (file.name) container.addFileComponents(new FileBuilder().setURL(`attachment://${file.name}`));
        }
        if (includeImages && (this.client.config.logging?.rehost_images ?? true)) {
            const gallery = await buildImageGalleryFromCandidates(
                images.map(url => ({ url, contentType: undefined })),
                `message-log-${event.eventId}`,
                CV2_MEDIA_GALLERY_ITEM_BUDGET - files.length,
            );
            if (gallery.items.length)
                container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(...gallery.items));
            files.push(...gallery.files);
        }
        return {
            components: [container],
            files,
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] },
            nonce: event.eventId,
            enforceNonce: true,
        };
    }

    private safeStore(operation: () => unknown): void {
        try {
            operation();
        } catch (error) {
            this.metrics.storeErrors++;
            void this.client
                .logError("Message logging store failed", error instanceof Error ? error : String(error))
                .catch(() => undefined);
        }
    }
}
