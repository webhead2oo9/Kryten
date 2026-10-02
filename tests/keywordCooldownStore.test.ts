import { randomBytes } from "crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KrytenClient } from "../src/classes/client";
import { KEYWORD_COOLDOWN_MS, UserInteractionStore } from "../src/features/userInteractions/store";
import { decryptJson, encryptJson, isEncryptedJsonEnvelope } from "../src/utils/encryptedJson";

const KEY_ENV = "KEYWORD_COOLDOWN_TEST_KEY";

describe("keyword auto-response cooldown storage", () => {
    let dir: string;
    let storePath: string;
    let key: Buffer;
    let testClient: KrytenClient;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "kryten-keyword-cooldown-"));
        storePath = join(dir, "user_interactions.json");
        key = randomBytes(32);
        process.env[KEY_ENV] = key.toString("base64");
        testClient = client(storePath);
    });

    afterEach(() => {
        delete process.env[KEY_ENV];
        rmSync(dir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it("atomically acquires one durable claim per user and rule", async () => {
        const store = new UserInteractionStore(testClient);
        const now = 1_800_000_000_000;

        const [first, duplicate] = await Promise.all([
            store.claimKeywordCooldown("user-1", "rule-1", now),
            store.claimKeywordCooldown("user-1", "rule-1", now),
        ]);

        expect([first.status, duplicate.status].sort()).toEqual(["acquired", "cooldown"]);
        await expect(store.claimKeywordCooldown("user-1", "rule-2", now)).resolves.toMatchObject({
            status: "acquired",
        });
        await expect(store.claimKeywordCooldown("user-2", "rule-1", now)).resolves.toMatchObject({
            status: "acquired",
        });
    });

    it("survives restart and expires exactly after 24 hours", async () => {
        const now = 1_800_000_000_000;
        const firstStore = new UserInteractionStore(testClient);
        await expect(firstStore.claimKeywordCooldown("user-1", "rule-1", now)).resolves.toMatchObject({
            status: "acquired",
        });

        const restarted = new UserInteractionStore(testClient);
        await expect(
            restarted.claimKeywordCooldown("user-1", "rule-1", now + KEYWORD_COOLDOWN_MS - 1),
        ).resolves.toEqual({
            status: "cooldown",
        });
        await expect(
            restarted.claimKeywordCooldown("user-1", "rule-1", now + KEYWORD_COOLDOWN_MS),
        ).resolves.toMatchObject({
            status: "acquired",
        });
    });

    it("releases only the matching claim after a failed send", async () => {
        const store = new UserInteractionStore(testClient);
        const result = await store.claimKeywordCooldown("user-1", "rule-1", 1_800_000_000_000);
        if (result.status !== "acquired") throw new Error("expected acquired claim");

        await store.releaseKeywordCooldown(result.claim);

        await expect(store.claimKeywordCooldown("user-1", "rule-1", 1_800_000_000_001)).resolves.toMatchObject({
            status: "acquired",
        });
    });

    it("fails before claiming when encrypted persistence is unavailable", async () => {
        const store = new UserInteractionStore(testClient);
        delete process.env[KEY_ENV];

        await expect(store.claimKeywordCooldown("user-1", "rule-1", Date.now())).rejects.toThrow(
            /required for encrypted persistence/,
        );
    });

    it("privacy deletion removes keyword cooldowns", async () => {
        const store = new UserInteractionStore(testClient);
        await store.claimKeywordCooldown("user-1", "rule-1", Date.now());

        await expect(store.deleteUser("user-1")).resolves.toBe(true);

        expect(readStore(storePath, key)).toEqual({});
    });

    it("prunes expired cooldowns while preserving unrelated user state", async () => {
        const now = Date.now();
        writeFileSync(
            storePath,
            encryptJson(
                {
                    "user-1": {
                        futureField: "preserved",
                        keywordCooldowns: {
                            expired: now - KEYWORD_COOLDOWN_MS,
                            current: now - KEYWORD_COOLDOWN_MS + 1,
                            future: now + 1,
                            malformed: "not-a-time",
                        },
                    },
                },
                key,
            ),
        );
        const store = new UserInteractionStore(testClient);

        await store.reconcileKeywordCooldowns(now);

        expect(readStore(storePath, key)).toEqual({
            "user-1": {
                futureField: "preserved",
                keywordCooldowns: { current: now - KEYWORD_COOLDOWN_MS + 1 },
            },
        });
    });
});

function client(storePath: string): KrytenClient {
    return {
        config: {
            auto_responder: { store_path: storePath, encryption_key_env: KEY_ENV },
            keyword_auto_responses: { enabled: true, rules: [] },
        },
        logError: vi.fn(async () => undefined),
    } as unknown as KrytenClient;
}

function readStore(path: string, key: Buffer): Record<string, unknown> {
    const envelope: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isEncryptedJsonEnvelope(envelope)) throw new Error("expected encrypted envelope");
    return decryptJson<Record<string, unknown>>(envelope, key);
}
