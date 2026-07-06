import { APIContainerComponent, ComponentType } from "discord.js";
import { describe, expect, it } from "vitest";
import { buildReviewMessages, outcomeNote, parseProposalButtonId } from "../src/proposals/reviewCard";
import { ProposalRecord } from "../src/proposals/types";
import { containerComponentCount, containerTextChars } from "../src/utils/cv2";

function record(overrides: Partial<ProposalRecord> = {}): ProposalRecord {
    return {
        proposalId: "a".repeat(32),
        operation: "create",
        commandName: "wifi",
        proposedCommand: {
            format: 2,
            name: "wifi",
            description: "Wifi help",
            accent_color: 0x5865f2,
            blocks: [
                { type: "heading", text: "Wifi" },
                { type: "text", text: "hello" },
            ],
        },
        status: "pending",
        createdAtMs: 0,
        expiresAtMs: 1,
        ...overrides,
    };
}

function containerJsons(message: { components: { toJSON(): APIContainerComponent }[] }): APIContainerComponent[] {
    return message.components.map(c => c.toJSON());
}

function actionRowsIn(container: APIContainerComponent) {
    return container.components.filter(c => c.type === ComponentType.ActionRow);
}

function allText(container: APIContainerComponent): string {
    return container.components.map(c => (c.type === ComponentType.TextDisplay ? c.content : "")).join("\n");
}

describe("parseProposalButtonId", () => {
    it("parses valid ids and rejects everything else", () => {
        expect(parseProposalButtonId(`cmdprop:approve:${"a".repeat(32)}`)).toEqual({
            action: "approve",
            proposalId: "a".repeat(32),
        });
        expect(parseProposalButtonId("cmdprop:approve:short")).toBeNull();
        expect(parseProposalButtonId("cmd-editor-save")).toBeNull();
    });
});

