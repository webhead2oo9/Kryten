import { randomBytes } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutoResponder } from "../src/features/autoresponder/autoResponder";
import { KrytenClient } from "../src/classes/client";
import { decryptJson, isEncryptedJsonEnvelope } from "../src/utils/encryptedJson";

const KEY_ENV = "AUTO_RESPONDER_TEST_KEY";

describe("AutoResponder.flushNow", () => {
    let dir: string;
    let storePath: string;
    let key: Buffer;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "kryten-ar-"));
        storePath = join(dir, "user_interactions.json");
        key = randomBytes(32);
        process.env[KEY_ENV] = key.toString("base64");
    });

    afterEach(() => {
        delete process.env[KEY_ENV];
        rmSync(dir, { recursive: true, force: true });
    });

    function makeClient(): KrytenClient {
        return {
            config: {
                auto_responder: {
                    store_path: storePath,
                    encryption_key_env: KEY_ENV,
                    random_greeting_channel_id: "123",
                },
            },
            logError: async () => undefined,
        } as unknown as KrytenClient;
    }

    it("persists a queued debounced write immediately, before the 1s debounce fires", async () => {
        const responder = new AutoResponder(makeClient());
        // Reach past the Discord-coupled process() to queue a save the way a
        // greeting does: mutate the store, then schedule the debounced write.
        const internal = responder as unknown as {
            store: Map<string, unknown>;
            scheduleSave: () => void;
        };
        internal.store.set("42", { firstMessageTimestamp: 1710000000, greetedInRandom: true });
        internal.scheduleSave();
        expect(existsSync(storePath)).toBe(false); // still inside the debounce window

        await responder.flushNow();

        expect(existsSync(storePath)).toBe(true);
        const envelope: unknown = JSON.parse(readFileSync(storePath, "utf8"));
        if (!isEncryptedJsonEnvelope(envelope)) throw new Error("expected encrypted envelope");
        expect(decryptJson(envelope, key)).toEqual({
            "42": { firstMessageTimestamp: 1710000000, greetedInRandom: true },
        });
    });

    it("is a no-op when nothing is queued", async () => {
        const responder = new AutoResponder(makeClient());
        await responder.flushNow();
        expect(existsSync(storePath)).toBe(false);
    });

    it("drains a write that raced in behind an in-flight flush", async () => {
        const responder = new AutoResponder(makeClient());
        const internal = responder as unknown as {
            store: Map<string, unknown>;
            scheduleSave: () => void;
            flush: () => Promise<void>;
        };
        internal.store.set("1", { firstMessageTimestamp: 1710000000, greetedInRandom: true });
        internal.scheduleSave();
        const inFlight = internal.flush(); // starts writing record "1"
        // Races in mid-write: flush() is already running, so this only sets
        // saveQueued — exactly the state shutdown must not lose.
        internal.store.set("2", { firstMessageTimestamp: 1710000001, greetedInRandom: true });
        internal.scheduleSave();

        await responder.flushNow();
        await inFlight;

        const envelope: unknown = JSON.parse(readFileSync(storePath, "utf8"));
        if (!isEncryptedJsonEnvelope(envelope)) throw new Error("expected encrypted envelope");
        const stored = decryptJson<Record<string, unknown>>(envelope, key);
        expect(Object.keys(stored).sort()).toEqual(["1", "2"]);
    });
});
