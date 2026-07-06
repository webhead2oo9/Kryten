import {
    ActionRowBuilder,
    ChatInputCommandInteraction,
    MessageFlags,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction,
} from "discord.js";
import { KrytenClient } from "../classes/client";
import { CommandPage } from "../types";
import { RenderUnit, unitContainers } from "../utils/commandRender";
import { sanitizeSelectDescription, sanitizeSelectLabel, sanitizeSelectValue } from "../utils/format";

/**
 * Build the page-select action row for a custom command's reply. The same select
 * is reused on update so the menu persists across page switches.
 */
function buildPageSelectComponents(
    pages: CommandPage[],
    customId: string,
): ActionRowBuilder<StringSelectMenuBuilder>[] {
    const options = pages.slice(0, 25).map(p => {
        const option: { label: string; value: string; description?: string } = {
            label: sanitizeSelectLabel(p.title, p.name),
            value: sanitizeSelectValue(p.name),
        };
        const description = sanitizeSelectDescription(p.description);
        if (description) option.description = description;
        return option;
    });
    if (!options.length) return [];
    return [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId(customId).addOptions(options),
        ),
    ];
}

/**
 * CV2 view of one command render unit, with the page dropdown living inside
 * the container so it reads as part of the card. A unit with no renderable
 * content still gets the dropdown, top-level.
 */
function buildComponents(
    unit: RenderUnit,
    fallbackAccent: number | undefined,
    selectRows: ActionRowBuilder<StringSelectMenuBuilder>[],
) {
    const containers = unitContainers(unit, fallbackAccent);
    const last = containers[containers.length - 1];
    if (last && selectRows.length) {
        for (const row of selectRows) last.addActionRowComponents(row);
        return containers;
    }
    return [...containers, ...selectRows];
}

export async function handleCustomCommand(
    interaction: ChatInputCommandInteraction,
    client: KrytenClient,
): Promise<void> {
    const custom = client.custom_commands.find(c => c.name === interaction.commandName);
    if (!custom) return;

    // commandsHandled is incremented by the router when it dispatches here.
    const selectRows = custom.pages?.length ? buildPageSelectComponents(custom.pages, interaction.commandName) : [];
    const hidden = interaction.options.getBoolean("hidden") ?? false;

    await interaction
        .reply({
            components: buildComponents(custom, custom.accent_color, selectRows),
            flags: hidden ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral : MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] },
        })
        .catch(err => client.logError("Custom command reply failed", err instanceof Error ? err : String(err)));
}

export async function handleCustomCommandPageSelect(
    interaction: StringSelectMenuInteraction,
    client: KrytenClient,
): Promise<void> {
    const custom = client.custom_commands.find(c => c.name === interaction.customId);
    if (!custom) {
        await interaction
            .reply({ content: "This command no longer exists.", flags: MessageFlags.Ephemeral })
            .catch(() => null);
        return;
    }

    // A reply that isn't already CV2 can't be updated in place: blocks only
    // render as CV2 and the flag can't be added to an existing message.
    if (!interaction.message.flags.has(MessageFlags.IsComponentsV2)) {
        await interaction
            .reply({
                content: "This command was upgraded — run it again to switch pages.",
                flags: MessageFlags.Ephemeral,
            })
            .catch(() => null);
        return;
    }

    const selectRows = custom.pages?.length ? buildPageSelectComponents(custom.pages, interaction.customId) : [];
    const selectedName = interaction.values[0];
    const selectedPage = selectedName ? custom.pages?.find(p => p.name === selectedName) : undefined;
    if (selectedName && !selectedPage) {
        await interaction
            .reply({ content: "That page is no longer available.", flags: MessageFlags.Ephemeral })
            .catch(() => null);
        return;
    }
    await interaction
        .update({
            components: buildComponents(selectedPage ?? {}, custom.accent_color, selectRows),
            allowedMentions: { parse: [] },
        })
        .catch(err => client.logError("Custom command page update failed", err instanceof Error ? err : String(err)));
}
