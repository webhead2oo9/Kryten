import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import net from "net";
import type { AddressInfo } from "net";
import { randomUUID } from "crypto";
import { apiKeyRateLimited, handleProposalIntake, keyMatches } from "../src/api/proposalIntake";
import type { SubmitStatus } from "../src/proposals/types";

const ORIGINAL_API_KEY = process.env["PROPOSAL_API_KEY"];

/** Fresh key per test so the module-level sliding-window map never bleeds across tests. */
function uniqueKey(): string {
    return `k-${randomUUID()}`;
}

afterEach(() => {
    // Real timers again so a rate-limit test's fake clock can never leak into the HTTP tests.
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (ORIGINAL_API_KEY === undefined) delete process.env["PROPOSAL_API_KEY"];
    else process.env["PROPOSAL_API_KEY"] = ORIGINAL_API_KEY;
});

describe("keyMatches", () => {
    it("returns true for identical keys", () => {
        expect(keyMatches("s3cr3t-key", "s3cr3t-key")).toBe(true);
    });

    it("returns false for differing keys of equal length", () => {
        expect(keyMatches("aaaaaaaa", "bbbbbbbb")).toBe(false);
    });

    it("returns false for keys of different length WITHOUT throwing (sha256 equalizes lengths)", () => {
        // timingSafeEqual throws on unequal buffer lengths; hashing first makes both 32 bytes.
        expect(() => keyMatches("short", "a-much-longer-expected-key")).not.toThrow();
        expect(keyMatches("short", "a-much-longer-expected-key")).toBe(false);
    });

    it("returns false for an empty presented key", () => {
        expect(keyMatches("", "expected")).toBe(false);
    });
});

describe("apiKeyRateLimited", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-07-06T00:00:00.000Z"));
    });

    it("allows up to the per-minute limit and rejects the next call", () => {
        const key = uniqueKey();
        const limit = 3;
        expect(apiKeyRateLimited(key, limit)).toBe(false);
        expect(apiKeyRateLimited(key, limit)).toBe(false);
        expect(apiKeyRateLimited(key, limit)).toBe(false);
        expect(apiKeyRateLimited(key, limit)).toBe(true);
    });

    it("allows again once the 60s window has expired", () => {
        const key = uniqueKey();
        const limit = 2;
        expect(apiKeyRateLimited(key, limit)).toBe(false);
        expect(apiKeyRateLimited(key, limit)).toBe(false);
        expect(apiKeyRateLimited(key, limit)).toBe(true);

        vi.advanceTimersByTime(60_001);
        expect(apiKeyRateLimited(key, limit)).toBe(false);
    });

    it("keeps the budget still exhausted just under the window boundary", () => {
        const key = uniqueKey();
        const limit = 1;
        expect(apiKeyRateLimited(key, limit)).toBe(false);
        vi.advanceTimersByTime(59_999);
        expect(apiKeyRateLimited(key, limit)).toBe(true);
    });

    it("gives distinct keys independent budgets", () => {
        const a = uniqueKey();
        const b = uniqueKey();
        const limit = 1;
        expect(apiKeyRateLimited(a, limit)).toBe(false);
        expect(apiKeyRateLimited(a, limit)).toBe(true);
        // b is untouched by a's exhausted budget.
        expect(apiKeyRateLimited(b, limit)).toBe(false);
    });
});

