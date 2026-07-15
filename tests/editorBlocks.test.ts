import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { ButtonInteraction, ModalSubmitInteraction, StringSelectMenuInteraction } from "discord.js";
import {
    BLOCK_SELECT_ID,
    BUTTON_DELETE_PAGE_ID,
    BUTTON_EDIT_BLOCK_ID,
    MODAL_BLOCKS_ID,
    MODAL_BLOCK_ID,
    applyBlockEdit,
    buildBlockFromInputs,
    buildBlockSelectOptions,
    buildEditorResponse,
    handleBlockSelection,
    handleEditorButton,
    handleEditorModal,
} from "../src/handlers/editorHandler";
import { CustomCommandEditor, EditorSession } from "../src/classes/customCommandEditor";
import { KrytenClient } from "../src/classes/client";
import { CommandBlock, CustomCommand } from "../src/types";

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

const text = (t: string): CommandBlock => ({ type: "text", text: t });

describe("buildBlockFromInputs", () => {
    it("builds each content block type from its inputs, trimming whitespace", () => {
        expect(buildBlockFromInputs("heading", { text: " Title " })).toEqual({
            block: { type: "heading", text: "Title" },
        });
        expect(buildBlockFromInputs("heading", { text: "T", url: "https://vd.com" })).toEqual({
            block: { type: "heading", text: "T", url: "https://vd.com" },
        });
        expect(buildBlockFromInputs("text", { text: "body" })).toEqual({ block: { type: "text", text: "body" } });
        expect(buildBlockFromInputs("small", { text: "note" })).toEqual({ block: { type: "small", text: "note" } });
        expect(buildBlockFromInputs("field", { name: "N", value: "V" })).toEqual({
            block: { type: "field", name: "N", value: "V" },
        });
        expect(buildBlockFromInputs("divider", {})).toEqual({ block: { type: "divider" } });
    });

    it("rejects a non-http(s) heading url", () => {
        const result = buildBlockFromInputs("heading", { text: "T", url: "ftp://x" });
        expect(result).toHaveProperty("error");
    });

    it("rejects empty required inputs", () => {
        expect(buildBlockFromInputs("text", { text: "   " })).toHaveProperty("error");
        expect(buildBlockFromInputs("field", { name: "N", value: " " })).toHaveProperty("error");
    });

    it("parses image URLs one per line, skipping blank lines and CRLF", () => {
        const result = buildBlockFromInputs("images", {
            urls: "https://a.com/1.png\r\n\n  https://a.com/2.png  \n",
        });
        expect(result).toEqual({ block: { type: "images", urls: ["https://a.com/1.png", "https://a.com/2.png"] } });
    });

    it("points at the offending line for an invalid image URL", () => {
        const result = buildBlockFromInputs("images", { urls: "https://a.com/1.png\nnot-a-url" });
        expect(result).toEqual({ error: expect.stringContaining("Line 2") });
    });

    it("rejects more than 10 image URLs", () => {
        const urls = Array.from({ length: 11 }, (_, i) => `https://a.com/${i}.png`).join("\n");
        expect(buildBlockFromInputs("images", { urls })).toHaveProperty("error");
    });
});

describe("applyBlockEdit", () => {
    it("inserts into an empty/undefined list", () => {
        const result = applyBlockEdit(undefined, { kind: "insert", block: text("a"), position: 1 }, "content");
        expect(result).toEqual({ blocks: [text("a")] });
    });

    it("moves a block via an edit with a new position", () => {
        const blocks = [text("a"), text("b"), text("c")];
        const result = applyBlockEdit(blocks, { kind: "edit", index: 0, block: text("a"), position: 3 }, "content");
        expect(result).toEqual({ blocks: [text("b"), text("c"), text("a")] });
        // input untouched
        expect(blocks[0]).toEqual(text("a"));
    });

    it("rejects an out-of-range position", () => {
        const result = applyBlockEdit([text("a")], { kind: "insert", block: text("b"), position: 3 }, "content");
        expect(result).toEqual({ error: "Position must be between 1 and 2." });
    });

    it("rejects an edit of a vanished index", () => {
        const result = applyBlockEdit([text("a")], { kind: "edit", index: 4, block: text("b"), position: 1 }, "content");
        expect(result).toHaveProperty("error");
    });

    it("rejects an insert past the 30-block cap", () => {
        const blocks = Array.from({ length: 30 }, (_, i) => text(`b${i}`));
        const result = applyBlockEdit(blocks, { kind: "insert", block: text("x"), position: 31 }, "content");
        expect(result).toEqual({ error: expect.stringContaining("max 30") });
    });

    it("rejects a result that would render only dividers", () => {
        const result = applyBlockEdit([], { kind: "insert", block: { type: "divider" }, position: 1 }, "content");
        expect(result).toEqual({ error: expect.stringContaining("non-divider") });
    });

    it("rejects a result over the rendered-text budget", () => {
        const blocks = [text("x".repeat(2000))];
        const result = applyBlockEdit(blocks, { kind: "insert", block: text("y".repeat(2000)), position: 2 }, "content");
        expect(result).toEqual({ error: expect.stringContaining("split content across pages") });
    });

    it("returns the normalized list (over-length text clamped by the shared validator)", () => {
        const result = applyBlockEdit(
            [],
            { kind: "insert", block: { type: "heading", text: "h".repeat(300) }, position: 1 },
            "content",
        );
        expect("blocks" in result && result.blocks[0]).toEqual({ type: "heading", text: "h".repeat(256) });
    });
});

