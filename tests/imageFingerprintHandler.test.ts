import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComponentType, MessageFlags } from "discord.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fake the two boundary layers that touch sharp/the network so tests control
// exactly which pHash each attachment yields. The rest of the handler — the
// store, matching, review/enforcement bookkeeping — runs for real.
vi.mock("../src/features/imageFingerprint/imageSources", () => ({
    resolveImageSources: async (message: any) =>
        [...message.attachments.values()].map((a: any) => ({
            raw: Buffer.from(a.phash, "utf8"),
            filename: a.name,
            url: a.url,
            contentType: "image/png",
            size: 10,
        })),
}));
vi.mock("../src/features/imageFingerprint/decode", () => ({
    // Our fake ImageSource carries its pHash hex as the raw bytes.
    computePhashHex: async (raw: Buffer) => raw.toString("utf8"),
}));

import {
    ImageFingerprintHandler,
    parseImgfpButtonId,
} from "../src/features/imageFingerprint/imageFingerprintHandler";
import { phashFromHex } from "../src/features/imageFingerprint/store";

let dir: string;
let handlers: ImageFingerprintHandler[] = [];
let dbCounter = 0;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "imgfp-handler-"));
    dbCounter = 0;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    for (const h of handlers) {
        try {
            h.stop();
        } catch {
            // ignore
        }
    }
    handlers = [];
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
});

// ---- fakes ----------------------------------------------------------------

function makeClient(imageFingerprintConfig: Record<string, unknown>, staffRoles: string[] = []): any {
    const channels = new Map<string, any>();
    return {
        config: {
            staff_roles: staffRoles,
            moderation: {
                image_fingerprint: {
                    db_path: join(dir, `fp_${dbCounter++}.db`),
                    ...imageFingerprintConfig,
                },
            },
        },
        logError: vi.fn(async () => undefined),
        channels: { fetch: vi.fn(async (id: string) => channels.get(id) ?? null) },
        _channels: channels,
    };
}

function registerChannel(client: any, id: string, channel: any): void {
    client._channels.set(id, channel);
}

function makeTextChannel(send?: any): any {
    return {
        isTextBased: () => true,
        send: send ?? vi.fn(async () => ({ id: "sent" })),
    };
}

function makeHandler(client: any): ImageFingerprintHandler {
    const h = new ImageFingerprintHandler(client);
    handlers.push(h);
    return h;
}

function makeGuild(membersFetch?: any): any {
    return {
        id: "guild-1",
        members: { fetch: membersFetch ?? vi.fn(async () => null) },
    };
}

// GuildMember-shaped role container (roles.cache.some) plus mod-action stubs.
function makeMember(roleIds: string[] = [], overrides: { kick?: any; timeout?: any } = {}): any {
    return {
        roles: { cache: { some: (fn: (r: { id: string }) => boolean) => roleIds.some(id => fn({ id })) } },
        kick: overrides.kick ?? vi.fn(async () => undefined),
        timeout: overrides.timeout ?? vi.fn(async () => undefined),
    };
}

let msgSeq = 0;
function makeMessage(opts: {
    attachments?: { phash: string; name?: string; url?: string }[];
    author?: any;
    member?: any;
    guild?: any;
    channelId?: string;
    delete?: any;
}): any {
    const attachments = new Map<string, any>();
    (opts.attachments ?? []).forEach((a, i) => {
        attachments.set(String(i), {
            phash: a.phash,
            name: a.name ?? `image-${i}.png`,
            url: a.url ?? `https://cdn/${i}.png`,
        });
    });
    const channelId = opts.channelId ?? "chan-A";
    const guild = opts.guild ?? makeGuild();
    return {
        id: `msg-${msgSeq++}`,
        author: opts.author ?? { id: "user-1", tag: "user#0001", bot: false },
        member: opts.member ?? null,
        guild,
        guildId: guild.id,
        channelId,
        channel: { isThread: () => false, parentId: null },
        attachments,
        url: `https://discord/${channelId}/msg`,
        delete: opts.delete ?? vi.fn(async () => undefined),
    };
}

