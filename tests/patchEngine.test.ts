import { describe, expect, it } from "vitest";
import {
    ProposalConflictError,
    ProposalValidationError,
    applyPatchEdits,
    summarizePatchEdits,
} from "../src/proposals/patchEngine";

function baseCommand(): Record<string, unknown> {
    return {
        format: 2,
        name: "wifi",
        description: "Wifi help",
        blocks: [
            { type: "heading", text: "Wifi" },
            { type: "text", text: "Use 5GHz for best results." },
        ],
        pages: [
            {
                name: "setup",
                title: "Setup",
                blocks: [
                    { type: "text", text: "Connect to the dedicated router." },
                    { type: "field", name: "Band", value: "5GHz only" },
                    { type: "field", name: "Channel", value: "36-48" },
                ],
            },
            { name: "faq", title: "FAQ", blocks: [{ type: "text", text: "Common questions." }] },
        ],
    };
}

describe("applyPatchEdits", () => {
    it("rejects empty edits", () => {
        expect(() => applyPatchEdits(baseCommand(), [])).toThrow(ProposalValidationError);
        expect(() => applyPatchEdits(baseCommand(), "nope")).toThrow(ProposalValidationError);
    });

    it("does not mutate the input", () => {
        const input = baseCommand();
        const snapshot = JSON.stringify(input);
        applyPatchEdits(input, [{ type: "replace_text", old: "5GHz for best", new: "6GHz for best" }]);
        expect(JSON.stringify(input)).toBe(snapshot);
    });

    describe("replace_text", () => {
        it("replaces a single global match", () => {
            const patched = applyPatchEdits(baseCommand(), [
                { type: "replace_text", old: "dedicated router", new: "dedicated 6E router" },
            ]);
            const pages = patched["pages"] as any[];
            expect(pages[0].blocks[0].text).toBe("Connect to the dedicated 6E router.");
        });

        it("conflicts on zero matches", () => {
            expect(() =>
                applyPatchEdits(baseCommand(), [{ type: "replace_text", old: "nonexistent", new: "x" }]),
            ).toThrow(ProposalConflictError);
        });

        it("conflicts on multiple matches (total occurrences, not slots)", () => {
            const command = baseCommand();
            (command["blocks"] as any[])[1].text = "router router";
            expect(() => applyPatchEdits(command, [{ type: "replace_text", old: "router", new: "x" }])).toThrow(
                ProposalConflictError,
            );
        });

        it("scopes to a named property on a target", () => {
            const patched = applyPatchEdits(baseCommand(), [
                {
                    type: "replace_text",
                    target: { kind: "block", page: "setup", block: "Band" },
                    property: "value",
                    old: "5GHz",
                    new: "6GHz",
                },
            ]);
            const pages = patched["pages"] as any[];
            expect(pages[0].blocks[1].value).toBe("6GHz only");
        });

        it("only counts visible text keys", () => {
            const command = baseCommand();
            (command as any)["internal_note"] = "dedicated router"; // not a visible key
            const patched = applyPatchEdits(command, [
                { type: "replace_text", old: "dedicated router", new: "dedicated 6E router" },
            ]);
            expect((patched as any)["internal_note"]).toBe("dedicated router");
        });

        it("inserts $-patterns in the replacement literally (no $&/$$/$` interpretation)", () => {
            const patched = applyPatchEdits(baseCommand(), [
                { type: "replace_text", old: "dedicated router", new: "router (see $& and $$5 and $`)" },
            ]);
            const pages = patched["pages"] as any[];
            expect(pages[0].blocks[0].text).toBe("Connect to the router (see $& and $$5 and $`).");
        });
    });

    describe("set_property", () => {
        it("requires the old guard key", () => {
            expect(() =>
                applyPatchEdits(baseCommand(), [{ type: "set_property", property: "description", new: "New" }]),
            ).toThrow(ProposalValidationError);
        });

        it("conflicts when the guard no longer matches", () => {
            expect(() =>
                applyPatchEdits(baseCommand(), [
                    { type: "set_property", property: "description", old: "Stale", new: "New desc" },
                ]),
            ).toThrow(ProposalConflictError);
        });

        it("sets when the guard matches", () => {
            const patched = applyPatchEdits(baseCommand(), [
                { type: "set_property", property: "description", old: "Wifi help", new: "Wireless help" },
            ]);
            expect(patched["description"]).toBe("Wireless help");
        });

        it("null guard matches a missing property, so optional properties can be added", () => {
            const patched = applyPatchEdits(baseCommand(), [
                { type: "set_property", property: "thumbnail_url", old: null, new: "https://cdn.example.com/i.png" },
            ]);
            expect(patched["thumbnail_url"]).toBe("https://cdn.example.com/i.png");
        });

        it("null guard conflicts when the property is already set", () => {
            const command = baseCommand();
            command["thumbnail_url"] = "https://cdn.example.com/old.png";
            expect(() =>
                applyPatchEdits(command, [
                    { type: "set_property", property: "thumbnail_url", old: null, new: "https://cdn.example.com/new.png" },
                ]),
            ).toThrow(ProposalConflictError);
        });

        it("adds a page thumbnail via a page target", () => {
            const patched = applyPatchEdits(baseCommand(), [
                {
                    type: "set_property",
                    target: { kind: "page", page: "setup" },
                    property: "thumbnail_url",
                    old: null,
                    new: "https://cdn.example.com/setup.png",
                },
            ]);
            expect((patched["pages"] as any[])[0].thumbnail_url).toBe("https://cdn.example.com/setup.png");
        });

        it("rejects prototype-sensitive property names", () => {
            for (const property of ["__proto__", "constructor", "prototype"]) {
                expect(() =>
                    applyPatchEdits(baseCommand(), [
                        { type: "set_property", property, old: {}, new: { polluted: true } },
                    ]),
                ).toThrow(ProposalValidationError);
            }
        });

        it("rejects removed target kinds", () => {
            expect(() =>
                applyPatchEdits(baseCommand(), [
                    { type: "set_property", target: { kind: "embed" }, property: "title", old: "x", new: "y" },
                ]),
            ).toThrow(ProposalValidationError);
        });

        it("re-validation of a patched null page surfaces a ProposalValidationError, not a raw throw", () => {
            // Setting pages to [null] via a guarded set_property must be classified
            // by the re-validate step as a ProposalValidationError (→400), never leak
            // out as a raw TypeError (the module contract: every failure is Proposal*).
            const current = baseCommand()["pages"];
            expect(() =>
                applyPatchEdits(baseCommand(), [
                    { type: "set_property", property: "pages", old: current, new: [null] },
                ]),
            ).toThrow(ProposalValidationError);
        });
    });

    describe("page targeting", () => {
        it("resolves pages by name or title, case-insensitively", () => {
            const patched = applyPatchEdits(baseCommand(), [
                {
                    type: "set_property",
                    target: { kind: "page", page: "FAQ" },
                    property: "title",
                    old: "FAQ",
                    new: "Questions",
                },
            ]);
            expect((patched["pages"] as any[])[1].title).toBe("Questions");
        });

        it("conflicts on ambiguous page references", () => {
            const command = baseCommand();
            (command["pages"] as any[]).push({
                name: "faq2",
                title: "faq",
                blocks: [{ type: "text", text: "x" }],
            });
            expect(() =>
                applyPatchEdits(command, [
                    {
                        type: "set_property",
                        target: { kind: "page", page: "faq" },
                        property: "title",
                        old: "FAQ",
                        new: "Q",
                    },
                ]),
            ).toThrow(ProposalConflictError);
        });

        it("conflicts on unknown pages", () => {
            expect(() =>
                applyPatchEdits(baseCommand(), [
                    {
                        type: "set_property",
                        target: { kind: "page", page: "missing" },
                        property: "title",
                        old: "x",
                        new: "y",
                    },
                ]),
            ).toThrow(ProposalConflictError);
        });
    });

    describe("block targeting", () => {
        it("set_property on a block by index and by field name", () => {
            const byIndex = applyPatchEdits(baseCommand(), [
                {
                    type: "set_property",
                    target: { kind: "block", page: "setup", block: 1 },
                    property: "value",
                    old: "5GHz only",
                    new: "6GHz preferred",
                },
            ]);
            expect((byIndex["pages"] as any)[0].blocks[1].value).toBe("6GHz preferred");

            const byName = applyPatchEdits(baseCommand(), [
                {
                    type: "set_property",
                    target: { kind: "block", page: "setup", block: "Channel" },
                    property: "value",
                    old: "36-48",
                    new: "36-64",
                },
            ]);
            expect((byName["pages"] as any)[0].blocks[2].value).toBe("36-64");
        });

        it("conflicts on ambiguous field-block names", () => {
            const command = baseCommand();
            (command["pages"] as any)[0].blocks.push({ type: "field", name: "Band", value: "again" });
            expect(() =>
                applyPatchEdits(command, [
                    {
                        type: "set_property",
                        target: { kind: "block", page: "setup", block: "Band" },
                        property: "value",
                        old: "5GHz only",
                        new: "x",
                    },
                ]),
            ).toThrow(ProposalConflictError);
        });
    });

    describe("insert/remove/move", () => {
        it("inserts a block at a position and appends with 'end'", () => {
            const patched = applyPatchEdits(baseCommand(), [
                {
                    type: "insert_item",
                    item_type: "block",
                    target: { page: "setup" },
                    position: 1,
                    item: { type: "divider" },
                },
                {
                    type: "insert_item",
                    item_type: "block",
                    target: { page: "setup" },
                    position: "end",
                    item: { type: "small", text: "footnote" },
                },
            ]);
            const blocks = (patched["pages"] as any[])[0].blocks;
            expect(blocks.map((b: any) => b.type)).toEqual(["text", "divider", "field", "field", "small"]);
        });

        it("rejects out-of-range positions", () => {
            expect(() =>
                applyPatchEdits(baseCommand(), [
                    {
                        type: "insert_item",
                        item_type: "block",
                        target: { page: "setup" },
                        position: 9,
                        item: { type: "divider" },
                    },
                ]),
            ).toThrow(ProposalConflictError);
        });

        it("rejects removed item types", () => {
            expect(() =>
                applyPatchEdits(baseCommand(), [
                    { type: "insert_item", item_type: "field", item: { name: "Z", value: "z" } },
                ]),
            ).toThrow(ProposalValidationError);
        });

        it("remove_item requires a deep-equal old guard", () => {
            expect(() =>
                applyPatchEdits(baseCommand(), [
                    {
                        type: "remove_item",
                        target: { kind: "block", page: "setup", block: "Band" },
                        old: { type: "field", name: "Band", value: "DRIFTED" },
                    },
                ]),
            ).toThrow(ProposalConflictError);

            const patched = applyPatchEdits(baseCommand(), [
                {
                    type: "remove_item",
                    target: { kind: "block", page: "setup", block: "Band" },
                    old: { type: "field", name: "Band", value: "5GHz only" },
                },
            ]);
            const blocks = (patched["pages"] as any[])[0].blocks;
            expect(blocks).toHaveLength(2);
            expect(blocks[1].name).toBe("Channel");
        });

        it("moves blocks and pages", () => {
            const movedBlock = applyPatchEdits(baseCommand(), [
                { type: "move_item", target: { kind: "block", block: 0 }, position: "end" },
            ]);
            expect((movedBlock["blocks"] as any[]).map(b => b.type)).toEqual(["text", "heading"]);

            const movedPage = applyPatchEdits(baseCommand(), [
                { type: "move_item", target: { kind: "page", page: "faq" }, position: 0 },
            ]);
            expect((movedPage["pages"] as any[]).map(p => p.name)).toEqual(["faq", "setup"]);
        });

        it("block edits against a body without blocks conflict rather than corrupt", () => {
            expect(() =>
                applyPatchEdits(
                    {
                        format: 2,
                        name: "wifi",
                        description: "d",
                        pages: [{ name: "p", blocks: [{ type: "text", text: "x" }] }],
                    },
                    [{ type: "insert_item", item_type: "block", item: { type: "divider" } }],
                ),
            ).toThrow(ProposalConflictError);
        });
    });

    it("re-validates the patched result", () => {
        expect(() =>
            applyPatchEdits(baseCommand(), [
                {
                    type: "set_property",
                    target: { kind: "block", block: 0 },
                    property: "type",
                    old: "heading",
                    new: "banner",
                },
            ]),
        ).toThrow(ProposalValidationError);
    });

    it("preserves key order of untouched parts", () => {
        const input = baseCommand();
        const patched = applyPatchEdits(input, [
            { type: "set_property", property: "description", old: "Wifi help", new: "W" },
        ]);
        expect(Object.keys(patched)).toEqual(Object.keys(input));
    });
});

describe("summarizePatchEdits", () => {
    it("summarizes and caps at 6 edits", () => {
        const edits = Array.from({ length: 8 }, (_, i) => ({
            type: "set_property",
            property: `p${i}`,
            old: "a",
            new: "b",
        }));
        const summary = summarizePatchEdits(edits)!;
        expect(summary).toContain("…and 2 more edit(s)");
        expect(summary.length).toBeLessThanOrEqual(1024);
    });

    it("summarizes block targets", () => {
        const summary = summarizePatchEdits([
            { type: "set_property", target: { kind: "block", page: "setup", block: 2 }, property: "value" },
        ]);
        expect(summary).toContain("page `setup`");
        expect(summary).toContain("block `2`");
    });

    it("returns null for empty input", () => {
        expect(summarizePatchEdits([])).toBeNull();
        expect(summarizePatchEdits(undefined)).toBeNull();
    });
});