describe("buildBlockSelectOptions", () => {
    it("lists blocks with 1-based labels, marks the cursor, and appends the six add entries", () => {
        const { options, hiddenBlockCount } = buildBlockSelectOptions(
            [{ type: "heading", text: "Hello" }, { type: "field", name: "Q", value: "A" }],
            1,
        );
        expect(hiddenBlockCount).toBe(0);
        expect(options).toHaveLength(8);
        expect(options[0]).toMatchObject({ label: "1 · heading", value: "blk:0", description: "Hello", default: false });
        expect(options[1]).toMatchObject({ label: "2 · field", value: "blk:1", description: "Q", default: true });
        expect(options.slice(2).map(o => o.value)).toEqual([
            "addblk:heading",
            "addblk:text",
            "addblk:field",
            "addblk:divider",
            "addblk:images",
            "addblk:small",
        ]);
    });

    it("gives add entries priority over block entries under the 25-option cap", () => {
        const blocks = Array.from({ length: 21 }, (_, i) => text(`b${i}`));
        const { options, hiddenBlockCount } = buildBlockSelectOptions(blocks, undefined);
        expect(options).toHaveLength(25);
        expect(hiddenBlockCount).toBe(2);
        expect(options.filter(o => o.value.startsWith("addblk:"))).toHaveLength(6);
    });

    it("drops the add entries at the 30-block cap and shows 25 blocks", () => {
        const blocks = Array.from({ length: 30 }, (_, i) => text(`b${i}`));
        const { options, hiddenBlockCount } = buildBlockSelectOptions(blocks, undefined);
        expect(options).toHaveLength(25);
        expect(hiddenBlockCount).toBe(5);
        expect(options.every(o => o.value.startsWith("blk:"))).toBe(true);
    });

    it("windows the block entries around a cursor past the visible slice", () => {
        const blocks = Array.from({ length: 21 }, (_, i) => text(`b${i}`));
        const { options, hiddenBlockCount } = buildBlockSelectOptions(blocks, 20);
        expect(options).toHaveLength(25);
        expect(hiddenBlockCount).toBe(2);
        const blockOptions = options.filter(o => o.value.startsWith("blk:"));
        expect(blockOptions[0]).toMatchObject({ label: "3 · text", value: "blk:2", default: false });
        expect(blockOptions[blockOptions.length - 1]).toMatchObject({
            label: "21 · text",
            value: "blk:20",
            default: true,
        });
    });
});

// ---------------------------------------------------------------- handlers

function makeCommand(): CustomCommand {
    return {
        format: 2,
        name: "faq",
        description: "d",
        blocks: [
            { type: "heading", text: "H" },
            { type: "field", name: "N", value: "V" },
        ],
        pages: [{ name: "p1", blocks: [text("page body")] }],
    };
}

function makeClientWithSession(): { client: KrytenClient; session: EditorSession } {
    const editor = new CustomCommandEditor();
    const client = { commandEditor: editor } as unknown as KrytenClient;
    const session = editor.getOrCreateSession("u1", [makeCommand()]);
    editor.selectCommand(session, "faq");
    session.selectedSection = "embed";
    return { client, session };
}

function modalInteraction(customId: string, fields: Record<string, string>): ModalSubmitInteraction {
    const values = new Map(Object.entries(fields).map(([key, value]) => [key, { value }]));
    return {
        user: { id: "u1" },
        customId,
        fields: {
            fields: values,
            getTextInputValue: (key: string) => {
                const field = values.get(key);
                if (!field) throw new Error(`Missing field ${key}`);
                return field.value;
            },
        },
        reply: vi.fn(async () => undefined),
        isFromMessage: () => true,
        update: vi.fn(async () => undefined),
    } as unknown as ModalSubmitInteraction;
}

