import { readFile, writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Config } from "../types";
import type { KrytenClient } from "../classes/client";
import { UserInteractionStore, classifierCampaignIsActive } from "../features/userInteractions/store";
import { decryptJson, isEncryptedJsonEnvelope, keyFromEnv } from "../utils/encryptedJson";
import { isRecord } from "../utils/isRecord";

const snowflake = (value: unknown): value is string =>
    typeof value === "string" && /^[1-9][0-9]{16,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
const timestamp = (value: unknown): number =>
    typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) ? Date.parse(value) : NaN;

export function validateBackfill(
    input: unknown,
    config: Config,
): { userIds: string[]; through: string; campaignId: string } {
    const beta = config.beta_classifier;
    if (
        !beta?.campaign_id ||
        !beta.campaign_started_at ||
        !beta.target_greeting_enabled ||
        !classifierCampaignIsActive({
            classifierId: "beta",
            campaignId: beta.campaign_id,
            startedAt: beta.campaign_started_at,
        })
    ) {
        throw new Error("backfill requires the active new campaign config");
    }
    if (
        !isRecord(input) ||
        input["complete"] !== true ||
        !snowflake(input["guild_id"]) ||
        !snowflake(input["channel_id"]) ||
        input["guild_id"] !== beta.guild_id ||
        input["channel_id"] !== beta.target_channel_id ||
        !snowflake(input["last_message_id"])
    ) {
        throw new Error("invalid backfill scope or completeness");
    }
    const since = timestamp(input["since_utc"]);
    const through = timestamp(input["through_utc"]);
    if (
        !Number.isFinite(since) ||
        !Number.isFinite(through) ||
        since !== Date.parse(beta.campaign_started_at) ||
        through < since ||
        through > Date.now()
    ) {
        throw new Error("invalid backfill coverage interval");
    }
    const userIds = input["user_ids"];
    if (
        !Array.isArray(userIds) ||
        userIds.length === 0 ||
        !userIds.every(snowflake) ||
        new Set(userIds).size !== userIds.length
    ) {
        throw new Error("backfill requires unique user ID strings");
    }
    return { userIds, through: input["through_utc"] as string, campaignId: beta.campaign_id };
}

/** Caller must fence every writer for the entire apply, including the initial snapshot. */
export async function migrateCampaignGreetings(
    config: Config,
    input: unknown,
    options: { apply: boolean; writerStopped?: boolean; assertWriterStopped?: () => void },
): Promise<{
    users: number;
    added: number;
    alreadyPresent: number;
    applied: boolean;
    through: string;
    backup?: string;
}> {
    const validated = validateBackfill(input, config);
    if (options.apply && !options.writerStopped) throw new Error("stop the production writer before taking a snapshot");
    if (options.apply) options.assertWriterStopped?.();
    const path = config.auto_responder?.store_path ?? "./data/user_interactions.json";
    const key = keyFromEnv(config.auto_responder?.encryption_key_env ?? "USER_INTERACTIONS_ENCRYPTION_KEY");
    const source = await readFile(path, "utf8");
    const decode = (text: string): Record<string, unknown> => {
        const envelope: unknown = JSON.parse(text);
        if (!isEncryptedJsonEnvelope(envelope)) throw new Error("migration requires an encrypted existing store");
        const decoded: unknown = decryptJson(envelope, key);
        if (!isRecord(decoded)) throw new Error("invalid store object");
        return decoded;
    };
    const expected = decode(source);
    let alreadyPresent = 0;
    for (const userId of validated.userIds) {
        const existing = expected[userId];
        if (existing !== undefined && !isRecord(existing)) throw new Error("cannot overwrite a legacy user record");
        const user = { ...existing };
        const greetings = user["campaignGreetings"];
        if (greetings !== undefined && !isRecord(greetings)) throw new Error("invalid greeting container");
        const beta = isRecord(greetings) ? greetings["beta"] : undefined;
        if (isRecord(beta) && beta["campaignId"] === validated.campaignId) {
            alreadyPresent++;
            continue;
        }
        user["campaignGreetings"] = { ...greetings, beta: { campaignId: validated.campaignId } };
        expected[userId] = user;
    }
    const summary = {
        users: validated.userIds.length,
        added: validated.userIds.length - alreadyPresent,
        alreadyPresent,
        applied: options.apply,
        through: validated.through,
    };
    if (!options.apply) return summary;
    const backup = `${path}.backup-${randomUUID()}`;
    const staged = `${path}.backfill-${randomUUID()}`;
    await writeFile(backup, source, { flag: "wx", mode: 0o600 });
    try {
        await writeFile(staged, source, { flag: "wx", mode: 0o600 });
        const stagedConfig = { ...config, auto_responder: { ...config.auto_responder, store_path: staged } };
        const store = new UserInteractionStore({ config: stagedConfig } as KrytenClient);
        await store.seedCampaignGreetings(validated.userIds, validated.campaignId);
        if (!isDeepStrictEqual(decode(await readFile(staged, "utf8")), expected))
            throw new Error("staged verification failed");
        options.assertWriterStopped?.();
        if ((await readFile(path, "utf8")) !== source)
            throw new Error("store changed during migration; refusing replacement");
        await rename(staged, path);
        if (!isDeepStrictEqual(decode(await readFile(path, "utf8")), expected))
            throw new Error("fresh-read verification failed; retain backup and keep writer stopped");
        const fresh = new UserInteractionStore({ config } as KrytenClient);
        for (const userId of validated.userIds) {
            if ((await fresh.getCampaignGreeting(userId, "beta")).record?.campaignId !== validated.campaignId) {
                throw new Error("application-store verification failed");
            }
        }
        return { ...summary, backup };
    } finally {
        await unlink(staged).catch(() => undefined);
        await unlink(`${staged}.tmp`).catch(() => undefined);
    }
}
