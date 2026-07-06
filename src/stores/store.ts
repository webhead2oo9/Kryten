import SuperMap from "@thunder04/supermap";
import { Command } from "../classes/command";
import { existsSync, readdirSync } from "fs";
import {
    ApplicationCommandData,
    AutocompleteInteraction,
    ChatInputCommandInteraction,
    MessageContextMenuCommandInteraction,
    UserContextMenuCommandInteraction,
} from "discord.js";
import { join } from "path";
import { StoreInitOptions, StoreTypes } from "../types";
import { ContextCommand } from "../classes/contextCommand";

/** The concrete entry class a Store holds, resolved from its StoreTypes tag. */
type StoreEntry<T extends StoreTypes> = T extends StoreTypes.COMMANDS ? Command : ContextCommand;

export class Store<T extends StoreTypes> {
    files_folder: string;
    loaded_classes: SuperMap<string, StoreEntry<T>>;
    storetype: StoreTypes;
    constructor(options: StoreInitOptions) {
        this.files_folder = options.files_folder;
        this.storetype = options.storetype;
        this.loaded_classes = new SuperMap<string, StoreEntry<T>>();
        if (options.load_classes_on_init && this.checkDirectory())
            this.loadClasses()
                .then(res => (this.loaded_classes = res))
                .catch(console.error);
    }

    checkDirectory() {
        return existsSync(join(__dirname, "../", this.files_folder));
    }

    async loadClasses(): Promise<SuperMap<string, StoreEntry<T>>> {
        if (!this.files_folder) throw new Error("No location for commands given");
        if (!this.checkDirectory()) throw new Error("Unable to find location");
        const files = readdirSync(join(__dirname, "../", this.files_folder)).filter(
            f => (f.endsWith(".js") || f.endsWith(".ts")) && !f.endsWith(".d.ts"),
        );
        const map = new SuperMap<string, StoreEntry<T>>();
        for (const command_file of files) {
            try {
                const command = new (require(
                    join(__dirname, "../", this.files_folder, command_file),
                ).default)() as StoreEntry<T>;
                map.set(command.name, command);
            } catch (error) {
                console.error(`Failed to load '${command_file}' from ${this.files_folder}:`, error);
            }
        }
        this.loaded_classes = map;
        console.log(`Loaded ${map.size} classes`);
        return map;
    }

    createPostBody(): ApplicationCommandData[] {
        if (this.storetype !== StoreTypes.COMMANDS && this.storetype !== StoreTypes.CONTEXTS) return [];
        const commands = (this.loaded_classes as SuperMap<string, Command>).map(c => c.commandData).filter(c => c);
        return commands as ApplicationCommandData[];
    }

    async getCommand(interaction: ChatInputCommandInteraction | AutocompleteInteraction): Promise<Command> {
        if (!this.loaded_classes.size) throw new Error("No commands loaded");
        if (this.storetype !== StoreTypes.COMMANDS) throw new Error("Wrong class type loaded");
        let command_name = interaction.commandName;
        if (interaction.options.getSubcommandGroup(false))
            command_name += `_${interaction.options.getSubcommandGroup()}`;
        if (interaction.options.getSubcommand(false)) command_name += `_${interaction.options.getSubcommand()}`;

        const command = this.loaded_classes.get(command_name);

        if (!command) throw new Error("Unable to find command");
        return command as Command;
    }

    async getContext(
        interaction: MessageContextMenuCommandInteraction | UserContextMenuCommandInteraction,
    ): Promise<ContextCommand> {
        if (!this.loaded_classes.size) throw new Error("No commands loaded");
        if (this.storetype !== StoreTypes.CONTEXTS) throw new Error("Wrong class type loaded");
        const command_name = interaction.commandName;

        const command = this.loaded_classes.get(command_name);

        if (!command) throw new Error("Unable to find context");
        return command as ContextCommand;
    }
}
