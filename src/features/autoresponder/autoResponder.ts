import { existsSync, readFileSync } from "fs";
import { mkdir, rename, writeFile } from "fs/promises";
import { dirname } from "path";
import { Message, TextChannel } from "discord.js";
import { KrytenClient } from "../../classes/client";
import { decryptJson, encryptJson, isEncryptedJsonEnvelope, isRecord, keyFromEnv } from "../../utils/encryptedJson";

const DEFAULT_ENCRYPTION_KEY_ENV = "USER_INTERACTIONS_ENCRYPTION_KEY";
// Persistence is debounced off the message hot path: coalesce a burst of
// newcomers into one async encrypt+write instead of a synchronous whole-file
// write per message. Short, so a crash loses at most ~1s of greeted-flag writes.
const SAVE_DEBOUNCE_MS = 1000;
// Drop never-greeted records older than this so the store doesn't accrue one row
// per user ever seen. Greeted (and owed-welcome) records are kept forever so a
// veteran is never re-welcomed.
const RECORD_RETENTION_SECONDS = 30 * 24 * 3600;

interface UserRecord {
    firstMessageTimestamp: number; // unix seconds
    greetedInRandom: boolean;
    // The full "welcome to the server" greeting was selected but its send hasn't
    // succeeded yet. Persisted so a retry on the user's next message doesn't fall
    // through to the generic greeting once the first-message time window passes.
    owedFullWelcome?: boolean;
}

/**
 * Tracks each user's first-seen time and greets newcomers in the configured
 * "random" channel. State is persisted to a small JSON file — a one-row-per-user
 * store doesn't justify a native SQLite dependency.
 */
export class AutoResponder {
    private readonly store = new Map<string, UserRecord>();
    // Records whose shape isn't recognized are carried through every save
    // verbatim instead of being destroyed by the plaintext→encrypted rewrite.
    // Recognized records win on key collision.
    private readonly legacyRecords = new Map<string, unknown>();
    // Users with a greeting send currently in flight. Prevents two messages fired
    // in quick succession from both passing the greeted guard and double-greeting,
    // now that the greeted flag is only persisted after a successful send.
    private readonly greetInFlight = new Set<string>();
    // Set when load() found a present-but-unreadable store and continued empty
    // (greeter disabled). Gates save() so a later write can't silently clobber the
    // unread on-disk file — e.g. after the greeter is enabled live via /reload_config.
    private loadFailed = false;
    // One staff-visible page per process for save failures: a greeter enabled
    // live without a working key fails EVERY save, and console-only errors
    // would hide that the greeted-set isn't being persisted at all.
    private saveFailureReported = false;
    // Debounced async persistence state (see SAVE_DEBOUNCE_MS).
    private saveTimer?: NodeJS.Timeout;
    private saveQueued = false;
    private flushing = false;

    constructor(private readonly client: KrytenClient) {
        this.load();
    }

    /**
     * Read fresh each use. Note: load() runs only in the constructor, so changing
     * store_path via /reload_config redirects future *writes* to the new path
     * without re-reading it — a restart is required to actually load a different
     * store. (Kept a getter so save() always targets the currently-configured path.)
     */
    private get storePath(): string {
        return this.client.config.auto_responder?.store_path ?? "./data/user_interactions.json";
    }

    private get keyEnv(): string {
        return this.client.config.auto_responder?.encryption_key_env ?? DEFAULT_ENCRYPTION_KEY_ENV;
    }

    /** Whether the greeter is actually configured; gates whether store errors are fatal. */
    private get greeterInUse(): boolean {
        return Boolean(this.client.config.auto_responder?.random_greeting_channel_id);
    }

    private isUserRecord(value: unknown): value is UserRecord {
        if (!isRecord(value)) return false;
        return (
            typeof value["firstMessageTimestamp"] === "number" &&
            typeof value["greetedInRandom"] === "boolean" &&
            (value["owedFullWelcome"] === undefined || typeof value["owedFullWelcome"] === "boolean")
        );
    }

