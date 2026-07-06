import { ChatInputCommandInteraction, Colors, ContainerBuilder, MessageFlags, TextDisplayBuilder } from "discord.js";
import { CommandContextInitOptions } from "../types";
import { BaseContext } from "./baseContext";

export class CommandContext extends BaseContext {
    override interaction: ChatInputCommandInteraction;
    constructor(options: CommandContextInitOptions) {
        super(options);
        this.interaction = options.interaction;
    }

    async error(options: {
        content?: string;
        error_key?: string;
        ephemeral?: boolean;
        codeblock?: boolean;
        type?: "user" | "guild";
        args?: string[];
    }) {
        const err_string = options.content ?? "Unknown Error";
        const container = new ContainerBuilder()
            .setAccentColor(Colors.Red)
            .addTextDisplayComponents(
                new TextDisplayBuilder().setContent(
                    `❌ **Error** | ${(options.codeblock ?? true) ? `\`${err_string}\`` : err_string}`,
                ),
            );
        if (this.interaction.replied || this.interaction.deferred)
            // Clear content/embeds explicitly: a prior non-CV2 reply may carry
            // them, and the API rejects the CV2 flag alongside either.
            return await this.interaction.editReply({
                content: null,
                embeds: [],
                components: [container],
                flags: MessageFlags.IsComponentsV2,
                allowedMentions: { parse: [] },
            });
        else
            return await this.interaction.reply({
                components: [container],
                flags:
                    (options.ephemeral ?? true)
                        ? MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral
                        : MessageFlags.IsComponentsV2,
                allowedMentions: { parse: [] },
            });
    }
}
