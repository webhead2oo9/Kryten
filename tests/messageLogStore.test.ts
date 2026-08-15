import { randomBytes } from "crypto";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { MessageLogStore } from "../src/features/messageLogging/store";
import { MessageLogEvent, MessageSnapshot } from "../src/features/messageLogging/types";

const directories: string[] = [];

function temporaryDatabase(): string {
    const directory = mkdtempSync(join(tmpdir(), "kryten-message-log-"));
    directories.push(directory);
    return join(directory, "messages.db");
}

function snapshot(id: string, content = `secret-${id}`): MessageSnapshot {
    return {
        version: 1,
        messageId: id,
        guildId: "guild",
        channelId: "channel",
        authorId: "author",
        authorLabel: "Person",
        createdAtMs: Date.now(),
        content,
        attachments: [],
        imageUrls: [],
        jumpUrl: `https://discord.com/channels/guild/channel/${id}`,
    };
}

function deletion(value: MessageSnapshot): MessageLogEvent {
    return {
        version: 1,
        eventId: "123456789012345678901234",
        kind: "delete",
        occurredAtMs: Date.now(),
        snapshot: value,
    };
}

afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MessageLogStore", () => {
    it("encrypts snapshots and durable outbox payloads and recovers them after reopen", () => {
        const path = temporaryDatabase();
        const key = randomBytes(32);
        const value = snapshot("one");
        const event = deletion(value);
        let store = new MessageLogStore(path, key, 60_000, 100);
        store.saveSnapshot(value);
        store.commitEvent(event, null, [value.messageId]);
        expect(store.pendingCount()).toBe(1);
        store.close();

        expect(readFileSync(path).toString("utf8")).not.toContain(value.content);
        store = new MessageLogStore(path, key, 60_000, 100);
        expect(store.nextDue(Number.MAX_SAFE_INTEGER)?.event).toEqual(event);
        store.close();
    });

    it("fails closed when an existing database is opened with the wrong key", () => {
        const path = temporaryDatabase();
        const store = new MessageLogStore(path, randomBytes(32), 60_000, 100);
        store.close();

        expect(() => new MessageLogStore(path, randomBytes(32), 60_000, 100)).toThrow(/cannot be decrypted/);
    });

    it("applies snapshot TTL and newest-first capacity bounds", () => {
        const store = new MessageLogStore(temporaryDatabase(), randomBytes(32), 1, 2);
        store.saveSnapshot({ ...snapshot("one"), createdAtMs: 1 });
        store.saveSnapshot({ ...snapshot("two"), createdAtMs: 2 });
        store.saveSnapshot({ ...snapshot("three"), createdAtMs: 3 });
        // The capacity bound walks the whole table, so it is a sweep-time job:
        // saveSnapshot runs on every message in the guild.
        expect(store.snapshotCount()).toBe(3);
        store.sweep(0);
        expect(store.snapshotCount()).toBe(2);
        expect(store.getSnapshot("one")).toBeNull();
        store.sweep(Date.now() + 10);
        expect(store.snapshotCount()).toBe(0);
        store.close();
    });

    it("applies retention changes to existing snapshots and persists the policy", () => {
        const path = temporaryDatabase();
        const key = randomBytes(32);
        const originalRetention = 30_000;
        const reducedRetention = 1_000;
        const capturedAt = Date.now();
        let store = new MessageLogStore(path, key, originalRetention, 100);
        store.saveSnapshot(snapshot("existing"));

        store.reconfigure(reducedRetention, 100);
        store.sweep(capturedAt + reducedRetention + 100);
        expect(store.getSnapshot("existing")).toBeNull();
        store.saveSnapshot(snapshot("after-change"));
        store.close();

        store = new MessageLogStore(path, key, originalRetention, 100);
        store.sweep(Date.now() + reducedRetention + 100);
        expect(store.getSnapshot("after-change")).not.toBeNull();
        store.close();
    });
});
