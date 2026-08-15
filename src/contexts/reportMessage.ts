import {
    ApplicationCommandType,
    ContainerBuilder,
    ContextMenuCommandBuilder,
    MessageFlags,
    TextChannel,
    TextDisplayBuilder,
} from "discord.js";
import { ContextCommand, ContextMenuInteraction } from "../classes/contextCommand";
import { KrytenClient } from "../classes/client";
import { channelOrParentListed } from "../utils/channels";
import { AccentColor, renderFields } from "../utils/cv2";
import { clampText } from "../utils/format";
import { sendAlertWithGallery } from "../utils/imageGallery";
import { sweepExpired } from "../utils/sweepExpired";

// Reporting is deliberately open to everyone, so it needs abuse guards:
// without these, one user re-reporting the same message is an unlimited ping vector.
const REPORTER_COOLDOWN_MS = 60_000;
const MESSAGE_DEDUP_MS = 10 * 60_000;
const lastReportByUser = new Map<string, number>();
const recentlyReportedMessages = new Map<string, number>();

const commandData = new ContextMenuCommandBuilder()
    .setName("Report Message")
    .setType(ApplicationCommandType.Message)
    .setDMPermission(false)
    .toJSON();

export default class extends ContextCommand {
    constructor() {
        super({ name: "Report Message", command_data: commandData });
    }

    override async run(interaction: ContextMenuInteraction, client: KrytenClient): Promise<void> {
        if (!interaction.isMessageContextMenuCommand()) return;

        const message = interaction.targetMessage;
        const mod = client.config.moderation;
        const blacklist = mod?.channel_blacklist ?? [];

        if (channelOrParentListed(interaction.channel, interaction.channelId, blacklist)) {
            await interaction.reply({ content: "This isn't allowed here.", flags: MessageFlags.Ephemeral });
            return;
        }

        const guild = interaction.guild;
        if (!guild) {
            await interaction.reply({ content: "This can only be used in a server.", flags: MessageFlags.Ephemeral });
            return;
        }

        const modRoleId = mod?.mod_role_id;
        const alertChannelId = mod?.alert_channel_id;
        const alertChannel = alertChannelId ? await client.channels.fetch(alertChannelId).catch(() => null) : null;

        if (!modRoleId || !alertChannel || !alertChannel.isTextBased()) {
            await interaction.reply({
                content: "Configuration error. Please check the moderation settings.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        const now = Date.now();
        sweepExpired(lastReportByUser, now, REPORTER_COOLDOWN_MS);
        sweepExpired(recentlyReportedMessages, now, MESSAGE_DEDUP_MS);

        if (recentlyReportedMessages.has(message.id)) {
            await interaction.reply({
                content: "That message was already reported recently - the moderators have been notified.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        const lastReport = lastReportByUser.get(interaction.user.id);
        if (lastReport !== undefined && now - lastReport < REPORTER_COOLDOWN_MS) {
            await interaction.reply({
                content: "You recently reported a message. Please wait a minute before reporting another.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        lastReportByUser.set(interaction.user.id, now);
        recentlyReportedMessages.set(message.id, now);

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const link = `https://discord.com/channels/${guild.id}/${message.channelId}/${message.id}`;
        // The mod-role ping lives in a TextDisplay now; allowedMentions
        // restricted to that role keeps the reporter/channel mentions from
        // pinging while still notifying the mods.
        const buildContainer = () =>
            new ContainerBuilder().setAccentColor(AccentColor.Red).addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`<@&${modRoleId}>`),
                new TextDisplayBuilder().setContent("## User Report"),
                new TextDisplayBuilder().setContent(
                    renderFields([
                        {
                            name: "Reporter",
                            value: `A message was reported by ${interaction.user} in ${message.channel}`,
                        },
                        { name: "Reported Message Link", value: `[Jump to message](${link})` },
                        { name: "Message Content", value: clampText(message.content) },
                    ]) + `\n\n-# Reported Message ID: ${message.id}`,
                ),
            );

        try {
            await sendAlertWithGallery({
                channel: alertChannel as TextChannel,
                sourceMessage: message,
                filenamePrefix: "report-image",
                buildContainer,
                allowedMentions: { roles: [modRoleId] },
                fallbackLogLabel: "Report",
            });
        } catch (error) {
            // The alert send itself failed; allow the message to be re-reported
            // AND release the reporter's per-user cooldown — otherwise they're told
            // "an error occurred" yet blocked from retrying (or reporting anything
            // else) for the next 60s even though no report reached the mods.
            recentlyReportedMessages.delete(message.id);
            lastReportByUser.delete(interaction.user.id);
            client.errorCount++;
            client.lastErrorTime = new Date().toISOString();
            console.error("Error in Report Message:", error);
            await interaction.editReply({ content: "An error occurred while reporting." }).catch(() => undefined);
            return;
        }
        // The alert is out. A failed confirmation edit must NOT revert the dedup —
        // that would re-open the duplicate mod-ping path the guard exists to close.
        await interaction.editReply({ content: "The message has been reported." }).catch(() => undefined);
    }
}
