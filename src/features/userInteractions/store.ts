import { existsSync, readFileSync } from "fs";
import { chmod, mkdir, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import type { KrytenClient } from "../../classes/client";
import { decryptJson, encryptJson, isEncryptedJsonEnvelope, keyFromEnv } from "../../utils/encryptedJson";
import { isRecord } from "../../utils/isRecord";

const DEFAULT_STORE_PATH = "./data/user_interactions.json";
const DEFAULT_KEY_ENV = "USER_INTERACTIONS_ENCRYPTION_KEY";
const SAVE_DEBOUNCE_MS = 1_000;
const GREETING_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const CAMPAIGN_PURGE_RETRY_MS = 60_000;
export const CLASSIFIER_CAMPAIGN_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const BETA_CLASSIFIER_ID = "beta";
export const BETA_GREETING_ID = "beta";

export type ClassifierDecision = "ROUTE" | "IGNORE";

export interface GreetingRecord {
    firstMessageTimestamp: number;
    greetedInRandom: boolean;
    owedFullWelcome?: boolean;
}

export interface ClassifierCampaign {
    classifierId: string;
    campaignId: string;
    startedAt: string;
}

export interface ClassifierRun {
    readonly key: string;
    readonly userId: string;
    readonly classifierId: string;
    readonly campaignId: string;
    readonly generation: number;
}

export type ClassifierAdmission =
    | { status: "acquired"; run: ClassifierRun }
    | { status: "already_routed" | "busy" | "expired" };

interface StoredClassifierRecord {
    campaignId: string;
    decision: ClassifierDecision;
    classifiedAt: number;
}

interface GreetingSnapshot {
    record?: GreetingRecord;
    generation: number;
}

export interface CampaignGreetingRecord {
    campaignId: string;
}

export interface CampaignGreetingSnapshot {
    record?: CampaignGreetingRecord;
    generation: number;
}

export function classifierCampaignIsActive(campaign: ClassifierCampaign, now = Date.now()): boolean {
    const startedAt = Date.parse(campaign.startedAt);
    return Number.isFinite(startedAt) && now >= startedAt && now < startedAt + CLASSIFIER_CAMPAIGN_RETENTION_MS;
}

export class UserInteractionStore {
    private records = new Map<string, Record<string, unknown>>();
    private readonly legacyRecords = new Map<string, unknown>();
    private readonly generations = new Map<string, number>();
    private readonly inFlight = new Map<string, ClassifierRun>();
    private operationChain: Promise<void> = Promise.resolve();
    private saveTimer?: NodeJS.Timeout;
    private campaignExpiryTimer?: NodeJS.Timeout;
    private dirty = false;
    private loadFailed = false;
    private saveFailureReported = false;
    private campaignPurgeFailureReported = false;

    readonly storePath: string;
    readonly keyEnv: string;

    constructor(private readonly client: KrytenClient) {
        this.storePath = client.config.auto_responder?.store_path ?? DEFAULT_STORE_PATH;
        this.keyEnv = client.config.auto_responder?.encryption_key_env ?? DEFAULT_KEY_ENV;
        this.load();
    }

    async getGreeting(userId: string): Promise<GreetingSnapshot> {
        return this.exclusive(() => ({
            record: greetingRecord(this.records.get(userId)),
            generation: this.generation(userId),
        }));
    }

    async setGreeting(userId: string, record: GreetingRecord, generation: number): Promise<boolean> {
        return this.exclusive(() => {
            if (this.generation(userId) !== generation) return false;
            const next = { ...(this.records.get(userId) ?? {}), ...record };
            if (record.owedFullWelcome === undefined) delete next["owedFullWelcome"];
            this.records.set(userId, next);
            this.dirty = true;
            this.scheduleSave();
            return true;
        });
    }

    async getCampaignGreeting(userId: string, greetingId: string): Promise<CampaignGreetingSnapshot> {
        return this.exclusive(() => ({
            record: campaignGreetingRecord(this.records.get(userId), greetingId),
            generation: this.generation(userId),
        }));
    }

    async setCampaignGreeting(
        userId: string,
        greetingId: string,
        record: CampaignGreetingRecord,
        generation: number,
    ): Promise<boolean> {
        return this.exclusive(() => {
            if (this.generation(userId) !== generation) return false;
            const user = { ...(this.records.get(userId) ?? {}) };
            const greetings = isRecord(user["campaignGreetings"]) ? { ...user["campaignGreetings"] } : {};
            greetings[greetingId] = record;
            user["campaignGreetings"] = greetings;
            this.records.set(userId, user);
            this.dirty = true;
            this.scheduleSave();
            return true;
        });
    }

    async beginClassifierRun(userId: string, campaign: ClassifierCampaign): Promise<ClassifierAdmission> {
        return this.exclusive(() => {
            if (!classifierCampaignIsActive(campaign)) return { status: "expired" };
            const key = classifierRunKey(campaign.classifierId, userId);
            if (this.inFlight.has(key)) return { status: "busy" };
            const existing = classifierRecord(this.records.get(userId), campaign.classifierId);
            if (existing?.campaignId === campaign.campaignId && existing.decision === "ROUTE") {
                return { status: "already_routed" };
            }
            const run: ClassifierRun = {
                key,
                userId,
                classifierId: campaign.classifierId,
                campaignId: campaign.campaignId,
                generation: this.generation(userId),
            };
            this.inFlight.set(key, run);
            return { status: "acquired", run };
        });
    }

    isClassifierRunCurrent(run: ClassifierRun): boolean {
        return this.inFlight.get(run.key) === run && this.generation(run.userId) === run.generation;
    }

    isUserGenerationCurrent(run: ClassifierRun): boolean {
        return this.generation(run.userId) === run.generation;
    }

    async completeClassifierRun(
        run: ClassifierRun,
        campaign: ClassifierCampaign,
        decision: ClassifierDecision,
        classifiedAt: number,
    ): Promise<"stored" | "cancelled"> {
        return this.exclusive(async () => {
            try {
                if (!this.isClassifierRunCurrent(run)) return "cancelled";
                if (
                    run.classifierId !== campaign.classifierId ||
                    run.campaignId !== campaign.campaignId ||
                    !classifierCampaignIsActive(campaign)
                ) {
                    return "cancelled";
                }
                const nextRecords = new Map(this.records);
                const user = { ...(nextRecords.get(run.userId) ?? {}) };
                const classifiers = isRecord(user["classifiers"]) ? { ...user["classifiers"] } : {};
                classifiers[run.classifierId] = {
                    campaignId: run.campaignId,
                    decision,
                    classifiedAt,
                } satisfies StoredClassifierRecord;
                user["classifiers"] = classifiers;
                nextRecords.set(run.userId, user);
                const retainedRecords = this.retained(nextRecords);
                await this.persist(retainedRecords);
                this.records = retainedRecords;
                this.dirty = false;
                return "stored";
            } finally {
                if (this.inFlight.get(run.key) === run) this.inFlight.delete(run.key);
            }
        });
    }

    async releaseClassifierRun(run: ClassifierRun): Promise<void> {
        await this.exclusive(() => {
            if (this.inFlight.get(run.key) === run) this.inFlight.delete(run.key);
        });
    }

    async deleteUser(userId: string): Promise<boolean> {
        return this.exclusive(async () => {
            this.assertDeletable();
            const existed = this.records.has(userId) || this.legacyRecords.has(userId);
            const hadInFlight = [...this.inFlight.values()].some(run => run.userId === userId);
            this.generations.set(userId, this.generation(userId) + 1);
            for (const [key, run] of this.inFlight) {
                if (run.userId === userId) this.inFlight.delete(key);
            }
            if (!existed) return hadInFlight;
            const nextRecords = new Map(this.records);
            const nextLegacy = new Map(this.legacyRecords);
            nextRecords.delete(userId);
            nextLegacy.delete(userId);
            const retainedRecords = this.retained(nextRecords);
            await this.persist(retainedRecords, nextLegacy);
            this.records = retainedRecords;
            this.legacyRecords.clear();
            for (const [key, value] of nextLegacy) this.legacyRecords.set(key, value);
            this.dirty = false;
            return true;
        });
    }

    async reconcileClassifierCampaigns(): Promise<void> {
        const campaign = betaCampaign(this.client);
        await this.exclusive(async () => {
            this.assertUsableWhenRequired();
            const nextRecords = pruneRecords(this.records, campaign);
            const changed = !mapsEqual(this.records, nextRecords);
            if (changed || this.dirty) {
                await this.persist(nextRecords);
                this.records = nextRecords;
                this.dirty = false;
            }
            for (const [key, run] of this.inFlight) {
                if (
                    run.classifierId === BETA_CLASSIFIER_ID &&
                    (!campaign || run.campaignId !== campaign.campaignId || !classifierCampaignIsActive(campaign))
                ) {
                    this.inFlight.delete(key);
                }
            }
        });
        this.scheduleCampaignExpiry(campaign);
    }

    async flushNow(): Promise<void> {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        await this.exclusive(async () => {
            if (!this.dirty) return;
            const retainedRecords = this.retained(this.records);
            await this.persist(retainedRecords);
            this.records = retainedRecords;
            this.dirty = false;
        });
    }

    private load(): void {
        let key: Buffer;
        try {
            key = keyFromEnv(this.keyEnv);
        } catch (error) {
            if (this.persistenceRequired()) throw error;
            this.loadFailed = existsSync(this.storePath);
            return;
        }
        if (!existsSync(this.storePath)) return;
        try {
            const parsed: unknown = JSON.parse(readFileSync(this.storePath, "utf8"));
            const encrypted = isEncryptedJsonEnvelope(parsed);
            const raw: unknown = encrypted ? decryptJson<unknown>(parsed, key) : parsed;
            if (!isRecord(raw)) throw new Error(`user interaction store at ${this.storePath} is not an object`);
            for (const [userId, record] of Object.entries(raw)) {
                if (isRecord(record)) this.records.set(userId, record);
                else this.legacyRecords.set(userId, record);
            }
            this.dirty = !encrypted;
        } catch (error) {
            if (this.persistenceRequired()) throw error;
            this.loadFailed = true;
            console.error("UserInteractionStore: failed to load; preserving the unreadable file:", error);
        }
    }

    private persistenceRequired(): boolean {
        return Boolean(
            this.client.config.auto_responder?.random_greeting_channel_id ||
            this.client.config.beta_classifier?.enabled ||
            this.client.config.beta_classifier?.target_greeting_enabled,
        );
    }

    private assertUsableWhenRequired(): void {
        this.assertConfigurationUnchanged();
        if (!this.persistenceRequired()) return;
        keyFromEnv(this.keyEnv);
        if (this.loadFailed) throw new Error(`user interaction store at ${this.storePath} could not be loaded`);
    }

    private assertConfigurationUnchanged(): void {
        const configuredPath = this.client.config.auto_responder?.store_path ?? DEFAULT_STORE_PATH;
        const configuredKeyEnv = this.client.config.auto_responder?.encryption_key_env ?? DEFAULT_KEY_ENV;
        if (configuredPath !== this.storePath || configuredKeyEnv !== this.keyEnv) {
            throw new Error("changing the user interaction store path or encryption key requires a restart");
        }
    }

    private assertDeletable(): void {
        this.assertConfigurationUnchanged();
        if (this.loadFailed) throw new Error(`user interaction store at ${this.storePath} could not be loaded`);
        if (existsSync(this.storePath)) keyFromEnv(this.keyEnv);
    }

    private scheduleSave(): void {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            void this.flushNow().catch(error => {
                this.dirty = true;
                console.error("UserInteractionStore: failed to save:", error);
                if (this.saveFailureReported) return;
                this.saveFailureReported = true;
                void this.client
                    .logError(
                        "User interaction store save failed",
                        error instanceof Error ? error : String(error),
                        false,
                    )
                    .catch(() => undefined);
            });
        }, SAVE_DEBOUNCE_MS);
        this.saveTimer.unref();
    }

    private scheduleCampaignExpiry(campaign: ClassifierCampaign | null): void {
        if (this.campaignExpiryTimer) clearTimeout(this.campaignExpiryTimer);
        this.campaignExpiryTimer = undefined;
        if (!campaign) return;
        const startsAt = Date.parse(campaign.startedAt);
        const expiresAt = Date.parse(campaign.startedAt) + CLASSIFIER_CAMPAIGN_RETENTION_MS;
        const now = Date.now();
        if (!Number.isFinite(startsAt) || expiresAt <= now) return;
        const transitionAt = startsAt > now ? startsAt : expiresAt;
        const delay = Math.min(Math.max(1, transitionAt - now + 1), MAX_TIMER_DELAY_MS);
        this.setCampaignTimer(delay);
    }

    private setCampaignTimer(delay: number): void {
        this.campaignExpiryTimer = setTimeout(() => {
            this.campaignExpiryTimer = undefined;
            void this.reconcileClassifierCampaigns().then(
                () => {
                    this.campaignPurgeFailureReported = false;
                },
                error => {
                    console.error("UserInteractionStore: campaign expiry purge failed:", error);
                    if (!this.campaignPurgeFailureReported) {
                        this.campaignPurgeFailureReported = true;
                        void this.client
                            .logError(
                                "Classifier campaign expiry purge failed",
                                error instanceof Error ? error : String(error),
                                false,
                            )
                            .catch(() => undefined);
                    }
                    this.setCampaignTimer(CAMPAIGN_PURGE_RETRY_MS);
                },
            );
        }, delay);
        this.campaignExpiryTimer.unref();
    }

    private retained(records: ReadonlyMap<string, Record<string, unknown>>): Map<string, Record<string, unknown>> {
        return pruneRecords(records, betaCampaign(this.client));
    }

    private async persist(
        records: ReadonlyMap<string, Record<string, unknown>>,
        legacyRecords: ReadonlyMap<string, unknown> = this.legacyRecords,
    ): Promise<void> {
        this.assertUsableWhenRequired();
        const output: Record<string, unknown> = {};
        for (const [userId, record] of legacyRecords) output[userId] = record;
        for (const [userId, record] of records) output[userId] = record;
        const key = keyFromEnv(this.keyEnv);
        await mkdir(dirname(this.storePath), { recursive: true });
        const temporaryPath = `${this.storePath}.tmp`;
        await writeFile(temporaryPath, encryptJson(output, key), { mode: 0o600 });
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, this.storePath);
    }

    private generation(userId: string): number {
        return this.generations.get(userId) ?? 0;
    }

    private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
        const previous = this.operationChain;
        let release!: () => void;
        this.operationChain = new Promise<void>(resolve => {
            release = resolve;
        });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }
}

