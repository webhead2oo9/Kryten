import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleInteraction } from "../src/handlers/interactionRouter";
import { KrytenClient } from "../src/classes/client";
import { Interaction } from "discord.js";
import {
    BLOCK_SELECT_ID,
    BUTTON_DELETE_PAGE_ID,
    EDITOR_BUTTON_IDS,
    EDITOR_MODAL_PREFIX,
    SECTION_SELECT_ID,
} from "../src/handlers/editorHandler";
import { IMGFP_BUTTON_PREFIX } from "../src/features/imageFingerprint/imageFingerprintHandler";
import { PROPOSAL_BUTTON_PREFIX } from "../src/proposals/reviewCard";

// Stub every handler the route table dispatches to so each test can assert
// exactly which handler fired. editorHandler is mocked WITH importOriginal so
// the router keeps matching against the real EDITOR_BUTTON_IDS / prefixes /
// SECTION_SELECT_ID while its handler functions are spies.
const H = vi.hoisted(() => ({
    handleContexts: vi.fn(),
    handleCommands: vi.fn(),
    handleCustomCommand: vi.fn(),
    handleCustomCommandPageSelect: vi.fn(),
    handleProposalButton: vi.fn(),
    editorButton: vi.fn(),
    editorModal: vi.fn(),
    sectionSelect: vi.fn(),
    blockSelect: vi.fn(),
    imgfpButton: vi.fn(),
}));

vi.mock("../src/handlers/contextHandler", () => ({ handleContexts: H.handleContexts }));
vi.mock("../src/handlers/commandHandler", () => ({ handleCommands: H.handleCommands }));
vi.mock("../src/handlers/customCommandHandler", () => ({
    handleCustomCommand: H.handleCustomCommand,
    handleCustomCommandPageSelect: H.handleCustomCommandPageSelect,
}));
vi.mock("../src/handlers/proposalHandler", () => ({ handleProposalButton: H.handleProposalButton }));
vi.mock("../src/handlers/messageHandler", () => ({
    getImageFingerprintHandler: () => ({ handleButton: H.imgfpButton }),
}));
vi.mock("../src/handlers/editorHandler", async importOriginal => {
    const actual = await importOriginal<typeof import("../src/handlers/editorHandler")>();
    return {
        ...actual,
        handleEditorButton: H.editorButton,
        handleEditorModal: H.editorModal,
        handleSectionSelection: H.sectionSelect,
        handleBlockSelection: H.blockSelect,
    };
});

/** Every handler spy — used to assert "exactly one fired". */
const allHandlers = [
    H.handleContexts,
    H.handleCommands,
    H.handleCustomCommand,
    H.handleCustomCommandPageSelect,
    H.handleProposalButton,
    H.editorButton,
    H.editorModal,
    H.sectionSelect,
    H.blockSelect,
    H.imgfpButton,
];

function makeClient(overrides: Record<string, unknown> = {}): KrytenClient {
    return {
        commandsHandled: 0,
        custom_commands: [] as { name: string }[],
        isBuiltinCommandName: () => false,
        logError: vi.fn(async () => undefined),
        ...overrides,
    } as unknown as KrytenClient;
}

/** Synthetic interaction with every type-guard the router calls defaulting to false. */
function makeInteraction(overrides: Record<string, unknown> = {}): Interaction {
    return {
        isMessageContextMenuCommand: () => false,
        isUserContextMenuCommand: () => false,
        isStringSelectMenu: () => false,
        isButton: () => false,
        isModalSubmit: () => false,
        isChatInputCommand: () => false,
        isMessageComponent: () => false,
        isRepliable: () => true,
        replied: false,
        deferred: false,
        deferUpdate: vi.fn(async () => undefined),
        reply: vi.fn(async () => undefined),
        followUp: vi.fn(async () => undefined),
        ...overrides,
    } as unknown as Interaction;
}

function button(customId: string, overrides: Record<string, unknown> = {}): Interaction {
    return makeInteraction({ isButton: () => true, isMessageComponent: () => true, customId, ...overrides });
}

function stringSelect(customId: string, overrides: Record<string, unknown> = {}): Interaction {
    return makeInteraction({
        isStringSelectMenu: () => true,
        isMessageComponent: () => true,
        customId,
        ...overrides,
    });
}

function chatInput(commandName: string): Interaction {
    return makeInteraction({ isChatInputCommand: () => true, commandName });
}

/** Assert `expected` fired once and no other handler spy did. */
function expectOnly(expected: (typeof allHandlers)[number]): void {
    expect(expected).toHaveBeenCalledTimes(1);
    for (const spy of allHandlers) {
        if (spy !== expected) expect(spy).not.toHaveBeenCalled();
    }
}

