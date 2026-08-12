import { randomBytes } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KrytenClient } from "../src/classes/client";
import { decryptJson, encryptJson, isEncryptedJsonEnvelope } from "../src/utils/encryptedJson";
import {
    BETA_CLASSIFIER_ID,
    CLASSIFIER_CAMPAIGN_RETENTION_MS,
    ClassifierCampaign,
    UserInteractionStore,
} from "../src/features/userInteractions/store";

const KEY_ENV = "USER_INTERACTION_STORE_TEST_KEY";

describe("UserInteractionStore", () => {
    let dir: string;
    let storePath: string;
    let key: Buffer;
    let testClient: KrytenClient;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "kryten-interactions-"));
        storePath = join(dir, "user_interactions.json");
        key = randomBytes(32);
        process.env[KEY_ENV] = key.toString("base64");
        testClient = client(storePath);
    });

    afterEach(() => {
        vi.useRealTimers();
        delete process.env[KEY_ENV];
        rmSync(dir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it("merges greeting and classifier state into one encrypted user record", async () => {
        const store = new UserInteractionStore(testClient);
        const greeting = await store.getGreeting("42");
        await store.setGreeting(
            "42",
            { firstMessageTimestamp: 1_710_000_000, greetedInRandom: true },
            greeting.generation,
        );
        const admission = await store.beginClassifierRun("42", campaign());
        if (admission.status !== "acquired") throw new Error("expected classifier admission");
        await store.completeClassifierRun(admission.run, campaign(), "ROUTE", 1_720_000_000);

        expect(readStore(storePath, key)).toEqual({
            "42": {
                firstMessageTimestamp: 1_710_000_000,
                greetedInRandom: true,
                classifiers: {
                    beta: {
                        campaignId: "synthetic-beta",
                        decision: "ROUTE",
                        classifiedAt: 1_720_000_000,
                    },
                },
            },
        });
    });

    it("flushes debounced greeting state and does nothing when clean", async () => {
        const store = new UserInteractionStore(testClient);
        await store.flushNow();
        expect(existsSync(storePath)).toBe(false);

        const snapshot = await store.getGreeting("42");
        await store.setGreeting(
            "42",
            { firstMessageTimestamp: Math.floor(Date.now() / 1_000), greetedInRandom: false },
            snapshot.generation,
        );
        expect(existsSync(storePath)).toBe(false);
        await store.flushNow();
        expect(readStore(storePath, key)).toHaveProperty("42.greetedInRandom", false);
    });

    it("suppresses a current ROUTE but permits another run after IGNORE", async () => {
        const store = new UserInteractionStore(testClient);
        const first = await store.beginClassifierRun("ignored", campaign());
        if (first.status !== "acquired") throw new Error("expected classifier admission");
        await store.completeClassifierRun(first.run, campaign(), "IGNORE", 1_720_000_000);
        const retry = await store.beginClassifierRun("ignored", campaign());
        expect(retry.status).toBe("acquired");
        if (retry.status === "acquired") await store.releaseClassifierRun(retry.run);

        const routed = await store.beginClassifierRun("routed", campaign());
        if (routed.status !== "acquired") throw new Error("expected classifier admission");
        await store.completeClassifierRun(routed.run, campaign(), "ROUTE", 1_720_000_000);
        await expect(store.beginClassifierRun("routed", campaign())).resolves.toEqual({
            status: "already_routed",
        });
    });

    it("rejects concurrent work for the same user and classifier", async () => {
        const store = new UserInteractionStore(testClient);
        const first = await store.beginClassifierRun("42", campaign());
        if (first.status !== "acquired") throw new Error("expected classifier admission");
        await expect(store.beginClassifierRun("42", campaign())).resolves.toEqual({
            status: "busy",
        });
        await store.releaseClassifierRun(first.run);
    });

    it("purges the old campaign while preserving greeting state", async () => {
        const store = new UserInteractionStore(testClient);
        const greeting = await store.getGreeting("42");
        await store.setGreeting(
            "42",
            { firstMessageTimestamp: 1_710_000_000, greetedInRandom: true },
            greeting.generation,
        );
        const admission = await store.beginClassifierRun("42", campaign());
        if (admission.status !== "acquired") throw new Error("expected classifier admission");
        await store.completeClassifierRun(admission.run, campaign(), "ROUTE", 1_720_000_000);

        testClient.config.beta_classifier = {
            ...testClient.config.beta_classifier,
            campaign_id: "next-beta",
            campaign_started_at: new Date(Date.now() - 1_000).toISOString(),
        };
        await store.reconcileClassifierCampaigns();

        expect(readStore(storePath, key)).toEqual({
            "42": { firstMessageTimestamp: 1_710_000_000, greetedInRandom: true },
        });
    });

    it("expires the whole campaign 30 days after its configured start", async () => {
        writeFileSync(
            storePath,
            encryptJson(
                {
                    "42": {
                        classifiers: {
                            beta: {
                                campaignId: "synthetic-beta",
                                decision: "ROUTE",
                                classifiedAt: 1_720_000_000,
                            },
                        },
                    },
                },
                key,
            ),
        );
        testClient.config.beta_classifier!.campaign_started_at = new Date(
            Date.now() - 31 * 24 * 60 * 60 * 1_000,
        ).toISOString();
        const store = new UserInteractionStore(testClient);
        await store.reconcileClassifierCampaigns();
        expect(readStore(storePath, key)).toEqual({});
        await expect(store.beginClassifierRun("42", expiredCampaign())).resolves.toEqual({
            status: "expired",
        });
    });

    it("physically purges records when an active campaign reaches its expiry time", async () => {
        const startedAt = new Date(Date.now() - CLASSIFIER_CAMPAIGN_RETENTION_MS + 500).toISOString();
        testClient.config.beta_classifier!.campaign_started_at = startedAt;
        writeFileSync(
            storePath,
            encryptJson(
                {
                    "42": {
                        classifiers: {
                            beta: {
                                campaignId: "synthetic-beta",
                                decision: "ROUTE",
                                classifiedAt: 1_720_000_000,
                            },
                        },
                    },
                },
                key,
            ),
        );
        const store = new UserInteractionStore(testClient);
        await store.reconcileClassifierCampaigns();
        expect(readStore(storePath, key)).toHaveProperty("42.classifiers.beta");

        await vi.waitFor(() => expect(readStore(storePath, key)).toEqual({}), { timeout: 2_000, interval: 25 });
    });

    it("retries a campaign expiry purge after a transient persistence failure", async () => {
        vi.useFakeTimers({ now: Date.now() });
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const startedAt = new Date(Date.now() - CLASSIFIER_CAMPAIGN_RETENTION_MS + 500).toISOString();
        testClient.config.beta_classifier!.campaign_started_at = startedAt;
        writeFileSync(
            storePath,
            encryptJson(
                {
                    "42": {
                        classifiers: {
                            beta: {
                                campaignId: "synthetic-beta",
                                decision: "ROUTE",
                                classifiedAt: 1_720_000_000,
                            },
                        },
                    },
                },
                key,
            ),
        );
        const store = new UserInteractionStore(testClient);
        await store.reconcileClassifierCampaigns();

        delete process.env[KEY_ENV];
        await vi.advanceTimersByTimeAsync(501);
        expect(readStore(storePath, key)).toHaveProperty("42.classifiers.beta");
        expect(testClient.logError).toHaveBeenCalledWith(
            "Classifier campaign expiry purge failed",
            expect.anything(),
            false,
        );
        expect(vi.getTimerCount()).toBe(1);

        process.env[KEY_ENV] = key.toString("base64");
        await vi.advanceTimersByTimeAsync(60_001);
        vi.useRealTimers();
        await vi.waitFor(() => expect(readStore(storePath, key)).toEqual({}), { timeout: 1_000, interval: 10 });
    });

    it("deletion removes all user state and cancels an in-flight write", async () => {
        const store = new UserInteractionStore(testClient);
        const snapshot = await store.getGreeting("42");
        await store.setGreeting(
            "42",
            { firstMessageTimestamp: 1_710_000_000, greetedInRandom: true },
            snapshot.generation,
        );
        await store.flushNow();
        const admission = await store.beginClassifierRun("42", campaign());
        if (admission.status !== "acquired") throw new Error("expected classifier admission");

        await expect(store.deleteUser("42")).resolves.toBe(true);
        await expect(store.completeClassifierRun(admission.run, campaign(), "ROUTE", 1_720_000_000)).resolves.toBe(
            "cancelled",
        );
        await expect(
            store.setGreeting(
                "42",
                { firstMessageTimestamp: 1_710_000_000, greetedInRandom: true },
                snapshot.generation,
            ),
        ).resolves.toBe(false);
        expect(readStore(storePath, key)).toEqual({});
    });

    it("migrates plaintext records without discarding unknown fields", async () => {
        writeFileSync(
            storePath,
            JSON.stringify({
                "42": { firstMessageTimestamp: 1_710_000_000, greetedInRandom: true, futureField: "preserved" },
                legacy: "preserved",
            }),
        );
        const store = new UserInteractionStore(testClient);
        await store.reconcileClassifierCampaigns();

        expect(readStore(storePath, key)).toEqual({
            "42": { firstMessageTimestamp: 1_710_000_000, greetedInRandom: true, futureField: "preserved" },
            legacy: "preserved",
        });
    });

    it("requires a working encryption key when a persistent classifier is enabled", () => {
        delete process.env[KEY_ENV];
        expect(() => new UserInteractionStore(testClient)).toThrow(/required for encrypted persistence/);
    });

    it("requires a restart to change the shared store path or key", async () => {
        const store = new UserInteractionStore(testClient);
        testClient.config.auto_responder!.store_path = join(dir, "other.json");
        await expect(store.reconcileClassifierCampaigns()).rejects.toThrow(/requires a restart/);
    });

    it("refuses to report deletion when an existing store could not be read", async () => {
        testClient.config.beta_classifier!.enabled = false;
        writeFileSync(storePath, "not valid encrypted JSON");
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        const store = new UserInteractionStore(testClient);

        await expect(store.deleteUser("42")).rejects.toThrow(/could not be loaded/);
        expect(readFileSync(storePath, "utf8")).toBe("not valid encrypted JSON");
    });
});

function client(storePath: string): KrytenClient {
    return {
        config: {
            auto_responder: { store_path: storePath, encryption_key_env: KEY_ENV },
            beta_classifier: {
                enabled: true,
                campaign_id: "synthetic-beta",
                campaign_started_at: new Date(Date.now() - 1_000).toISOString(),
            },
        },
        logError: vi.fn(async () => undefined),
    } as unknown as KrytenClient;
}

function campaign(): ClassifierCampaign {
    return {
        classifierId: BETA_CLASSIFIER_ID,
        campaignId: "synthetic-beta",
        startedAt: new Date(Date.now() - 1_000).toISOString(),
    };
}

function expiredCampaign(): ClassifierCampaign {
    return {
        classifierId: BETA_CLASSIFIER_ID,
        campaignId: "synthetic-beta",
        startedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1_000).toISOString(),
    };
}

function readStore(path: string, key: Buffer): Record<string, unknown> {
    const envelope: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isEncryptedJsonEnvelope(envelope)) throw new Error("expected encrypted envelope");
    return decryptJson<Record<string, unknown>>(envelope, key);
}
