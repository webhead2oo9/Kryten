import {
    ApplicationCommandType,
    ChannelType,
    ContainerBuilder,
    ContextMenuCommandBuilder,
    MessageFlags,
    TextChannel,
    TextDisplayBuilder,
} from "discord.js";
import { ContextCommand, ContextMenuInteraction } from "../classes/contextCommand";
import { KrytenClient } from "../classes/client";
import { AccentColor, renderFields } from "../utils/cv2";

const ROLE_PROPAGATION_DELAY_MS = 2000;

const commandData = new ContextMenuCommandBuilder()
    .setName("Timeout Corner")
    .setType(ApplicationCommandType.User)
    .setDMPermission(false)
    .toJSON();

export default class extends ContextCommand {
    constructor() {
        super({ name: "Timeout Corner", command_data: commandData });
    }

    override async run(interaction: ContextMenuInteraction, client: KrytenClient): Promise<void> {
        if (!interaction.isUserContextMenuCommand()) return;
        if (!interaction.inCachedGuild()) {
            await interaction.reply({ content: "This can only be used in a server.", flags: MessageFlags.Ephemeral });
            return;
        }

        const guild = interaction.guild;
        const cfg = client.config.moderation?.timeout;
        const allowedRoleIds = cfg?.allowed_role_ids ?? [];

        if (!interaction.member.roles.cache.some(role => allowedRoleIds.includes(role.id))) {
            await interaction.reply({
                content: "You do not have permission to use this command.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        if (interaction.targetUser.id === interaction.user.id) {
            await interaction.reply({ content: "You can't put yourself in time out.", flags: MessageFlags.Ephemeral });
            return;
        }

        const timeoutChannel = cfg?.channel_id ? await client.channels.fetch(cfg.channel_id).catch(() => null) : null;
        const timeoutRole = cfg?.role_id ? await guild.roles.fetch(cfg.role_id).catch(() => null) : null;

        if (!timeoutChannel || timeoutChannel.type !== ChannelType.GuildText || !timeoutRole) {
            await interaction.reply({
                content: "Configuration error. Please check the settings.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const targetMember = await guild.members.fetch(interaction.targetUser.id).catch(() => null);
            if (!targetMember) {
                await interaction.editReply({ content: "Could not find that member in this server." });
                return;
            }

            try {
                await targetMember.roles.add(timeoutRole, "User timed out");
            } catch (error) {
                await interaction.editReply({
                    content: `Failed to apply the timeout role: ${error instanceof Error ? error.message : String(error)}`,
                });
                return;
            }

            // Wait for the role assignment to propagate before creating the thread.
            await new Promise(resolve => setTimeout(resolve, ROLE_PROPAGATION_DELAY_MS));

            // From here on the target holds the restrictive role. If the thread
            // setup fails, roll the role back — otherwise the user is stranded
            // in role-based timeout with no thread while staff believe the
            // command failed.
            const rollbackRole = () =>
                targetMember.roles.remove(timeoutRole, "Timeout thread setup failed").catch(() => null);

            const thread = await timeoutChannel.threads
                .create({ name: `Timeout: ${targetMember.displayName}`, type: ChannelType.PrivateThread })
                .catch(() => null);
            if (!thread) {
                await rollbackRole();
                await interaction.editReply({
                    content:
                        "Failed to create the thread due to insufficient permissions. The timeout role was removed again.",
                });
                return;
            }

            const usersAdded = await thread.members
                .add(interaction.targetUser.id)
                .then(() => thread.members.add(interaction.user.id))
                .then(() => true)
                .catch(() => false);
            if (!usersAdded) {
                await rollbackRole();
                await thread.delete("Timeout thread setup failed").catch(() => null);
                await interaction.editReply({
                    content:
                        "Failed to add users to the thread due to insufficient permissions. The timeout role was removed again.",
                });
                return;
            }

            const introSent = await thread
                .send({
                    content: `${interaction.targetUser} You've been placed in time out, please join us in this channel to discuss.`,
                })
                .then(() => true)
                .catch(() => false);
            if (!introSent) {
                await rollbackRole();
                await thread.delete("Timeout thread setup failed").catch(() => null);
                await interaction.editReply({
                    content:
                        "Failed to send the timeout thread message due to insufficient permissions. The timeout role was removed again.",
                });
                return;
            }

            await interaction.editReply({ content: "User has been timed out and a thread has been created." });

            await sendNotification(
                client,
                cfg?.notification_channel_id,
                guild.id,
                thread.id,
                `${interaction.targetUser}`,
                `${interaction.user}`,
            );
        } catch (error) {
            console.error("Error in Timeout Corner:", error);
            await client
                .logError("Timeout Corner", error instanceof Error ? error : String(error))
                .catch(() => undefined);
            await interaction
                .editReply({ content: "An error occurred while processing the timeout." })
                .catch(() => undefined);
        }
    }
}

async function sendNotification(
    client: KrytenClient,
    notificationChannelId: string | undefined,
    guildId: string,
    threadId: string,
    targetUser: string,
    moderator: string,
): Promise<void> {
    if (!notificationChannelId) return;

    try {
        const notifChannel = await client.channels.fetch(notificationChannelId).catch(() => null);
        if (!notifChannel || !notifChannel.isTextBased()) return;

        // A thread is its own channel: link guild/thread. The 3-segment
        // guild/channel/message form doesn't apply — a starterless private
        // thread has no anchor message in the parent, so that shape resolves
        // to a non-existent message and never opens the thread.
        const threadLink = `https://discord.com/channels/${guildId}/${threadId}`;
        const container = new ContainerBuilder().setAccentColor(AccentColor.Red).addTextDisplayComponents(
            new TextDisplayBuilder().setContent("## Timeout Issued"),
            new TextDisplayBuilder().setContent(
                renderFields([
                    { name: "Details", value: `${targetUser} has been placed in time out by ${moderator}.` },
                    { name: "Thread Link", value: `[Join the thread](${threadLink})` },
                ]),
            ),
        );
        await (notifChannel as TextChannel).send({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] },
        });
    } catch (error) {
        console.error("Timeout Corner notification failed:", error);
        await client
            .logError("Timeout Corner notification failed", error instanceof Error ? error : String(error))
            .catch(() => undefined);
    }
}