describe("handleProposalIntake over HTTP", () => {
    let server: http.Server;
    let baseUrl: string;
    let port: number;
    let currentClient: any;

    function makeClient(service: unknown, rateLimit = 100): any {
        return { proposalService: service, config: { proposals: { rate_limit_per_minute: rateLimit } } };
    }

    async function post(opts: {
        key?: string;
        body?: string;
        headers?: Record<string, string>;
    }): Promise<Response> {
        const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
        if (opts.key !== undefined) headers["X-API-Key"] = opts.key;
        return fetch(baseUrl, { method: "POST", headers, body: opts.body });
    }

    beforeAll(async () => {
        server = http.createServer((req, res) => handleProposalIntake(currentClient, req, res));
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address() as AddressInfo;
        port = addr.port;
        baseUrl = `http://127.0.0.1:${port}/api/v1/commands/proposals`;
    });

    /**
     * Raw-socket exchange: declare a large Content-Length but send only a sliver of
     * the body. Faithfully reproduces "a large body behind an early reject" without
     * relying on a fetch client's willingness to tolerate the post-reply socket reset
     * (undici aborts a >256KiB in-flight upload with ECONNRESET even though the full
     * reply was already flushed). Resolves with the bytes the server sent back; a
     * hang trips the deadline and rejects.
     */
    function rawEarlyReject(apiKeyHeader: string, declaredLen: number, sentBytes: number): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const sock = net.connect(port, "127.0.0.1");
            let received = "";
            const deadline = setTimeout(() => {
                sock.destroy();
                reject(new Error("server did not reply and close within the deadline (hang)"));
            }, 3000);
            sock.setEncoding("utf8");
            sock.on("data", chunk => (received += chunk));
            sock.on("close", () => {
                clearTimeout(deadline);
                resolve(received);
            });
            sock.on("error", () => {}); // the reset after the reply flushes is expected
            sock.on("connect", () => {
                sock.write(
                    `POST /api/v1/commands/proposals HTTP/1.1\r\nHost: x\r\n` +
                        `X-API-Key: ${apiKeyHeader}\r\nContent-Type: application/json\r\n` +
                        `Content-Length: ${declaredLen}\r\n\r\n`,
                );
                sock.write("x".repeat(sentBytes));
            });
        });
    }

    afterAll(async () => {
        await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())));
    });

    beforeEach(() => {
        // Silence the intended console.error on the 500 catch path.
        vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("responds 503 when the proposal service is absent", async () => {
        process.env["PROPOSAL_API_KEY"] = uniqueKey();
        currentClient = makeClient(undefined);

        const res = await post({ key: process.env["PROPOSAL_API_KEY"], body: "{}" });
        expect(res.status).toBe(503);
        expect(await res.json()).toEqual({
            status: "unavailable",
            message: "Command proposals are not available",
            proposal_id: null,
        });
    });

    it("responds 503 when PROPOSAL_API_KEY is not configured", async () => {
        delete process.env["PROPOSAL_API_KEY"];
        currentClient = makeClient({ submitProposal: vi.fn() });

        const res = await post({ key: "anything", body: "{}" });
        expect(res.status).toBe(503);
        expect((await res.json()).status).toBe("unavailable");
    });

    it("responds 401 on a wrong key", async () => {
        process.env["PROPOSAL_API_KEY"] = uniqueKey();
        const submit = vi.fn();
        currentClient = makeClient({ submitProposal: submit });

        const res = await post({ key: "not-the-right-key", body: JSON.stringify({ operation: "create" }) });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({
            status: "unauthorized",
            message: "Invalid or missing X-API-Key",
            proposal_id: null,
        });
        expect(submit).not.toHaveBeenCalled();
    });

    it("responds 401 with a missing X-API-Key header", async () => {
        process.env["PROPOSAL_API_KEY"] = uniqueKey();
        currentClient = makeClient({ submitProposal: vi.fn() });

        const res = await post({ body: "{}" });
        expect(res.status).toBe(401);
    });

    it("flushes the full 401 reply and closes without hanging when a large unconsumed body sits behind a bad key", async () => {
        process.env["PROPOSAL_API_KEY"] = uniqueKey();
        currentClient = makeClient({ submitProposal: vi.fn() });

        // Declare 300KiB but only send 1KiB: the server must reply and close, not wait on the rest.
        const response = await rawEarlyReject("wrong-key", 300 * 1024, 1024);
        expect(response).toContain("HTTP/1.1 401 Unauthorized");
        expect(response).toContain('"status":"unauthorized"');
        expect(response).toContain('"message":"Invalid or missing X-API-Key"');
    });

    it("responds 429 once the key's sliding-window budget is spent", async () => {
        const key = uniqueKey();
        process.env["PROPOSAL_API_KEY"] = key;
        const submit = vi.fn().mockResolvedValue({ status: "staged", message: "ok", proposalId: "id" });
        currentClient = makeClient({ submitProposal: submit }, 1);

        const first = await post({ key, body: JSON.stringify({ operation: "create", command_name: "foo" }) });
        expect(first.status).toBe(201);

        const second = await post({ key, body: JSON.stringify({ operation: "create", command_name: "foo" }) });
        expect(second.status).toBe(429);
        expect(await second.json()).toEqual({
            status: "rate_limited",
            message: "Rate limit exceeded",
            proposal_id: null,
        });
    });

    it("responds 413 on a body larger than 256KiB and never calls submitProposal", async () => {
        process.env["PROPOSAL_API_KEY"] = uniqueKey();
        const submit = vi.fn();
        currentClient = makeClient({ submitProposal: submit });

        const res = await post({
            key: process.env["PROPOSAL_API_KEY"],
            body: "x".repeat(256 * 1024 + 512),
        });
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({
            status: "invalid",
            message: "Request body too large",
            proposal_id: null,
        });
        expect(submit).not.toHaveBeenCalled();
    });

    it("responds 400 on a body that is not valid JSON", async () => {
        process.env["PROPOSAL_API_KEY"] = uniqueKey();
        const submit = vi.fn();
        currentClient = makeClient({ submitProposal: submit });

        const res = await post({ key: process.env["PROPOSAL_API_KEY"], body: "{not json" });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            status: "invalid",
            message: "Body must be valid JSON",
            proposal_id: null,
        });
        expect(submit).not.toHaveBeenCalled();
    });

    it("responds 400 on a JSON array body", async () => {
        process.env["PROPOSAL_API_KEY"] = uniqueKey();
        const submit = vi.fn();
        currentClient = makeClient({ submitProposal: submit });

        const res = await post({ key: process.env["PROPOSAL_API_KEY"], body: "[1, 2, 3]" });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
            status: "invalid",
            message: "Body must be a JSON object",
            proposal_id: null,
        });
        expect(submit).not.toHaveBeenCalled();
    });

    const MAPPING: Array<[SubmitStatus, number]> = [
        ["staged", 201],
        ["duplicate", 200],
        ["too_many_pending", 429],
        ["invalid", 400],
        ["conflict", 409],
        ["unavailable", 503],
        ["error", 500],
    ];

    for (const [status, httpCode] of MAPPING) {
        it(`maps submit status "${status}" to HTTP ${httpCode}`, async () => {
            const key = uniqueKey();
            process.env["PROPOSAL_API_KEY"] = key;
            const submit = vi.fn().mockResolvedValue({ status, message: `message-${status}` });
            currentClient = makeClient({ submitProposal: submit });

            const res = await post({ key, body: JSON.stringify({ operation: "create", command_name: "foo" }) });
            expect(res.status).toBe(httpCode);
            expect(await res.json()).toEqual({
                status,
                message: `message-${status}`,
                proposal_id: null,
            });
        });
    }

    it("maps the request body fields to submitProposal and echoes proposal_id", async () => {
        const key = uniqueKey();
        process.env["PROPOSAL_API_KEY"] = key;
        const proposalId = "0123456789abcdef0123456789abcdef";
        const submit = vi.fn().mockResolvedValue({ status: "staged", message: "Staged", proposalId });
        currentClient = makeClient({ submitProposal: submit });

        const payload = {
            operation: "edit",
            command_name: "link-headset",
            command: { format: 2 },
            edits: [{ kind: "replace_text" }],
            rationale: "fix a typo",
            proposer: "llm-bot",
        };
        const res = await post({ key, body: JSON.stringify(payload) });

        expect(res.status).toBe(201);
        expect(await res.json()).toEqual({ status: "staged", message: "Staged", proposal_id: proposalId });
        expect(submit).toHaveBeenCalledWith({
            operation: "edit",
            commandName: "link-headset",
            command: { format: 2 },
            edits: [{ kind: "replace_text" }],
            rationale: "fix a typo",
            proposer: "llm-bot",
        });
    });

    it("responds 500 with the generic error contract when submitProposal rejects", async () => {
        const key = uniqueKey();
        process.env["PROPOSAL_API_KEY"] = key;
        const submit = vi.fn().mockRejectedValue(new Error("boom"));
        currentClient = makeClient({ submitProposal: submit });

        const res = await post({ key, body: JSON.stringify({ operation: "create", command_name: "foo" }) });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({
            status: "error",
            message: "Internal error",
            proposal_id: null,
        });
    });
});
