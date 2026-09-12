import { createHash, randomBytes } from "node:crypto";
import type { Message, GuildTextBasedChannel } from "discord.js";
import type { KrytenClient } from "../../classes/client";
import { channelOrParentListed } from "../../utils/channels";
import { isRecord } from "../../utils/isRecord";
import { StickyStore, StickyState } from "./store";

export class StickyPosts {
    private store?: StickyStore;
    private stopped = false;
    private expired = false;
    async stop(timeoutMs = 5000): Promise<void> {
        this.stopped = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                Promise.all(this.queues.values()),
                new Promise<void>(resolve => {
                    timer = setTimeout(() => {
                        this.expired = true;
                        resolve();
                    }, timeoutMs);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }
    constructor(
        private readonly client: KrytenClient,
        private readonly path = "./data/sticky_posts.json",
    ) {}

    private readonly queues = new Map<string, Promise<void>>();
    private readonly depths = new Map<string, number>();
    private queued = 0;

    private enqueue(id: string, work: () => Promise<void>): Promise<void> {
        if (this.stopped) return Promise.resolve();
        const depth = this.depths.get(id) ?? 0;
        if (depth >= 100 || this.queued >= 1000)
            return Promise.reject(new Error("Sticky queue capacity exceeded; message not counted"));
        this.queued++;
        this.depths.set(id, depth + 1);
        const task = (this.queues.get(id) ?? Promise.resolve()).then(work);
        const tail = task
            .catch(() => undefined)
            .finally(() => {
                this.queued--;
                const remaining = this.depths.get(id)! - 1;
                if (remaining) this.depths.set(id, remaining);
                else this.depths.delete(id);
                if (this.queues.get(id) === tail) this.queues.delete(id);
            });
        this.queues.set(id, tail);
        return task;
    }

    process(message: Message): Promise<void> {
        if (
            message.author.bot ||
            message.webhookId ||
            message.system ||
            ![0, 19].includes(message.type) ||
            !message.guildId ||
            message.guildId !== process.env["GUILD_ID"]
        )
            return Promise.resolve();
        const channel = message.channel;
        if (!channel || channel.isDMBased() || !channel.isSendable()) return Promise.resolve();
        return this.enqueue(channel.id, () => this.handle(channel, true));
    }

    async reload(): Promise<void> {
        if (this.client.configLoadFailed || !this.client.config.sticky_posts?.enabled) return;
        const failures: Error[] = [];
        for (const id of Object.keys(this.client.config.sticky_posts.channels)) {
            try {
                await this.enqueue(id, async () => {
                    const store = (this.store ??= new StickyStore(this.path));
                    const state = store.get(id);
                    if (state.intent) throw new Error("Sticky delivery uncertain; operator reconciliation required");
                    if (!state.canonical) return;
                    const channel = await this.client.channels.fetch(id);
                    if (channel && !channel.isDMBased() && channel.isSendable()) await this.handle(channel, false);
                });
            } catch (error) {
                failures.push(
                    new Error(`Sticky channel ${id}: ${error instanceof Error ? error.message : String(error)}`, {
                        cause: error,
                    }),
                );
            }
        }
        if (failures.length)
            throw new AggregateError(
                failures,
                `Sticky reload failed: ${failures.map(error => error.message).join("; ")}`,
            );
    }

    private eligible(channel: GuildTextBasedChannel): boolean {
        return (
            !this.expired &&
            !this.client.configLoadFailed &&
            !!this.client.config.sticky_posts?.enabled &&
            !!this.client.config.sticky_posts.channels[channel.id] &&
            channel.guildId === process.env["GUILD_ID"] &&
            !channelOrParentListed(channel, channel.id, this.client.config.moderation?.channel_blacklist ?? [])
        );
    }

    private async handle(channel: GuildTextBasedChannel, increment: boolean): Promise<void> {
        if (!this.eligible(channel)) return;
        const entry = this.client.config.sticky_posts!.channels[channel.id]!;
        const store = (this.store ??= new StickyStore(this.path));
        const state = store.get(channel.id);
        if (state.intent) throw new Error("Sticky delivery uncertain; operator reconciliation required");
        const hash = createHash("sha256")
            .update(
                JSON.stringify(entry.embed, (_key, value: unknown) =>
                    isRecord(value)
                        ? Object.fromEntries(
                              Object.keys(value)
                                  .sort()
                                  .map(key => [key, value[key]]),
                          )
                        : value,
                ),
            )
            .digest("hex");
        if (increment) {
            state.count = Math.min(state.count + 1, entry.interval_messages);
            store.save(channel.id, state);
        }
        let canonicalExists = false;
        if (state.canonical) {
            try {
                const canonical = await channel.messages.fetch({ message: state.canonical, force: true, cache: false });
                if (canonical.author.id !== this.client.user?.id || canonical.webhookId)
                    throw new Error("Sticky ownership mismatch");
                canonicalExists = true;
            } catch (error) {
                if ((error as { code?: number }).code !== 10008) throw error;
            }
        }
        if (!this.eligible(channel)) return;
        if (state.pending && canonicalExists) {
            await this.cleanup(channel, state, store);
            if (!this.eligible(channel)) return;
            if (state.pending) {
                if (!increment && state.hash !== hash) throw new Error("Sticky refresh blocked by pending deletion");
                return;
            }
        }
        if (canonicalExists && state.hash === hash && (!increment || state.count < entry.interval_messages)) {
            store.save(channel.id, state);
            return;
        }
        if (!this.eligible(channel) || this.client.config.sticky_posts!.channels[channel.id] !== entry) return;
        state.intent = randomBytes(12).toString("hex");
        store.save(channel.id, state);
        // Confirmed absence frees the canonical slot even if an older deletion
        // is backed off. Retain that pending ID instead of creating another debt.
        const old = canonicalExists ? state.canonical : undefined;
        let sent: Message;
        try {
            sent = await channel.send({
                embeds: [entry.embed],
                allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
                nonce: state.intent,
                enforceNonce: true,
            });
        } catch (error) {
            // Transport/5xx failures may have delivered. Never blindly retry an
            // uncertain send, even after Discord's short nonce window expires.
            const status = (error as { status?: number }).status;
            if (status && status >= 400 && status < 500) {
                delete state.intent;
                store.save(channel.id, state);
            }
            throw error;
        }
        delete state.intent;
        state.canonical = sent.id;
        state.count = 0;
        state.hash = hash;
        if (old) state.pending = { id: old, attempts: 0, retryAt: 0 };
        try {
            store.save(channel.id, state);
        } catch (error) {
            // The durable send intent remains the restart guard if cleanup also
            // fails. Never delete the previous canonical on this path.
            if (!this.eligible(channel)) throw error;
            try {
                const untracked = await channel.messages.fetch({ message: sent.id, force: true, cache: false });
                if (untracked.author.id !== this.client.user?.id || untracked.webhookId)
                    throw new Error("Sticky ownership mismatch");
                if (this.eligible(channel)) await untracked.delete();
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Sticky persistence failed closed; untracked send cleanup failed",
                );
            }
            throw error;
        }
        await this.cleanup(channel, state, store);
    }

    private async cleanup(channel: GuildTextBasedChannel, state: StickyState, store: StickyStore): Promise<void> {
        const pending = state.pending;
        if (!this.eligible(channel) || !pending || pending.retryAt > Date.now()) return;
        if (pending.attempts >= 10)
            throw new Error("Sticky deletion retry limit reached; operator reconciliation required");
        let deleteSubmitted = false;
        try {
            const old = await channel.messages.fetch({ message: pending.id, force: true, cache: false });
            if (old.author.id !== this.client.user?.id || old.webhookId) throw new Error("Sticky ownership mismatch");
            if (!this.eligible(channel)) return;
            deleteSubmitted = true;
            await old.delete();
        } catch (error) {
            // Reads can be abandoned when inactive; submitted deletes must retain
            // their outcome so re-enabling cannot lose cleanup progress or backoff.
            if (!deleteSubmitted && !this.eligible(channel)) return;
            if ((error as { code?: number }).code !== 10008) {
                pending.attempts = Math.min(pending.attempts + 1, 10);
                pending.retryAt = Date.now() + Math.min(30_000 * 2 ** (pending.attempts - 1), 3_600_000);
                store.save(channel.id, state);
                throw error;
            }
        }
        delete state.pending;
        store.save(channel.id, state);
    }
}