    /**
     * Load the encrypted store. Failures (missing/invalid key, or an unreadable/
     * corrupt/undecryptable/misshapen store) are FATAL only when the greeter is in
     * use (random_greeting_channel_id set): running without the greeted-set would
     * re-welcome veterans and running without a key would lose state or write PII
     * in plaintext, so the error propagates and startup (index.ts) treats it as
     * fatal. When the greeter is unconfigured, the same failures are non-fatal — we
     * log and continue with an empty in-memory store so an irrelevant state file
     * can't crash an unrelated deployment's boot; in that case save() preserves
     * (never clobbers) the on-disk file it couldn't read.
     */
    private load(): void {
        let key: Buffer;
        try {
            key = keyFromEnv(this.keyEnv);
        } catch (error) {
            if (this.greeterInUse) throw error;
            // Present-but-unreadable (no key): gate save() so it preserves the
            // file instead of clobbering it if a working key arrives later.
            this.loadFailed = existsSync(this.storePath);
            return;
        }

        if (!existsSync(this.storePath)) return;

        try {
            const parsed: unknown = JSON.parse(readFileSync(this.storePath, "utf8"));
            const encrypted = isEncryptedJsonEnvelope(parsed);
            const raw: unknown = encrypted ? decryptJson<unknown>(parsed, key) : parsed;

            if (!isRecord(raw)) {
                throw new Error(`user interaction store at ${this.storePath} is not an object`);
            }

            let unrecognized = 0;
            for (const [userId, record] of Object.entries(raw)) {
                if (this.isUserRecord(record)) {
                    this.store.set(userId, record);
                } else {
                    this.legacyRecords.set(userId, record);
                    unrecognized++;
                }
            }
            if (unrecognized > 0) {
                console.warn(`AutoResponder: carrying ${unrecognized} unrecognized store record(s) through unchanged.`);
            }

            if (!encrypted) {
                console.warn("AutoResponder: user interaction store was plaintext; rewriting it encrypted.");
                this.scheduleSave();
            }
        } catch (error) {
            if (this.greeterInUse) throw error;
            // Present but unreadable: continue empty, and gate save() so it won't
            // clobber the file we couldn't read.
            this.loadFailed = true;
            console.error(
                "AutoResponder: failed to load user interaction store; continuing with an empty store:",
                error,
            );
        }
    }

