import { describe, expect, it } from "vitest";
import { ComponentType } from "discord.js";
import { blocksToContainer, unitContainers } from "../src/utils/commandRender";

function totalText(container: ReturnType<typeof blocksToContainer>): number {
    return container
        .toJSON()
        .components.reduce((sum, c) => sum + (c.type === ComponentType.TextDisplay ? c.content.length : 0), 0);
}

describe("blocksToContainer", () => {
    it("maps every block type to its CV2 component", () => {
        const json = blocksToContainer(
            [
                { type: "heading", text: "Title", url: "https://example.com" },
                { type: "text", text: "Body" },
                { type: "field", name: "Name", value: "Value" },
                { type: "divider" },
                { type: "images", urls: ["https://example.com/a.png", "https://example.com/b.png"] },
                { type: "small", text: "footnote" },
            ],
            0x5865f2,
        ).toJSON();
        expect(json.accent_color).toBe(0x5865f2);
        expect(json.components.map(c => c.type)).toEqual([
            ComponentType.TextDisplay,
            ComponentType.TextDisplay,
            ComponentType.TextDisplay,
            ComponentType.Separator,
            ComponentType.MediaGallery,
            ComponentType.TextDisplay,
        ]);
        const texts = json.components.filter(c => c.type === ComponentType.TextDisplay) as { content: string }[];
        expect(texts.map(t => t.content)).toEqual([
            "## [Title](https://example.com)",
            "Body",
            "**Name**\nValue",
            "-# footnote",
        ]);
        const gallery = json.components.find(c => c.type === ComponentType.MediaGallery) as {
            items: { media: { url: string } }[];
        };
        expect(gallery.items.map(i => i.media.url)).toEqual(["https://example.com/a.png", "https://example.com/b.png"]);
    });

    it("renders an unlinked heading", () => {
        const json = blocksToContainer([{ type: "heading", text: "Plain" }]).toJSON();
        expect((json.components[0] as { content: string }).content).toBe("## Plain");
    });

    it("fits text blocks against the budget", () => {
        const container = blocksToContainer([
            { type: "text", text: "a".repeat(3000) },
            { type: "text", text: "b".repeat(3000) },
        ]);
        expect(totalText(container)).toBeLessThanOrEqual(4000);
    });

    it("respects a caller-supplied budget", () => {
        const container = blocksToContainer([{ type: "text", text: "a".repeat(500) }], undefined, 100);
        expect(totalText(container)).toBeLessThanOrEqual(100);
    });

    it("does not append a truncation notice after exhausting the text budget", () => {
        const container = blocksToContainer(
            [
                { type: "text", text: "a".repeat(20) },
                { type: "text", text: "b".repeat(50) },
                { type: "text", text: "c".repeat(50) },
            ],
            undefined,
            20,
            3,
            "Preview truncated",
        );
        const json = container.toJSON();
        const textDisplays = json.components.filter(c => c.type === ComponentType.TextDisplay) as { content: string }[];

        expect(totalText(container)).toBe(20);
        expect(textDisplays.map(display => display.content)).toEqual(["a".repeat(20)]);
    });

    it("uses the reserved component for a truncation notice when text budget remains", () => {
        const container = blocksToContainer(
            [
                { type: "text", text: "first" },
                { type: "text", text: "second" },
            ],
            undefined,
            9,
            2,
            "Preview truncated",
        );
        const json = container.toJSON();
        const textDisplays = json.components.filter(c => c.type === ComponentType.TextDisplay) as { content: string }[];

        expect(textDisplays).toHaveLength(1);
        expect(textDisplays[0]!.content).toBe("Preview …");
        expect(totalText(container)).toBe(9);
    });
});

