import { describe, expect, it, vi } from "vitest";
import { ChannelType } from "discord.js";
import { handleTwitterLinks, protectedRanges, sanitizeWebhookUsername } from "../src/features/twitter/twitterHandler";

describe("sanitizeWebhookUsername", () => {
    it("strips 'discord' and 'clyde' case-insensitively", () => {
        expect(sanitizeWebhookUsername("aDISCORDb")).toBe("ab");
        expect(sanitizeWebhookUsername("xClYdEy")).toBe("xy");
    });

    it("loops so a removal cannot reform a reserved substring (discord)", () => {
        // Single global replace of "discord" over "Hidisdiscordcordbye" removes the
        // inner match and joins "dis" + "cord" back into a fresh "discord"; only the
        // loop clears it. If sanitize were single-pass the result would still contain
        // "discord" and Discord would 400 the repost.
        const result = sanitizeWebhookUsername("Hidisdiscordcordbye");

        expect(result).toBe("Hibye");
        expect(/discord|clyde/i.test(result)).toBe(false);
    });

    it("loops so a clyde removal that reforms 'discord' is also cleared", () => {
        // "disclydecord": no "discord" initially, but removing "clyde" joins
        // "dis" + "cord" into "discord", which a second pass must strip.
        const result = sanitizeWebhookUsername("disclydecord");

        expect(/discord|clyde/i.test(result)).toBe(false);
        expect(result).toBe("Link Fixer");
    });

    it("clamps the result to 80 characters", () => {
        const result = sanitizeWebhookUsername("a".repeat(200));

        expect(result).toHaveLength(80);
    });

    it("falls back to 'Link Fixer' when nothing usable remains", () => {
        expect(sanitizeWebhookUsername("")).toBe("Link Fixer");
        expect(sanitizeWebhookUsername("   ")).toBe("Link Fixer");
        expect(sanitizeWebhookUsername("discord")).toBe("Link Fixer");
        expect(sanitizeWebhookUsername("ClYdE")).toBe("Link Fixer");
    });
});

describe("protectedRanges", () => {
    const INSIDE = "https://x.com/inside";
    const OUTSIDE = "https://x.com/outside";

    function expectInsideProtectedOutsideNot(content: string): void {
        const mask = protectedRanges(content);
        expect(mask).toHaveLength(content.length);

        const insideAt = content.indexOf(INSIDE);
        const outsideAt = content.indexOf(OUTSIDE);
        expect(insideAt).toBeGreaterThanOrEqual(0);
        expect(outsideAt).toBeGreaterThanOrEqual(0);

        // A link inside a protected region must never be reported unprotected.
        expect(mask[insideAt]).toBe(true);
        // The one outside every marker is free to rewrite.
        expect(mask[outsideAt]).toBe(false);
    }

    it("masks a link inside a fenced code block, leaving one outside free", () => {
        expectInsideProtectedOutsideNot("```\n" + INSIDE + "\n```\nsee " + OUTSIDE);
    });

    it("masks a link inside an inline code span, leaving one outside free", () => {
        expectInsideProtectedOutsideNot("`" + INSIDE + "` and " + OUTSIDE);
    });

    it("masks a link inside a spoiler span, leaving one outside free", () => {
        expectInsideProtectedOutsideNot("||" + INSIDE + "|| and " + OUTSIDE);
    });

    it("keeps a link protected when spoiler markers are nested inside a code fence", () => {
        // Fences are applied first; the spoiler markers inside the fence must not
        // un-protect the link. Over-marking is safe, under-marking is the bug.
        expectInsideProtectedOutsideNot("```||" + INSIDE + "||``` then " + OUTSIDE);
    });

    it("returns an all-false mask when there are no protected regions", () => {
        const content = "plain " + OUTSIDE + " text";
        const mask = protectedRanges(content);

        expect(mask).toHaveLength(content.length);
        expect(mask.some(Boolean)).toBe(false);
    });

    it("protects every character of a fenced block spanning multiple links", () => {
        const content = "```\n" + INSIDE + "\n" + OUTSIDE + "\n```";
        const mask = protectedRanges(content);

        // Both links live inside the same fence, so both are masked.
        expect(mask[content.indexOf(INSIDE)]).toBe(true);
        expect(mask[content.indexOf(OUTSIDE)]).toBe(true);
    });
});

describe("handleTwitterLinks attachment mirroring", () => {
    it("leaves the original alone when attachments exceed the total mirror cap", async () => {
        const webhookSend = vi.fn(async () => undefined);
        const deleteMessage = vi.fn(async () => undefined);
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        const message: any = {
            content: "check https://x.com/virtualdesktop/status/1",
            channelId: "twitter-channel",
            channel: {
                type: ChannelType.GuildText,
                fetchWebhooks: vi.fn(async () => ({ find: () => ({ send: webhookSend }) })),
            },
            attachments: new Map([
                ["a", { url: "https://cdn.example/a.bin", name: "a.bin", size: 26 * 1024 * 1024 }],
                ["b", { url: "https://cdn.example/b.bin", name: "b.bin", size: 26 * 1024 * 1024 }],
            ]),
            member: { displayName: "Poster", displayAvatarURL: () => "https://cdn.example/member.png" },
            author: { username: "poster", displayAvatarURL: () => "https://cdn.example/user.png" },
            delete: deleteMessage,
        };
        const client: any = {
            config: {
                twitter: {
                    enabled: true,
                    enabled_channels: ["twitter-channel"],
                    embed_service: "vxtwitter.com",
                },
            },
        };

        await handleTwitterLinks(message, client);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(webhookSend).not.toHaveBeenCalled();
        expect(deleteMessage).not.toHaveBeenCalled();
    });
});
