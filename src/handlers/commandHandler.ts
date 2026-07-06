import { ChatInputCommandInteraction, MessageFlags } from "discord.js";
import { KrytenClient } from "../classes/client";
import { CommandContext } from "../classes/commandContext";

export async function handleCommands(interaction: ChatInputCommandInteraction, client: KrytenClient) {
    const command = await client.commands.getCommand(interaction).catch(() => null);
    if (!command) return;
    const context = new CommandContext({ interaction, client });
    if (!interaction.inCachedGuild())
        return await context.error({
            content: "You can only use commands in guilds",
            ephemeral: true,
        });
    if (!interaction.channel)
        return await context.error({
            content: "Please add me to the private thread (by mentioning me) to use commands",
            ephemeral: true,
        });
    const bypassStaffGateForConfigRecovery = client.configLoadFailed && command.name === "reload_config";
    if (command.staff_only && !context.is_staff && !bypassStaffGateForConfigRecovery)
        return await context.error({
            content: "You are not staff",
        });

    let hasResponded = false;
    const safetyTimeout = setTimeout(async () => {
        if (!hasResponded && !interaction.replied && !interaction.deferred) {
            try {
                await interaction.deferReply({ ephemeral: true });
            } catch {
                // Already responded or deferred - ignore
            }
        }
    }, 2500);

    try {
        return await command.run(context);
    } catch (error) {
        // Mirror contextHandler: surface to staff via logError and give the
        // user a visible failure instead of an eternal "Bot is thinking...".
        await client
            .logError(`Command '/${interaction.commandName}' failed`, error instanceof Error ? error : String(error))
            .catch(() => undefined);
        // Only surface the failure when the user would otherwise see nothing
        // (no reply / eternal "thinking…"). If the command already replied,
        // its primary output succeeded — a contradictory error followUp would
        // mislead; logError above is enough.
        if (interaction.deferred && !interaction.replied) {
            await interaction
                .editReply({ content: "An error occurred while running this command." })
                .catch(() => undefined);
        } else if (!interaction.replied) {
            await interaction
                .reply({ content: "An error occurred while running this command.", flags: MessageFlags.Ephemeral })
                .catch(() => undefined);
        }
    } finally {
        hasResponded = true;
        clearTimeout(safetyTimeout);
    }
}
