import { Message, PartialMessage } from "discord.js";
import { KrytenClient } from "../classes/client";

/**
 * A pluggable message-pipeline feature. Add a new feature (e.g. a small mod
 * action) by appending one entry to the registry in handlers/messageHandler.ts.
 * Errors thrown from the hooks are caught centrally and routed to logError.
 */
export interface Feature {
    name: string;
    /** Optional gate; if it returns false the feature is skipped for this event. */
    enabled?(client: KrytenClient): boolean;
    /**
     * Resolve `true` to stop the pipeline for this message — e.g. enforcement
     * deleted it, so later features must not track or act on it. `void`/`false`
     * continues to the next feature.
     */
    onMessage?(message: Message, client: KrytenClient): Promise<void | boolean>;
    onMessageDelete?(message: Message | PartialMessage, client: KrytenClient): Promise<void>;
}
