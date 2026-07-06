import { Interaction, MessageFlags } from "discord.js";
import { KrytenClient } from "../classes/client";
import { getImageFingerprintHandler } from "./messageHandler";
import { handleCommands } from "./commandHandler";
import { handleContexts } from "./contextHandler";
import {
    BLOCK_SELECT_ID,
    EDITOR_BUTTON_IDS,
    EDITOR_MODAL_PREFIX,
    SECTION_SELECT_ID,
    handleBlockSelection,
    handleEditorButton,
    handleEditorModal,
    handleSectionSelection,
} from "./editorHandler";
import { handleProposalButton } from "./proposalHandler";
import { IMGFP_BUTTON_PREFIX } from "../features/imageFingerprint/imageFingerprintHandler";
import { PROPOSAL_BUTTON_PREFIX } from "../proposals/reviewCard";
import { handleCustomCommand, handleCustomCommandPageSelect } from "./customCommandHandler";

interface InteractionRoute {
    name: string;
    matches(interaction: Interaction, client: KrytenClient): boolean;
    handle(interaction: Interaction, client: KrytenClient): Promise<void> | void;
}

function isBuiltInChatCommand(interaction: Interaction, client: KrytenClient): boolean {
    return interaction.isChatInputCommand() && client.isBuiltinCommandName(interaction.commandName);
}

const interactionRoutes: InteractionRoute[] = [
    {
        name: "context-menu",
        matches: interaction => interaction.isMessageContextMenuCommand() || interaction.isUserContextMenuCommand(),
        handle: async (interaction, client) => {
            if (interaction.isMessageContextMenuCommand() || interaction.isUserContextMenuCommand()) {
                await handleContexts(interaction, client);
            }
        },
    },
    {
        name: "editor-section-select",
        matches: interaction => interaction.isStringSelectMenu() && interaction.customId === SECTION_SELECT_ID,
        handle: async (interaction, client) => {
            if (interaction.isStringSelectMenu()) await handleSectionSelection(interaction, client);
        },
    },
    {
        name: "editor-block-select",
        matches: interaction => interaction.isStringSelectMenu() && interaction.customId === BLOCK_SELECT_ID,
        handle: async (interaction, client) => {
            if (interaction.isStringSelectMenu()) await handleBlockSelection(interaction, client);
        },
    },
    {
        name: "proposal-review-button",
        matches: interaction => interaction.isButton() && interaction.customId.startsWith(PROPOSAL_BUTTON_PREFIX),
        handle: async (interaction, client) => {
            if (interaction.isButton()) await handleProposalButton(interaction, client);
        },
    },
    {
        name: "image-fingerprint-review-button",
        matches: interaction => interaction.isButton() && interaction.customId.startsWith(IMGFP_BUTTON_PREFIX),
        handle: async (interaction, client) => {
            if (interaction.isButton()) await getImageFingerprintHandler(client).handleButton(interaction);
        },
    },
    {
        name: "editor-button",
        matches: interaction => interaction.isButton() && EDITOR_BUTTON_IDS.includes(interaction.customId),
        handle: async (interaction, client) => {
            if (interaction.isButton()) await handleEditorButton(interaction, client);
        },
    },
    {
        name: "editor-modal",
        matches: interaction => interaction.isModalSubmit() && interaction.customId.startsWith(EDITOR_MODAL_PREFIX),
        handle: async (interaction, client) => {
            if (interaction.isModalSubmit()) await handleEditorModal(interaction, client);
        },
    },
    {
        name: "custom-command",
        matches: (interaction, client) =>
            interaction.isChatInputCommand() &&
            !isBuiltInChatCommand(interaction, client) &&
            client.custom_commands.some(c => c.name === interaction.commandName),
        handle: async (interaction, client) => {
            if (!interaction.isChatInputCommand()) return;
            // Count dispatched command interactions in one place (mirrors the
            // built-in route below) so both command kinds share one metric basis.
            client.commandsHandled++;
            await handleCustomCommand(interaction, client);
        },
    },
    {
        name: "custom-command-page-select",
        matches: (interaction, client) =>
            interaction.isStringSelectMenu() && client.custom_commands.some(c => c.name === interaction.customId),
        handle: async (interaction, client) => {
            if (interaction.isStringSelectMenu()) await handleCustomCommandPageSelect(interaction, client);
        },
    },
    {
        name: "stale-message-component",
        matches: interaction => interaction.isMessageComponent() && !interaction.replied && !interaction.deferred,
        handle: async interaction => {
            if (interaction.isMessageComponent()) await interaction.deferUpdate().catch(() => null);
        },
    },
    {
        name: "built-in-chat-command",
        matches: interaction => interaction.isChatInputCommand(),
        handle: async (interaction, client) => {
            if (!interaction.isChatInputCommand()) return;
            client.commandsHandled++;
            await handleCommands(interaction, client);
        },
    },
];

async function reportRouteFailure(
    route: InteractionRoute,
    interaction: Interaction,
    client: KrytenClient,
    error: unknown,
): Promise<void> {
    await client
        .logError(`Interaction route '${route.name}' failed`, error instanceof Error ? error : String(error))
        .catch(() => undefined);

    if (!interaction.isRepliable()) return;
    const payload = {
        content: "An error occurred while handling this interaction.",
        flags: MessageFlags.Ephemeral,
    } as const;
    if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload).catch(() => undefined);
    } else {
        await interaction.reply(payload).catch(() => undefined);
    }
}

export async function handleInteraction(interaction: Interaction, client: KrytenClient): Promise<void> {
    for (const route of interactionRoutes) {
        if (!route.matches(interaction, client)) continue;
        try {
            await route.handle(interaction, client);
        } catch (error) {
            await reportRouteFailure(route, interaction, client, error);
        }
        return;
    }
}
