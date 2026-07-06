import { afterEach, describe, expect, it, vi } from "vitest";
import { FingerprintHubClient } from "../src/features/imageFingerprint/hubClient";

const SYNC_PARAMS = {
    since: 7,
    limit: 100,
    algorithm: "phash",
    algorithm_version: "1",
    normalization_version: "alpha_white_v1",
};

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("FingerprintHubClient transport discipline", () => {
    it("returns null from sync when fetch rejects (network down), never throwing", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("ECONNREFUSED");
            }),
        );
        const client = new FingerprintHubClient("http://hub", "key");

        await expect(client.sync(SYNC_PARAMS)).resolves.toBeNull();
    });

    it("returns a structured error from contribute when fetch rejects", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("ECONNREFUSED");
            }),
        );
        const client = new FingerprintHubClient("http://hub", "key");

        const result = await client.contribute({
            phash_hex: "ff",
            category: "scam",
            action: "delete",
            algorithm: "phash",
            algorithm_version: "1",
            normalization_version: "alpha_white_v1",
        });

        expect(result).toEqual({ status: "error", detail: "ECONNREFUSED" });
    });

    it("never throws from the fire-and-forget methods when fetch rejects", async () => {
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => {
                throw new Error("down");
            }),
        );
        const client = new FingerprintHubClient("http://hub", "key");

        await expect(client.reportHit(1, { guild_id: "g" })).resolves.toBeUndefined();
        await expect(client.flag(1, "why")).resolves.toBeUndefined();
        await expect(client.remove(1)).resolves.toBeUndefined();
    });

    it("aborts a request that hangs past timeoutMs and returns a structured failure", async () => {
        // fetch that only ever rejects when the abort signal fires; the client's
        // internal setTimeout must trip and abort it.
        vi.stubGlobal(
            "fetch",
            vi.fn(
                (_url: string, opts: any) =>
                    new Promise((_resolve, reject) => {
                        opts.signal.addEventListener("abort", () => reject(new Error("aborted")));
                    }),
            ),
        );
        const client = new FingerprintHubClient("http://hub", "key", 15);

        await expect(client.sync(SYNC_PARAMS)).resolves.toBeNull();
    });
});

describe("FingerprintHubClient.sync", () => {
    it("returns null on a non-200 status", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ fingerprints: [] }, 500)));
        const client = new FingerprintHubClient("http://hub", "key");

        await expect(client.sync(SYNC_PARAMS)).resolves.toBeNull();
    });

    it("returns null when the 200 body has a non-array fingerprints field", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ fingerprints: "nope" })));
        const client = new FingerprintHubClient("http://hub", "key");

        await expect(client.sync(SYNC_PARAMS)).resolves.toBeNull();
    });

    it("falls next_since back to the input since when the response omits it", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ fingerprints: [], has_more: true })));
        const client = new FingerprintHubClient("http://hub", "key");

        const page = await client.sync(SYNC_PARAMS);

        expect(page).not.toBeNull();
        expect(page!.next_since).toBe(SYNC_PARAMS.since);
    });

    it("coerces has_more to a boolean (truthy non-bool -> true, missing -> false)", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ fingerprints: [], next_since: 9, has_more: 1 })));
        const truthyClient = new FingerprintHubClient("http://hub", "key");
        const truthy = await truthyClient.sync(SYNC_PARAMS);
        expect(truthy!.has_more).toBe(true);
        expect(truthy!.next_since).toBe(9);
        vi.unstubAllGlobals();

        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ fingerprints: [], next_since: 9 })));
        const missingClient = new FingerprintHubClient("http://hub", "key");
        const missing = await missingClient.sync(SYNC_PARAMS);
        expect(missing!.has_more).toBe(false);
    });

    it("passes through the fingerprints array from a well-formed page", async () => {
        const rows = [{ id: 3, phash_hex: "ab" }];
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ fingerprints: rows, next_since: 12, has_more: false })));
        const client = new FingerprintHubClient("http://hub", "key");

        const page = await client.sync(SYNC_PARAMS);

        expect(page).toEqual({ fingerprints: rows, next_since: 12, has_more: false });
    });
});