function betaCampaign(client: KrytenClient): ClassifierCampaign | null {
    const config = client.config.beta_classifier;
    if (!config?.campaign_id || !config.campaign_started_at) return null;
    return {
        classifierId: BETA_CLASSIFIER_ID,
        campaignId: config.campaign_id,
        startedAt: config.campaign_started_at,
    };
}

function greetingRecord(value: Record<string, unknown> | undefined): GreetingRecord | undefined {
    if (!value) return undefined;
    if (typeof value["firstMessageTimestamp"] !== "number" || typeof value["greetedInRandom"] !== "boolean") {
        return undefined;
    }
    const owed = value["owedFullWelcome"];
    if (owed !== undefined && typeof owed !== "boolean") return undefined;
    return {
        firstMessageTimestamp: value["firstMessageTimestamp"],
        greetedInRandom: value["greetedInRandom"],
        ...(owed === undefined ? {} : { owedFullWelcome: owed }),
    };
}

function classifierRecord(
    value: Record<string, unknown> | undefined,
    classifierId: string,
): StoredClassifierRecord | undefined {
    if (!value || !isRecord(value["classifiers"])) return undefined;
    const candidate = value["classifiers"][classifierId];
    if (!isRecord(candidate)) return undefined;
    if (
        typeof candidate["campaignId"] !== "string" ||
        (candidate["decision"] !== "ROUTE" && candidate["decision"] !== "IGNORE") ||
        typeof candidate["classifiedAt"] !== "number"
    ) {
        return undefined;
    }
    return {
        campaignId: candidate["campaignId"],
        decision: candidate["decision"],
        classifiedAt: candidate["classifiedAt"],
    };
}

