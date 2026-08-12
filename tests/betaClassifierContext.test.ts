import { describe, expect, it } from "vitest";
import { buildClassificationTranscript, TranscriptMessage } from "../src/features/betaClassifier/context";
import { sanitizeSensitiveText } from "../src/llm/privacy";

function message(
    id: string,
    authorId: string,
    content: string,
    createdTimestamp: number,
    overrides: Partial<TranscriptMessage> = {},
): TranscriptMessage {
    return { id, authorId, content, createdTimestamp, isBot: false, isStaff: false, ...overrides };
}

describe("buildClassificationTranscript", () => {
    it("uses stable anonymous speakers, role labels, reply links, and a target marker", () => {
        const transcript = buildClassificationTranscript(
            [
                message("one", "real-user-id-1", "Are you using the beta?", 1, { isStaff: true }),
                message("two", "real-user-id-2", "Yes, but USB is not detected.", 2, { replyToId: "one" }),
            ],
            "two",
            { maxMessages: 25, maxCharacters: 40_000, referencedParentId: "one" },
        );

        expect(transcript).toContain("speaker=member_a role=staff");
        expect(transcript).toContain("speaker=member_b role=member reply_to=member_a TARGET");
        expect(transcript).not.toContain("real-user-id");
    });

    it("includes only messages at or before the target and keeps at most 25", () => {
        const messages = Array.from({ length: 30 }, (_, index) =>
            message(`message-${index}`, `author-${index}`, `synthetic ${index}`, index),
        );
        messages.push(message("future", "future-author", "future content", 100));

        const transcript = buildClassificationTranscript(messages, "message-29", {
            maxMessages: 25,
            maxCharacters: 40_000,
        })!;

        expect(transcript).not.toContain("future content");
        expect(transcript).not.toContain("synthetic 4");
        expect(transcript).toContain("synthetic 5");
        expect(transcript.match(/^\[\d+\]/gm)).toHaveLength(25);
    });

    it("preserves an older referenced parent while dropping a less relevant prior message", () => {
        const transcript = buildClassificationTranscript(
            [
                message("parent", "a", "important parent", 1),
                message("middle", "b", "ordinary middle", 2),
                message("recent", "c", "recent context", 3),
                message("target", "d", "same problem", 4, { replyToId: "parent" }),
            ],
            "target",
            { maxMessages: 3, maxCharacters: 40_000, referencedParentId: "parent" },
        )!;

        expect(transcript).toContain("important parent");
        expect(transcript).toContain("recent context");
        expect(transcript).not.toContain("ordinary middle");
    });

    it("keeps the referenced parent and target visible under a tight character cap", () => {
        const transcript = buildClassificationTranscript(
            [
                message("parent", "a", "P".repeat(4_000), 1),
                message("middle", "b", "drop me", 2),
                message("target", "c", "T".repeat(4_000), 3, { replyToId: "parent" }),
            ],
            "target",
            { maxMessages: 3, maxCharacters: 1_000, referencedParentId: "parent" },
        )!;

        expect(transcript.length).toBeLessThanOrEqual(1_000);
        expect(transcript).toContain("role=member");
        expect(transcript).toContain("TARGET");
        expect(transcript).toContain("PPP");
        expect(transcript).toContain("TTT");
        expect(transcript).not.toContain("drop me");
    });
});

describe("sanitizeSensitiveText", () => {
    it("removes Discord identifiers, raw links, and snowflake-shaped text", () => {
        const sanitized = sanitizeSensitiveText(
            "<@123456789012345678> see <#223456789012345678> and <#623456789012345678> " +
                "<@&323456789012345678> <:wave:423456789012345678> " +
                "https://example.test/private 523456789012345678",
            { "223456789012345678": "beta-testing" },
        );

        expect(sanitized).toBe("@member see #beta-testing and #channel @role :wave: [link omitted] [id omitted]");
        expect(sanitized).not.toMatch(/\d{17,20}/);
    });

    it("redacts contact details, network identifiers, and common secret formats", () => {
        const fireworksToken = `fw_${"a".repeat(26)}`;
        const bearerToken = "b".repeat(32);
        const sanitized = sanitizeSensitiveText(
            `email me@example.com call +1 (415) 555-0123 host 192.168.1.20 and ::1 ` +
                `or 2001:db8::1 mac aa:bb:cc:dd:ee:ff token=super-secret-value ${fireworksToken} ` +
                `Authorization: Bearer ${bearerToken}`,
        );

        expect(sanitized).toContain("[email omitted]");
        expect(sanitized).toContain("[phone number omitted]");
        expect(sanitized).toContain("[IP address omitted]");
        expect(sanitized).toContain("[MAC address omitted]");
        expect(sanitized).not.toContain("super-secret-value");
        expect(sanitized).not.toContain(fireworksToken);
        expect(sanitized).not.toContain(bearerToken);
        expect(sanitized).not.toContain("::1");
        expect(sanitized).not.toContain("2001:db8::1");
    });

    it("keeps beta versions and ordinary USB troubleshooting numbers", () => {
        expect(sanitizeSensitiveText("Quest 1.34.20 drops every 12 minutes on USB 3.0")).toBe(
            "Quest 1.34.20 drops every 12 minutes on USB 3.0",
        );
    });

    it("redacts complete authorization headers and quoted secret values", () => {
        const basicCredential = Buffer.from("synthetic-user:synthetic-password").toString("base64");
        const sanitized = sanitizeSensitiveText(
            `Authorization: Basic ${basicCredential}\n` +
                `Proxy-Authorization: Basic ${basicCredential}\n` +
                "token=\"multiple synthetic words\" password='another secret value'",
        );

        expect(sanitized).not.toContain(basicCredential);
        expect(sanitized).not.toContain("multiple synthetic words");
        expect(sanitized).not.toContain("another secret value");
        expect(sanitized.match(/\[secret omitted\]/g)).toHaveLength(4);
    });
});
