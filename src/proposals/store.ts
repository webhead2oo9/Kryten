/**
 * SQLite-backed store for staged command proposals (better-sqlite3, WAL).
 *
 * Concurrency model: better-sqlite3 is synchronous, so each method runs to
 * completion before another interaction callback can interleave. The
 * approve-path claim is a conditional UPDATE (`WHERE status='pending'`)
 * checked via `info.changes` — the double-click gate. Never SELECT-then-
 * UPDATE for a status transition.
 *
 * Lifecycle: pending → applying → approved | conflict | failed
 *            pending → rejected | expired | failed(staging)
 */
import Database from "better-sqlite3";
import { randomBytes } from "crypto";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { ProposalOperation, ProposalRecord, ProposalStatus } from "./types";

export const DEFAULT_PROPOSAL_TTL_HOURS = 72;

interface Row {
    proposal_id: string;
    operation: string;
    command_name: string;
    proposed_command: string | null;
    proposed_edits: string | null;
    base_commands_sha: string | null;
    status: string;
    proposer: string | null;
    rationale: string | null;
    review_message_id: string | null;
    committed_sha: string | null;
    created_at_ms: number;
    expires_at_ms: number;
    resolved_at_ms: number | null;
    resolved_by: string | null;
    resolution_note: string | null;
}

function rowToRecord(row: Row): ProposalRecord {
    const record: ProposalRecord = {
        proposalId: row.proposal_id,
        operation: row.operation as ProposalOperation,
        commandName: row.command_name,
        status: row.status as ProposalStatus,
        createdAtMs: row.created_at_ms,
        expiresAtMs: row.expires_at_ms,
    };
    if (row.proposed_command !== null) record.proposedCommand = JSON.parse(row.proposed_command);
    if (row.proposed_edits !== null) record.proposedEdits = JSON.parse(row.proposed_edits);
    if (row.base_commands_sha !== null) record.baseCommandsSha = row.base_commands_sha;
    if (row.proposer !== null) record.proposer = row.proposer;
    if (row.rationale !== null) record.rationale = row.rationale;
    if (row.review_message_id !== null) record.reviewMessageId = row.review_message_id;
    if (row.committed_sha !== null) record.committedSha = row.committed_sha;
    if (row.resolved_at_ms !== null) record.resolvedAtMs = row.resolved_at_ms;
    if (row.resolved_by !== null) record.resolvedBy = row.resolved_by;
    if (row.resolution_note !== null) record.resolutionNote = row.resolution_note;
    return record;
}

export class ProposalStore {
    private readonly db: Database.Database;
    /** Retained so /reload_config can detect a ttl_hours/db_path change and rebuild. */
    readonly dbPath: string;
    readonly ttlMs: number;