function campaignGreetingRecord(
    value: Record<string, unknown> | undefined,
    greetingId: string,
): CampaignGreetingRecord | undefined {
    if (!value || !isRecord(value["campaignGreetings"])) return undefined;
    const candidate = value["campaignGreetings"][greetingId];
    if (!isRecord(candidate) || typeof candidate["campaignId"] !== "string") return undefined;
    return { campaignId: candidate["campaignId"] };
}

function classifierRunKey(classifierId: string, userId: string): string {
    return `${classifierId}\u0000${userId}`;
}

function pruneRecords(
    source: ReadonlyMap<string, Record<string, unknown>>,
    beta: ClassifierCampaign | null,
): Map<string, Record<string, unknown>> {
    const output = new Map<string, Record<string, unknown>>();
    const greetingCutoff = Math.floor(Date.now() / 1_000) - GREETING_RETENTION_SECONDS;
    const betaActive = beta ? classifierCampaignIsActive(beta) : false;
    for (const [userId, original] of source) {
        const record = { ...original };
        const greeting = greetingRecord(record);
        if (
            greeting &&
            !greeting.greetedInRandom &&
            !greeting.owedFullWelcome &&
            greeting.firstMessageTimestamp < greetingCutoff
        ) {
            delete record["firstMessageTimestamp"];
            delete record["greetedInRandom"];
            delete record["owedFullWelcome"];
        }
        if (isRecord(record["classifiers"])) {
            const classifiers = { ...record["classifiers"] };
            const existingBeta = classifierRecord(record, BETA_CLASSIFIER_ID);
            if (
                BETA_CLASSIFIER_ID in classifiers &&
                (!existingBeta || !betaActive || existingBeta.campaignId !== beta?.campaignId)
            ) {
                delete classifiers[BETA_CLASSIFIER_ID];
            }
            if (Object.keys(classifiers).length) record["classifiers"] = classifiers;
            else delete record["classifiers"];
        }
        if (isRecord(record["campaignGreetings"])) {
            const greetings = { ...record["campaignGreetings"] };
            const betaGreeting = campaignGreetingRecord(record, BETA_GREETING_ID);
            if (
                BETA_GREETING_ID in greetings &&
                (!betaGreeting || !betaActive || betaGreeting.campaignId !== beta?.campaignId)
            ) {
                delete greetings[BETA_GREETING_ID];
            }
            if (Object.keys(greetings).length) record["campaignGreetings"] = greetings;
            else delete record["campaignGreetings"];
        }
        if (Object.keys(record).length) output.set(userId, record);
    }
    return output;
}

function mapsEqual(
    left: ReadonlyMap<string, Record<string, unknown>>,
    right: ReadonlyMap<string, Record<string, unknown>>,
): boolean {
    if (left.size !== right.size) return false;
    for (const [key, value] of left) {
        const other = right.get(key);
        if (!other || JSON.stringify(value) !== JSON.stringify(other)) return false;
    }
    return true;
}
