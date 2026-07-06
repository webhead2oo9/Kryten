import { MessageFlags, SlashCommandBuilder } from "discord.js";
import { Command } from "../classes/command";
import { CommandContext } from "../classes/commandContext";
import { SAVE_IN_PROGRESS_MESSAGE, buildEditorResponse } from "../handlers/editorHandler";
import { NAME_PATTERN } from "../utils/format";

const commandData = new SlashCommandBuilder()
    .setName("create_command")
    .setDescription("Create a new custom command")
    .setDMPermission(false)
    .addStringOption(option =>
        option.setName("name").setDescription("Name for the new custom command").setRequired(true),
    );

export default class extends Command {
    constructor() {
        super({
            name: "create_command",
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

        if (!NAME_PATTERN.test(commandName)) {
            return ctx.interaction.reply({
                content:
                    "Command name must be 1-32 characters, using lowercase letters, numbers, underscores or hyphens.",
                ephemeral: true,
            });
        }

        // A custom command sharing a built-in's name produces a duplicate entry
        // in the registration payload — Discord 400s the whole guild set.
        if (ctx.client.commands.loaded_classes.has(commandName)) {
            return ctx.interaction.reply({
                content: `'${commandName}' is reserved for a built-in command.`,
                ephemeral: true,
            });
        }

        // The router matches editor component ids ("cmd-editor-…") before
        // custom-command page selects, whose custom-id is the command name.
        if (commandName.startsWith("cmd-editor-")) {
            return ctx.interaction.reply({
                content: "Names starting with 'cmd-editor-' are reserved.",
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

        // Same guard edit_command uses: don't bundle another command's unsaved
        // edits into this session, or the next Save would commit them too.
        if (session.hasUnsavedChanges && session.selectedCommandName && session.selectedCommandName !== commandName) {
            return ctx.interaction.reply({
                content: `You have unsaved changes for '${session.selectedCommandName}'. Please save or discard them before creating '${commandName}'.`,
                ephemeral: true,
            });
        }

        if (!session.hasUnsavedChanges) {
            ctx.client.commandEditor.refreshCommands(session, ctx.client.custom_commands);
            // Only (re)anchor the conflict-detection base when the working copy
            // was actually refreshed — see the matching note in editCommands.
            session.fileShas = ctx.client.commandSync.snapshotShas();
        }

        if (session.commands.find(c => c.name === commandName)) {
            return ctx.interaction.reply({
                content: `Command '${commandName}' already exists. Use /edit_command instead.`,
                ephemeral: true,
            });
        }

        ctx.client.commandEditor.addNewCommand(session, commandName);
        session.responseToken = ctx.interaction.token;
        session.applicationId = ctx.interaction.applicationId ?? ctx.client.application?.id ?? undefined;
        session.statusMessage = `Created '${commandName}'.`;

        const response = buildEditorResponse(session);
        return ctx.interaction.reply({
            ...response,
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
        });
    }
}
