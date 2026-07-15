import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    DuplicateFingerprintError,
    ImageFingerprintStore,
    hammingBig,
    phashFromHex,
} from "../src/features/imageFingerprint/store";

let dir: string;
let stores: ImageFingerprintStore[] = [];

function makeStore(config: Record<string, unknown>): ImageFingerprintStore {
    const s = new ImageFingerprintStore(
        { db_path: join(dir, `fp_${stores.length}.db`), ...config },
        { onError: () => undefined },
    );
    stores.push(s);
    return s;
}

// Flip `n` low bits of a pHash so we can build near-matches with a known distance.
function flipBits(hex: string, n: number): bigint {
    let v = phashFromHex(hex);
    for (let i = 0; i < n; i++) v ^= 1n << BigInt(i);
    return v;
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fpstore-"));
    stores = [];
});
afterEach(() => {
    for (const s of stores) s.close();
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
});

describe("hammingBig", () => {
    it("counts differing bits across the full 64-bit width", () => {
        expect(hammingBig(0n, 0n)).toBe(0);
        expect(hammingBig(phashFromHex("ffffffffffffffff"), 0n)).toBe(64);
        expect(hammingBig(phashFromHex("e5de4a00bcbd5a25"), phashFromHex("e5de4a00bcbd5a25"))).toBe(0);
        expect(hammingBig(1n, 0n)).toBe(1);
        expect(hammingBig(0x8000000000000000n, 0n)).toBe(1);
    });
});

describe("ImageFingerprintStore — local", () => {
    it("adds and matches within tolerance, not beyond", () => {
        const s = makeStore({});
        const phash = phashFromHex("e5de4a00bcbd5a25");
        const rowId = s.add({ phash, action: "kick", category: "scam", addedBy: "test" });
        expect(rowId).toBeGreaterThan(0);
        expect(s.size).toBe(1);

        expect(s.match(phash, 5)?.distance).toBe(0);
        expect(s.match(flipBits("e5de4a00bcbd5a25", 3), 5)?.rowId).toBe(rowId);
        expect(s.match(flipBits("e5de4a00bcbd5a25", 3), 5)?.distance).toBe(3);
        expect(s.match(flipBits("e5de4a00bcbd5a25", 8), 5)).toBeNull();
    });

    it("rejects a near-duplicate when a duplicate tolerance is given", () => {
        const s = makeStore({});
        s.add({ phash: phashFromHex("e5de4a00bcbd5a25"), action: "kick", category: "scam", addedBy: "a" });
        expect(() =>
            s.add({
                phash: flipBits("e5de4a00bcbd5a25", 2),
                action: "kick",
                category: "scam",
                addedBy: "b",
                duplicateTolerance: 5,
            }),
        ).toThrow(DuplicateFingerprintError);
        expect(s.size).toBe(1);
    });

    it("validates action and category", () => {
        const s = makeStore({});
        expect(() => s.add({ phash: 1n, action: "ban", category: "scam", addedBy: "x" })).toThrow(/invalid action/);
        expect(() => s.add({ phash: 1n, action: "kick", category: "spam", addedBy: "x" })).toThrow(/invalid category/);
    });

    it("removes a local row and survives a reload", () => {
        const s = makeStore({});
        const id = s.add({ phash: phashFromHex("e5de4a00bcbd5a25"), action: "kick", category: "scam", addedBy: "a" });
        void s.remove(id);
        expect(s.size).toBe(0);
        s.reload();
        expect(s.size).toBe(0);
    });

    it("persists across store instances (same db)", () => {
        const path = join(dir, "shared.db");
        const a = new ImageFingerprintStore({ db_path: path }, { onError: () => undefined });
        a.add({ phash: phashFromHex("e5de4a00bcbd5a25"), action: "timeout", category: "crypto", addedBy: "a" });
        a.close();
        const b = new ImageFingerprintStore({ db_path: path }, { onError: () => undefined });
        stores.push(b);
        expect(b.size).toBe(1);
        expect(b.match(phashFromHex("e5de4a00bcbd5a25"), 0)?.action).toBe("timeout");
    });
});