function makeButtonInteraction(
    customId: string,
    opts: { memberRoles?: string[]; userId?: string; userTag?: string } = {},
): any {
    return {
        customId,
        // Array role shape — memberHasStaffRole accepts it directly.
        member: { roles: opts.memberRoles ?? [] },
        user: { id: opts.userId ?? "staff-1", tag: opts.userTag ?? "staff#0001" },
        deferUpdate: vi.fn(async () => undefined),
        reply: vi.fn(async () => undefined),
        followUp: vi.fn(async () => undefined),
        editReply: vi.fn(async () => undefined),
        // Production imgfp review cards are Components-V2, so resolveCard takes
        // its CV2 branch: it rebuilds the container, drops the button ActionRow,
        // and renders the outcome note into a TextDisplay (never `content`).
        // A message-component-shaped object (type + toJSON, like real discord.js
        // yields) exercises that path faithfully.
        message: {
            flags: { has: (f: unknown) => f === MessageFlags.IsComponentsV2 },
            components: [
                {
                    type: ComponentType.Container,
                    toJSON: () => ({
                        type: ComponentType.Container,
                        accent_color: 0xffa500,
                        components: [
                            { type: ComponentType.TextDisplay, content: "## Image Crosspost Review" },
                            { type: ComponentType.ActionRow, components: [{ type: ComponentType.Button }] },
                        ],
                    }),
                },
            ],
        },
    };
}

// resolveCard's CV2 branch renders the outcome note into a TextDisplay inside
// the rebuilt component tree, not the `content` field. Pull it back out of the
// editReply payload for assertions (falls back to `content` for the non-CV2
// path so the helper stays honest about either rendering).
function resolvedNote(interaction: any): string {
    const payload = interaction.editReply.mock.calls[0][0];
    if (typeof payload.content === "string") return payload.content;
    return JSON.stringify(payload.components ?? []);
}

// Pull the review token out of the card the handler just sent.
function extractToken(sendMock: any): string {
    const calls = sendMock.mock.calls;
    const payload = calls[calls.length - 1][0];
    const json = JSON.stringify(payload.components.map((c: any) => (c.toJSON ? c.toJSON() : c)));
    const m = json.match(/imgfp:approve:([0-9a-f]{32})/);
    if (!m) throw new Error("no review token in sent card");
    return m[1];
}

// Drive a same-user, two-channel crosspost so the handler raises a review card.
async function raiseReview(
    handler: ImageFingerprintHandler,
    sendMock: any,
    phash: string,
    author: any = { id: "spammer-1", tag: "spammer#0001", bot: false },
): Promise<string> {
    const guild = makeGuild();
    await handler.process(
        makeMessage({ attachments: [{ phash }], author, member: makeMember([]), guild, channelId: "chan-A" }),
    );
    await handler.process(
        makeMessage({ attachments: [{ phash }], author, member: makeMember([]), guild, channelId: "chan-B" }),
    );
    return extractToken(sendMock);
}

const KNOWN_BAD = "e5de4a00bcbd5a25";

// ---- parseImgfpButtonId ---------------------------------------------------

describe("parseImgfpButtonId", () => {
    it("parses a valid approve id", () => {
        expect(parseImgfpButtonId("imgfp:approve:deadbeef")).toEqual({ action: "approve", token: "deadbeef" });
    });
    it("parses a valid deny id", () => {
        expect(parseImgfpButtonId("imgfp:deny:abc123")).toEqual({ action: "deny", token: "abc123" });
    });
    it("rejects an unknown action", () => {
        expect(parseImgfpButtonId("imgfp:bogus:tok")).toBeNull();
    });
    it("rejects an empty token", () => {
        expect(parseImgfpButtonId("imgfp:approve:")).toBeNull();
        expect(parseImgfpButtonId("imgfp:approve")).toBeNull();
    });
    it("rejects a wrong prefix", () => {
        expect(parseImgfpButtonId("other:approve:tok")).toBeNull();
        expect(parseImgfpButtonId("cmdprop:approve:tok")).toBeNull();
    });
    it("rejects garbage", () => {
        expect(parseImgfpButtonId("garbage")).toBeNull();
        expect(parseImgfpButtonId("imgfp:")).toBeNull();
        expect(parseImgfpButtonId("")).toBeNull();
    });
});

