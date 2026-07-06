import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { Command } from "../classes/command";
import { CommandContext } from "../classes/commandContext";
import { SAVE_IN_PROGRESS_MESSAGE, buildEditorResponse } from "../handlers/editorHandler";

const commandData = new SlashCommandBuilder()
    .setName("edit_command")
    .setDescription("Edit an existing custom command")
    .setDMPermission(false)
    .addStringOption(option =>
        option.setName("name").setDescription("Name of the custom command to edit").setRequired(true),
    );

export default class extends Command {
    constructor() {
        super({
            name: "edit_command",
            command_data: commandData.toJSON(),
            staff_only: true,
        });
    }

    override async run(ctx: CommandContext): Promise<any> {
        const commandName = ctx.interaction.options.getString("name", true).trim().toLowerCase();

        if (!commandName.length) {
            return ctx.interaction.reply({
                content: "Command name cannot be empty.",
                ephemeral: true,
            });
        }

        const session = ctx.client.commandEditor.getOrCreateSession(
            ctx.interaction.user.id,
            ctx.client.custom_commands,
        );

        if (session.saving) {
            return ctx.interaction.reply({ content: SAVE_IN_PROGRESS_MESSAGE, ephemeral: true });
        }

        if (session.hasUnsavedChanges && session.selectedCommandName && session.selectedCommandName !== commandName) {
            return ctx.interaction.reply({
                content: `You have unsaved changes for '${session.selectedCommandName}'. Please save or discard them before editing '${commandName}'.`,
                ephemeral: true,
            });
        }

        if (!session.hasUnsavedChanges) {
            ctx.client.commandEditor.refreshCommands(session, ctx.client.custom_commands);
            // Only (re)anchor the conflict-detection base when the working copy
            // was actually refreshed — bumping it for a dirty session would pair
            // a stale snapshot with fresh SHAs, silently overwriting whatever
            // another editor committed in between.
            session.fileShas = ctx.client.commandSync.snapshotShas();
        }

        const target = session.commands.find(c => c.name === commandName);
        if (!target) {
            return ctx.interaction.reply({
                content: `Command '${commandName}' was not found.`,
                ephemeral: true,
            });
        }

        ctx.client.commandEditor.selectCommand(session, target.name);
        session.responseToken = ctx.interaction.token;
        session.applicationId = ctx.interaction.applicationId ?? ctx.client.application?.id ?? undefined;
        session.statusMessage = `Editing '${target.name}'.`;

        const response = buildEditorResponse(session);
        return ctx.interaction.reply({
            ...response,
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        });
    }
}