describe("buildReviewMessages", () => {
    it("puts the approve/reject buttons inside the first message's metadata container only", () => {
        const messages = buildReviewMessages(record());
        const first = containerJsons(messages[0]!);
        const rows = actionRowsIn(first[0]!);
        expect(rows).toHaveLength(1);
        const ids = (rows[0] as { components: { custom_id: string }[] }).components.map(b => b.custom_id);
        expect(ids).toEqual([`cmdprop:approve:${"a".repeat(32)}`, `cmdprop:reject:${"a".repeat(32)}`]);
        // no other container anywhere carries buttons
        const rest = [...first.slice(1), ...messages.slice(1).flatMap(containerJsons)];
        for (const container of rest) {
            expect(actionRowsIn(container)).toHaveLength(0);
        }
    });

    it("renders block previews natively with page labels and accent inheritance", () => {
        const messages = buildReviewMessages(
            record({
                proposedCommand: {
                    format: 2,
                    name: "wifi",
                    description: "d",
                    accent_color: 0x5865f2,
                    blocks: [
                        { type: "heading", text: "Wifi" },
                        { type: "text", text: "top body" },
                    ],
                    pages: [{ name: "setup", title: "Setup", blocks: [{ type: "text", text: "page body" }] }],
                },
            }),
        );
        const containers = messages.flatMap(containerJsons);
        // metadata + top-level unit + page unit
        expect(containers).toHaveLength(3);
        expect(containers[1]!.accent_color).toBe(0x5865f2);
        expect(allText(containers[1]!)).toContain("## Wifi");
        expect(containers[2]!.accent_color).toBe(0x5865f2);
        expect(allText(containers[2]!)).toContain("📑 Page preview: Setup");
        expect(allText(containers[2]!)).toContain("page body");
        expect(allText(containers[0]!)).toContain("2 top-level blocks");
    });

    it("uses a formatted proposer label when provided", () => {
        const messages = buildReviewMessages(record({ proposer: "discord_user:134295609287901184" }), {
            proposedBy: "Alice Example\n-# ID: 134295609287901184",
        });
        const metadata = containerJsons(messages[0]!)[0]!;
        expect(allText(metadata)).toContain("Alice Example");
        expect(allText(metadata)).toContain("ID: 134295609287901184");
        expect(allText(metadata)).not.toContain("discord_user:");
    });

    it("passes proposed thumbnails into top-level and page previews", () => {
        const messages = buildReviewMessages(
            record({
                proposedCommand: {
                    format: 2,
                    name: "wifi",
                    description: "d",
                    blocks: [{ type: "text", text: "top body" }],
                    thumbnail_url: "https://cdn.example.com/top.png",
                    pages: [
                        {
                            name: "setup",
                            blocks: [{ type: "text", text: "page body" }],
                            thumbnail_url: "https://cdn.example.com/page.png",
                        },
                    ],
                },
            }),
        );
        const containers = messages.flatMap(containerJsons);
        const topSection = containers[1]!.components[0] as { type: number; accessory: { media: { url: string } } };
        const pageSection = containers[2]!.components[0] as { type: number; accessory: { media: { url: string } } };
        expect(topSection.type).toBe(ComponentType.Section);
        expect(topSection.accessory.media.url).toBe("https://cdn.example.com/top.png");
        expect(pageSection.type).toBe(ComponentType.Section);
        expect(pageSection.accessory.media.url).toBe("https://cdn.example.com/page.png");
    });

    it("chunks a large command under the CV2 message budgets", () => {
        const pages = Array.from({ length: 30 }, (_, i) => ({
            name: `page${i}`,
            title: `Page ${i}`,
            blocks: [
                { type: "heading" as const, text: `Page ${i}` },
                { type: "text" as const, text: "x".repeat(800) },
            ],
        }));
        const messages = buildReviewMessages(
            record({
                proposedCommand: {
                    format: 2,
                    name: "wifi",
                    description: "d",
                    blocks: [{ type: "heading", text: "Top" }],
                    pages,
                },
            }),
        );
        let total = 0;
        for (const message of messages) {
            const containers = containerJsons(message);
            const chars = containers.reduce((sum, c) => sum + containerTextChars(c), 0);
            const components = containers.reduce((sum, c) => sum + containerComponentCount(c), 0);
            expect(chars).toBeLessThanOrEqual(4000);
            expect(components).toBeLessThanOrEqual(40);
            total += containers.length;
        }
        // metadata + capped 24 preview units
        expect(total).toBeLessThanOrEqual(25);
        // truncation warning present on the metadata container
        const metadata = containerJsons(messages[0]!)[0]!;
        expect(allText(metadata)).toContain("Preview truncated");
    });

    it("fits an oversize view so it renders instead of failing the card", () => {
        const messages = buildReviewMessages(
            record({
                proposedCommand: {
                    format: 2,
                    name: "wifi",
                    description: "d",
                    blocks: [
                        { type: "heading", text: "Big" },
                        { type: "text", text: "y".repeat(3800) },
                        { type: "text", text: "z".repeat(3800) },
                    ],
                },
            }),
        );
        for (const message of messages) {
            for (const container of containerJsons(message)) {
                expect(containerTextChars(container)).toBeLessThanOrEqual(4000);
            }
        }
        const preview = messages.flatMap(containerJsons).find(c => allText(c).includes("## Big"));
        expect(preview).toBeDefined();
        expect(allText(preview!)).toContain("…");
    });

    it("warns when a pages-only command has no top-level blocks", () => {
        const messages = buildReviewMessages(
            record({
                proposedCommand: {
                    format: 2,
                    name: "wifi",
                    description: "d",
                    pages: [{ name: "p", blocks: [{ type: "text", text: "x" }] }],
                },
            }),
        );
        const metadata = containerJsons(messages[0]!)[0]!;
        expect(allText(metadata)).toContain("Initial response");
    });

    it("delete proposals render a single metadata-only message", () => {
        const messages = buildReviewMessages(record({ operation: "delete", proposedCommand: undefined }));
        expect(messages).toHaveLength(1);
        expect(messages[0]!.components).toHaveLength(1);
    });
});

describe("outcomeNote", () => {
    it("formats terminal outcomes with their accent colors", () => {
        expect(outcomeNote({ status: "approved", message: "ok", committedSha: "abcdef1234", actor: "@mod" })).toEqual({
            note: "**Outcome**\n✅ Approved & committed by @mod · `abcdef12`",
            color: 0x57f287,
        });
        expect(outcomeNote({ status: "rejected", message: "no", actor: "@mod" }).note).toContain("Rejected by @mod");
        expect(outcomeNote({ status: "conflict", message: "sha moved", actor: "@mod" }).note).toContain(
            "conflict: sha moved",
        );
    });
});