// ---- feature gates --------------------------------------------------------

describe("ImageFingerprintHandler.process gates", () => {
    it("is a no-op when the feature is disabled", async () => {
        const client = makeClient({ enabled: false, dry_run: false });
        const handler = makeHandler(client);
        handler.store.add({ phash: phashFromHex(KNOWN_BAD), action: "kick", category: "scam", addedBy: "seed" });
        const del = vi.fn(async () => undefined);
        const result = await handler.process(makeMessage({ attachments: [{ phash: KNOWN_BAD }], delete: del }));
        expect(result).toBe(false);
        expect(del).not.toHaveBeenCalled();
        expect(handler.getMetrics().imagesScanned).toBe(0);
    });

    it("skips messages authored by a bot", async () => {
        const client = makeClient({ enabled: true, dry_run: false });
        const handler = makeHandler(client);
        handler.store.add({ phash: phashFromHex(KNOWN_BAD), action: "kick", category: "scam", addedBy: "seed" });
        const del = vi.fn(async () => undefined);
        const result = await handler.process(
            makeMessage({
                attachments: [{ phash: KNOWN_BAD }],
                author: { id: "bot-1", tag: "bot#0001", bot: true },
                delete: del,
            }),
        );
        expect(result).toBe(false);
        expect(del).not.toHaveBeenCalled();
        expect(handler.getMetrics().imagesScanned).toBe(0);
    });

    it("exempts a whitelisted (cached) member without scanning", async () => {
        const client = makeClient({ enabled: true, dry_run: false, whitelisted_role_ids: ["vip"] });
        const handler = makeHandler(client);
        handler.store.add({ phash: phashFromHex(KNOWN_BAD), action: "kick", category: "scam", addedBy: "seed" });
        const del = vi.fn(async () => undefined);
        const guild = makeGuild();
        const result = await handler.process(
            makeMessage({ attachments: [{ phash: KNOWN_BAD }], member: makeMember(["vip"]), guild, delete: del }),
        );
        expect(result).toBe(false);
        expect(del).not.toHaveBeenCalled();
        expect(guild.members.fetch).not.toHaveBeenCalled();
        expect(handler.getMetrics().imagesScanned).toBe(0);
    });

    it("exempts a staff member (via staff_roles) without scanning", async () => {
        const client = makeClient({ enabled: true, dry_run: false }, ["mod"]);
        const handler = makeHandler(client);
        handler.store.add({ phash: phashFromHex(KNOWN_BAD), action: "kick", category: "scam", addedBy: "seed" });
        const del = vi.fn(async () => undefined);
        const result = await handler.process(
            makeMessage({ attachments: [{ phash: KNOWN_BAD }], member: makeMember(["mod"]), delete: del }),
        );
        expect(result).toBe(false);
        expect(del).not.toHaveBeenCalled();
        expect(handler.getMetrics().imagesScanned).toBe(0);
    });

    it("fetches an uncached member to apply the whitelist exemption", async () => {
        const client = makeClient({ enabled: true, dry_run: false, whitelisted_role_ids: ["vip"] });
        const handler = makeHandler(client);
        handler.store.add({ phash: phashFromHex(KNOWN_BAD), action: "kick", category: "scam", addedBy: "seed" });
        const del = vi.fn(async () => undefined);
        const fetch = vi.fn(async () => makeMember(["vip"]));
        const guild = makeGuild(fetch);
        const result = await handler.process(
            makeMessage({ attachments: [{ phash: KNOWN_BAD }], member: null, guild, delete: del }),
        );
        expect(result).toBe(false);
        expect(fetch).toHaveBeenCalledWith("user-1");
        expect(del).not.toHaveBeenCalled();
        expect(handler.getMetrics().imagesScanned).toBe(0);
    });
});

// ---- known-bad match ------------------------------------------------------

