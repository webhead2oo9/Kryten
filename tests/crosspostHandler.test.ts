import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CrosspostHandler } from "../src/features/crosspost/crosspostHandler";

// The handler is the enforcement seam that times out / kicks real users, so
// these tests pin the gating (burst thresholds, offense escalation, dry-run,
// exemptions, directional update suppression) against silent regressions. Only
// Discord/network boundaries are faked; the real SimilarityEngine runs.

const AUTHOR_ID = "user-1";
const GUILD_ID = "guild-1";
const BASE = new Date("2026-07-06T00:00:00Z").getTime();

// Long / short crosspost pair whose engine scores were measured up-front, so the
// relaxed similarity thresholds below reliably match them while the directional
// isUpdate test can key off the exact length ratio (LONG≈2.53× SHORT normalized).
const SHORT = "quest3 wifi keeps disconnecting from virtualdesktop";
const LONG =
    "quest3 wifi keeps disconnecting from virtualdesktop constantly during multiplayer gaming sessions every single evening after work";
// Near-identical pair that clears the DEFAULT thresholds but is not byte-identical,
// so it exercises the similarity (non-exact) path.
const SIM_A = "my quest3 keeps disconnecting from virtualdesktop every few minutes and it is really annoying";
const SIM_B = "my quest2 keeps disconnecting from virtualdesktop every few minutes and it is really annoying";
const IDENTICAL = "check out my quest3 setup guide for virtualdesktop streaming latency";

let msgSeq = 0;
let warnSeq = 0;

function makeAuthor(id = AUTHOR_ID, bot = false) {
    return { id, bot, toString: () => `<@${id}>` };
}

function makeMember(roleIds: string[] = []) {
    return {
        roles: { cache: roleIds.map(id => ({ id })) },
        timeout: vi.fn().mockResolvedValue(undefined),
        kick: vi.fn().mockResolvedValue(undefined),
    };
}

function makeChannel(id: string) {
    return {
        id,
        isThread: () => false,
        parentId: null,
        // Each warning is a fresh object with its own delete() spy so deletion
        // cleanup can be asserted on the exact warning message the handler stored.
        send: vi.fn(async () => ({ id: `warn-${warnSeq++}`, delete: vi.fn().mockResolvedValue(undefined) })),
    };
}

function makeGuild(fetch = vi.fn().mockResolvedValue(null)) {
    return { members: { fetch } };
}

function attachments(list: Array<{ name: string; size: number }>) {
    const m = new Map<string, { name: string; size: number }>();
    list.forEach((a, i) => m.set(String(i), a));
    return m;
}

interface MsgOpts {
    channelId: string;
    content?: string;
    authorId?: string;
    member?: unknown;
    guild?: unknown;
    attachments?: Map<string, { name: string; size: number }>;
    id?: string;
}

function makeMessage(opts: MsgOpts): any {
    return {
        id: opts.id ?? `msg-${msgSeq++}`,
        author: makeAuthor(opts.authorId ?? AUTHOR_ID),
        member: "member" in opts ? opts.member : undefined,
        guild: opts.guild ?? makeGuild(),
        guildId: GUILD_ID,
        channelId: opts.channelId,
        channel: makeChannel(opts.channelId),
        content: opts.content ?? "",
        attachments: opts.attachments ?? new Map(),
        createdTimestamp: Date.now(),
        delete: vi.fn().mockResolvedValue(undefined),
    };
}

function makeClient(crosspost: any, opts?: { staffRoles?: string[]; alertChannelId?: string }): any {
    return {
        config: {
            staff_roles: opts?.staffRoles ?? [],
            moderation: { crosspost, alert_channel_id: opts?.alertChannelId },
        },
        channels: { fetch: vi.fn().mockResolvedValue(null) },
        logError: vi.fn().mockResolvedValue(undefined),
    };
}

function recentOf(handler: any, userId = AUTHOR_ID): Array<{ messageId: string; channelId: string }> | undefined {
    return handler.recentMessages.get(userId);
}

function cooldownOf(handler: any, userId = AUTHOR_ID): { handledAt: number; offenseCount: number } | undefined {
    return handler.burstCooldowns.get(userId);
}