function selectInteraction(value: string): StringSelectMenuInteraction {
    return {
        user: { id: "u1" },
        customId: BLOCK_SELECT_ID,
        values: [value],
        reply: vi.fn(async () => undefined),
        update: vi.fn(async () => undefined),
        showModal: vi.fn(async () => undefined),
    } as unknown as StringSelectMenuInteraction;
}

function buttonInteraction(customId: string): ButtonInteraction {
    return {
        user: { id: "u1" },
        customId,
        reply: vi.fn(async () => undefined),
        update: vi.fn(async () => undefined),
        showModal: vi.fn(async () => undefined),
    } as unknown as ButtonInteraction;
}

describe("handleEditorButton — page-action buttons are page-scoped", () => {
    it("deletes the page named in the button id, not the session's current cursor page", async () => {
        const editor = new CustomCommandEditor();
        const client = { commandEditor: editor } as unknown as KrytenClient;
        const command: CustomCommand = {
            format: 2,
            name: "faq",
            description: "d",
            blocks: [{ type: "heading", text: "H" }],
            pages: [
                { name: "p1", blocks: [text("one")] },
                { name: "p2", blocks: [text("two")] },
            ],
        };
        const session = editor.getOrCreateSession("u1", [command]);
        editor.selectCommand(session, "faq");
        // Session cursor points at p1 (as if a newer editor message navigated
        // there), but the click arrives from an older card that shows p2.
        editor.setView(session, "page", "p1");

        const interaction = buttonInteraction(`${BUTTON_DELETE_PAGE_ID}:faq:p2`);
        await handleEditorButton(interaction, client);

        const pages = editor.getSession("u1")!.commands.find(c => c.name === "faq")!.pages!;
        expect(pages.map(p => p.name)).toEqual(["p1"]);
        expect(interaction.update).toHaveBeenCalled();
    });

    it("does not resolve a stale card's common page name against another command", async () => {
        const editor = new CustomCommandEditor();
        const client = { commandEditor: editor } as unknown as KrytenClient;
        const commands: CustomCommand[] = [
            {
                format: 2,
                name: "faq",
                description: "d",
                blocks: [{ type: "heading", text: "FAQ" }],
                pages: [{ name: "common", blocks: [text("faq")] }],
            },
            {
                format: 2,
                name: "setup",
                description: "d",
                blocks: [{ type: "heading", text: "Setup" }],
                pages: [{ name: "common", blocks: [text("setup")] }],
            },
        ];
        const session = editor.getOrCreateSession("u1", commands);
        editor.selectCommand(session, "setup");
        editor.setView(session, "page", "common");

        const interaction = buttonInteraction(`${BUTTON_DELETE_PAGE_ID}:faq:common`);
        await handleEditorButton(interaction, client);

        const current = editor.getSession("u1")!;
        expect(current.commands.find(c => c.name === "faq")!.pages).toHaveLength(1);
        expect(current.commands.find(c => c.name === "setup")!.pages).toHaveLength(1);
        expect(interaction.update).toHaveBeenCalled();
    });
});

describe("handleEditorModal — raw block modal", () => {
    it("surfaces malformed block JSON before scanning thumbnail text", async () => {
        const { client, session } = makeClientWithSession();
        const interaction = modalInteraction(`${MODAL_BLOCKS_ID}:faq`, {
            accent_color: "",
            thumbnail_url: "https://cdn.example.com/icon.png",
            blocks_json: "[null]",
        });

        await handleEditorModal(interaction, client);

        expect((interaction as any).reply).toHaveBeenCalledWith({
            content: "content block 1 must be an object",
            ephemeral: true,
        });
        expect((interaction as any).update).not.toHaveBeenCalled();
        expect(session.hasUnsavedChanges).toBe(false);
    });
});

