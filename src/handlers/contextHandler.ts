import { MessageContextMenuCommandInteraction, MessageFlags, UserContextMenuCommandInteraction } from "discord.js";
import { KrytenClient } from "../classes/client";
import { memberHasStaffRole } from "../utils/staff";

export async function handleContexts(
    interaction: MessageContextMenuCommandInteraction | UserContextMenuCommandInteraction,
    client: KrytenClient,
): Promise<void> {
    const context = await client.contexts.getContext(interaction).catch(() => null);
    if (!context) return;

    // Enforce staff_only the same way commandHandler does — the ContextCommand
    // constructor accepts the flag but doesn't enforce it, so a staff-gated
    // context command depends on this check.
    if (context.staff_only && !memberHasStaffRole(interaction.member, client.config)) {
        await interaction.reply({ content: "You are not staff", flags: MessageFlags.Ephemeral }).catch(() => undefined);
        return;
    }

    try {
        await context.run(interaction, client);
    } catch (error) {
        await client
            .logError(
                `Context menu '${interaction.commandName}' failed`,
                error instanceof Error ? error : String(error),
            )
            .catch(() => undefined);
        const payload = {
            content: "An error occurred while running this action.",
            flags: MessageFlags.Ephemeral,
        } as const;
        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(payload).catch(() => undefined);
        } else {
            await interaction.reply(payload).catch(() => undefined);
        }
    }
}
