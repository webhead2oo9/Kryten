import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPayload, handleCommandRead, listPayload, searchCommands, searchPayload } from "../src/api/commandRead";
import type { Commands } from "../src/types";

const CORPUS: Commands = [
    {
        format: 2,
        name: "link-headset",
        description: "How to link your Quest headset to your account",
        accent_color: 3447003,
        blocks: [
            { type: "heading", text: "Linking your headset" },
            { type: "text", text: "Open the Meta Quest mobile app and follow the pairing steps." },
            { type: "field", name: "Step 2", value: "Enable Bluetooth and pair the controllers." },
        ],
    },
    {
        format: 2,
        name: "refund-policy",
        description: "Store refund rules and how to request one",
        blocks: [{ type: "text", text: "Request a refund within 14 days if playtime is under 2 hours." }],
    },
    {
        format: 2,
        name: "rules",
        description: "Server rules",
        pages: [
            { name: "general", title: "General", blocks: [{ type: "text", text: "Be respectful to everyone." }] },
            { name: "voice", title: "Voice chat", blocks: [{ type: "text", text: "No mic spam in voice channels." }] },
        ],
    },
];

const RAW_BODIES = new Map<string, Record<string, unknown>>([
    ["link-headset", { format: 2, name: "link-headset", raw: true }],
]);
const getRaw = (name: string) => RAW_BODIES.get(name);
const ORIGINAL_API_KEY = process.env["PROPOSAL_API_KEY"];

function responseRecorder() {
    return {
        headersSent: false,
        writableEnded: false,
        statusCode: 0,
        body: "",
        writeHead: vi.fn(function (this: any, status: number) {
            this.statusCode = status;
            this.headersSent = true;
        }),
        end: vi.fn(function (this: any, body = "") {
            this.body = body;
            this.writableEnded = true;
        }),
    };
}

beforeEach(() => {
    process.env["PROPOSAL_API_KEY"] = "test-command-read-key";
});

afterEach(() => {
    if (ORIGINAL_API_KEY === undefined) delete process.env["PROPOSAL_API_KEY"];
    else process.env["PROPOSAL_API_KEY"] = ORIGINAL_API_KEY;
});

describe("searchCommands", () => {
    it("matches a command by name tokens", () => {
        const results = searchCommands(CORPUS, "link headset");
        expect(results.length).toBeGreaterThan(0);
        expect(results[0]!.name).toBe("link-headset");
        expect(results[0]!.score).toBeGreaterThanOrEqual(50);
        expect(results[0]!.matchedFields.length).toBeGreaterThan(0);
    });

    it("finds words that only appear in a field block value", () => {
        const results = searchCommands(CORPUS, "bluetooth controllers");
        expect(results[0]!.name).toBe("link-headset");
        expect(results[0]!.matchedFields.some(path => path.endsWith(".value"))).toBe(true);
    });

    it("finds words inside page blocks", () => {
        const results = searchCommands(CORPUS, "mic spam voice");
        expect(results[0]!.name).toBe("rules");
    });

    it("tolerates prefix typos", () => {
        const results = searchCommands(CORPUS, "headst", 10, 40);
        expect(results.map(match => match.name)).toContain("link-headset");
    });

    it("filters noise below min_score", () => {
        expect(searchCommands(CORPUS, "zxqwvkptmn")).toEqual([]);
    });

    it("prefers specific content over a subset-only name match", () => {
        const results = searchCommands(CORPUS, "refund rules", 10, 0);
        const names = results.map(match => match.name);
        expect(names.indexOf("refund-policy")).toBeLessThan(names.indexOf("rules"));
    });

    it("respects the limit and sorts by descending score", () => {
        const results = searchCommands(CORPUS, "rules", 1, 0);
        expect(results).toHaveLength(1);
        const unlimited = searchCommands(CORPUS, "refund", 10, 0);
        const scores = unlimited.map(match => match.score);
        expect(scores).toEqual([...scores].sort((a, b) => b - a));
    });

    it("returns nothing for an empty query", () => {
        expect(searchCommands(CORPUS, "   ")).toEqual([]);
    });
});

describe("payload builders", () => {
    it("lists a summary with has_pages", () => {
        const payload = listPayload(CORPUS, getRaw, "summary") as { count: number; commands: any[] };
        expect(payload.count).toBe(3);
        expect(payload.commands[0]).toEqual({
            name: "link-headset",
            description: "How to link your Quest headset to your account",
            has_pages: false,
        });
        expect(payload.commands[2]!.has_pages).toBe(true);
    });

    it("lists full raw bodies, falling back to the normalized command", () => {
        const payload = listPayload(CORPUS, getRaw, "full") as { commands: any[] };
        expect(payload.commands[0]).toEqual({ format: 2, name: "link-headset", raw: true });
        expect(payload.commands[1]!.name).toBe("refund-policy"); // normalized fallback
    });

    it("gets one command's raw body case-insensitively", () => {
        const payload = getPayload(CORPUS, getRaw, "LINK-HEADSET") as { command: any };
        expect(payload.command.raw).toBe(true);
        expect(getPayload(CORPUS, getRaw, "missing")).toBeUndefined();
    });

    it("search payload carries full command bodies and matched_fields", () => {
        const payload = searchPayload(CORPUS, getRaw, "bluetooth controllers", 10, 45) as {
            query: string;
            count: number;
            results: any[];
        };
        expect(payload.query).toBe("bluetooth controllers");
        expect(payload.count).toBe(payload.results.length);
        expect(payload.results[0]!.name).toBe("link-headset");
        expect(payload.results[0]!.command.raw).toBe(true);
        expect(Array.isArray(payload.results[0]!.matched_fields)).toBe(true);
    });
});

describe("handleCommandRead", () => {
    it("is unavailable when the proposal service is disabled", () => {
        const client = {
            proposalService: undefined,
            config: { proposals: { rate_limit_per_minute: 100 } },
            custom_commands: CORPUS,
            commandSync: { getRawBody: getRaw },
        };
        const res = responseRecorder();

        handleCommandRead(
            client as any,
            { headers: { "x-api-key": "test-command-read-key" } } as any,
            res as any,
            new URL("http://localhost/api/v1/commands"),
        );

        expect(res.statusCode).toBe(503);
    });

    it("rejects oversized search queries before scoring", () => {
        const client = {
            proposalService: {},
            config: { proposals: { rate_limit_per_minute: 100 } },
            custom_commands: CORPUS,
            commandSync: { getRawBody: getRaw },
        };
        const res = responseRecorder();

        handleCommandRead(
            client as any,
            { headers: { "x-api-key": "test-command-read-key" } } as any,
            res as any,
            new URL(`http://localhost/api/v1/commands/search?q=${"x".repeat(257)}`),
        );

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body).error).toContain("too long");
    });
});
