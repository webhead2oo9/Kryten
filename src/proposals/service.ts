/**
 * Orchestrates LLM-proposed command changes through staff review: validates
 * an incoming proposal against the live corpus, dedupes and rate-limits,
 * stages it in SQLite, posts the review card, and — on staff approval —
 * re-applies the change against the live GitHub file and commits it.
 */
import type { KrytenClient } from "../classes/client";
import { WriteResult, clampCommitMessage, sanitizeCommitAuthor } from "../github/contentsApi";
import { CustomCommand } from "../types";
import { NAME_PATTERN, normalizeName } from "../utils/format";
import { jsonClone } from "../utils/jsonClone";
import { validateCustomCommandDetailed } from "../utils/validateCommand";
import { ProposalConflictError, ProposalValidationError, applyPatchEdits } from "./patchEngine";
import { ProposalStore } from "./store";
import { ProposalOperation, ProposalRecord, ResolutionResult, SubmitResult } from "./types";

const DEFAULT_MAX_PENDING = 5;
const SWEEP_INTERVAL_MS = 6 * 3600 * 1000;
// Keep resolved/expired rows a week past resolution for auditing, then reclaim.
const RESOLVED_RETENTION_MS = 7 * 24 * 3600 * 1000;
const FULL_BODY_EDIT_UNSUPPORTED =
    "Full-body edit proposals are not supported; submit semantic patch edits in 'edits' instead.";

/** Posts the review card; Discord-coupled implementation lives in proposalHandler. */
export interface Reviewer {
    postReviewCard(
        record: ProposalRecord,
    ): Promise<{ messageId: string } | { error: { message: string; contentRejected: boolean } }>;
}

export interface SubmitInput {
    operation?: unknown;
    commandName?: unknown;
    command?: unknown;
    edits?: unknown;
    rationale?: unknown;
    proposer?: unknown;
}

/**
 * Outcome of one apply-and-commit attempt against the live GitHub file.
 * Semantic conflicts are THROWN (ProposalConflictError), not returned.
 */
type ApplyOutcome =
    | { kind: "committed"; sha?: string; body?: Record<string, unknown> }
    | { kind: "retry" } // GitHub sha race — the ONLY retryable outcome
    | { kind: "failed"; message: string };

export class ProposalService {
    private sweepTimer?: NodeJS.Timeout;

    constructor(
        private readonly client: KrytenClient,
        readonly store: ProposalStore,
        private readonly reviewer: Reviewer,
    ) {
        this.store.expireStale();
        // Recover proposals left mid-approve by a crash/restart (see method doc).
        const recovered = this.store.failStaleApplying();
        if (recovered > 0) {
            console.warn(`Recovered ${recovered} proposal(s) stuck in 'applying' after a restart (marked failed).`);
        }
        this.sweepTimer = setInterval(() => {
            try {
                const expired = this.store.expireStale();
                if (expired > 0) console.log(`Expired ${expired} stale command proposal(s)`);
                const purged = this.store.purgeResolved(RESOLVED_RETENTION_MS);
                if (purged > 0) console.log(`Purged ${purged} resolved command proposal(s) past retention`);
            } catch (error) {
                console.error("Proposal expiry sweep failed:", error);
            }
        }, SWEEP_INTERVAL_MS);
        this.sweepTimer.unref();
    }

    private resolving = 0;
    private onIdle?: () => void;