describe("ImageFingerprintHandler known-bad match", () => {
    it("in dry-run does not delete/enforce and does not stop the pipeline", async () => {
        const client = makeClient({ enabled: true, dry_run: true, report_hits_in_dry_run: false });
        const handler = makeHandler(client);
        handler.store.add({ phash: phashFromHex(KNOWN_BAD), action: "kick", category: "scam", addedBy: "seed" });
        const hitSpy = vi.spyOn(handler.store, "incrementHit");

        const del = vi.fn(async () => undefined);
        const member = makeMember([]);
        const result = await handler.process(
            makeMessage({ attachments: [{ phash: KNOWN_BAD }], member, delete: del }),
        );

        expect(result).toBe(false); // pipeline continues — message still present
        expect(del).not.toHaveBeenCalled();
        expect(member.kick).not.toHaveBeenCalled();
        expect(member.timeout).not.toHaveBeenCalled();
        expect(handler.getMetrics().knownBadMatches).toBe(1);
        expect(handler.getMetrics().actionsTaken).toBe(0);
        // report_hits_in_dry_run:false suppresses hub telemetry for this hit.
        expect(hitSpy.mock.calls[0][1]?.reportToHub).toBe(false);

        // Default (report_hits_in_dry_run:true) keeps the observational telemetry on.
        client.config.moderation.image_fingerprint.report_hits_in_dry_run = true;
        await handler.process(makeMessage({ attachments: [{ phash: KNOWN_BAD }], member, delete: del }));
        expect(hitSpy.mock.calls[1][1]?.reportToHub).toBe(true);
    });

    it("in enforce mode deletes and applies the action, stopping the pipeline", async () => {
        const client = makeClient({ enabled: true, dry_run: false, default_action: "kick" });
        const handler = makeHandler(client);
        handler.store.add({ phash: phashFromHex(KNOWN_BAD), action: "kick", category: "scam", addedBy: "seed" });

        const del = vi.fn(async () => undefined);
        const member = makeMember([]);
        const result = await handler.process(
            makeMessage({ attachments: [{ phash: KNOWN_BAD }], member, delete: del }),
        );

        expect(result).toBe(true); // deletion succeeded → stop the pipeline
        expect(del).toHaveBeenCalledTimes(1);
        expect(member.kick).toHaveBeenCalledTimes(1);
        expect(handler.getMetrics().knownBadMatches).toBe(1);
        expect(handler.getMetrics().actionsTaken).toBe(1);
    });

    it("does not stop the pipeline when the delete fails", async () => {
        const client = makeClient({ enabled: true, dry_run: false, default_action: "kick" });
        const handler = makeHandler(client);
        handler.store.add({ phash: phashFromHex(KNOWN_BAD), action: "kick", category: "scam", addedBy: "seed" });

        const del = vi.fn(async () => {
            throw new Error("missing permissions");
        });
        const member = makeMember([]);
        const result = await handler.process(
            makeMessage({ attachments: [{ phash: KNOWN_BAD }], member, delete: del }),
        );

        expect(result).toBe(false); // delete failed → later features still see the message
        expect(del).toHaveBeenCalledTimes(1);
        expect(member.kick).toHaveBeenCalledTimes(1);
        expect(handler.getMetrics().actionsTaken).toBe(1);
    });

    it("does not inflate actionsTaken when the member action fails", async () => {
        const client = makeClient({ enabled: true, dry_run: false, default_action: "kick" });
        const handler = makeHandler(client);
        handler.store.add({ phash: phashFromHex(KNOWN_BAD), action: "kick", category: "scam", addedBy: "seed" });

        const del = vi.fn(async () => undefined);
        const member = makeMember([], {
            kick: vi.fn(async () => {
                throw new Error("missing Kick Members");
            }),
        });
        const result = await handler.process(
            makeMessage({ attachments: [{ phash: KNOWN_BAD }], member, delete: del }),
        );

        expect(result).toBe(true); // delete succeeded even though the kick failed
        expect(member.kick).toHaveBeenCalledTimes(1);
        expect(handler.getMetrics().knownBadMatches).toBe(1);
        expect(handler.getMetrics().actionsTaken).toBe(0);
    });

    it("takes priority over the crosspost-review path", async () => {
        const client = makeClient({
            enabled: true,
            dry_run: true,
            review_channel_id: "review-chan",
            review_channel_threshold: 2,
        });
        const handler = makeHandler(client);
        const author = { id: "u-prio", tag: "u#prio", bot: false };
        const guild = makeGuild();

        // First post (benign) is remembered for crosspost tracking.
        await handler.process(
            makeMessage({ attachments: [{ phash: KNOWN_BAD }], author, member: makeMember([]), guild, channelId: "chan-A" }),
        );
        // Now the same image becomes known-bad.
        handler.store.add({ phash: phashFromHex(KNOWN_BAD), action: "kick", category: "scam", addedBy: "seed" });
        // Second post across a distinct channel would meet the crosspost threshold,
        // but the known-bad match short-circuits before the review path runs.
        await handler.process(
            makeMessage({ attachments: [{ phash: KNOWN_BAD }], author, member: makeMember([]), guild, channelId: "chan-B" }),
        );

        expect(handler.getMetrics().knownBadMatches).toBe(1);
        expect(handler.getMetrics().reviewsRaised).toBe(0);
    });
});

