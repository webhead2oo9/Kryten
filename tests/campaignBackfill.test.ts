import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encryptJson, decryptJson } from "../src/utils/encryptedJson";
import { migrateCampaignGreetings, validateBackfill } from "../src/maintenance/campaignBackfill";

const scratch = tmpdir();
const key = Buffer.alloc(32, 7);
const campaign = {
    campaign_id: "synthetic-v2",
    campaign_started_at: "2026-09-30T16:35:00Z",
    guild_id: "111111111111111111",
    target_channel_id: "222222222222222222",
    target_greeting_enabled: true,
};
const exported = {
    guild_id: campaign.guild_id,
    channel_id: campaign.target_channel_id,
    since_utc: campaign.campaign_started_at,
    through_utc: "2026-09-30T17:34:05.768Z",
    complete: true,
    last_message_id: "333333333333333333",
    user_ids: ["444444444444444444", "555555555555555555"],
};
let directory: string;
let config: any;
const initial = {
    "444444444444444444": {
        campaignGreetings: { beta: { campaignId: "old" }, other: { campaignId: "untouched" } },
        classifiers: { beta: { campaignId: "old", decision: "ROUTE", classifiedAt: 1 }, other: { x: 1 } },
        firstMessageTimestamp: 1,
        greetedInRandom: false,
    },
    "666666666666666666": { campaignGreetings: { beta: { campaignId: "synthetic-v2" } }, opaque: "later user" },
    "777777777777777777": "legacy",
};
beforeEach(async () => {
    vi.useFakeTimers({ now: new Date("2026-09-30T18:00:00Z") });
    vi.stubEnv("SYNTHETIC_BACKFILL_KEY", key.toString("hex"));
    directory = await mkdtemp(join(scratch, "kryten-backfill-test-"));
    config = {
        beta_classifier: campaign,
        auto_responder: { store_path: join(directory, "state.json"), encryption_key_env: "SYNTHETIC_BACKFILL_KEY" },
    };
    await writeFile(config.auto_responder.store_path, encryptJson(initial, key));
});
afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
});

describe("offline campaign greeting migration", () => {
    it("dry runs without changing the encrypted source", async () => {
        const before = await readFile(config.auto_responder.store_path, "utf8");
        expect(await migrateCampaignGreetings(config, exported, { apply: false })).toMatchObject({
            users: 2,
            added: 2,
            alreadyPresent: 0,
            applied: false,
            through: exported.through_utc,
        });
        expect(await readFile(config.auto_responder.store_path, "utf8")).toBe(before);
    });
    it("backs up, adds greetings only, preserves later suppression and unrelated data, and is idempotent", async () => {
        const before = await readFile(config.auto_responder.store_path, "utf8");
        const result = await migrateCampaignGreetings(config, exported, { apply: true, writerStopped: true });
        expect(await readFile(result.backup!, "utf8")).toBe(before);
        const actual = decryptJson(JSON.parse(await readFile(config.auto_responder.store_path, "utf8")), key);
        expect(actual).toEqual({
            ...initial,
            "444444444444444444": {
                ...initial["444444444444444444"],
                campaignGreetings: {
                    ...initial["444444444444444444"].campaignGreetings,
                    beta: { campaignId: campaign.campaign_id },
                },
            },
            "555555555555555555": { campaignGreetings: { beta: { campaignId: campaign.campaign_id } } },
        });
        expect((await stat(config.auto_responder.store_path)).mode & 0o777).toBe(0o600);
        expect(await migrateCampaignGreetings(config, exported, { apply: true, writerStopped: true })).toMatchObject({
            added: 0,
            alreadyPresent: 2,
        });
    });
    it.each([
        { complete: false },
        { guild_id: "999999999999999999" },
        { channel_id: "999999999999999999" },
        { since_utc: "2026-09-29T16:35:00Z" },
        { through_utc: "invalid" },
        { through_utc: "2027-01-01T00:00:00Z" },
        { through_utc: "2026-09-30T15:00:00Z" },
        { user_ids: [123] },
        { user_ids: ["bad"] },
        { user_ids: ["444444444444444444", "444444444444444444"] },
        { last_message_id: "bad" },
    ])("rejects invalid export metadata or IDs without mutation", async patch => {
        expect(() => validateBackfill({ ...exported, ...patch }, config)).toThrow();
    });
    it("refuses replacement if a writer changes the source after staging", async () => {
        let checks = 0;
        const changed = encryptJson({ synthetic: "concurrent writer" }, key);
        const { writeFileSync } = await import("node:fs");
        await expect(
            migrateCampaignGreetings(config, exported, {
                apply: true,
                writerStopped: true,
                assertWriterStopped: () => {
                    if (++checks === 2) writeFileSync(config.auto_responder.store_path, changed);
                },
            }),
        ).rejects.toThrow("store changed");
        expect(await readFile(config.auto_responder.store_path, "utf8")).toBe(changed);
    });
    it("refuses missing or plaintext stores", async () => {
        await writeFile(config.auto_responder.store_path, JSON.stringify(initial));
        await expect(migrateCampaignGreetings(config, exported, { apply: false })).rejects.toThrow();
        await rm(config.auto_responder.store_path);
        await expect(migrateCampaignGreetings(config, exported, { apply: false })).rejects.toThrow();
    });
    it("refuses apply without a stopped writer, expired campaign, unreadable encryption, and legacy collisions", async () => {
        await expect(migrateCampaignGreetings(config, exported, { apply: true })).rejects.toThrow();
        expect(() =>
            validateBackfill(exported, {
                ...config,
                beta_classifier: { ...campaign, campaign_started_at: "2026-08-01T00:00:00Z" },
            }),
        ).toThrow();
        await expect(
            migrateCampaignGreetings(config, { ...exported, user_ids: ["777777777777777777"] }, { apply: false }),
        ).rejects.toThrow();
        await writeFile(config.auto_responder.store_path, encryptJson(initial, Buffer.alloc(32, 8)));
        await expect(migrateCampaignGreetings(config, exported, { apply: false })).rejects.toThrow();
    });
});
