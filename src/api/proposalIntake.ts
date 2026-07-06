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

/** The one place the response contract lives: { status, message, proposal_id }. */
function respond(
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
    respond(res, http, status, message);
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
    const service = client.proposalService;
    const apiKey = process.env["PROPOSAL_API_KEY"];
    if (!service || !apiKey) {
        rejectAndClose(req, res, 503, "unavailable", "Command proposals are not available");
        return;
    }

    const presented = req.headers["x-api-key"];
    if (typeof presented !== "string" || !keyMatches(presented, apiKey)) {
        rejectAndClose(req, res, 401, "unauthorized", "Invalid or missing X-API-Key");
        return;
    }

    const limit = client.config.proposals?.rate_limit_per_minute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
    if (apiKeyRateLimited(presented, limit)) {
        rejectAndClose(req, res, 429, "rate_limited", "Rate limit exceeded");
        return;
    }

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
            respond(res, 400, "invalid", "Body must be valid JSON");
            return;
        }
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            respond(res, 400, "invalid", "Body must be a JSON object");
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
                respond(res, STATUS_TO_HTTP[result.status], result.status, result.message, result.proposalId ?? null);
            })
            .catch(error => {
                console.error("Proposal intake failed:", error);
                respond(res, 500, "error", "Internal error");
            });
    });
    req.on("error", () => {
        if (!res.headersSent) {
            respond(res, 400, "invalid", "Request stream error");
        }
    });
}