describe("thumbnail sections", () => {
    const THUMB = "https://cdn.example.com/icon.png";
    const asJson = (container: ReturnType<typeof blocksToContainer>) => container.toJSON();

    it("wraps the leading text run (max 3) in a section with the thumbnail accessory", () => {
        const json = asJson(
            blocksToContainer(
                [
                    { type: "heading", text: "Title" },
                    { type: "text", text: "Body" },
                    { type: "field", name: "Name", value: "Value" },
                    { type: "small", text: "note" },
                    { type: "images", urls: ["https://example.com/a.png"] },
                ],
                undefined,
                undefined,
                undefined,
                undefined,
                THUMB,
            ),
        );
        expect(json.components.map(c => c.type)).toEqual([
            ComponentType.Section,
            ComponentType.TextDisplay, // 4th text block falls outside the 3-child cap
            ComponentType.MediaGallery,
        ]);
        const section = json.components[0] as {
            components: { content: string }[];
            accessory: { type: number; media: { url: string } };
        };
        expect(section.components.map(t => t.content)).toEqual(["## Title", "Body", "**Name**\nValue"]);
        expect(section.accessory.type).toBe(ComponentType.Thumbnail);
        expect(section.accessory.media.url).toBe(THUMB);
        expect((json.components[1] as { content: string }).content).toBe("-# note");
    });

    it("starts the section at the first text block, after leading media", () => {
        const json = asJson(
            blocksToContainer(
                [
                    { type: "images", urls: ["https://example.com/a.png"] },
                    { type: "heading", text: "Title" },
                    { type: "divider" },
                    { type: "text", text: "After the divider" },
                ],
                undefined,
                undefined,
                undefined,
                undefined,
                THUMB,
            ),
        );
        // The divider breaks the text run: only the heading joins the section.
        expect(json.components.map(c => c.type)).toEqual([
            ComponentType.MediaGallery,
            ComponentType.Section,
            ComponentType.Separator,
            ComponentType.TextDisplay,
        ]);
        expect((json.components[1] as { components: { content: string }[] }).components).toHaveLength(1);
    });

    it("renders flat when the view has no text block", () => {
        const json = asJson(
            blocksToContainer(
                [{ type: "images", urls: ["https://example.com/a.png"] }],
                undefined,
                undefined,
                undefined,
                undefined,
                THUMB,
            ),
        );
        expect(json.components.map(c => c.type)).toEqual([ComponentType.MediaGallery]);
    });

    it("drops the thumbnail when the component budget cannot fit the section", () => {
        // Budget 3 = container + 2 children; the section alone needs 3 slots.
        const json = asJson(
            blocksToContainer([{ type: "text", text: "hello" }], undefined, undefined, 3, undefined, THUMB),
        );
        expect(json.components.map(c => c.type)).toEqual([ComponentType.TextDisplay]);
    });

    it("caps section children to the component budget", () => {
        // Budget 5 = container + 4: section + accessory + 2 children fit.
        const json = asJson(
            blocksToContainer(
                [
                    { type: "text", text: "one" },
                    { type: "text", text: "two" },
                    { type: "text", text: "three" },
                ],
                undefined,
                undefined,
                5,
                undefined,
                THUMB,
            ),
        );
        expect(json.components.map(c => c.type)).toEqual([ComponentType.Section]);
        expect((json.components[0] as { components: { content: string }[] }).components.map(t => t.content)).toEqual([
            "one",
            "two",
        ]);
    });

    it("section text respects the message text budget", () => {
        const container = blocksToContainer(
            [
                { type: "text", text: "a".repeat(3000) },
                { type: "text", text: "b".repeat(3000) },
            ],
            undefined,
            undefined,
            undefined,
            undefined,
            THUMB,
        );
        const json = container.toJSON();
        const section = json.components[0] as { components: { content: string }[] };
        const total = section.components.reduce((sum, t) => sum + t.content.length, 0);
        expect(json.components.map(c => c.type)).toEqual([ComponentType.Section]);
        expect(total).toBeLessThanOrEqual(4000);
    });
});

describe("unitContainers", () => {
    it("renders a unit with accent fallback", () => {
        const containers = unitContainers({ blocks: [{ type: "text", text: "hello" }] }, 0xff0000);
        expect(containers).toHaveLength(1);
        expect(containers[0]!.toJSON().accent_color).toBe(0xff0000);
    });

    it("unit accent overrides the fallback", () => {
        const containers = unitContainers(
            { blocks: [{ type: "text", text: "hello" }], accent_color: 0x00ff00 },
            0xff0000,
        );
        expect(containers[0]!.toJSON().accent_color).toBe(0x00ff00);
    });

    it("renders nothing for an empty unit", () => {
        expect(unitContainers({})).toHaveLength(0);
        expect(unitContainers({ blocks: [] })).toHaveLength(0);
    });

    it("passes the unit thumbnail through to a section", () => {
        const containers = unitContainers({
            blocks: [{ type: "text", text: "hello" }],
            thumbnail_url: "https://cdn.example.com/icon.png",
        });
        const json = containers[0]!.toJSON();
        expect(json.components[0]!.type).toBe(ComponentType.Section);
    });
});
