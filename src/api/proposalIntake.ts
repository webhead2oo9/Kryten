/**
 * HTTP intake for LLM command proposals. The contract matches what the
 * external LLM proposer bot's client already speaks, so that client is drop-in:
 *
 *   POST /api/v1/commands/proposals
 *   Header: X-API-Key (compared constant-time against PROPOSAL_API_KEY)
 *   Body:   { operation, command_name, command?, edits?, rationale?, proposer? }
 *   → { status, message, proposal_id } with the same status→HTTP mapping.
 *
 * Served from the existing health server (health.ts routes here).
 */
import { createHash, timingSafeEqual } from "crypto";
import { IncomingMessage, ServerResponse } from "http";
import type { KrytenClient } from "../classes/client";
import { SubmitStatus } from "../proposals/types";

const MAX_BODY_BYTES = 256 * 1024;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 100;

const STATUS_TO_HTTP: Record<SubmitStatus, number> = {
    staged: 201,
    duplicate: 200,
    too_many_pending: 429,
    invalid: 400,
    conflict: 409,
    unavailable: 503,
    error: 500,
};

// Sliding-window request timestamps per key fingerprint.
const requestLog = new Map<string, number[]>();

function sha256(value: string): Buffer {
    return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time key check; hashing first equalizes lengths (no length leak, no throw). */
export function keyMatches(presented: string, expected: string): boolean {
    return timingSafeEqual(sha256(presented), sha256(expected));
}

/** Shared per-key sliding-window rate limit — one budget across intake + reads. */
export function apiKeyRateLimited(presented: string, limitPerMinute: number): boolean {
    return rateLimited(sha256(presented).toString("hex").slice(0, 12), limitPerMinute);
}

export interface ApiAccessFailure {
    http: number;
    status: "unavailable" | "unauthorized" | "rate_limited";
    message: string;
}

/**
 * The shared 503/401/429 guard for the proposal intake and the command-read
 * API: service configured, constant-time key check, then the shared per-key
 * rate budget (single default, defined once here). Messages follow the intake
 * contract; the read side overrides wording for its own { error } contract.
 */
export function checkApiAccess(client: KrytenClient, presented: unknown): ApiAccessFailure | null {
    const apiKey = process.env["PROPOSAL_API_KEY"];
    if (!client.proposalService || !apiKey) {
        return { http: 503, status: "unavailable", message: "Command proposals are not available" };
    }
    if (typeof presented !== "string" || !keyMatches(presented, apiKey)) {
        return { http: 401, status: "unauthorized", message: "Invalid or missing X-API-Key" };
    }
    const limit = client.config.proposals?.rate_limit_per_minute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
    if (apiKeyRateLimited(presented, limit)) {
        return { http: 429, status: "rate_limited", message: "Rate limit exceeded" };
    }
    return null;
}

/** The one place the response contract lives: { status, message, proposal_id }. */
function respondStatus(
    res: ServerResponse,
    http: number,
    status: string,
    message: string,
    proposalId: string | null = null,
): void {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(http, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status, message, proposal_id: proposalId }));
}

/**
 * Reject and stop reading the request body without truncating the response.
 * Destroying the socket immediately (the old 413 path did) can reset the
 * connection before the reply flushes; wait for the response to finish first.
 * Used on the early reject paths so a large body behind a bad key / 503 /
 * rate-limit isn't left unconsumed on a keep-alive socket.
 */
function rejectAndClose(
    req: IncomingMessage,
    res: ServerResponse,
    http: number,
    status: string,
    message: string,
): void {
    respondStatus(res, http, status, message);
    if (res.writableFinished) req.destroy();
    else res.once("finish", () => req.destroy());
}

function rateLimited(keyFingerprint: string, limitPerMinute: number): boolean {
    const now = Date.now();
    const entries = (requestLog.get(keyFingerprint) ?? []).filter(ts => now - ts < RATE_WINDOW_MS);
    if (entries.length >= limitPerMinute) {
        requestLog.set(keyFingerprint, entries);
        return true;
    }
    entries.push(now);
    requestLog.set(keyFingerprint, entries);
    return false;
}

export function handleProposalIntake(client: KrytenClient, req: IncomingMessage, res: ServerResponse): void {
    const failure = checkApiAccess(client, req.headers["x-api-key"]);
    if (failure) {
        rejectAndClose(req, res, failure.http, failure.status, failure.message);
        return;
    }
    // checkApiAccess only passes when the service is configured.
    const service = client.proposalService!;

    const chunks: Buffer[] = [];
    let received = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
        if (aborted) return;
        received += chunk.length;
        if (received > MAX_BODY_BYTES) {
            aborted = true;
            rejectAndClose(req, res, 413, "invalid", "Request body too large");
            return;
        }
        chunks.push(chunk);
    });
    req.on("end", () => {
        if (aborted) return;
        let payload: unknown;
        try {
            payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
            respondStatus(res, 400, "invalid", "Body must be valid JSON");
            return;
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            respondStatus(res, 400, "invalid", "Body must be a JSON object");
            return;
        }
        const body = payload as Record<string, unknown>;

        service
            .submitProposal({
                operation: body["operation"],
                commandName: body["command_name"],
                command: body["command"],
                edits: body["edits"],
                rationale: body["rationale"],
                proposer: body["proposer"],
            })
            .then(result => {
                respondStatus(
                    res,
                    STATUS_TO_HTTP[result.status],
                    result.status,
                    result.message,
                    result.proposalId ?? null,
                );
            })
            .catch(error => {
                console.error("Proposal intake failed:", error);
                respondStatus(res, 500, "error", "Internal error");
            });
    });
    req.on("error", () => {
        if (!res.headersSent) {
            respondStatus(res, 400, "invalid", "Request stream error");
        }
    });
}