beforeEach(() => {
    for (const spy of Object.values(H)) spy.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("handleInteraction route table", () => {
    it("routes a context-menu command to the context handler", async () => {
        const interaction = makeInteraction({ isMessageContextMenuCommand: () => true });
        await handleInteraction(interaction, makeClient());
        expectOnly(H.handleContexts);
    });

    it("routes a cmdprop button to the proposal handler (prefix beats editor exact-ids)", async () => {
        const interaction = button(`${PROPOSAL_BUTTON_PREFIX}approve:${"a".repeat(32)}`);
        await handleInteraction(interaction, makeClient());
        expectOnly(H.handleProposalButton);
    });

    it("routes an imgfp button to the image-fingerprint button handler", async () => {
        const interaction = button(`${IMGFP_BUTTON_PREFIX}approve:tok123`);
        await handleInteraction(interaction, makeClient());
        expectOnly(H.imgfpButton);
    });

    it("routes every editor button id to the editor button handler", async () => {
        for (const id of EDITOR_BUTTON_IDS) {
            for (const spy of Object.values(H)) spy.mockReset();
            await handleInteraction(button(id), makeClient());
            expectOnly(H.editorButton);
        }
    });

    it("routes a page-scoped editor button id (base:commandName:pageName) to the editor button handler", async () => {
        await handleInteraction(button(`${BUTTON_DELETE_PAGE_ID}:faq:p2`), makeClient());
        expectOnly(H.editorButton);
    });

    it("routes the section select to the section-selection handler", async () => {
        await handleInteraction(stringSelect(SECTION_SELECT_ID), makeClient());
        expectOnly(H.sectionSelect);
    });

    it("routes the block select to the block-selection handler", async () => {
        await handleInteraction(stringSelect(BLOCK_SELECT_ID), makeClient());
        expectOnly(H.blockSelect);
    });

    it("routes an editor modal (any suffix) to the editor modal handler", async () => {
        const interaction = makeInteraction({
            isModalSubmit: () => true,
            customId: `${EDITOR_MODAL_PREFIX}general:faq`,
        });
        await handleInteraction(interaction, makeClient());
        expectOnly(H.editorModal);
    });

    it("routes a chat input matching a custom command (not a built-in) to the custom command handler", async () => {
        const client = makeClient({ custom_commands: [{ name: "faq" }] });
        await handleInteraction(chatInput("faq"), client);
        expectOnly(H.handleCustomCommand);
    });

    it("routes to the built-in handler when the name is a built-in even if a custom command shares it", async () => {
        const client = makeClient({
            custom_commands: [{ name: "help" }],
            isBuiltinCommandName: (name: string) => name === "help",
        });
        await handleInteraction(chatInput("help"), client);
        expectOnly(H.handleCommands);
    });

    it("falls back to the built-in handler for an unknown chat input command", async () => {
        const client = makeClient();
        await handleInteraction(chatInput("ghost"), client);
        expectOnly(H.handleCommands);
    });

    it("routes a custom-command page select to its page-select handler", async () => {
        const client = makeClient({ custom_commands: [{ name: "faq" }] });
        await handleInteraction(stringSelect("faq"), client);
        expectOnly(H.handleCustomCommandPageSelect);
    });

    it("absorbs an unmatched, un-acknowledged message component via deferUpdate and nothing else", async () => {
        const interaction = button("some-unrelated-button");
        await handleInteraction(interaction, makeClient());

        expect((interaction as any).deferUpdate).toHaveBeenCalledTimes(1);
        for (const spy of allHandlers) expect(spy).not.toHaveBeenCalled();
    });

    it("does not absorb a message component that was already replied/deferred", async () => {
        const interaction = button("some-unrelated-button", { replied: true });
        await handleInteraction(interaction, makeClient());

        expect((interaction as any).deferUpdate).not.toHaveBeenCalled();
        for (const spy of allHandlers) expect(spy).not.toHaveBeenCalled();
    });
});

describe("commandsHandled metric", () => {
    it("increments for a dispatched custom chat command", async () => {
        const client = makeClient({ custom_commands: [{ name: "faq" }] });
        await handleInteraction(chatInput("faq"), client);
        expect(client.commandsHandled).toBe(1);
    });

    it("increments for a dispatched built-in chat command", async () => {
        const client = makeClient({ isBuiltinCommandName: (name: string) => name === "help" });
        await handleInteraction(chatInput("help"), client);
        expect(client.commandsHandled).toBe(1);
    });
});

describe("route failure reporting", () => {
    it("logs the error and replies ephemerally when a not-yet-acknowledged route throws", async () => {
        H.editorButton.mockRejectedValue(new Error("editor boom"));
        const client = makeClient();
        const interaction = button(EDITOR_BUTTON_IDS[0]!);

        await handleInteraction(interaction, client);

        expect(client.logError).toHaveBeenCalledTimes(1);
        expect((interaction as any).reply).toHaveBeenCalledTimes(1);
        expect((interaction as any).followUp).not.toHaveBeenCalled();
    });

    it("logs the error and follows up when an already-deferred route throws", async () => {
        H.handleProposalButton.mockRejectedValue(new Error("proposal boom"));
        const client = makeClient();
        const interaction = button(`${PROPOSAL_BUTTON_PREFIX}approve:${"b".repeat(32)}`, { deferred: true });

        await handleInteraction(interaction, client);

        expect(client.logError).toHaveBeenCalledTimes(1);
        expect((interaction as any).followUp).toHaveBeenCalledTimes(1);
        expect((interaction as any).reply).not.toHaveBeenCalled();
    });

    it("does not attempt an ephemeral reply when the failed interaction is not repliable", async () => {
        H.editorButton.mockRejectedValue(new Error("editor boom"));
        const client = makeClient();
        const interaction = button(EDITOR_BUTTON_IDS[0]!, { isRepliable: () => false });

        await handleInteraction(interaction, client);

        expect(client.logError).toHaveBeenCalledTimes(1);
        expect((interaction as any).reply).not.toHaveBeenCalled();
        expect((interaction as any).followUp).not.toHaveBeenCalled();
    });
});
