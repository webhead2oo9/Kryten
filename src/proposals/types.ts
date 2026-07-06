/** Shared types for the command-proposal subsystem. */

/** Stored operations; the external API also accepts "edit" (normalized to "patch"). */
export type ProposalOperation = "create" | "delete" | "patch";

export type ProposalStatus = "pending" | "applying" | "approved" | "rejected" | "expired" | "conflict" | "failed";

export interface ProposalRecord {
    proposalId: string; // 32 hex chars
    operation: ProposalOperation;
    commandName: string;
    /** For create: the proposed body. For patch: the pre-applied result (preview). */
    proposedCommand?: Record<string, unknown>;
    /** For patch: the raw semantic edits, re-applied against the live file at approve time. */
    proposedEdits?: unknown[];
    /** Commands-directory digest at submit time (informational). */
    baseCommandsSha?: string;
    status: ProposalStatus;
    proposer?: string;
    rationale?: string;
    reviewMessageId?: string;
    committedSha?: string;
    createdAtMs: number;
    expiresAtMs: number;
    resolvedAtMs?: number;
    resolvedBy?: string;
    resolutionNote?: string;
}

export type SubmitStatus =
    | "staged"
    | "duplicate"
    | "too_many_pending"
    | "invalid"
    | "conflict"
    | "unavailable"
    | "error";

export interface SubmitResult {
    status: SubmitStatus;
    message: string;
    proposalId?: string;
}

export interface ResolutionResult {
    ok: boolean;
    status: "approved" | "rejected" | "conflict" | "failed" | "already_resolved";
    message: string;
    committedSha?: string;
    /**
     * For `already_resolved`: the proposal's actual terminal state, so the card
     * can render the real outcome (approved by X, rejected, …) instead of a
     * generic "already resolved" note that could clobber the winner's annotation
     * in a concurrent double-click.
     */
    resolved?: { status: ProposalStatus; resolvedBy?: string; committedSha?: string };
}
