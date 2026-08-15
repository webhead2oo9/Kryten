import { ContainerBuilder, GuildMember, MessageFlags, TextChannel } from "discord.js";
import { KrytenClient } from "../../classes/client";
import { markInternalMessageDelete } from "../messageLogging/messageLogger";

/**
 * Reusable moderation-action toolkit. Each action is self-contained, returns a
 * structured result (never throws), and is shared across features — this is the
 * seam to extend when adding new small mod actions (warn, purge, role-strip…).
 */

export interface ActionResult {
    ok: boolean;
    detail: string;
}

export async function timeoutMember(member: GuildMember, minutes: number, reason: string): Promise<ActionResult> {
    try {
        await member.timeout(minutes * 60 * 1000, reason);
        return { ok: true, detail: `${minutes}min timeout` };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, detail: `Timeout failed - ${detail}` };
    }
}

export async function kickMember(member: GuildMember, reason: string): Promise<ActionResult> {
    try {
        await member.kick(reason);
        return { ok: true, detail: "User kicked" };
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { ok: false, detail: `Kick failed - ${detail}` };
    }
}

/** Delete a message by id without needing it cached. Returns true if removed. */
export async function deleteMessageById(client: KrytenClient, channelId: string, messageId: string): Promise<boolean> {
    try {
        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel || !channel.isTextBased()) return false;
        const message = await channel.messages.fetch(messageId).catch(() => null);
        if (!message) return false;
        const clearDeleteMarker = markInternalMessageDelete(client, messageId, "moderation action");
        await message.delete().catch(error => {
            clearDeleteMarker();
            throw error;
        });
        return true;
    } catch {
        return false;
    }
}

/** Send a Components-V2 container to a configured moderator alert channel. Returns true if sent. */
export async function sendModAlert(
    client: KrytenClient,
    channelId: string,
    container: ContainerBuilder,
): Promise<boolean> {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return false;
    try {
        await (channel as TextChannel).send({
            components: [container],
            flags: MessageFlags.IsComponentsV2,
            allowedMentions: { parse: [] },
        });
        return true;
    } catch {
        return false;
    }
}