describe("handleEditorModal — typed block modal", () => {
    it("edits a block in place and moves it to the submitted position", async () => {
        const { client, session } = makeClientWithSession();
        session.selectedBlockIndex = 1;
        session.pendingBlockEdit = { unitTag: "", index: 1, block: { type: "field", name: "N", value: "V" } };
        const interaction = modalInteraction(`${MODAL_BLOCK_ID}:faq::1:field`, {
            name: "New name",
            value: "New value",
            position: "1",
        });

        await handleEditorModal(interaction, client);

        const command = session.commands[0]!;
        expect(command.blocks).toEqual([
            { type: "field", name: "New name", value: "New value" },
            { type: "heading", text: "H" },
        ]);
        expect(session.hasUnsavedChanges).toBe(true);
        expect(session.selectedBlockIndex).toBe(0);
        expect((interaction as any).update).toHaveBeenCalledTimes(1);
        expect((interaction as any).reply).not.toHaveBeenCalled();
    });

    it("inserts a new block at the submitted position", async () => {
        const { client, session } = makeClientWithSession();
        const interaction = modalInteraction(`${MODAL_BLOCK_ID}:faq::new:small`, {
            text: "footnote",
            position: "3",
        });

        await handleEditorModal(interaction, client);

        const command = session.commands[0]!;
        expect(command.blocks).toHaveLength(3);
        expect(command.blocks![2]).toEqual({ type: "small", text: "footnote" });
        expect(session.selectedBlockIndex).toBe(2);
    });

    it("edits a page's blocks when the scope carries the page name", async () => {
        const { client, session } = makeClientWithSession();
        session.selectedSection = "page";
        session.selectedPageName = "p1";
        session.selectedBlockIndex = 0;
        session.pendingBlockEdit = { unitTag: "p1", index: 0, block: text("page body") };
        const interaction = modalInteraction(`${MODAL_BLOCK_ID}:faq:p1:0:text`, {
            text: "updated page body",
            position: "1",
        });

        await handleEditorModal(interaction, client);

        expect(session.commands[0]!.pages![0]!.blocks).toEqual([text("updated page body")]);
        expect(session.hasUnsavedChanges).toBe(true);
    });

    it("refuses when the block at the scoped index changed type underneath the modal", async () => {
        const { client, session } = makeClientWithSession();
        session.pendingBlockEdit = { unitTag: "", index: 1, block: text("was text") };
        const interaction = modalInteraction(`${MODAL_BLOCK_ID}:faq::1:text`, { text: "x", position: "1" });

        await handleEditorModal(interaction, client);

        expect((interaction as any).reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining("out of date") }),
        );
        expect(session.commands[0]!.blocks![1]).toEqual({ type: "field", name: "N", value: "V" });
        expect(session.hasUnsavedChanges).toBe(false);
    });

    it("refuses when a same-typed but different block sits at the scoped index", async () => {
        const { client, session } = makeClientWithSession();
        // Snapshot taken when the modal opened, before a reorder put the
        // current heading ("H") at index 0 — index+type alone would wrongly
        // accept and clobber it.
        session.pendingBlockEdit = { unitTag: "", index: 0, block: { type: "heading", text: "OLD" } };
        const interaction = modalInteraction(`${MODAL_BLOCK_ID}:faq::0:heading`, { text: "x", position: "1" });

        await handleEditorModal(interaction, client);

        expect((interaction as any).reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining("out of date") }),
        );
        expect(session.commands[0]!.blocks![0]).toEqual({ type: "heading", text: "H" });
        expect(session.hasUnsavedChanges).toBe(false);
    });

    it("refuses an edit submit with no recorded open (restart or another modal opened since)", async () => {
        const { client, session } = makeClientWithSession();
        const interaction = modalInteraction(`${MODAL_BLOCK_ID}:faq::1:field`, {
            name: "X",
            value: "Y",
            position: "1",
        });

        await handleEditorModal(interaction, client);

        expect((interaction as any).reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining("out of date") }),
        );
        expect(session.hasUnsavedChanges).toBe(false);
    });

    it("refuses when the scoped page no longer matches the session selection", async () => {
        const { client, session } = makeClientWithSession();
        session.selectedSection = "page";
        session.selectedPageName = "p1";
        const interaction = modalInteraction(`${MODAL_BLOCK_ID}:faq:otherpage:0:text`, {
            text: "x",
            position: "1",
        });

        await handleEditorModal(interaction, client);

        expect((interaction as any).reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining("out of date") }),
        );
        expect(session.hasUnsavedChanges).toBe(false);
    });

    it("refuses a top-level block modal when the viewed section is no longer content", async () => {
        const { client, session } = makeClientWithSession();
        session.selectedSection = "general";
        const interaction = modalInteraction(`${MODAL_BLOCK_ID}:faq::1:field`, {
            name: "Hidden edit",
            value: "Should not land",
            position: "1",
        });

        await handleEditorModal(interaction, client);

        expect((interaction as any).reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining("out of date") }),
        );
        expect(session.commands[0]!.blocks).toEqual([
            { type: "heading", text: "H" },
            { type: "field", name: "N", value: "V" },
        ]);
        expect(session.hasUnsavedChanges).toBe(false);
    });

    it("refuses a page block modal when that page name is remembered but the viewed section is content", async () => {
        const { client, session } = makeClientWithSession();
        session.selectedSection = "embed";
        session.selectedPageName = "p1";
        const interaction = modalInteraction(`${MODAL_BLOCK_ID}:faq:p1:0:text`, {
            text: "hidden page edit",
            position: "1",
        });

        await handleEditorModal(interaction, client);

        expect((interaction as any).reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining("out of date") }),
        );
        expect(session.commands[0]!.pages![0]!.blocks).toEqual([text("page body")]);
        expect(session.hasUnsavedChanges).toBe(false);
    });

    it("surfaces a validation problem without mutating the session", async () => {
        const { client, session } = makeClientWithSession();
        const interaction = modalInteraction(`${MODAL_BLOCK_ID}:faq::new:text`, {
            text: "x",
            position: "9",
        });

        await handleEditorModal(interaction, client);

        expect((interaction as any).reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: "Position must be between 1 and 3." }),
        );
        expect(session.commands[0]!.blocks).toHaveLength(2);
        expect(session.hasUnsavedChanges).toBe(false);
    });
});

