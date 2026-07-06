import { SlashCommandBuilder } from "discord.js";
import { Command } from "../classes/command";
import { CommandContext } from "../classes/commandContext";

const command_data = new SlashCommandBuilder()
    .setName("reload_commands")
    .setDMPermission(false)
    .setDescription("Reload custom commands from GitHub");

export default class extends Command {
    constructor() {
        super({
            name: "reload_commands",
            command_data: command_data.toJSON(),
            staff_only: true,
        });
    }

    override async run(ctx: CommandContext): Promise<any> {
        await ctx.interaction.deferReply({ ephemeral: true });

        try {
            const commands = await ctx.client.loadCustomCommands();

            // loadAll never throws — degradation shows up as the load source.
            // Staff running this to pull a fix must know when GitHub wasn't
            // actually reached.
            const source = ctx.client.commandSync.lastLoadSource;

            // "none" = GitHub unreachable AND no usable snapshot: the corpus is
            // empty only because nothing could be loaded. Registering that
            // would deregister every live custom command from Discord — keep
            // the registration as-is until a load succeeds (the poller applies
            // the same source guard before touching registration).
            if (source !== "none") {
                await ctx.client.registerApplicationCommands();
            }

            const content =
                source === "github"
                    ? `Reloaded from GitHub. Loaded ${commands.length} custom commands.`
                    : source === "cache"
                      ? `⚠️ GitHub was not adopted — serving ${commands.length} commands from the local snapshot/current corpus. Check the error log channel.`
                      : source === "memory"
                        ? `⚠️ GitHub was not adopted and no local snapshot was usable — kept ${commands.length} current in-memory custom commands. Check the error log channel.`
                        : "⚠️ GitHub was not available and no local snapshot exists — no custom commands are loaded. Slash-command registration was left unchanged. Check the error log channel.";
            return ctx.interaction.editReply({ content });
        } catch (error) {
            console.error("Error reloading commands:", error);

            const errorResponse = await ctx.interaction.editReply({
                content: "Failed to reload commands. Check the bot logs for details.",
            });

            ctx.client
                .logError("Command Reload Failed", error instanceof Error ? error : String(error), false)
                .catch(console.error);

            return errorResponse;
        }
    }
}
