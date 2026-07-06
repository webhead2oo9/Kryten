import { ContainerBuilder, Message, TextChannel, TextDisplayBuilder } from "discord.js";
import { KrytenClient } from "../../classes/client";
import { AccentColor, renderFields } from "../../utils/cv2";
import { clampText } from "../../utils/format";
import { sendAlertWithGallery } from "../../utils/imageGallery";

// The alert itself re-pings the mod role, so without a per-user throttle a user
// repeatedly typing the mod mention generates unbounded real mod pings.
const MODPING_COOLDOWN_MS = 10_000;
const lastAlertByUser = new Map<string, number>();

function sweep(map: Map<string, number>, now: number, ttlMs: number): void {
    for (const [key, ts] of map) {
        if (now - ts > ttlMs) map.delete(key);
    }
}

/**
 * Detect explicit mentions of the configured moderator role and forward an
 * alert to the alert channel. The role must be mentionable, or the bot must
 * have "Mention All Roles" in the alert channel, for the ping to notify.
 *
 * Errors propagate to the feature registry, which routes them to logError.
 */
export async function handleModPing(message: Message, client: KrytenClient): Promise<void> {
    const mod = client.config.moderation;
    const modRoleId = mod?.mod_role_id;
    if (!modRoleId) return;
    if (!message.mentions.roles.has(modRoleId)) return;

    const guild = message.guild;
    if (!guild) return;

    const alertChannelId = mod?.alert_channel_id;
    const alertChannel = alertChannelId ? await client.channels.fetch(alertChannelId).catch(() => null) : null;
    if (!alertChannel || !alertChannel.isTextBased()) return;

    // Throttle per author so a user spamming the mod mention can't drive an
    // unbounded stream of mod-role pings through the bot.
    const now = Date.now();
    sweep(lastAlertByUser, now, MODPING_COOLDOWN_MS);
    const last = lastAlertByUser.get(message.author.id);
    if (last !== undefined && now - last < MODPING_COOLDOWN_MS) return;
    lastAlertByUser.set(message.author.id, now);

    const link = `https://discord.com/channels/${guild.id}/${message.channelId}/${message.id}`;
    // The mod-role ping lives in a TextDisplay; allowedMentions restricted to
    // that role keeps the author/channel mentions from pinging while still
    // notifying the mods.
    const buildContainer = () =>
        new ContainerBuilder().setAccentColor(AccentColor.Red).addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`<@&${modRoleId}>`),
            new TextDisplayBuilder().setContent("## Moderator Ping"),
            new TextDisplayBuilder().setContent(
                renderFields([
                    { name: "Alert", value: `Moderator role was pinged by ${message.author} in ${message.channel}` },
                    { name: "Message Content", value: clampText(message.content) },
                    { name: "Original Message", value: `[Jump to message](${link})` },
                ]) + `\n\n-# Message ID: ${message.id}`,
            ),
        );

    // Re-host the pinging message's images alongside the alert so mods see the
    // evidence even if the message is deleted before they look.
    await sendAlertWithGallery({
        channel: alertChannel as TextChannel,
        sourceMessage: message,
        filenamePrefix: "modping-image",
        buildContainer,
        allowedMentions: { roles: [modRoleId] },
        fallbackLogLabel: "Mod-ping",
    });
}