describe("handleBlockSelection", () => {
    it("sets the block cursor and repaints", async () => {
        const { client, session } = makeClientWithSession();
        const interaction = selectInteraction("blk:1");

        await handleBlockSelection(interaction, client);

        expect(session.selectedBlockIndex).toBe(1);
        expect((interaction as any).update).toHaveBeenCalledTimes(1);
        expect((interaction as any).showModal).not.toHaveBeenCalled();
    });

    it("clears a cursor pointing past the current block list", async () => {
        const { client, session } = makeClientWithSession();
        const interaction = selectInteraction("blk:7");

        await handleBlockSelection(interaction, client);

        expect(session.selectedBlockIndex).toBeUndefined();
        expect(session.statusMessage).toContain("no longer exists");
    });

    it("inserts a divider immediately after the cursor without a modal", async () => {
        const { client, session } = makeClientWithSession();
        session.selectedBlockIndex = 0;
        const interaction = selectInteraction("addblk:divider");

        await handleBlockSelection(interaction, client);

        expect(session.commands[0]!.blocks).toEqual([
            { type: "heading", text: "H" },
            { type: "divider" },
            { type: "field", name: "N", value: "V" },
        ]);
        expect(session.selectedBlockIndex).toBe(1);
        expect(session.hasUnsavedChanges).toBe(true);
        expect((interaction as any).showModal).not.toHaveBeenCalled();
    });

    it("opens the typed modal for a content add entry", async () => {
        const { client, session } = makeClientWithSession();
        const interaction = selectInteraction("addblk:field");

        await handleBlockSelection(interaction, client);

        expect((interaction as any).showModal).toHaveBeenCalledTimes(1);
        expect(session.hasUnsavedChanges).toBe(false);
    });
});

describe("handleEditorButton — Edit Block", () => {
    it("snapshots the selected block before showing the modal, anchoring the submit", async () => {
        const { client, session } = makeClientWithSession();
        session.selectedBlockIndex = 0;
        const interaction = buttonInteraction(BUTTON_EDIT_BLOCK_ID);

        await handleEditorButton(interaction, client);

        expect((interaction as any).showModal).toHaveBeenCalledTimes(1);
        expect(session.pendingBlockEdit).toEqual({ unitTag: "", index: 0, block: { type: "heading", text: "H" } });
    });
});

describe("buildEditorResponse block wiring", () => {
    it("renders the block select and block buttons for the viewed unit", () => {
        const { session } = makeClientWithSession();
        session.selectedBlockIndex = 0;

        const serialized = JSON.stringify(buildEditorResponse(session).components);

        expect(serialized).toContain(BLOCK_SELECT_ID);
        expect(serialized).toContain(BUTTON_EDIT_BLOCK_ID);
        expect(serialized).toContain("addblk:heading");
    });

    it("omits the block select on the general section", () => {
        const { session } = makeClientWithSession();
        session.selectedSection = "general";

        const serialized = JSON.stringify(buildEditorResponse(session).components);

        expect(serialized).not.toContain(BLOCK_SELECT_ID);
    });
});