    /** Queue a debounced async flush; coalesces bursts off the message hot path. */
    private scheduleSave(): void {
        this.saveQueued = true;
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            void this.flush();
        }, SAVE_DEBOUNCE_MS);
        this.saveTimer.unref();
    }

    /**
     * Flush any pending debounced write immediately (graceful shutdown): the
     * debounce timer is unref'd, so without this a write queued in the last
     * ~1s before process.exit is lost and those users are re-greeted after
     * restart.
     */
    async flushNow(): Promise<void> {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        // Wait out an in-flight flush first: flush() no-ops while one is
        // running, and the in-flight write may leave saveQueued set behind it
        // (a record raced in mid-write). One trailing flush drains that
        // remainder; a FAILED flush is not retried — shutdown must not spin
        // on a broken disk/key.
        while (this.flushing) await new Promise<void>(resolve => setImmediate(() => resolve()));
        await this.flush();
    }

    /** Drop never-greeted records past the retention window (see RECORD_RETENTION_SECONDS). */
    private pruneStale(): void {
        const cutoff = Math.floor(Date.now() / 1000) - RECORD_RETENTION_SECONDS;
        for (const [userId, record] of this.store) {
            if (!record.greetedInRandom && !record.owedFullWelcome && record.firstMessageTimestamp < cutoff) {
                this.store.delete(userId);
            }
        }
    }

    private async flush(): Promise<void> {
        if (!this.saveQueued || this.flushing) return;
        this.flushing = true;
        this.saveQueued = false;
        let failed = false;
        try {
            const key = keyFromEnv(this.keyEnv);
            await mkdir(dirname(this.storePath), { recursive: true });
            // load() couldn't read an existing store and we continued empty — don't
            // silently overwrite that file with our empty state (e.g. after a live
            // /reload_config enables the greeter). Preserve it once as `.corrupt` so
            // the unread data isn't lost; if even that fails, refuse to write.
            if (this.loadFailed && existsSync(this.storePath)) {
                try {
                    await rename(this.storePath, `${this.storePath}.corrupt`);
                    console.warn(
                        `AutoResponder: preserved the unreadable store as ${this.storePath}.corrupt before writing a fresh one.`,
                    );
                } catch (error) {
                    console.error(
                        "AutoResponder: refusing to overwrite an unreadable store we couldn't preserve:",
                        error,
                    );
                    return;
                }
            }
            this.loadFailed = false;
            this.pruneStale();
            const obj: Record<string, unknown> = {};
            for (const [userId, record] of this.legacyRecords) obj[userId] = record;
            for (const [userId, record] of this.store) obj[userId] = record;
            // Atomic write: a crash mid-write must not corrupt the store.
            const tmp = `${this.storePath}.tmp`;
            await writeFile(tmp, encryptJson(obj, key));
            await rename(tmp, this.storePath);
        } catch (error) {
            failed = true;
            this.saveQueued = true; // keep the data queued; the next message retries
            console.error("AutoResponder: failed to save store:", error);
            if (!this.saveFailureReported) {
                this.saveFailureReported = true;
                void this.client
                    .logError("AutoResponder store save failed", error instanceof Error ? error : String(error), false)
                    .catch(() => undefined);
            }
        } finally {
            this.flushing = false;
            // Reschedule only to chase a write that arrived DURING a successful
            // flush (its scheduleSave saw flushing and may have left no timer). A
            // FAILED flush is NOT rescheduled here — it waits for the next
            // scheduleSave (next message) rather than spinning every second while
            // the disk/key stays broken.
            if (this.saveQueued && !this.saveTimer && !failed) this.scheduleSave();
        }
    }

    private settings(): { trackChannelIds: string[]; randomGreetingChannelId: string } {
        const c = this.client.config.auto_responder ?? {};
        return {
            trackChannelIds: c.auto_response_channel_ids ?? [],
            randomGreetingChannelId: c.random_greeting_channel_id ?? "",
        };
    }

    /** No tracking channels configured → track everywhere (legacy fallback). */
    private shouldTrack(channelId: string, trackChannelIds: string[]): boolean {
        return trackChannelIds.length === 0 || trackChannelIds.includes(channelId);
    }

    async process(message: Message): Promise<void> {
        if (message.author.bot) return;
        const s = this.settings();
        if (!s.randomGreetingChannelId) return; // greeting disabled → nothing to track/do

        const currentTime = Math.floor(message.createdTimestamp / 1000);
        const userId = message.author.id;

        // INSERT-OR-IGNORE semantics: only record the first time we see a user.
        if (this.shouldTrack(message.channelId, s.trackChannelIds) && !this.store.has(userId)) {
            this.store.set(userId, { firstMessageTimestamp: currentTime, greetedInRandom: false });
            this.scheduleSave();
        }

        await this.handleRandomGreeting(message, s.randomGreetingChannelId, currentTime);
    }

    private async handleRandomGreeting(message: Message, randomChannelId: string, currentTime: number): Promise<void> {
        if (message.channelId !== randomChannelId) return;

        const userId = message.author.id;
        const channel = message.channel as TextChannel;
        const record = this.store.get(userId);

        // Greet each user at most once. greetedInRandom is persisted only after a
        // successful send (a failed send retries next message); greetInFlight stops
        // two rapid messages from both greeting before that send resolves.
        if (record?.greetedInRandom) return;
        if (this.greetInFlight.has(userId)) return;

        let greeting: string;
        let isFullWelcome = false;
        if (!record) {
            // NOTE: `process()` records first-seen *before* calling this, so when
            // tracking is global (no auto_response_channel_ids) the record always
            // exists here and the long welcome below fires. This short welcome is
            // only reached under restricted tracking where the random channel is
            // not in the tracked list and the user hasn't been seen elsewhere yet.
            greeting = `Welcome to the server, ${message.author}! It's great to have you here!`;
        } else if (record.owedFullWelcome || Math.abs(record.firstMessageTimestamp - currentTime) <= 2) {
            greeting =
                `Welcome to the Virtual Desktop Discord server, ${message.author}! We're glad you've joined our Discord. ` +
                "If you have any questions or need assistance with Virtual Desktop, please head over to the 'Virtual Desktop Help' category " +
                "and post in one of the support channels there. Our team and community members will be happy to help you out. " +
                "Feel free to explore the other channels and get involved in discussions once your issue is resolved. Enjoy your stay!";
            isFullWelcome = true;
        } else {
            greeting =
                `Hey ${message.author}! Welcome to the random channel! Feel free to chat about anything here, as long as it follows the server rules. ` +
                "If you have any Virtual Desktop related questions, the 'Virtual Desktop Help' category is the perfect place to ask.";
        }

        this.greetInFlight.add(userId);
        try {
            await channel.send(greeting);
            const current = this.store.get(userId) ?? { firstMessageTimestamp: currentTime, greetedInRandom: false };
            current.greetedInRandom = true;
            delete current.owedFullWelcome;
            this.store.set(userId, current);
            this.scheduleSave();
        } catch (error) {
            console.error("AutoResponder: error handling random greeting:", error);
            // Remember an owed full welcome so the retry doesn't downgrade to the
            // generic greeting once the first-message time window has elapsed.
            if (isFullWelcome && record && !record.owedFullWelcome) {
                record.owedFullWelcome = true;
                this.scheduleSave();
            }
        } finally {
            this.greetInFlight.delete(userId);
        }
    }
}
