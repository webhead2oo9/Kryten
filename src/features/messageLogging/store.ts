import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { decryptJson, encryptJson, isEncryptedJsonEnvelope } from "../../utils/encryptedJson";
import { MessageLogEvent, MessageSnapshot, StoredOutboxEvent } from "./types";

const STORE_SENTINEL = "kryten-message-logging-v1";
const RETENTION_META_KEY = "snapshot-retention-ms";
const OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const OUTBOX_CAP = 10_000;
/**
 * Delay before an event's first delivery attempt, giving the audit-log feed time
 * to deliver the entry that names the moderator. The logger resolves attribution
 * on the same schedule, so the two must stay in step.
 */
export const OUTBOX_FIRST_ATTEMPT_MS = 1_500;

interface EncryptedRow {
    encrypted_payload: string;
}

interface OutboxRow extends EncryptedRow {
    attempts: number;
}

function decryptPayload<T>(payload: string, key: Buffer): T {
    const parsed: unknown = JSON.parse(payload);
    if (!isEncryptedJsonEnvelope(parsed)) throw new Error("Encrypted message-log row has an invalid envelope");
    return decryptJson<T>(parsed, key);
}

export class MessageLogStore {
    private readonly db: Database.Database;
    private droppedEvents = 0;

    constructor(
        readonly dbPath: string,
        private readonly key: Buffer,
        private retentionMs: number,
        private maxSnapshots: number,
    ) {
        mkdirSync(dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS message_log_meta (
                key TEXT PRIMARY KEY,
                encrypted_value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS message_snapshots (
                message_id TEXT PRIMARY KEY,
                created_at_ms INTEGER NOT NULL,
                expires_at_ms INTEGER NOT NULL,
                encrypted_payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_message_snapshots_expiry
                ON message_snapshots(expires_at_ms);
            CREATE INDEX IF NOT EXISTS idx_message_snapshots_created
                ON message_snapshots(created_at_ms);
            CREATE TABLE IF NOT EXISTS message_log_outbox (
                event_id TEXT PRIMARY KEY,
                created_at_ms INTEGER NOT NULL,
                next_attempt_at_ms INTEGER NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                encrypted_payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_message_log_outbox_due
                ON message_log_outbox(next_attempt_at_ms, created_at_ms);
        `);
        this.verifyKey();
        this.initializeRetention();
    }

    private verifyKey(): void {
        const row = this.db
            .prepare("SELECT encrypted_value AS encrypted_payload FROM message_log_meta WHERE key = 'sentinel'")
            .get() as EncryptedRow | undefined;
        if (!row) {
            this.db
                .prepare("INSERT INTO message_log_meta (key, encrypted_value) VALUES ('sentinel', ?)")
                .run(encryptJson({ sentinel: STORE_SENTINEL }, this.key));
            return;
        }
        try {
            const value = decryptPayload<{ sentinel?: string }>(row.encrypted_payload, this.key);
            if (value.sentinel !== STORE_SENTINEL) throw new Error("unexpected sentinel");
        } catch {
            this.db.close();
            throw new Error("Message logging database cannot be decrypted with the configured encryption key");
        }
    }

    private initializeRetention(): void {
        const row = this.db
            .prepare("SELECT encrypted_value AS encrypted_payload FROM message_log_meta WHERE key = ?")
            .get(RETENTION_META_KEY) as EncryptedRow | undefined;
        if (!row) {
            this.db
                .prepare("INSERT INTO message_log_meta (key, encrypted_value) VALUES (?, ?)")
                .run(RETENTION_META_KEY, encryptJson({ retentionMs: this.retentionMs }, this.key));
            this.sweep();
            return;
        }
        let storedRetentionMs: number;
        try {
            const value = decryptPayload<{ retentionMs?: number }>(row.encrypted_payload, this.key);
            if (!Number.isSafeInteger(value.retentionMs) || value.retentionMs! <= 0)
                throw new Error("invalid retention");
            storedRetentionMs = value.retentionMs!;
        } catch {
            this.db.close();
            throw new Error("Message logging database contains invalid retention metadata");
        }
        const configuredRetentionMs = this.retentionMs;
        this.retentionMs = storedRetentionMs;
        this.reconfigure(configuredRetentionMs, this.maxSnapshots);
    }

    reconfigure(retentionMs: number, maxSnapshots: number): void {
        const previousRetentionMs = this.retentionMs;
        const previousMaxSnapshots = this.maxSnapshots;
        this.retentionMs = retentionMs;
        this.maxSnapshots = maxSnapshots;
        try {
            this.db.transaction(() => {
                if (retentionMs !== previousRetentionMs) {
                    // Each expiry was written as capture-time + the then-active
                    // retention. Shifting by the delta preserves that capture
                    // time while applying the new policy to existing rows.
                    this.db
                        .prepare("UPDATE message_snapshots SET expires_at_ms = expires_at_ms + ?")
                        .run(retentionMs - previousRetentionMs);
                    this.db
                        .prepare("UPDATE message_log_meta SET encrypted_value = ? WHERE key = ?")
                        .run(encryptJson({ retentionMs }, this.key), RETENTION_META_KEY);
                }
                this.sweep();
            })();
        } catch (error) {
            this.retentionMs = previousRetentionMs;
            this.maxSnapshots = previousMaxSnapshots;
            throw error;
        }
    }

    close(): void {
        this.db.pragma("wal_checkpoint(TRUNCATE)");
        this.db.close();
    }

    saveSnapshot(snapshot: MessageSnapshot): void {
        const expiresAt = Date.now() + this.retentionMs;
        this.db
            .prepare(
                `INSERT INTO message_snapshots (message_id, created_at_ms, expires_at_ms, encrypted_payload)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(message_id) DO UPDATE SET
                    expires_at_ms = excluded.expires_at_ms,
                    encrypted_payload = excluded.encrypted_payload`,
            )
            .run(snapshot.messageId, snapshot.createdAtMs, expiresAt, encryptJson(snapshot, this.key));
    }

    getSnapshot(messageId: string): MessageSnapshot | null {
        const row = this.db
            .prepare("SELECT encrypted_payload FROM message_snapshots WHERE message_id = ? AND expires_at_ms > ?")
            .get(messageId, Date.now()) as EncryptedRow | undefined;
        if (!row) return null;
        try {
            return decryptPayload<MessageSnapshot>(row.encrypted_payload, this.key);
        } catch {
            this.db.prepare("DELETE FROM message_snapshots WHERE message_id = ?").run(messageId);
            return null;
        }
    }

    commitEvent(event: MessageLogEvent, replacement: MessageSnapshot | null, deleteIds: readonly string[]): void {
        const transaction = this.db.transaction(() => {
            for (const id of deleteIds) this.db.prepare("DELETE FROM message_snapshots WHERE message_id = ?").run(id);
            if (replacement) {
                const expiresAt = Date.now() + this.retentionMs;
                this.db
                    .prepare(
                        `INSERT INTO message_snapshots (message_id, created_at_ms, expires_at_ms, encrypted_payload)
                         VALUES (?, ?, ?, ?)
                         ON CONFLICT(message_id) DO UPDATE SET
                            expires_at_ms = excluded.expires_at_ms,
                            encrypted_payload = excluded.encrypted_payload`,
                    )
                    .run(replacement.messageId, replacement.createdAtMs, expiresAt, encryptJson(replacement, this.key));
            }
            this.db
                .prepare(
                    `INSERT OR IGNORE INTO message_log_outbox
                     (event_id, created_at_ms, next_attempt_at_ms, attempts, encrypted_payload)
                     VALUES (?, ?, ?, 0, ?)`,
                )
                .run(
                    event.eventId,
                    event.occurredAtMs,
                    Date.now() + OUTBOX_FIRST_ATTEMPT_MS,
                    encryptJson(event, this.key),
                );
            this.enforceOutboxCap();
        });
        transaction();
    }

    nextDue(now = Date.now()): StoredOutboxEvent | null {
        const row = this.db
            .prepare(
                `SELECT encrypted_payload, attempts FROM message_log_outbox
                 WHERE next_attempt_at_ms <= ? ORDER BY created_at_ms LIMIT 1`,
            )
            .get(now) as OutboxRow | undefined;
        if (!row) return null;
        try {
            return { event: decryptPayload<MessageLogEvent>(row.encrypted_payload, this.key), attempts: row.attempts };
        } catch {
            this.db.prepare("DELETE FROM message_log_outbox WHERE encrypted_payload = ?").run(row.encrypted_payload);
            return null;
        }
    }

    markSent(eventId: string): void {
        this.db.prepare("DELETE FROM message_log_outbox WHERE event_id = ?").run(eventId);
    }

    retry(eventId: string, attempts: number, nextAttemptAtMs: number): void {
        this.db
            .prepare("UPDATE message_log_outbox SET attempts = ?, next_attempt_at_ms = ? WHERE event_id = ?")
            .run(attempts, nextAttemptAtMs, eventId);
    }

    sweep(now = Date.now()): void {
        this.db.prepare("DELETE FROM message_snapshots WHERE expires_at_ms <= ?").run(now);
        this.db.prepare("DELETE FROM message_log_outbox WHERE created_at_ms <= ?").run(now - OUTBOX_RETENTION_MS);
        this.enforceSnapshotCap();
        this.enforceOutboxCap();
    }

    snapshotCount(): number {
        return (this.db.prepare("SELECT COUNT(*) AS n FROM message_snapshots").get() as { n: number }).n;
    }

    pendingCount(): number {
        return (this.db.prepare("SELECT COUNT(*) AS n FROM message_log_outbox").get() as { n: number }).n;
    }

    /** Undelivered events discarded to stay under the outbox cap, since this store opened. */
    droppedCount(): number {
        return this.droppedEvents;
    }

    /**
     * Walks the whole table, so it runs only from `sweep()` (hourly) and
     * `reconfigure()` — never from `saveSnapshot`, which every message in the
     * guild hits before any other pipeline feature runs. `retention_days` is
     * the primary bound; this one just keeps the file from growing without one.
     */
    private enforceSnapshotCap(): void {
        this.db
            .prepare(
                `DELETE FROM message_snapshots WHERE message_id IN (
                    SELECT message_id FROM message_snapshots
                    ORDER BY created_at_ms DESC LIMIT -1 OFFSET ?
                )`,
            )
            .run(this.maxSnapshots);
    }

    private enforceOutboxCap(): void {
        const info = this.db
            .prepare(
                `
            DELETE FROM message_log_outbox WHERE event_id IN (
                SELECT event_id FROM message_log_outbox
                ORDER BY created_at_ms DESC LIMIT -1 OFFSET ${OUTBOX_CAP}
            )
        `,
            )
            .run();
        this.droppedEvents += info.changes;
    }
}