// ---- crosspost review -----------------------------------------------------

describe("ImageFingerprintHandler crosspost review", () => {
    it("raises exactly one card across threshold channels and dedupes near-identical variants while pending", async () => {
        const send = vi.fn(async () => ({ id: "m" }));
        const client = makeClient({
            enabled: true,
            dry_run: true,
            review_channel_id: "review-chan",
            review_channel_threshold: 2,
            crosspost_tolerance: 5,
        });
        registerChannel(client, "review-chan", makeTextChannel(send));
        const handler = makeHandler(client);
        const author = { id: "spammer-1", tag: "spammer#0001", bot: false };
        const guild = makeGuild();

        const P = "0000000000000000";
        await handler.process(
            makeMessage({ attachments: [{ phash: P }], author, member: makeMember([]), guild, channelId: "chan-A" }),
        );
        await handler.process(
            makeMessage({ attachments: [{ phash: P }], author, member: makeMember([]), guild, channelId: "chan-B" }),
        );
        expect(send).toHaveBeenCalledTimes(1);
        expect(handler.getMetrics().reviewsRaised).toBe(1);

        // A recompressed copy (1 bit off) in a third channel must not raise a
        // second card while the first review is still pending.
        await handler.process(
            makeMessage({
                attachments: [{ phash: "0000000000000001" }],
                author,
                member: makeMember([]),
                guild,
                channelId: "chan-C",
            }),
        );
        expect(send).toHaveBeenCalledTimes(1);
        expect(handler.getMetrics().reviewsRaised).toBe(1);
    });

    it("removes the pending phash when posting the card fails, so a later occurrence can raise a new card", async () => {
        let n = 0;
        const send = vi.fn(async () => {
            n++;
            if (n === 1) throw new Error("send failed");
            return { id: "m" };
        });
        const client = makeClient({
            enabled: true,
            dry_run: true,
            review_channel_id: "review-chan",
            review_channel_threshold: 2,
            crosspost_tolerance: 5,
        });
        registerChannel(client, "review-chan", makeTextChannel(send));
        const handler = makeHandler(client);
        const author = { id: "spammer-2", tag: "spammer#0002", bot: false };
        const guild = makeGuild();
        const P = "0000000000000000";

        await handler.process(
            makeMessage({ attachments: [{ phash: P }], author, member: makeMember([]), guild, channelId: "chan-A" }),
        );
        await handler.process(
            makeMessage({ attachments: [{ phash: P }], author, member: makeMember([]), guild, channelId: "chan-B" }),
        );
        // First card failed to post; pending phash cleared, no review recorded.
        expect(handler.getMetrics().reviewsRaised).toBe(0);

        await handler.process(
            makeMessage({ attachments: [{ phash: P }], author, member: makeMember([]), guild, channelId: "chan-C" }),
        );
        expect(send).toHaveBeenCalledTimes(2);
        expect(handler.getMetrics().reviewsRaised).toBe(1);
    });

    it("suppresses review when the image is already known-bad-ish (duplicate_tolerance > match_tolerance)", async () => {
        const send = vi.fn(async () => ({ id: "m" }));
        const client = makeClient({
            enabled: true,
            dry_run: true,
            review_channel_id: "review-chan",
            review_channel_threshold: 2,
            match_tolerance: 5,
            duplicate_tolerance: 10,
            crosspost_tolerance: 5,
        });
        registerChannel(client, "review-chan", makeTextChannel(send));
        const handler = makeHandler(client);
        const author = { id: "spammer-3", tag: "spammer#0003", bot: false };
        const guild = makeGuild();

        const P = "0000000000000000";
        // Q is 7 bits from P: beyond match_tolerance (5) but within duplicate_tolerance (10).
        handler.store.add({
            phash: phashFromHex("000000000000007f"),
            action: "kick",
            category: "scam",
            addedBy: "seed",
        });

        await handler.process(
            makeMessage({ attachments: [{ phash: P }], author, member: makeMember([]), guild, channelId: "chan-A" }),
        );
        await handler.process(
            makeMessage({ attachments: [{ phash: P }], author, member: makeMember([]), guild, channelId: "chan-B" }),
        );

        expect(send).not.toHaveBeenCalled();
        expect(handler.getMetrics().reviewsRaised).toBe(0);
    });
});

