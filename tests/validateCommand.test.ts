import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateCustomCommandDetailed, validateBlocksDetailed, isValidEmbedUrl } from "../src/utils/validateCommand";

function blockCommand(overrides: Record<string, unknown> = {}): any {
    return {
        format: 2,
        name: "blockcmd",
        description: "A block command",
        accent_color: 0x5865f2,
        blocks: [
            { type: "heading", text: "Title" },
            { type: "text", text: "Body text" },
        ],
        ...overrides,
    };
}

beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("isValidEmbedUrl", () => {
    it("accepts http and https", () => {
        expect(isValidEmbedUrl("https://example.com/a?b=c")).toBe(true);
        expect(isValidEmbedUrl("http://example.com")).toBe(true);
    });

    it("rejects non-urls and other schemes", () => {
        expect(isValidEmbedUrl("example.com")).toBe(false);
        expect(isValidEmbedUrl("javascript:alert(1)")).toBe(false);
        expect(isValidEmbedUrl("ftp://example.com")).toBe(false);
        expect(isValidEmbedUrl("")).toBe(false);
        expect(isValidEmbedUrl(42)).toBe(false);
        expect(isValidEmbedUrl(undefined)).toBe(false);
    });
});

describe("validateCustomCommandDetailed", () => {
    it("accepts a valid block command", () => {
        expect(validateCustomCommandDetailed(blockCommand())).toBeNull();
    });

    it("rejects legacy embed commands outright", () => {
        expect(
            validateCustomCommandDetailed({
                name: "old",
                description: "d",
                embed: { title: "Hello", description: "World" },
            }),
        ).toMatch(/requires "format": 2/);
        expect(validateCustomCommandDetailed(blockCommand({ format: undefined }))).toMatch(/requires "format": 2/);
        expect(validateCustomCommandDetailed(blockCommand({ format: 3 }))).toMatch(/requires "format": 2/);
        expect(validateCustomCommandDetailed(blockCommand({ embed: { title: "no" } }))).toMatch(/not 'embed'/);
    });

    it("requires blocks or pages", () => {
        expect(validateCustomCommandDetailed(blockCommand({ blocks: undefined }))).toMatch(
            /requires 'blocks' or 'pages'/,
        );
        const pagesOnly = blockCommand({
            blocks: undefined,
            pages: [{ name: "p1", blocks: [{ type: "text", text: "x" }] }],
        });
        expect(validateCustomCommandDetailed(pagesOnly)).toBeNull();
    });

    it("strips the legacy ephemeral field and normalizes names", () => {
        const command = blockCommand({ name: "  BlockCmd  ", ephemeral: true });
        expect(validateCustomCommandDetailed(command)).toBeNull();
        expect(command.name).toBe("blockcmd");
        expect(command.ephemeral).toBeUndefined();
    });

    it("rejects names with the reserved editor component-id prefix", () => {
        expect(validateCustomCommandDetailed(blockCommand({ name: "cmd-editor-section-select" }))).toMatch(
            /reserved for editor components/,
        );
    });

    it("truncates over-length descriptions", () => {
        const command = blockCommand({ description: "d".repeat(150) });
        expect(validateCustomCommandDetailed(command)).toBeNull();
        expect(command.description.length).toBe(100);
    });

    it("validates pages: blocks required, embeds rejected, names deduped", () => {
        const good = blockCommand({
            pages: [{ name: "p1", title: "P1", blocks: [{ type: "text", text: "page body" }] }],
        });
        expect(validateCustomCommandDetailed(good)).toBeNull();

        const withEmbed = blockCommand({
            pages: [{ name: "p1", blocks: [{ type: "text", text: "x" }], embed: { title: "no" } }],
        });
        expect(validateCustomCommandDetailed(withEmbed)).toMatch(/pages use 'blocks'/);

        const noBlocks = blockCommand({ pages: [{ name: "p1" }] });
        expect(validateCustomCommandDetailed(noBlocks)).toMatch(/'blocks' must be an array/);

        const dupes = blockCommand({
            pages: [
                { name: "One", blocks: [{ type: "text", text: "a" }] },
                { name: "one", blocks: [{ type: "text", text: "b" }] },
            ],
        });
        expect(validateCustomCommandDetailed(dupes)).toBeNull();
        expect(dupes.pages).toHaveLength(1);
    });

    it("rejects non-string page title/description (render-time crash guard)", () => {
        const command = blockCommand({
            pages: [{ name: "p1", title: 42, blocks: [{ type: "text", text: "x" }] }],
        });
        expect(validateCustomCommandDetailed(command)).toMatch(/'title' must be a string/);
    });

    it("rejects a null or non-object page entry without throwing", () => {
        // `"pages":[null]` is valid JSON; the guard must RETURN a problem string,
        // not throw a TypeError — the load path and proposal patch engine both
        // rely on validation never throwing.
        expect(() => validateCustomCommandDetailed(blockCommand({ pages: [null] }))).not.toThrow();
        expect(validateCustomCommandDetailed(blockCommand({ pages: [null] }))).toMatch(/page entry must be an object/);
        expect(validateCustomCommandDetailed(blockCommand({ pages: ["nope"] }))).toMatch(
            /page entry must be an object/,
        );
    });

    it("rejects unknown block types and empty galleries", () => {
        expect(validateCustomCommandDetailed(blockCommand({ blocks: [{ type: "banner", text: "x" }] }))).toMatch(
            /unknown type 'banner'/,
        );
        expect(
            validateCustomCommandDetailed(blockCommand({ blocks: [{ type: "images", urls: ["ftp://x"] }] })),
        ).toMatch(/no valid urls/);
    });

    it("drops invalid accent colors and urls, truncates over-length text", () => {
        const command = blockCommand({
            accent_color: -5,
            blocks: [{ type: "heading", text: "T".repeat(300), url: "not-a-url" }],
        });
        expect(validateCustomCommandDetailed(command)).toBeNull();
        expect(command.accent_color).toBeUndefined();
        expect(command.blocks[0].url).toBeUndefined();
        expect(command.blocks[0].text.length).toBe(256);
    });

    it("keeps boundary accent colors 0 and 0xffffff", () => {
        const low = blockCommand({ accent_color: 0 });
        expect(validateCustomCommandDetailed(low)).toBeNull();
        expect(low.accent_color).toBe(0);
        const high = blockCommand({ accent_color: 0xffffff });
        expect(validateCustomCommandDetailed(high)).toBeNull();
        expect(high.accent_color).toBe(0xffffff);
    });

    it("rejects a view over the rendered text budget", () => {
        const blocks = Array.from({ length: 4 }, () => ({ type: "text", text: "x".repeat(1200) }));
        expect(validateCustomCommandDetailed(blockCommand({ blocks }))).toMatch(/renders \d+ text characters/);
    });

    describe("thumbnail_url", () => {
        it("keeps a valid thumbnail on command and page", () => {
            const command = blockCommand({
                thumbnail_url: "https://cdn.example.com/icon.png",
                pages: [
                    {
                        name: "p1",
                        thumbnail_url: "https://cdn.example.com/page.png",
                        blocks: [{ type: "text", text: "page body" }],
                    },
                ],
            });
            expect(validateCustomCommandDetailed(command)).toBeNull();
            expect(command.thumbnail_url).toBe("https://cdn.example.com/icon.png");
            expect(command.pages[0].thumbnail_url).toBe("https://cdn.example.com/page.png");
        });

        it("strips a non-http(s) or over-length url (repair, not reject)", () => {
            const bad = blockCommand({ thumbnail_url: "javascript:alert(1)" });
            expect(validateCustomCommandDetailed(bad)).toBeNull();
            expect(bad.thumbnail_url).toBeUndefined();

            const long = blockCommand({ thumbnail_url: `https://example.com/${"a".repeat(1024)}` });
            expect(validateCustomCommandDetailed(long)).toBeNull();
            expect(long.thumbnail_url).toBeUndefined();
        });

        it("strips a thumbnail on a view with no text block to attach it to", () => {
            const imagesOnly = blockCommand({
                thumbnail_url: "https://cdn.example.com/icon.png",
                blocks: [{ type: "images", urls: ["https://example.com/a.png"] }],
            });
            expect(validateCustomCommandDetailed(imagesOnly)).toBeNull();
            expect(imagesOnly.thumbnail_url).toBeUndefined();
        });

        it("strips a command thumbnail when pages carry all the content", () => {
            const command = blockCommand({
                blocks: undefined,
                thumbnail_url: "https://cdn.example.com/icon.png",
                pages: [{ name: "p1", blocks: [{ type: "text", text: "x" }] }],
            });
            expect(validateCustomCommandDetailed(command)).toBeNull();
            expect(command.thumbnail_url).toBeUndefined();
        });

        it("strips a page thumbnail when that page has no text block", () => {
            const command = blockCommand({
                pages: [
                    {
                        name: "p1",
                        thumbnail_url: "https://cdn.example.com/icon.png",
                        blocks: [{ type: "images", urls: ["https://example.com/a.png"] }],
                    },
                ],
            });
            expect(validateCustomCommandDetailed(command)).toBeNull();
            expect(command.pages[0].thumbnail_url).toBeUndefined();
        });
    });
});

describe("validateBlocksDetailed", () => {
    it("rejects non-arrays, empties, and over-count views", () => {
        expect(validateBlocksDetailed("nope", "ctx")).toMatch(/must be an array/);
        expect(validateBlocksDetailed([], "ctx")).toMatch(/must not be empty/);
        const many = Array.from({ length: 31 }, () => ({ type: "divider" }));
        expect(validateBlocksDetailed(many, "ctx")).toMatch(/31 blocks/);
    });

    it("requires content on text-bearing blocks", () => {
        expect(validateBlocksDetailed([{ type: "heading", text: "  " }], "ctx")).toMatch(/non-empty 'text'/);
        expect(validateBlocksDetailed([{ type: "field", name: "x", value: " " }], "ctx")).toMatch(/non-empty 'value'/);
        expect(validateBlocksDetailed([{ type: "small" }], "ctx")).toMatch(/non-empty 'text'/);
    });

    it("drops invalid image urls but errors when none remain", () => {
        const blocks = [{ type: "images", urls: ["https://ok.example/a.png", "nope"] }];
        expect(validateBlocksDetailed(blocks, "ctx")).toBeNull();
        expect((blocks[0] as { urls: string[] }).urls).toEqual(["https://ok.example/a.png"]);
    });
});