describe("FingerprintHubClient.contribute", () => {
    it("treats a 200 with a numeric id as linked", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: 42 }, 200)));
        const client = new FingerprintHubClient("http://hub", "key");

        const result = await client.contribute({
            phash_hex: "ff",
            category: "scam",
            action: "delete",
            algorithm: "phash",
            algorithm_version: "1",
            normalization_version: "alpha_white_v1",
        });

        expect(result).toEqual({ status: "linked", hubId: 42 });
    });

    it("treats a 201 with a numeric id as linked", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: 7 }, 201)));
        const client = new FingerprintHubClient("http://hub", "key");

        const result = await client.contribute({
            phash_hex: "ff",
            category: "scam",
            action: "delete",
            algorithm: "phash",
            algorithm_version: "1",
            normalization_version: "alpha_white_v1",
        });

        expect(result).toEqual({ status: "linked", hubId: 7 });
    });

    it("errors when a 200/201 is missing the id", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ created: true }, 201)));
        const client = new FingerprintHubClient("http://hub", "key");

        const result = await client.contribute({
            phash_hex: "ff",
            category: "scam",
            action: "delete",
            algorithm: "phash",
            algorithm_version: "1",
            normalization_version: "alpha_white_v1",
        });

        expect(result).toEqual({ status: "error", detail: "missing id in 201 response" });
    });

    it("treats a 409 with existing_id as linked (already-exists counts as linked)", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ existing_id: 99 }, 409)));
        const client = new FingerprintHubClient("http://hub", "key");

        const result = await client.contribute({
            phash_hex: "ff",
            category: "scam",
            action: "delete",
            algorithm: "phash",
            algorithm_version: "1",
            normalization_version: "alpha_white_v1",
        });

        expect(result).toEqual({ status: "linked", hubId: 99 });
    });

    it("errors on a 409 without an existing_id", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 409)));
        const client = new FingerprintHubClient("http://hub", "key");

        const result = await client.contribute({
            phash_hex: "ff",
            category: "scam",
            action: "delete",
            algorithm: "phash",
            algorithm_version: "1",
            normalization_version: "alpha_white_v1",
        });

        expect(result).toEqual({ status: "error", detail: "409 without existing_id" });
    });

    it("errors on any other status", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 500)));
        const client = new FingerprintHubClient("http://hub", "key");

        const result = await client.contribute({
            phash_hex: "ff",
            category: "scam",
            action: "delete",
            algorithm: "phash",
            algorithm_version: "1",
            normalization_version: "alpha_white_v1",
        });

        expect(result).toEqual({ status: "error", detail: "HTTP 500" });
    });
});

describe("FingerprintHubClient request construction", () => {
    it("trims trailing slashes off the base URL and sends the X-API-Key header", async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ fingerprints: [], next_since: 1, has_more: false }));
        vi.stubGlobal("fetch", fetchMock);
        const client = new FingerprintHubClient("http://hub///", "fph_secret");

        await client.sync(SYNC_PARAMS);

        const [url, init] = fetchMock.mock.calls[0] as [string, any];
        expect(url.startsWith("http://hub/v1/fingerprints/sync")).toBe(true);
        expect(url).not.toContain("hub//v1");
        expect(init.headers["X-API-Key"]).toBe("fph_secret");
    });

    it("sets Content-Type only when a body is present", async () => {
        const fetchMock = vi.fn(async () => jsonResponse({ id: 1 }, 201));
        vi.stubGlobal("fetch", fetchMock);
        const client = new FingerprintHubClient("http://hub", "key");

        await client.contribute({
            phash_hex: "ff",
            category: "scam",
            action: "delete",
            algorithm: "phash",
            algorithm_version: "1",
            normalization_version: "alpha_white_v1",
        });

        const [, init] = fetchMock.mock.calls[0] as [string, any];
        expect(init.headers["Content-Type"]).toBe("application/json");
        expect(typeof init.body).toBe("string");
    });
});