/** Post identical-content messages across the given channels, one per channel, in order. */
async function crosspostAcross(
    handler: CrosspostHandler,
    channels: string[],
    opts?: { content?: string; member?: unknown; guild?: unknown },
): Promise<any[]> {
    const msgs: any[] = [];
    for (const channelId of channels) {
        const m = makeMessage({
            channelId,
            content: opts?.content ?? IDENTICAL,
            member: opts?.member,
            guild: opts?.guild,
        });
        await handler.check(m);
        msgs.push(m);
    }
    return msgs;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe("CrosspostHandler — burst threshold is strictly greater than burst_channel_threshold", () => {
    it("does not burst at exactly the threshold count of channels but does one above it", async () => {
        const client = makeClient({ enabled: true, dry_run: true, burst_channel_threshold: 3 });
        const handler = new CrosspostHandler(client);

        // 3 distinct channels → channels.size === 3, NOT > 3 → normal warn path.
        await crosspostAcross(handler, ["chan-a", "chan-b", "chan-c"]);
        expect(handler.getMetrics().burstSpamDetected).toBe(0);
        expect(handler.getMetrics().warningsSent).toBe(2); // b and c each warn against a

        // A 4th distinct channel → channels.size === 4 > 3 → burst handling.
        await handler.check(makeMessage({ channelId: "chan-d", content: IDENTICAL }));
        expect(handler.getMetrics().burstSpamDetected).toBe(1);
    });
});

describe("CrosspostHandler — burst offense escalation (enforcement mode)", () => {
    it("times out on the first burst incident and does not kick", async () => {
        const client = makeClient({
            enabled: true,
            dry_run: false,
            burst_channel_threshold: 3,
            burst_timeout_minutes: 30,
        });
        const handler = new CrosspostHandler(client);
        const member = makeMember();
        const guild = makeGuild();

        const msgs = await crosspostAcross(handler, ["chan-a", "chan-b", "chan-c", "chan-d"], { member, guild });

        expect(member.timeout).toHaveBeenCalledTimes(1);
        expect(member.timeout).toHaveBeenCalledWith(30 * 60 * 1000, "Cross-channel spam");
        expect(member.kick).not.toHaveBeenCalled();
        // The burst-triggering message was deleted and history cleared.
        expect(msgs[3].delete).toHaveBeenCalledTimes(1);
        expect(recentOf(handler)).toEqual([]);
    });

    it("kicks on a second burst incident within 24h", async () => {
        const client = makeClient({ enabled: true, dry_run: false, burst_channel_threshold: 3 });
        const handler = new CrosspostHandler(client);
        const member = makeMember();
        const guild = makeGuild();

        await crosspostAcross(handler, ["chan-a", "chan-b", "chan-c", "chan-d"], { member, guild });
        expect(member.timeout).toHaveBeenCalledTimes(1);

        // Past the 60s incident cooldown, well within the 24h offense window.
        vi.setSystemTime(BASE + 120_000);
        await crosspostAcross(handler, ["chan-a", "chan-b", "chan-c", "chan-d"], { member, guild });

        expect(member.kick).toHaveBeenCalledTimes(1);
        expect(member.kick).toHaveBeenCalledWith("Repeat cross-channel spam");
        expect(member.timeout).toHaveBeenCalledTimes(1); // still just the first offense's timeout
    });

    it("resets to a timeout after the 24h offense window elapses", async () => {
        const client = makeClient({ enabled: true, dry_run: false, burst_channel_threshold: 3 });
        const handler = new CrosspostHandler(client);
        const member = makeMember();
        const guild = makeGuild();

        await crosspostAcross(handler, ["chan-a", "chan-b", "chan-c", "chan-d"], { member, guild });
        expect(member.timeout).toHaveBeenCalledTimes(1);

        // Past OFFENSE_RESET_SECONDS (86400s): the offense count is dropped, so the
        // next burst is treated as a first offense (timeout) rather than a kick.
        vi.setSystemTime(BASE + 86_500_000);
        await crosspostAcross(handler, ["chan-a", "chan-b", "chan-c", "chan-d"], { member, guild });

        expect(member.timeout).toHaveBeenCalledTimes(2);
        expect(member.kick).not.toHaveBeenCalled();
    });
});

describe("CrosspostHandler — dry_run matrix", () => {
    it("records a dry-run burst incident without offense escalation, enforcement, or losing tracking", async () => {
        const crosspost = { enabled: true, dry_run: true, burst_channel_threshold: 3, burst_timeout_minutes: 30 };
        const client = makeClient(crosspost);
        const handler = new CrosspostHandler(client);
        const member = makeMember();
        const guild = makeGuild();

        const msgs = await crosspostAcross(handler, ["chan-a", "chan-b", "chan-c", "chan-d"], { member, guild });

        expect(handler.getMetrics().burstSpamDetected).toBe(1);
        expect(handler.getMetrics().messagesProcessed).toBe(4);
        expect(member.timeout).not.toHaveBeenCalled();
        expect(member.kick).not.toHaveBeenCalled();
        expect(msgs[3].delete).not.toHaveBeenCalled();
        // Tracking continues (nothing deleted) and the current message is re-tracked.
        expect(recentOf(handler)).toHaveLength(4);
        // Incident recorded but offense count untouched.
        expect(cooldownOf(handler)!.offenseCount).toBe(0);

        // Behavioral proof the dry-run incident did NOT count as offense #1: flip to
        // enforcement past the incident cooldown; the retained history immediately
        // re-bursts and, being a first true offense, times out (does not kick).
        crosspost.dry_run = false;
        vi.setSystemTime(BASE + 120_000);
        await handler.check(makeMessage({ channelId: "chan-a", content: IDENTICAL, member, guild }));
        expect(member.timeout).toHaveBeenCalledTimes(1);
        expect(member.kick).not.toHaveBeenCalled();
    });

    it("an enforcement burst deletes, clears the user's history, and does not re-track the current message", async () => {
        const client = makeClient({ enabled: true, dry_run: false, burst_channel_threshold: 3 });
        const handler = new CrosspostHandler(client);
        const member = makeMember();
        const guild = makeGuild();

        const msgs = await crosspostAcross(handler, ["chan-a", "chan-b", "chan-c", "chan-d"], { member, guild });

        expect(msgs[3].delete).toHaveBeenCalledTimes(1);
        expect(member.timeout).toHaveBeenCalledTimes(1);
        expect(recentOf(handler)).toEqual([]); // cleared AND current message not re-inserted
    });
});

describe("CrosspostHandler — shouldWarn semantics", () => {
    it("in dry-run a similarity-only match is detected but stays silent", async () => {
        const client = makeClient({ enabled: true, dry_run: true });
        const handler = new CrosspostHandler(client);

        await handler.check(makeMessage({ channelId: "chan-a", content: SIM_A }));
        await handler.check(makeMessage({ channelId: "chan-b", content: SIM_B }));

        expect(handler.getMetrics().messagesProcessed).toBe(2);
        expect(handler.getMetrics().similarityMatches).toBe(1);
        expect(handler.getMetrics().exactMatches).toBe(0);
        expect(handler.getMetrics().warningsSent).toBe(0);
    });

    it("in dry-run an exact attachment match still warns", async () => {
        const client = makeClient({ enabled: true, dry_run: true });
        const handler = new CrosspostHandler(client);
        const file = [{ name: "screenshot.png", size: 12_345 }];

        await handler.check(makeMessage({ channelId: "chan-a", attachments: attachments(file) }));
        await handler.check(makeMessage({ channelId: "chan-b", attachments: attachments(file) }));

        expect(handler.getMetrics().exactMatches).toBe(1);
        expect(handler.getMetrics().warningsSent).toBe(1);
    });

    it("in enforcement a non-update similarity match warns", async () => {
        const client = makeClient({ enabled: true, dry_run: false });
        const handler = new CrosspostHandler(client);

        await handler.check(makeMessage({ channelId: "chan-a", content: SIM_A }));
        await handler.check(makeMessage({ channelId: "chan-b", content: SIM_B }));

        expect(handler.getMetrics().similarityMatches).toBe(1);
        expect(handler.getMetrics().warningsSent).toBe(1);
    });
});

describe("CrosspostHandler — staff/whitelist exemption", () => {
    it("fetches an uncached member and skips an exempt (staff-role) user entirely", async () => {
        const fetch = vi.fn().mockResolvedValue(makeMember(["staff-role"]));
        const client = makeClient({ enabled: true }, { staffRoles: ["staff-role"] });
        const handler = new CrosspostHandler(client);

        // member undefined → not cached → the handler must fetch rather than skip.
        await handler.check(makeMessage({ channelId: "chan-a", content: IDENTICAL, member: undefined, guild: makeGuild(fetch) }));

        expect(fetch).toHaveBeenCalledWith(AUTHOR_ID);
        expect(recentOf(handler)).toBeUndefined();
        expect(handler.getMetrics().messagesProcessed).toBe(0);
    });

    it("skips a cached whitelisted-role user without a member fetch", async () => {
        const fetch = vi.fn().mockResolvedValue(null);
        const client = makeClient({ enabled: true, whitelisted_role_ids: ["vip-role"] });
        const handler = new CrosspostHandler(client);

        await handler.check(
            makeMessage({ channelId: "chan-a", content: IDENTICAL, member: makeMember(["vip-role"]), guild: makeGuild(fetch) }),
        );

        expect(fetch).not.toHaveBeenCalled();
        expect(recentOf(handler)).toBeUndefined();
        expect(handler.getMetrics().messagesProcessed).toBe(0);
    });
});

describe("CrosspostHandler — directional update suppression", () => {
    // Relaxed thresholds so the long/short pair (lengthRatio ≈ 2.53) still matches;
    // the point under test is the asymmetric isUpdate check, not the score gates.
    const updateConfig = {
        enabled: true,
        dry_run: false,
        sequence_ratio_threshold: 0.5,
        jaccard_threshold: 0.3,
        char_cosine_threshold: 0.6,
        min_normalized_length: 40,
        length_ratio_threshold: 3.0,
        min_algorithms_to_match: 2,
        new_content_ratio_threshold: 0.3,
    };

    it("suppresses a longer elaboration of an earlier message as an update", async () => {
        const handler = new CrosspostHandler(makeClient({ ...updateConfig }));

        await handler.check(makeMessage({ channelId: "chan-a", content: SHORT }));
        await handler.check(makeMessage({ channelId: "chan-b", content: LONG }));

        expect(handler.getMetrics().updatesDetected).toBe(1);
        expect(handler.getMetrics().warningsSent).toBe(0);
    });

    it("does NOT suppress a shorter reworded crosspost (the symmetric-ratio regression guard)", async () => {
        const handler = new CrosspostHandler(makeClient({ ...updateConfig }));

        await handler.check(makeMessage({ channelId: "chan-a", content: LONG }));
        await handler.check(makeMessage({ channelId: "chan-b", content: SHORT }));

        expect(handler.getMetrics().updatesDetected).toBe(0);
        expect(handler.getMetrics().warningsSent).toBe(1);
    });
});

describe("CrosspostHandler — attachment fingerprint uses name:size", () => {
    it("treats same-name different-size attachments as NOT an exact match", async () => {
        const client = makeClient({ enabled: true, dry_run: true });
        const handler = new CrosspostHandler(client);

        await handler.check(makeMessage({ channelId: "chan-a", attachments: attachments([{ name: "image.png", size: 100 }]) }));
        await handler.check(makeMessage({ channelId: "chan-b", attachments: attachments([{ name: "image.png", size: 200 }]) }));

        expect(handler.getMetrics().messagesProcessed).toBe(2);
        expect(handler.getMetrics().exactMatches).toBe(0);
        expect(handler.getMetrics().similarityMatches).toBe(0);
        expect(handler.getMetrics().warningsSent).toBe(0);
    });
});

describe("CrosspostHandler — warn cooldown", () => {
    it("suppresses a second warn for the same user+channel within the cooldown but still tracks the message", async () => {
        const client = makeClient({ enabled: true, dry_run: true, burst_channel_threshold: 5 });
        const handler = new CrosspostHandler(client);

        await handler.check(makeMessage({ channelId: "chan-a", content: IDENTICAL })); // source
        await handler.check(makeMessage({ channelId: "chan-b", content: IDENTICAL })); // warns in chan-b
        const third = makeMessage({ channelId: "chan-b", content: IDENTICAL });
        await handler.check(third); // matches chan-a again, but chan-b is on cooldown

        expect(handler.getMetrics().warningsSent).toBe(1);
        expect(handler.getMetrics().warningsSuppressed).toBe(1);
        expect(recentOf(handler)!.some(e => e.messageId === third.id)).toBe(true);
    });
});

describe("CrosspostHandler — handleMessageDeletion", () => {
    it("removes a warned message's linked warning and clears its cooldown", async () => {
        const client = makeClient({ enabled: true, dry_run: true });
        const handler = new CrosspostHandler(client);

        await handler.check(makeMessage({ channelId: "chan-a", content: IDENTICAL, id: "source-1" }));
        const duplicate = makeMessage({ channelId: "chan-b", content: IDENTICAL, id: "dup-1" });
        await handler.check(duplicate);

        const stored = (handler as any).warningMessages.get("dup-1")[0].warningMessage;
        expect((handler as any).spamWarnings.get(AUTHOR_ID)?.get("chan-b")).toBeDefined();

        await handler.handleMessageDeletion(duplicate);

        expect(stored.delete).toHaveBeenCalledTimes(1);
        expect((handler as any).spamWarnings.get(AUTHOR_ID)?.get("chan-b")).toBeUndefined();
        expect(recentOf(handler)!.some(e => e.messageId === "dup-1")).toBe(false);
    });

    it("cleans up a partial (authorless) deletion via the full recent-message scan", async () => {
        const client = makeClient({ enabled: true, dry_run: true });
        const handler = new CrosspostHandler(client);

        await handler.check(makeMessage({ channelId: "chan-a", content: IDENTICAL, id: "source-1" }));
        const duplicate = makeMessage({ channelId: "chan-b", content: IDENTICAL, id: "dup-1" });
        await handler.check(duplicate);

        const stored = (handler as any).warningMessages.get("dup-1")[0].warningMessage;

        // PartialMessage with no author id → the userId branch can't run, so the
        // fallback scan over all users must find and drop the entry.
        await handler.handleMessageDeletion({ id: "dup-1", author: undefined } as any);

        expect(stored.delete).toHaveBeenCalledTimes(1);
        expect(recentOf(handler)!.some(e => e.messageId === "dup-1")).toBe(false);
    });
});