    constructor(dbPath: string, ttlMs: number = DEFAULT_PROPOSAL_TTL_HOURS * 3600 * 1000) {
        this.dbPath = dbPath;
        this.ttlMs = ttlMs;
        mkdirSync(dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS command_proposals (
                proposal_id       TEXT PRIMARY KEY,
                operation         TEXT NOT NULL CHECK (operation IN ('create','delete','patch')),
                command_name      TEXT NOT NULL,
                proposed_command  TEXT,
                proposed_edits    TEXT,
                base_commands_sha TEXT,
                status            TEXT NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','applying','approved','rejected','expired','conflict','failed')),
                proposer          TEXT,
                rationale         TEXT,
                review_message_id TEXT,
                committed_sha     TEXT,
                created_at_ms     INTEGER NOT NULL,
                expires_at_ms     INTEGER NOT NULL,
                resolved_at_ms    INTEGER,
                resolved_by       TEXT,
                resolution_note   TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_proposals_status ON command_proposals(status);
        `);
    }

    close(): void {
        this.db.close();
    }

    createProposal(input: {
        operation: ProposalOperation;
        commandName: string;
        proposedCommand?: Record<string, unknown>;
        proposedEdits?: unknown[];
        baseCommandsSha?: string;
        proposer?: string;
        rationale?: string;
    }): ProposalRecord {
        const now = Date.now();
        const proposalId = randomBytes(16).toString("hex");
        this.db
            .prepare(
                `INSERT INTO command_proposals
                 (proposal_id, operation, command_name, proposed_command, proposed_edits, base_commands_sha,
                  status, proposer, rationale, created_at_ms, expires_at_ms)
                 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
            )
            .run(
                proposalId,
                input.operation,
                input.commandName,
                input.proposedCommand !== undefined ? JSON.stringify(input.proposedCommand) : null,
                input.proposedEdits !== undefined ? JSON.stringify(input.proposedEdits) : null,
                input.baseCommandsSha ?? null,
                input.proposer ?? null,
                input.rationale ?? null,
                now,
                now + this.ttlMs,
            );
        return this.get(proposalId)!;
    }

    get(proposalId: string): ProposalRecord | null {
        const row = this.db.prepare("SELECT * FROM command_proposals WHERE proposal_id = ?").get(proposalId) as
            | Row
            | undefined;
        return row ? rowToRecord(row) : null;
    }

    setReviewMessageId(proposalId: string, messageId: string): void {
        this.db
            .prepare("UPDATE command_proposals SET review_message_id = ? WHERE proposal_id = ?")
            .run(messageId, proposalId);
    }

    countPending(): number {
        const row = this.db.prepare("SELECT COUNT(*) AS n FROM command_proposals WHERE status = 'pending'").get() as {
            n: number;
        };
        return row.n;
    }

    /** Most recent pending proposal with the same operation + command name. */
    findPendingDuplicate(operation: ProposalOperation, commandName: string): ProposalRecord | null {
        const row = this.db
            .prepare(
                `SELECT * FROM command_proposals
                 WHERE status = 'pending' AND operation = ? AND command_name = ?
                 ORDER BY created_at_ms DESC LIMIT 1`,
            )
            .get(operation, commandName) as Row | undefined;
        return row ? rowToRecord(row) : null;
    }

    private runExpireStale(now: number): number {
        return this.db
            .prepare(
                `UPDATE command_proposals
                 SET status = 'expired', resolved_at_ms = ?, resolution_note = 'expired (TTL)'
                 WHERE status = 'pending' AND expires_at_ms <= ?`,
            )
            .run(now, now).changes;
    }

    expireStale(): number {
        return this.runExpireStale(Date.now());
    }

    /**
     * Delete terminal (resolved/expired) rows older than the retention window.
     * The TTL only flips status; without this the table — carrying each proposal's
     * full serialized body — grows without bound over the DB's lifetime.
     */
    purgeResolved(retentionMs: number): number {
        return this.db
            .prepare(
                `DELETE FROM command_proposals
                 WHERE status NOT IN ('pending','applying')
                   AND resolved_at_ms IS NOT NULL AND resolved_at_ms < ?`,
            )
            .run(Date.now() - retentionMs).changes;
    }

    /**
     * Fail any proposal stuck in 'applying'. An approve claims a row (pending →
     * applying) up front, and no in-flight approve survives a process restart —
     * so at startup every 'applying' row is a crash between the claim and its
     * terminal update. expireStale() only touches 'pending', so these would
     * otherwise be un-claimable, un-expirable, and their card permanently dead.
     * Mark them failed so staff can re-submit; the GitHub commit may or may not
     * have landed, and the commands poller reconciles either way.
     */
    failStaleApplying(): number {
        return this.db
            .prepare(
                `UPDATE command_proposals
                 SET status = 'failed', resolved_at_ms = ?, resolution_note = 'interrupted while applying (bot restarted)'
                 WHERE status = 'applying'`,
            )
            .run(Date.now()).changes;
    }

    /**
     * Atomically claim a pending proposal for resolution (pending → applying).
     * Returns the claimed record, or null when this caller lost the race /
     * the proposal was already resolved or expired.
     */
    claimForResolution(proposalId: string): ProposalRecord | null {
        const claim = this.db.transaction((id: string): ProposalRecord | null => {
            const now = Date.now();
            this.runExpireStale(now);
            const info = this.db
                .prepare(
                    `UPDATE command_proposals
                     SET status = 'applying'
                     WHERE proposal_id = ? AND status = 'pending' AND expires_at_ms > ?`,
                )
                .run(id, now);
            if (info.changes !== 1) return null;
            return this.get(id);
        });
        return claim(proposalId);
    }

    private resolveFromApplying(
        proposalId: string,
        status: "approved" | "conflict" | "failed",
        resolvedBy: string | undefined,
        note: string | undefined,
        committedSha?: string,
    ): ProposalRecord | null {
        const info = this.db
            .prepare(
                `UPDATE command_proposals
                 SET status = ?, resolved_at_ms = ?, resolved_by = ?, resolution_note = ?, committed_sha = ?
                 WHERE proposal_id = ? AND status = 'applying'`,
            )
            .run(status, Date.now(), resolvedBy ?? null, note ?? null, committedSha ?? null, proposalId);
        return info.changes === 1 ? this.get(proposalId) : null;
    }

    markApproved(proposalId: string, resolvedBy: string, committedSha?: string, note?: string): ProposalRecord | null {
        return this.resolveFromApplying(proposalId, "approved", resolvedBy, note, committedSha);
    }

    markConflict(proposalId: string, resolvedBy: string | undefined, note: string): ProposalRecord | null {
        return this.resolveFromApplying(proposalId, "conflict", resolvedBy, note);
    }

    markFailed(
        proposalId: string,
        resolvedBy: string | undefined,
        note: string,
        committedSha?: string,
    ): ProposalRecord | null {
        return this.resolveFromApplying(proposalId, "failed", resolvedBy, note, committedSha);
    }

    /** Reject requires the proposal to still be pending (not mid-approve). */
    markRejected(proposalId: string, resolvedBy: string, note?: string): ProposalRecord | null {
        const reject = this.db.transaction((id: string): ProposalRecord | null => {
            const now = Date.now();
            this.runExpireStale(now);
            const info = this.db
                .prepare(
                    `UPDATE command_proposals
                     SET status = 'rejected', resolved_at_ms = ?, resolved_by = ?, resolution_note = ?
                     WHERE proposal_id = ? AND status = 'pending' AND expires_at_ms > ?`,
                )
                .run(now, resolvedBy, note ?? null, id, now);
            return info.changes === 1 ? this.get(id) : null;
        });
        return reject(proposalId);
    }

    /** The review card could not be posted; the proposal never became actionable. */
    markStagingFailed(proposalId: string, note: string): void {
        this.db
            .prepare(
                `UPDATE command_proposals
                 SET status = 'failed', resolved_at_ms = ?, resolution_note = ?
                 WHERE proposal_id = ? AND status = 'pending'`,
            )
            .run(Date.now(), note, proposalId);
    }
}