    stop(): void {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = undefined;
        }
        this.store.close();
    }

    /** True while a resolution click is in flight and still needs the live store. */
    get busy(): boolean {
        return this.resolving > 0;
    }

    /**
     * Enter the teardown gate synchronously, returning an idempotent release.
     * Button handlers acquire this before their first Discord await so a config
     * reload cannot close the captured service's store during acknowledgement.
     */
    acquireResolutionGate(): () => void {
        this.resolving++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            if (--this.resolving === 0 && this.onIdle) {
                const fn = this.onIdle;
                this.onIdle = undefined;
                fn();
            }
        };
    }

    /**
     * Run `fn` now when idle, else defer it until the last in-flight resolution
     * finishes. Lets `/reload_config` postpone a store teardown/rebuild that would
     * otherwise close the SQLite handle under a running approve — the deferred
     * reconcile re-reads fresh config, so the change still lands, just a beat later.
     */
    runWhenIdle(fn: () => void): void {
        if (this.resolving === 0) fn();
        else this.onIdle = fn;
    }

    /** Read fresh so /reload_config takes effect like every other setting. */
    private maxPending(): number {
        return Math.max(1, this.client.config.proposals?.max_pending ?? DEFAULT_MAX_PENDING);
    }

    /** App-command names backed by built-in code, which shadow custom commands. */
    private builtInNames(): Set<string> {
        const names = new Set<string>();
        try {
            for (const [name] of this.client.commands.loaded_classes) names.add(normalizeName(name));
        } catch {
            // never fail a proposal on a registry read
        }
        return names;
    }

    async submitProposal(input: SubmitInput): Promise<SubmitResult> {
        // 1. Corpus available? (config'd + at least one successful load)
        if (!this.client.commandSync.filesClient()) {
            return { status: "unavailable", message: "GitHub commands repo is not configured." };
        }
        if (this.client.commandSync.lastLoadSource === "none") {
            return {
                status: "unavailable",
                message: "Command corpus is empty (not loaded yet, or GitHub unreachable with no local snapshot).",
            };
        }

        // 2. Operation + name validity ("edit" is accepted and normalized to patch).
        const rawOperation = String(input.operation ?? "")
            .trim()
            .toLowerCase();
        if (!["create", "edit", "delete", "patch"].includes(rawOperation)) {
            return { status: "invalid", message: "operation must be one of create, edit, delete, patch" };
        }
        const name = normalizeName(input.commandName);
        if (!NAME_PATTERN.test(name)) {
            return {
                status: "invalid",
                message: "command_name must be 1-32 chars of lowercase letters, digits, hyphens, or underscores",
            };
        }

        let operation = rawOperation as ProposalOperation | "edit";
        const edits = input.edits;
        if (operation === "edit") {
            if (input.command !== undefined && input.command !== null) {
                return { status: "invalid", message: FULL_BODY_EDIT_UNSUPPORTED };
            }
            if (!Array.isArray(edits) || edits.length === 0) {
                return { status: "invalid", message: "edit proposals require a non-empty 'edits' array" };
            }
            operation = "patch";
        }

        // 3. Per-operation validation + live-corpus conflict checks.
        const existing = this.client.custom_commands.find(c => c.name === name);
        let proposedCommand: Record<string, unknown> | undefined;
        let proposedEdits: unknown[] | undefined;

        if (operation === "create") {
            if (!input.command || typeof input.command !== "object" || Array.isArray(input.command)) {
                return { status: "invalid", message: "create proposals require an object 'command' body" };
            }
            const body = jsonClone(input.command) as Record<string, unknown>;
            const validationError = validateCustomCommandDetailed(body);
            if (validationError) {
                return { status: "invalid", message: `command body is invalid: ${validationError}` };
            }
            if (normalizeName(body["name"]) !== name) {
                return { status: "invalid", message: "command_name does not match the command body's name" };
            }
            if (existing) {
                return { status: "conflict", message: `command '${name}' already exists` };
            }
            if (this.builtInNames().has(name)) {
                return {
                    status: "invalid",
                    message: `'${name}' collides with a built-in command and would be shadowed`,
                };
            }
            proposedCommand = body;
        } else {
            if (!existing) {
                return { status: "conflict", message: `command '${name}' does not exist` };
            }
            if (operation === "patch") {
                if (!Array.isArray(edits) || edits.length === 0) {
                    return { status: "invalid", message: "patch proposals require a non-empty 'edits' array" };
                }
                // The pre-apply below proves the edits fit the live file. When
                // running from the snapshot the stored bodies are normalized
                // approximations of the real files, so exact-match guards
                // (replace_text/set_property old values) could be falsely
                // rejected — refuse instead of guessing (retryable).
                if (this.client.commandSync.lastLoadSource !== "github") {
                    return {
                        status: "unavailable",
                        message: "Command corpus is running from a fallback (GitHub unreachable); try again later.",
                    };
                }
                const liveRaw = this.client.commandSync.getRawBody(name);
                if (!liveRaw) {
                    return {
                        status: "unavailable",
                        message: `no raw body available for '${name}'; run /reload_commands`,
                    };
                }
                try {
                    proposedCommand = applyPatchEdits(liveRaw, edits);
                } catch (error) {
                    if (error instanceof ProposalConflictError) {
                        return { status: "conflict", message: error.message };
                    }
                    if (error instanceof ProposalValidationError) {
                        return { status: "invalid", message: error.message };
                    }
                    throw error;
                }
                if (normalizeName(proposedCommand["name"]) !== name) {
                    return { status: "invalid", message: "patched body's name no longer matches command_name" };
                }
                proposedEdits = edits;
            }
        }

        // 4. Dedupe + rate limit (expired proposals don't count).
        this.store.expireStale();
        const finalOperation = operation as ProposalOperation;
        const duplicate = this.store.findPendingDuplicate(finalOperation, name);
        if (duplicate) {
            return {
                status: "duplicate",
                message: `a pending ${finalOperation} proposal for '${name}' already exists`,
                proposalId: duplicate.proposalId,
            };
        }
        if (this.store.countPending() >= this.maxPending()) {
            return { status: "too_many_pending", message: `too many pending proposals (max ${this.maxPending()})` };
        }

        // 5. Persist + post the review card.
        let record: ProposalRecord;
        try {
            record = this.store.createProposal({
                operation: finalOperation,
                commandName: name,
                ...(proposedCommand !== undefined ? { proposedCommand } : {}),
                ...(proposedEdits !== undefined ? { proposedEdits } : {}),
                ...(this.client.commandSync.getDigest() !== undefined
                    ? { baseCommandsSha: this.client.commandSync.getDigest()! }
                    : {}),
                proposer: String(input.proposer ?? "chatbot").slice(0, 80),
                ...(input.rationale !== undefined && input.rationale !== null
                    ? { rationale: String(input.rationale).slice(0, 1024) }
                    : {}),
            });
        } catch (error) {
            console.error("Failed to stage proposal:", error);
            return { status: "error", message: "failed to stage the proposal" };
        }

        const posted = await this.reviewer.postReviewCard(record);
        if ("error" in posted) {
            this.store.markStagingFailed(record.proposalId, `review card failed: ${posted.error.message}`);
            if (posted.error.contentRejected) {
                return { status: "invalid", message: `Discord rejected the review card: ${posted.error.message}` };
            }
            return { status: "unavailable", message: `could not post the review card: ${posted.error.message}` };
        }
        this.store.setReviewMessageId(record.proposalId, posted.messageId);
        return { status: "staged", message: "proposal staged for staff review", proposalId: record.proposalId };
    }

    private mapWriteResult(result: WriteResult, body?: Record<string, unknown>): ApplyOutcome {
        if (result.status === "ok") {
            return {
                kind: "committed",
                ...(result.newSha !== undefined ? { sha: result.newSha } : {}),
                ...(body !== undefined ? { body } : {}),
            };
        }
        if (result.status === "sha_conflict") return { kind: "retry" };
        return {
            kind: "failed",
            message:
                result.status === "timeout"
                    ? "timeout (the write may have landed; run /reload_commands before retrying)"
                    : result.message,
        };
    }

    /**
     * One apply-and-commit attempt: re-fetch the live file and re-apply the
     * operation against it. Throws ProposalConflictError/ProposalValidationError
     * for semantic failures (never retried).
     */
    private async applyOnce(record: ProposalRecord, message: string): Promise<ApplyOutcome> {
        const files = this.client.commandSync.filesClient()!;
        const live = await files.loadCommand(record.commandName);

        if (record.operation === "create") {
            if (live !== "not_found") {
                if (live === "error" || live === "invalid") {
                    throw new ProposalConflictError("could not confirm the command file is absent on GitHub");
                }
                throw new ProposalConflictError(`'${record.commandName}' already exists on GitHub`);
            }
            const body = record.proposedCommand;
            if (!body) throw new ProposalValidationError("create proposal has no command body");
            return this.mapWriteResult(await files.commitCommand(record.commandName, body, message), body);
        }

        if (live === "not_found" || live === "error" || live === "invalid") {
            throw new ProposalConflictError(
                `'${record.commandName}' could not be loaded from GitHub (deleted, invalid, or unreachable)`,
            );
        }

        if (record.operation === "delete") {
            return this.mapWriteResult(await files.deleteCommand(record.commandName, message, live.sha));
        }

        // patch: re-apply the semantic edits against the CURRENT body.
        const patched = applyPatchEdits(live.raw, record.proposedEdits);
        if (normalizeName(patched["name"]) !== record.commandName) {
            throw new ProposalValidationError("patched body's name no longer matches the proposal");
        }
        return this.mapWriteResult(await files.commitCommand(record.commandName, patched, message, live.sha), patched);
    }

    /**
     * Result for a lost double-click race: carry the proposal's ACTUAL terminal
     * state so the card can render the real outcome instead of a generic (and
     * potentially winner-clobbering) "already resolved" note.
     */
    private alreadyResolvedResult(proposalId: string): ResolutionResult {
        const existing = this.store.get(proposalId);
        return {
            ok: false,
            status: "already_resolved",
            message: "This proposal was already resolved (or expired).",
            ...(existing
                ? {
                      resolved: {
                          status: existing.status,
                          ...(existing.resolvedBy !== undefined ? { resolvedBy: existing.resolvedBy } : {}),
                          ...(existing.committedSha !== undefined ? { committedSha: existing.committedSha } : {}),
                      },
                  }
                : {}),
        };
    }

    async approveProposal(proposalId: string, reviewerName: string): Promise<ResolutionResult> {
        // Hold the "resolving" gate across the whole approve so a concurrent
        // /reload_config defers any store teardown until the terminal markApproved
        // has run on the live store (see runWhenIdle).
        const release = this.acquireResolutionGate();
        try {
            return await this.approveProposalInner(proposalId, reviewerName);
        } finally {
            release();
        }
    }

    private async approveProposalInner(proposalId: string, reviewerName: string): Promise<ResolutionResult> {
        const record = this.store.claimForResolution(proposalId);
        if (!record) {
            return this.alreadyResolvedResult(proposalId);
        }

        if (!this.client.commandSync.filesClient()) {
            this.store.markFailed(proposalId, reviewerName, "GitHub not configured at approve time");
            return { ok: false, status: "failed", message: "GitHub commands repo is not configured." };
        }

        const safeReviewer = sanitizeCommitAuthor(reviewerName);
        const message = clampCommitMessage(
            `chore(commands): ${record.operation} ${record.commandName} (approved by ${safeReviewer})`,
        );

        // One automatic retry, ONLY on a GitHub sha race (someone committed the
        // same file between our fetch and our write). Semantic conflicts and
        // transport errors never retry.
        let outcome: ApplyOutcome = { kind: "retry" };
        for (let attempt = 0; attempt < 2 && outcome.kind === "retry"; attempt++) {
            try {
                outcome = await this.applyOnce(record, message);
            } catch (error) {
                if (error instanceof ProposalConflictError || error instanceof ProposalValidationError) {
                    this.store.markConflict(proposalId, reviewerName, error.message);
                    return { ok: false, status: "conflict", message: `No longer applies: ${error.message}` };
                }
                this.store.markFailed(
                    proposalId,
                    reviewerName,
                    `apply failed: ${error instanceof Error ? error.message : String(error)}`,
                );
                return {
                    ok: false,
                    status: "failed",
                    message: "Could not apply the proposal against the current command.",
                };
            }
        }
        if (outcome.kind === "retry") {
            this.store.markFailed(proposalId, reviewerName, "commit failed: sha_conflict (twice)");
            return { ok: false, status: "failed", message: "GitHub commit kept conflicting; try again." };
        }
        if (outcome.kind === "failed") {
            this.store.markFailed(proposalId, reviewerName, `commit failed: ${outcome.message}`);
            return { ok: false, status: "failed", message: `GitHub commit failed: ${outcome.message}` };
        }

        // Committed. Sync the bot in memory (same shape as the editor save
        // path — no full corpus refetch), refresh the digest so the poller
        // doesn't re-reload, persist the local snapshot, and re-register only
        // if (name, description) changed.
        const committedSha = outcome.sha;
        const previous = this.client.custom_commands;
        try {
            if (record.operation === "delete") {
                this.client.commandSync.applyDelete(record.commandName);
                this.client.custom_commands = previous.filter(c => c.name !== record.commandName);
            } else {
                const body = outcome.body!;
                this.client.commandSync.applyCommit(record.commandName, committedSha, body);
                const normalized = jsonClone(body) as unknown as CustomCommand;
                const validationError = validateCustomCommandDetailed(normalized);
                if (validationError) {
                    // Should be unreachable: the body was validated before commit.
                    throw new Error(`committed body failed validation: ${validationError}`);
                }
                this.client.custom_commands = [...previous.filter(c => c.name !== record.commandName), normalized].sort(
                    (a, b) => a.name.localeCompare(b.name),
                );
            }
            await this.client.commandSync.refreshDigest();
            this.client.commandSync.saveSnapshot();
            await this.client.registerIfChanged(previous);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            // The commit already landed — surface that explicitly; /reload_commands recovers.
            this.store.markFailed(
                proposalId,
                reviewerName,
                `committed ${committedSha ?? "(delete)"} but post-commit sync failed: ${detail}`,
                committedSha,
            );
            return {
                ok: false,
                status: "failed",
                message: `Committed to GitHub, but syncing the bot failed (${detail}). Run /reload_commands to bring the bot in sync.`,
                ...(committedSha !== undefined ? { committedSha } : {}),
            };
        }

        this.store.markApproved(proposalId, reviewerName, committedSha);
        return {
            ok: true,
            status: "approved",
            message: `Approved and committed${committedSha ? ` (${committedSha.slice(0, 8)})` : ""}.`,
            ...(committedSha !== undefined ? { committedSha } : {}),
        };
    }

    rejectProposal(proposalId: string, reviewerName: string): ResolutionResult {
        const record = this.store.markRejected(proposalId, reviewerName);
        if (!record) {
            return this.alreadyResolvedResult(proposalId);
        }
        return { ok: true, status: "rejected", message: "Proposal rejected." };
    }
}
