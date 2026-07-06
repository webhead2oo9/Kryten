import { SlashCommandBuilder } from "discord.js";
import { Command } from "../classes/command";
import { CommandContext } from "../classes/commandContext";
import { ensureProposalService } from "../handlers/proposalHandler";

const command_data = new SlashCommandBuilder()
    .setName("reload_config")
    .setDMPermission(false)
    .setDescription(`Reloads the config.json file`);

export default class extends Command {
    constructor() {
        super({
            name: "reload_config",
            command_data: command_data.toJSON(),
            staff_only: true,
        });
    }

    override async run(ctx: CommandContext): Promise<any> {
        try {
            ctx.client.loadConfig();
        } catch (error) {
            return ctx.interaction.reply({
                content: `Failed to reload config: ${error instanceof Error ? error.message : String(error)}`,
                ephemeral: true,
            });
        }

        // Most features read config fresh per call, but these two hold state
        // derived from it: the poller's interval and the proposal service's
        // existence. Re-apply so config changes don't need a restart.
        ctx.client.poller.start();
        ensureProposalService(ctx.client);

        return ctx.interaction.reply({
            content: "Reloaded (poller and proposal service re-applied).",
            ephemeral: true,
        });
    }
}