// ---- handleButton ---------------------------------------------------------

describe("ImageFingerprintHandler.handleButton", () => {
    function reviewClient(extra: Record<string, unknown> = {}): { client: any; send: any } {
        const send = vi.fn(async () => ({ id: "m" }));
        const client = makeClient(
            {
                enabled: true,
                dry_run: true,
                review_channel_id: "review-chan",
                review_channel_threshold: 2,
                ...extra,
            },
            ["staff-role"],
        );
        registerChannel(client, "review-chan", makeTextChannel(send));
        return { client, send };
    }

    it("refuses a non-staff member and leaves the review open", async () => {
        const { client, send } = reviewClient();
        const handler = makeHandler(client);
        const token = await raiseReview(handler, send, "0000000000000000");

        const interaction = makeButtonInteraction(`imgfp:approve:${token}`, { memberRoles: ["not-staff"] });
        await handler.handleButton(interaction);

        expect(interaction.reply).toHaveBeenCalledTimes(1);
        expect(interaction.reply.mock.calls[0][0].content).toMatch(/Only staff/);
        expect(interaction.deferUpdate).not.toHaveBeenCalled();
        expect(handler.store.size).toBe(0);
        expect(handler.getMetrics().contributed).toBe(0);
    });

    it("defers and ignores an unparseable button id", async () => {
        const { client } = reviewClient();
        const handler = makeHandler(client);
        const interaction = makeButtonInteraction("imgfp:bogus:tok", { memberRoles: ["staff-role"] });
        await handler.handleButton(interaction);
        expect(interaction.deferUpdate).toHaveBeenCalledTimes(1);
        expect(interaction.reply).not.toHaveBeenCalled();
    });

    it("resolves the review on deny without contributing", async () => {
        const { client, send } = reviewClient();
        const handler = makeHandler(client);
        const token = await raiseReview(handler, send, "0000000000000000");

        const deny = makeButtonInteraction(`imgfp:deny:${token}`, { memberRoles: ["staff-role"] });
        await handler.handleButton(deny);
        expect(resolvedNote(deny)).toMatch(/Denied by/);
        expect(handler.store.size).toBe(0);

        // Review is gone: a follow-up click reports it inactive.
        const again = makeButtonInteraction(`imgfp:approve:${token}`, { memberRoles: ["staff-role"] });
        await handler.handleButton(again);
        expect(resolvedNote(again)).toMatch(/no longer active/);
    });

    it("adds the fingerprint and marks contribution on approve", async () => {
        const { client, send } = reviewClient({ default_action: "timeout", default_category: "scam" });
        const handler = makeHandler(client);
        const P = "0000000000000000";
        const token = await raiseReview(handler, send, P);

        const approve = makeButtonInteraction(`imgfp:approve:${token}`, { memberRoles: ["staff-role"] });
        await handler.handleButton(approve);

        expect(resolvedNote(approve)).toMatch(/Approved by/);
        expect(handler.store.size).toBe(1);
        expect(handler.getMetrics().contributed).toBe(1);
        const hit = handler.store.match(phashFromHex(P), 0);
        expect(hit?.action).toBe("timeout");
    });

    it("treats a DuplicateFingerprintError as terminal (resolves, no crash)", async () => {
        const { client, send } = reviewClient({ duplicate_tolerance: 5 });
        const handler = makeHandler(client);
        const P = "0000000000000000";
        const token = await raiseReview(handler, send, P);

        // Seed an overlapping fingerprint so store.add throws DuplicateFingerprintError.
        handler.store.add({ phash: phashFromHex(P), action: "kick", category: "scam", addedBy: "seed" });
        expect(handler.store.size).toBe(1);

        const approve = makeButtonInteraction(`imgfp:approve:${token}`, { memberRoles: ["staff-role"] });
        await handler.handleButton(approve);

        expect(resolvedNote(approve)).toMatch(/Skipped by/);
        expect(handler.store.size).toBe(1); // no duplicate row inserted
        expect(handler.getMetrics().contributed).toBe(0);

        // Terminal: a later click finds no active review.
        const again = makeButtonInteraction(`imgfp:deny:${token}`, { memberRoles: ["staff-role"] });
        await handler.handleButton(again);
        expect(resolvedNote(again)).toMatch(/no longer active/);
    });

    it("leaves the review open on a non-duplicate store failure so staff can retry", async () => {
        const { client, send } = reviewClient();
        const handler = makeHandler(client);
        const P = "0000000000000000";
        const token = await raiseReview(handler, send, P);

        const addSpy = vi.spyOn(handler.store, "add").mockImplementation(() => {
            throw new Error("database is locked");
        });
        const approve = makeButtonInteraction(`imgfp:approve:${token}`, { memberRoles: ["staff-role"] });
        await handler.handleButton(approve);

        expect(approve.followUp).toHaveBeenCalledTimes(1);
        expect(approve.followUp.mock.calls[0][0].content).toMatch(/still open/);
        expect(client.logError).toHaveBeenCalled();
        expect(handler.getMetrics().contributed).toBe(0);

        // The review stayed open — a retry after the fault clears now succeeds.
        addSpy.mockRestore();
        const retry = makeButtonInteraction(`imgfp:approve:${token}`, { memberRoles: ["staff-role"] });
        await handler.handleButton(retry);
        expect(resolvedNote(retry)).toMatch(/Approved by/);
        expect(handler.store.size).toBe(1);
        expect(handler.getMetrics().contributed).toBe(1);
    });
});