describe("ImageFingerprintStore — hub sync", () => {
    const triple = {
        algorithm: "phash",
        algorithm_version: "imagehash.phash",
        normalization_version: "alpha_white_v1",
    };

    // Only /sync GETs draw a page from the queue; other calls (flag/hit/contribute)
    // return a generic 200 so they don't desync the page sequence.
    function stubFetchPages(pages: unknown[]): void {
        const queue = [...pages];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                if (String(url).includes("/v1/fingerprints/sync")) {
                    const body = queue.shift() ?? { fingerprints: [], next_since: 0, has_more: false };
                    return { status: 200, json: async () => body } as unknown as Response;
                }
                return { status: 200, json: async () => ({}) } as unknown as Response;
            }),
        );
    }

    it("ingests an active peer row, overriding action to our configured default", async () => {
        process.env["FINGERPRINT_HUB_API_KEY"] = "fph_test";
        stubFetchPages([
            {
                fingerprints: [
                    {
                        id: 48,
                        sync_seq: 48,
                        phash_hex: "e5de4a00bcbd5a25",
                        ...triple,
                        category: "scam",
                        action: "kick", // peer says kick; we enforce our default (timeout)
                        consumer_id: 2,
                        status: "active",
                    },
                ],
                next_since: 48,
                has_more: false,
            },
        ]);
        const s = makeStore({ hub_enabled: true, default_action: "timeout" });
        expect(s.hubActive).toBe(true);
        await s.syncOnce();

        expect(s.size).toBe(1);
        const hit = s.match(phashFromHex("e5de4a00bcbd5a25"), 0);
        expect(hit?.action).toBe("timeout");
        expect(hit?.origin).toBe("hub");

        // Watermark advanced: a follow-up sync with an empty feed keeps it.
        await s.syncOnce();
        expect(s.size).toBe(1);
    });

    it("skips hub rows with malformed pHash hex", async () => {
        process.env["FINGERPRINT_HUB_API_KEY"] = "fph_test";
        const errors: string[] = [];
        stubFetchPages([
            {
                fingerprints: [
                    {
                        id: 99,
                        sync_seq: 99,
                        phash_hex: "not-a-phash",
                        ...triple,
                        category: "scam",
                        action: "kick",
                        consumer_id: 2,
                        status: "active",
                    },
                ],
                next_since: 99,
                has_more: false,
            },
        ]);
        const s = new ImageFingerprintStore(
            { db_path: join(dir, "invalid_hub.db"), hub_enabled: true },
            { onError: (context, error) => errors.push(`${context}: ${String(error)}`) },
        );
        stores.push(s);

        await s.syncOnce();

        expect(s.size).toBe(0);
        expect(errors.some(error => error.includes("not-a-phash"))).toBe(true);
    });

    it("removes a row on a tombstone", async () => {
        process.env["FINGERPRINT_HUB_API_KEY"] = "fph_test";
        stubFetchPages([
            {
                fingerprints: [
                    {
                        id: 7,
                        sync_seq: 7,
                        phash_hex: "aaaaaaaaaaaaaaaa",
                        ...triple,
                        category: "scam",
                        action: "kick",
                        consumer_id: 2,
                        status: "active",
                    },
                ],
                next_since: 7,
                has_more: false,
            },
            {
                fingerprints: [
                    {
                        id: 7,
                        sync_seq: 9,
                        phash_hex: "aaaaaaaaaaaaaaaa",
                        ...triple,
                        category: "scam",
                        action: "kick",
                        consumer_id: 2,
                        status: "deleted",
                    },
                ],
                next_since: 9,
                has_more: false,
            },
        ]);
        const s = makeStore({ hub_enabled: true });
        await s.syncOnce();
        expect(s.size).toBe(1);
        await s.syncOnce();
        expect(s.size).toBe(0);
    });

    it("suppresses a removed hub row so the next sync can't resurrect it", async () => {
        process.env["FINGERPRINT_HUB_API_KEY"] = "fph_test";
        const activeRow = {
            fingerprints: [
                {
                    id: 11,
                    sync_seq: 11,
                    phash_hex: "bbbbbbbbbbbbbbbb",
                    ...triple,
                    category: "scam",
                    action: "kick",
                    consumer_id: 2,
                    status: "active",
                },
            ],
            next_since: 11,
            has_more: false,
        };
        // Two identical active pages: one to ingest, one to try to resurrect.
        stubFetchPages([activeRow, activeRow]);
        const s = makeStore({ hub_enabled: true });
        await s.syncOnce();
        const id = s.match(phashFromHex("bbbbbbbbbbbbbbbb"), 0)!.rowId;
        await s.remove(id); // origin hub → records suppression + flags
        // A later feed re-sends id=11 active; suppression must keep it out.
        // Reset the watermark path by forcing another drain from since=0 is not
        // needed — applySyncRow checks suppressions regardless of watermark.
        await s.syncOnce();
        expect(s.match(phashFromHex("bbbbbbbbbbbbbbbb"), 0)).toBeNull();
    });

    it("deletes the orphaned hub row when the local row is removed mid-contribute", async () => {
        process.env["FINGERPRINT_HUB_API_KEY"] = "fph_test";
        const calls: { method: string; url: string }[] = [];
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init: any) => {
                calls.push({ method: init?.method ?? "GET", url: String(url) });
                if (String(url).endsWith("/v1/fingerprints") && init?.method === "POST") {
                    return { status: 201, json: async () => ({ id: 777 }) } as unknown as Response;
                }
                return { status: 204, json: async () => null } as unknown as Response;
            }),
        );
        const s = makeStore({ hub_enabled: true });
        const rowId = s.add({ phash: phashFromHex("cccccccccccccccc"), action: "kick", category: "scam", addedBy: "a" });
        // Remove locally before the fire-and-forget contribute stamps its hub id
        // (hub_fingerprint_id is still NULL, so remove() can't delete it hub-side).
        await s.remove(rowId);
        // When contribute's UPDATE finds the row gone, it must delete the hub orphan.
        await vi.waitFor(() => expect(calls.some(c => c.method === "DELETE")).toBe(true));
        expect(calls.some(c => c.method === "DELETE" && c.url.endsWith("/v1/fingerprints/777"))).toBe(true);
        expect(s.size).toBe(0);
    });

    it("does not write to the DB (and does not throw) when closed mid-sync", async () => {
        process.env["FINGERPRINT_HUB_API_KEY"] = "fph_test";
        let releaseSync: (() => void) | undefined;
        vi.stubGlobal(
            "fetch",
            vi.fn((url: string) => {
                if (String(url).includes("/v1/fingerprints/sync")) {
                    return new Promise<Response>(resolve => {
                        releaseSync = () =>
                            resolve({
                                status: 200,
                                json: async () => ({
                                    fingerprints: [
                                        {
                                            id: 5,
                                            sync_seq: 5,
                                            phash_hex: "dddddddddddddddd",
                                            algorithm: "phash",
                                            algorithm_version: "imagehash.phash",
                                            normalization_version: "alpha_white_v1",
                                            category: "scam",
                                            action: "kick",
                                            consumer_id: 2,
                                            status: "active",
                                        },
                                    ],
                                    next_since: 5,
                                    has_more: false,
                                }),
                            } as unknown as Response);
                    });
                }
                return Promise.resolve({ status: 200, json: async () => ({}) } as unknown as Response);
            }),
        );
        const errors: string[] = [];
        const s = new ImageFingerprintStore(
            { db_path: join(dir, "close_midsync.db"), hub_enabled: true },
            { onError: (context, error) => errors.push(`${context}: ${String(error)}`) },
        );
        const pending = s.syncOnce(); // parks awaiting the hub page
        s.close(); // close the DB while the sync is in flight
        releaseSync?.(); // page arrives — the guard must bail before any DB write
        await expect(pending).resolves.toBeUndefined();
        expect(errors).toEqual([]);
    });
});
