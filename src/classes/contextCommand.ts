import {
    MessageContextMenuCommandInteraction,
    RESTPostAPIContextMenuApplicationCommandsJSONBody,
    UserContextMenuCommandInteraction,
} from "discord.js";
import { KrytenClient } from "./client";

export type ContextMenuInteraction = MessageContextMenuCommandInteraction | UserContextMenuCommandInteraction;

export interface ContextCommandInitOptions {
    name: string;
    command_data: RESTPostAPIContextMenuApplicationCommandsJSONBody;
    staff_only?: boolean;
}

/**
 * Base class for context-menu (right-click) commands. Mirrors {@link Command}
 * but carries a context-menu interaction instead of a chat-input one.
 */
export class ContextCommand {
    name: string;
    commandData: RESTPostAPIContextMenuApplicationCommandsJSONBody;
    staff_only: boolean;

    constructor(options: ContextCommandInitOptions) {
        this.name = options.name;
        this.commandData = options.command_data;
        this.staff_only = options.staff_only ?? false;
    }

    async run(_interaction: ContextMenuInteraction, _client: KrytenClient): Promise<any> {
        throw new Error("You need to override the base run method");
    }
}
