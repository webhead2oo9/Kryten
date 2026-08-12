import { SlashCommandBuilder } from "discord.js";
import { Command } from "../classes/command";
import { CommandContext } from "../classes/commandContext";
import { getUserInteractionStore } from "../handlers/messageHandler";

const commandData = new SlashCommandBuilder()
    .setName("delete-data")
    .setDMPermission(false)
    .setDescription("Delete your stored Kryten interaction data");

export default class extends Command {
    constructor() {
        super({
            name: "delete-data",
            command_data: commandData.toJSON(),
            staff_only: false,
        });
    }

    override async run(ctx: CommandContext): Promise<any> {
        await ctx.interaction.deferReply({ ephemeral: true });
        await getUserInteractionStore(ctx.client).deleteUser(ctx.interaction.user.id);
        return ctx.interaction.editReply({
            content:
                "Your stored Kryten interaction data has been deleted. Future qualifying activity may create a new record, and the newcomer greeter may welcome you again.",
        });
    }
}