// ---- TTL sweep ------------------------------------------------------------

describe("ImageFingerprintHandler review TTL sweep", () => {
    it("ages out reviews older than the TTL while keeping fresh ones", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-07-06T00:00:00Z"));

        const send = vi.fn(async () => ({ id: "m" }));
        const client = makeClient(
            {
                enabled: true,
                dry_run: true,
                review_channel_id: "review-chan",
                review_channel_threshold: 2,
            },
            ["staff-role"],
        );
        registerChannel(client, "review-chan", makeTextChannel(send));
        const handler = makeHandler(client);
        handler.startBackgroundTasks();

        const token1 = await raiseReview(handler, send, "0000000000000000", {
            id: "u1",
            tag: "u1#0001",
            bot: false,
        });
        vi.advanceTimersByTime(23 * 60 * 60 * 1000); // 23h — token1 still fresh
        const token2 = await raiseReview(handler, send, "ffffffffffffffff", {
            id: "u2",
            tag: "u2#0002",
            bot: false,
        });
        vi.advanceTimersByTime(2 * 60 * 60 * 1000); // now +25h: token1 expired, token2 age 2h

        const stale = makeButtonInteraction(`imgfp:approve:${token1}`, { memberRoles: ["staff-role"] });
        await handler.handleButton(stale);
        expect(resolvedNote(stale)).toMatch(/no longer active/);

        const fresh = makeButtonInteraction(`imgfp:deny:${token2}`, { memberRoles: ["staff-role"] });
        await handler.handleButton(fresh);
        expect(resolvedNote(fresh)).toMatch(/Denied by/);
    });
});
