import { randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLogEvent, Collection, Message } from "discord.js";
import { KrytenClient } from "../src/classes/client";
import { markInternalMessageDelete, MessageLogger } from "../src/features/messageLogging/messageLogger";

const directories: string[] = [];

function makeClient(send = vi.fn(async () => undefined)): KrytenClient {
    const directory = mkdtempSync(join(tmpdir(), "kryten-message-logger-"));
    directories.push(directory);
    process.env["TEST_MESSAGE_LOG_KEY"] = randomBytes(32).toString("base64");
    return {
        config: {
            moderation: { channel_blacklist: [] },
            logging: {
                enabled: true,
                guild_id: "guild",
                message_channel_id: "logs",
                db_path: join(directory, "messages.db"),
                encryption_key_env: "TEST_MESSAGE_LOG_KEY",
                rehost_images: false,
            },
        },
        user: { id: "kryten" },
        channels: {
            fetch: vi.fn(async () => ({
                guildId: "guild",
                isSendable: () => true,
                send,
            })),
        },
        logError: vi.fn(async () => undefined),
    } as unknown as KrytenClient;
}

function makeMessage(content: string, overrides: Record<string, unknown> = {}): Message {
    return {
        id: "message",
        guildId: "guild",
        channelId: "channel",
        channel: { isThread: () => false, name: "general" },
        author: { id: "author", tag: "Person", bot: false },
        webhookId: null,
        system: false,
        createdTimestamp: 1_000,
        editedTimestamp: null,
        content,
        attachments: new Map(),
        embeds: [],
        url: "https://discord.com/channels/guild/channel/message",
        partial: false,
        ...overrides,
    } as unknown as Message;
}

