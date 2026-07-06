import { Channel } from "discord.js";

/**
 * True if `channelId` is in `list`, or — when the message lives in a thread —
 * if the thread's parent channel is in `list`. A message inside a thread carries
 * the thread's own id as `channelId`, so a bare `list.includes(channelId)` would
 * miss threads under a listed channel. Used for the moderation channel blacklist.
 */
export function channelOrParentListed(channel: Channel | null | undefined, channelId: string, list: string[]): boolean {
    if (list.includes(channelId)) return true;
    if (channel && channel.isThread() && channel.parentId) return list.includes(channel.parentId);
    return false;
}
