import { SlashCommandBuilder } from "discord.js";
import { Command } from "../classes/command";
import { CommandContext } from "../classes/commandContext";
import { ensureProposalService } from "../handlers/proposalHandler";
import { getMessageLogger, getUserInteractionStore } from "../handlers/messageHandler";

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
        const previousConfig = ctx.client.config;
        const previousLoadFailed = ctx.client.configLoadFailed;
        const messageLogger = getMessageLogger(ctx.client);
        let attemptedConfig = previousConfig;
        let loggingReconfigurationStarted = false;
        try {
            ctx.client.loadConfig();
            attemptedConfig = ctx.client.config;
            await getUserInteractionStore(ctx.client).reconcileClassifierCampaigns();
            // Reconfiguration can enforce a lower evidence-retention cap. Keep
            // it last so a later subsystem failure cannot make a failed reload
            // irreversibly discard snapshots before the config is rolled back.
            loggingReconfigurationStarted = true;
            await messageLogger.reconfigure(previousConfig.logging);
        } catch (error) {
            ctx.client.config = previousConfig;
            ctx.client.configLoadFailed = previousLoadFailed;
            if (loggingReconfigurationStarted) {
                await messageLogger.reconfigure(attemptedConfig.logging).catch(() => undefined);
            }
            return ctx.interaction.reply({
                content: `Failed to reload config: ${error instanceof Error ? error.message : String(error)}`,
                ephemeral: true,
            });
        }

        // Most features read config fresh per call, but these hold state
        // derived from it: the poller's interval and the proposal service's
        // existence. Re-apply so config changes don't need a restart.
        ctx.client.poller.start();
        ensureProposalService(ctx.client);

        return ctx.interaction.reply({
            content: "Reloaded (interaction retention, logging, poller, and proposal service re-applied).",
            ephemeral: true,
        });
    }
}