afterEach(() => {
    delete process.env["TEST_MESSAGE_LOG_KEY"];
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MessageLogger", () => {
    it("captures, ignores no-op updates, and durably delivers substantive edits", async () => {
        const send = vi.fn(async () => undefined);
        const client = makeClient(send);
        const logger = new MessageLogger(client);
        await logger.initialize();
        const original = makeMessage("before");
        await logger.capture(original);
        await logger.captureEdit(original, makeMessage("before"));
        expect(logger.getMetrics().editsQueued).toBe(0);

        await logger.captureEdit(original, makeMessage("after", { editedTimestamp: 2_000 }));
        expect(logger.getMetrics().editsQueued).toBe(1);
        await logger.drain();
        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0]?.[0]).toMatchObject({
            allowedMentions: { parse: [] },
            enforceNonce: true,
        });
        expect(logger.getMetrics().pending).toBe(0);
        logger.close();
    });

    it("excludes bots, other guilds, ignored threads, and the destination channel", async () => {
        const client = makeClient();
        client.config.logging!.ignored_channel_ids = ["ignored-parent"];
        const logger = new MessageLogger(client);
        await logger.initialize();
        await logger.capture(makeMessage("bot", { author: { id: "bot", tag: "Bot", bot: true } }));
        await logger.capture(makeMessage("other", { guildId: "elsewhere" }));
        await logger.capture(makeMessage("loop", { channelId: "logs" }));
        await logger.capture(
            makeMessage("thread", {
                channelId: "thread",
                channel: { isThread: () => true, parentId: "ignored-parent", name: "thread", parent: null },
            }),
        );
        expect(logger.getMetrics().captured).toBe(0);
        logger.close();
    });

    it("recovers a cached snapshot for a partial deletion", async () => {
        const send = vi.fn(async () => undefined);
        const client = makeClient(send);
        const logger = new MessageLogger(client);
        await logger.initialize();
        await logger.capture(makeMessage("deleted evidence"));
        await logger.captureDelete({
            id: "message",
            guildId: "guild",
            channelId: "channel",
            channel: { isThread: () => false },
            partial: true,
        } as never);
        expect(logger.getMetrics().deletesQueued).toBe(1);
        await logger.drain();
        expect(send).toHaveBeenCalledTimes(1);
        logger.close();
    });

    it("emits one evidence-bearing event for a bulk deletion", async () => {
        const send = vi.fn(async () => undefined);
        const client = makeClient(send);
        const logger = new MessageLogger(client);
        await logger.initialize();
        const first = makeMessage("first", { id: "first" });
        const second = makeMessage("second", { id: "second" });
        await logger.capture(first);
        await logger.capture(second);

        await logger.captureBulk(
            new Collection([
                [first.id, first],
                [second.id, second],
            ]),
        );
        await logger.drain();

        expect(send).toHaveBeenCalledTimes(1);
        expect(send.mock.calls[0]?.[0].files).toHaveLength(1);
        expect(JSON.stringify(send.mock.calls[0]?.[0].components?.[0]?.toJSON())).toContain(
            "attachment://bulk-delete-",
        );
        expect(logger.getMetrics().bulkDeletesQueued).toBe(1);
        logger.close();
    });

    it("names only a unique matching moderator audit entry", async () => {
        const send = vi.fn(async () => undefined);
        const client = makeClient(send);
        const logger = new MessageLogger(client);
        await logger.initialize();
        const message = makeMessage("evidence");
        await logger.capture(message);
        logger.recordAudit(
            {
                action: AuditLogEvent.MessageDelete,
                targetId: "author",
                executorId: "moderator",
                executor: { tag: "Mod" },
                extra: { channel: { id: "channel" }, count: 1 },
                reason: "cleanup",
                createdTimestamp: Date.now(),
            } as never,
            { id: "guild" } as never,
        );
        await logger.captureDelete(message);
        await logger.drain();

        const component = send.mock.calls[0]?.[0].components?.[0];
        expect(JSON.stringify(component?.toJSON())).toContain("Mod");
        logger.close();
    });

    it("names the moderator behind a bulk purge, whose audit entry carries the channel as its target", async () => {
        const send = vi.fn(async () => undefined);
        const client = makeClient(send);
        const logger = new MessageLogger(client);
        await logger.initialize();
        const known = makeMessage("recovered", { id: "known" });
        await logger.capture(known);
        const unknown = { id: "unknown", guildId: "guild", channelId: "channel", partial: true };
        logger.recordAudit(
            {
                action: AuditLogEvent.MessageBulkDelete,
                targetId: "channel",
                executorId: "moderator",
                executor: { tag: "Purger" },
                extra: { count: 2 },
                createdTimestamp: Date.now(),
            } as never,
            { id: "guild" } as never,
        );
        await logger.captureBulk(
            new Collection([
                [known.id, known],
                [unknown.id, unknown as never],
            ]),
        );
        await logger.drain();

        const card = JSON.stringify(send.mock.calls[0]?.[0].components?.[0]?.toJSON());
        expect(card).toContain("Purger");
        expect(card).toContain("**Messages** 2");
        logger.close();
    });

    it("keeps attribution for an event delivered after the audit window closes", async () => {
        vi.useFakeTimers();
        try {
            let failing = true;
            const send = vi.fn(async () => {
                if (failing) throw new Error("rate limited");
                return undefined;
            });
            const client = makeClient(send);
            const logger = new MessageLogger(client);
            await logger.initialize();
            const message = makeMessage("evidence");
            await logger.capture(message);
            logger.recordAudit(
                {
                    action: AuditLogEvent.MessageDelete,
                    targetId: "author",
                    executorId: "moderator",
                    executor: { tag: "Mod" },
                    extra: { channel: { id: "channel" }, count: 1 },
                    createdTimestamp: Date.now(),
                } as never,
                { id: "guild" } as never,
            );
            await logger.captureDelete(message);

            // Every attempt fails until well past the point where the audit feed
            // and the internal-delete markers have expired.
            await vi.advanceTimersByTimeAsync(2_000);
            expect(send).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(60_000);
            failing = false;
            await logger.drain();

            const card = JSON.stringify(send.mock.calls.at(-1)?.[0].components?.[0]?.toJSON());
            expect(card).toContain("Mod");
            logger.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it("never delivers a queued event to a newly configured guild", async () => {
        const send = vi.fn(async () => undefined);
        const client = makeClient(send);
        const logger = new MessageLogger(client);
        await logger.initialize();
        logger.stop();
        await logger.capture(makeMessage("guild A evidence"));
        await logger.captureDelete(makeMessage("guild A evidence"));

        client.config.logging = {
            ...client.config.logging,
            guild_id: "guild-b",
            message_channel_id: "guild-b-logs",
        };
        await logger.drain();

        expect(client.channels.fetch).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
        expect(logger.getMetrics().pending).toBe(1);
        logger.close();
    });

    it("waits for an active delivery before closing the store on disable", async () => {
        let signalStarted!: () => void;
        let finishSend!: () => void;
        const started = new Promise<void>(resolve => {
            signalStarted = resolve;
        });
        const send = vi.fn(
            () =>
                new Promise<void>(resolve => {
                    finishSend = resolve;
                    signalStarted();
                }),
        );
        const client = makeClient(send);
        const originalLogging = client.config.logging!;
        const logger = new MessageLogger(client);
        await logger.initialize();
        logger.stop();
        await logger.capture(makeMessage("evidence"));
        await logger.captureDelete(makeMessage("evidence"));
        const draining = logger.drain();
        await started;

        client.config.logging = { enabled: false };
        let disabled = false;
        const disabling = logger.reconfigure(originalLogging).then(() => {
            disabled = true;
        });
        await Promise.resolve();
        expect(disabled).toBe(false);
        finishSend();
        await Promise.all([draining, disabling]);

        client.config.logging = originalLogging;
        await logger.reconfigure({ enabled: false });
        expect(send).toHaveBeenCalledTimes(1);
        expect(logger.getMetrics().pending).toBe(0);
        expect(logger.getMetrics().storeErrors).toBe(0);
        logger.close();
    });

    it("clears internal attribution when a marked delete does not complete", async () => {
        const send = vi.fn(async () => undefined);
        const client = makeClient(send);
        const logger = new MessageLogger(client);
        await logger.initialize();
        await logger.capture(makeMessage("evidence"));
        const clearMarker = markInternalMessageDelete(client, "message", "failed moderation delete");
        clearMarker();
        await logger.captureDelete(makeMessage("evidence"));
        await logger.drain();

        const card = JSON.stringify(send.mock.calls[0]?.[0].components?.[0]?.toJSON());
        expect(card).toContain("Author or unknown");
        expect(card).not.toContain("failed moderation delete");
        logger.close();
    });

    it("ignores a pin or embed update on a message it holds no snapshot for", async () => {
        const send = vi.fn(async () => undefined);
        const client = makeClient(send);
        const logger = new MessageLogger(client);
        await logger.initialize();
        const partialOld = { id: "message", guildId: "guild", channelId: "channel", partial: true };

        await logger.captureEdit(partialOld as never, makeMessage("unchanged", { editedTimestamp: 1_000 }));
        expect(logger.getMetrics().editsQueued).toBe(0);

        await logger.captureEdit(partialOld as never, makeMessage("edited", { editedTimestamp: Date.now() }));
        expect(logger.getMetrics().editsQueued).toBe(1);
        logger.close();
    });

    it("gives up on an undeliverable event instead of blocking the outbox forever", async () => {
        const send = vi.fn(async () => {
            throw new Error("channel is gone");
        });
        const client = makeClient(send);
        const logger = new MessageLogger(client);
        await logger.initialize();
        await logger.capture(makeMessage("evidence"));
        await logger.captureDelete(makeMessage("evidence"));

        for (let attempt = 0; attempt < 10; attempt++) await logger.drain();

        expect(send).toHaveBeenCalledTimes(10);
        expect(logger.getMetrics().dropped).toBe(1);
        expect(logger.getMetrics().pending).toBe(0);
        logger.close();
    });
});
