import type { Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { KrytenClient } from "../src/classes/client";
import {
    KeywordAutoResponder,
    containsLiteralKeyword,
} from "../src/features/keywordAutoResponses/keywordAutoResponder";
import type { KeywordCooldownAdmission, UserInteractionStore } from "../src/features/userInteractions/store";
import type { KeywordAutoResponseRule } from "../src/types";

const GENERIC_RESPONSE = "Hi {user}!\n\nThe current status is available in the linked announcement.";

describe("literal keyword matching", () => {
    it.each([
        ["RELEASE STATUS is available", "release status"],
        ["Any (status update)?", "status update"],
        ["release status/announcement", "release status"],
    ])("matches a case-insensitive bounded mention in %j", (content, keyword) => {
        expect(containsLiteralKeyword(content, keyword)).toBe(true);
    });

    it.each([
        ["release statuses", "release status"],
        ["prerelease status", "release status"],
        ["release  status", "release status"],
        ["status-update", "status update"],
    ])("does not match a substring or non-literal phrase in %j", (content, keyword) => {
        expect(containsLiteralKeyword(content, keyword)).toBe(false);
    });
});

describe("KeywordAutoResponder", () => {
    it("replies in the exact configured channel with only the author mention allowed", async () => {
        const { handler, interactions } = setup();
        const message = makeMessage({ content: "Any RELEASE STATUS news?" });

        await handler.process(message);

        expect(interactions.claimKeywordCooldown).toHaveBeenCalledWith("user-1", "release-status");
        expect(message.reply).toHaveBeenCalledWith({
            content: "Hi <@user-1>!\n\nThe current status is available in the linked announcement.",
            allowedMentions: { parse: [], users: ["user-1"], repliedUser: false },
        });
    });

    it.each([
        ["another channel", { channelId: "other" }],
        [
            "a thread with the configured parent",
            { channelId: "thread", channel: { isThread: () => true, parentId: "support" } },
        ],
        ["a bot author", { author: { id: "user-1", bot: true } }],
    ])("does not respond in %s", async (_label, override) => {
        const { handler, interactions } = setup();
        const message = makeMessage(override);

        await handler.process(message);

        expect(interactions.claimKeywordCooldown).not.toHaveBeenCalled();
        expect(message.reply).not.toHaveBeenCalled();
    });

    it("does not respond to cached staff", async () => {
        const { handler, interactions } = setup();
        const message = makeMessage({
            member: {
                roles: {
                    cache: { some: (predicate: (role: { id: string }) => boolean) => predicate({ id: "staff" }) },
                },
            },
        });

        await handler.process(message);

        expect(interactions.claimKeywordCooldown).not.toHaveBeenCalled();
        expect(message.reply).not.toHaveBeenCalled();
    });

    it("fails safe when an uncached member cannot be fetched", async () => {
        const { handler, interactions } = setup();
        const message = makeMessage({
            member: null,
            guild: { members: { fetch: vi.fn(async () => Promise.reject(new Error("missing member"))) } },
        });

        await handler.process(message);

        expect(interactions.claimKeywordCooldown).not.toHaveBeenCalled();
        expect(message.reply).not.toHaveBeenCalled();
    });

    it("sends at most one reply when multiple rules match", async () => {
        const second = rule({ id: "second", keywords: ["status"] });
        const { handler, client, interactions } = setup();
        client.config.keyword_auto_responses!.rules!.push(second);
        const message = makeMessage({ content: "release status" });

        await handler.process(message);

        expect(interactions.claimKeywordCooldown).toHaveBeenCalledTimes(1);
        expect(message.reply).toHaveBeenCalledTimes(1);
    });

    it("falls through to a later matching rule when the first rule is cooling down", async () => {
        const first = rule({ id: "first" });
        const second = rule({ id: "second", response: "Second reply for {user}" });
        const claimKeywordCooldown = vi
            .fn()
            .mockResolvedValueOnce({ status: "cooldown" })
            .mockResolvedValueOnce({
                status: "acquired",
                claim: { userId: "user-1", ruleId: "second", respondedAt: Date.now(), generation: 0 },
            });
        const { handler, client } = setup({ claimKeywordCooldown });
        client.config.keyword_auto_responses!.rules = [first, second];
        const message = makeMessage();

        await expect(handler.process(message)).resolves.toBe(true);

        expect(claimKeywordCooldown).toHaveBeenNthCalledWith(1, "user-1", "first");
        expect(claimKeywordCooldown).toHaveBeenNthCalledWith(2, "user-1", "second");
        expect(message.reply).toHaveBeenCalledWith(expect.objectContaining({ content: "Second reply for <@user-1>" }));
    });

    it("allows only one of two concurrent duplicate triggers to reply", async () => {
        let claimed = false;
        const claimKeywordCooldown = vi.fn(async (): Promise<KeywordCooldownAdmission> => {
            if (claimed) return { status: "cooldown" };
            claimed = true;
            return {
                status: "acquired",
                claim: { userId: "user-1", ruleId: "release-status", respondedAt: Date.now(), generation: 0 },
            };
        });
        const { handler } = setup({ claimKeywordCooldown });
        const first = makeMessage({ id: "trigger-1" });
        const second = makeMessage({ id: "trigger-2" });

        await Promise.all([handler.process(first), handler.process(second)]);

        expect(first.reply).toHaveBeenCalledTimes(1);
        expect(second.reply).not.toHaveBeenCalled();
    });

    it("does not send when the durable claim cannot be stored", async () => {
        const { handler } = setup({ claimKeywordCooldown: vi.fn(async () => Promise.reject(new Error("disk full"))) });
        const message = makeMessage();

        await expect(handler.process(message)).rejects.toThrow("disk full");
        expect(message.reply).not.toHaveBeenCalled();
    });

    it("releases the claim when sending fails", async () => {
        const { handler, interactions } = setup();
        const message = makeMessage({ reply: vi.fn(async () => Promise.reject(new Error("Discord unavailable"))) });

        await expect(handler.process(message)).rejects.toThrow("Discord unavailable");

        expect(interactions.releaseKeywordCooldown).toHaveBeenCalledOnce();
    });

    it("logs a cooldown release failure separately without masking the send failure", async () => {
        const releaseKeywordCooldown = vi.fn(async () => Promise.reject(new Error("release persistence failed")));
        const { handler, client } = setup({ releaseKeywordCooldown });
        const message = makeMessage({ reply: vi.fn(async () => Promise.reject(new Error("Discord unavailable"))) });

        await expect(handler.process(message)).rejects.toThrow("Discord unavailable");

        expect(client.logError).toHaveBeenCalledWith(
            "Keyword auto-response cooldown release failed",
            expect.objectContaining({ message: "release persistence failed" }),
        );
    });

    it("fails safe when a cached member has no usable role collection", async () => {
        const { handler, interactions } = setup();
        const message = makeMessage({
            member: { roles: undefined },
            guild: { members: { fetch: vi.fn(async () => ({ roles: undefined })) } },
        });

        await handler.process(message);

        expect(interactions.claimKeywordCooldown).not.toHaveBeenCalled();
        expect(message.reply).not.toHaveBeenCalled();
    });

    it("stops admission and drains in-flight processing before resolving", async () => {
        let finishReply!: () => void;
        const replyStarted = Promise.withResolvers<void>();
        const replyGate = new Promise<void>(resolve => {
            finishReply = resolve;
        });
        const { handler } = setup();
        const active = makeMessage({
            id: "active-message",
            reply: vi.fn(async () => {
                replyStarted.resolve();
                await replyGate;
            }),
        });
        const processing = handler.process(active);
        await replyStarted.promise;

        let stopped = false;
        const stopping = handler.stop(1_000).then(() => {
            stopped = true;
        });
        const rejected = makeMessage({ id: "later-message" });
        await expect(handler.process(rejected)).resolves.toBe(false);
        expect(rejected.reply).not.toHaveBeenCalled();
        expect(stopped).toBe(false);

        finishReply();
        await Promise.all([processing, stopping]);
        expect(stopped).toBe(true);
    });

    it("bounds shutdown and releases a late claim without sending", async () => {
        const claimStarted = Promise.withResolvers<void>();
        const claimGate = Promise.withResolvers<KeywordCooldownAdmission>();
        const claimKeywordCooldown = vi.fn(async () => {
            claimStarted.resolve();
            return claimGate.promise;
        });
        const { handler, interactions } = setup({ claimKeywordCooldown });
        const message = makeMessage({ id: "late-claim" });
        const processing = handler.process(message);
        await claimStarted.promise;

        await handler.stop(5);
        claimGate.resolve({
            status: "acquired",
            claim: { userId: "user-1", ruleId: "release-status", respondedAt: Date.now(), generation: 0 },
        });

        await expect(processing).resolves.toBe(false);
        expect(interactions.releaseKeywordCooldown).toHaveBeenCalledOnce();
        expect(message.reply).not.toHaveBeenCalled();
    });

    it("deduplicates concurrent processing of one message before trying overlapping rules", async () => {
        const firstClaimStarted = Promise.withResolvers<void>();
        const firstClaimGate = Promise.withResolvers<KeywordCooldownAdmission>();
        const claimKeywordCooldown = vi
            .fn()
            .mockImplementationOnce(async () => {
                firstClaimStarted.resolve();
                return firstClaimGate.promise;
            })
            .mockResolvedValueOnce({ status: "cooldown" })
            .mockResolvedValueOnce({
                status: "acquired",
                claim: { userId: "user-1", ruleId: "second", respondedAt: Date.now(), generation: 0 },
            });
        const { handler, client } = setup({ claimKeywordCooldown });
        client.config.keyword_auto_responses!.rules = [rule({ id: "first" }), rule({ id: "second" })];
        const message = makeMessage({ id: "duplicate-event" });

        const first = handler.process(message);
        await firstClaimStarted.promise;
        const duplicate = handler.process(message);
        firstClaimGate.resolve({
            status: "acquired",
            claim: { userId: "user-1", ruleId: "first", respondedAt: Date.now(), generation: 0 },
        });

        await expect(Promise.all([first, duplicate])).resolves.toEqual([true, false]);
        expect(claimKeywordCooldown).toHaveBeenCalledOnce();
        expect(message.reply).toHaveBeenCalledOnce();
    });

    it("cancels and releases an acquired claim when config changes while processing", async () => {
        let finishClaim!: (value: KeywordCooldownAdmission) => void;
        const claimKeywordCooldown = vi.fn(
            async () =>
                new Promise<KeywordCooldownAdmission>(resolve => {
                    finishClaim = resolve;
                }),
        );
        const { handler, client, interactions } = setup({ claimKeywordCooldown });
        const message = makeMessage();
        const processing = handler.process(message);
        await vi.waitFor(() => expect(claimKeywordCooldown).toHaveBeenCalledOnce());
        client.config.keyword_auto_responses!.enabled = false;
        finishClaim({
            status: "acquired",
            claim: { userId: "user-1", ruleId: "release-status", respondedAt: Date.now(), generation: 0 },
        });

        await processing;

        expect(message.reply).not.toHaveBeenCalled();
        expect(interactions.releaseKeywordCooldown).toHaveBeenCalledOnce();
    });
});

function setup(overrides: Record<string, unknown> = {}): {
    handler: KeywordAutoResponder;
    client: KrytenClient;
    interactions: {
        claimKeywordCooldown: ReturnType<typeof vi.fn>;
        releaseKeywordCooldown: ReturnType<typeof vi.fn>;
    };
} {
    const client = {
        config: {
            staff_roles: ["staff"],
            keyword_auto_responses: { enabled: true, rules: [rule()] },
        },
        logError: vi.fn(async () => undefined),
    } as unknown as KrytenClient;
    const interactions = {
        claimKeywordCooldown: vi.fn(async () => ({
            status: "acquired" as const,
            claim: { userId: "user-1", ruleId: "release-status", respondedAt: Date.now(), generation: 0 },
        })),
        releaseKeywordCooldown: vi.fn(async () => undefined),
        isUserGeneration: vi.fn(() => true),
        ...overrides,
    };
    return {
        handler: new KeywordAutoResponder(client, interactions as unknown as UserInteractionStore),
        client,
        interactions,
    };
}

function rule(overrides: Partial<KeywordAutoResponseRule> = {}): KeywordAutoResponseRule {
    return {
        id: "release-status",
        channel_ids: ["support"],
        keywords: ["release status", "status update"],
        response: GENERIC_RESPONSE,
        ...overrides,
    };
}

function makeMessage(overrides: Record<string, unknown> = {}): Message & { reply: ReturnType<typeof vi.fn> } {
    return {
        id: "message-1",
        content: "release status",
        author: { id: "user-1", bot: false },
        channelId: "support",
        channel: { isThread: () => false },
        member: { roles: { cache: { some: () => false } } },
        guild: { members: { fetch: vi.fn() } },
        reply: vi.fn(async () => undefined),
        ...overrides,
    } as unknown as Message & { reply: ReturnType<typeof vi.fn> };
}
