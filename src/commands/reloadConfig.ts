import { SlashCommandBuilder } from "discord.js";
import { Command } from "../classes/command";
import { CommandContext } from "../classes/commandContext";
import { ensureProposalService } from "../handlers/proposalHandler";
import { getStickyPosts, getUserInteractionStore } from "../handlers/messageHandler";

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
        await ctx.interaction.deferReply({ ephemeral: true });
        const previousConfig = ctx.client.config;
        const previousLoadFailed = ctx.client.configLoadFailed;
        try {
            ctx.client.loadConfig();
            const interactions = getUserInteractionStore(ctx.client);
            await interactions.reconcileClassifierCampaigns();
            await interactions.reconcileKeywordCooldowns();
        } catch (error) {
            ctx.client.config = previousConfig;
            ctx.client.configLoadFailed = previousLoadFailed;
            return ctx.interaction.editReply({
                content: `Failed to reload config: ${error instanceof Error ? error.message : String(error)}`,
            });
        }

        // Most features read config fresh per call, but these hold state
        // derived from it: the poller's interval and the proposal service's
        // existence. Re-apply so config changes don't need a restart.
        ctx.client.poller.start();
        ensureProposalService(ctx.client);

        try {
            await getStickyPosts(ctx.client).reload();
        } catch (error) {
            await ctx.client
                .logError("Sticky config refresh failed", error instanceof Error ? error : String(error))
                .catch(() => undefined);
            return ctx.interaction.editReply({
                content:
                    "Config reloaded, but sticky refresh failed. Existing posts/state are retained; check the error log before retrying.",
            });
        }

        return ctx.interaction.editReply({
            content: "Reloaded (interaction retention, poller, proposal service, and sticky posts re-applied).",
        });
    }
}
