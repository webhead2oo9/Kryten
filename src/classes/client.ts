import {
    ApplicationCommandDataResolvable,
    ApplicationCommandOptionType,
    ApplicationCommandType,
    Client,
    ClientOptions,
    ContainerBuilder,
    MessageFlags,
    SeparatorBuilder,
    TextDisplayBuilder,
    Webhook,
    TextChannel,
} from "discord.js";
import { readFileSync } from "fs";
import { Store } from "../stores/store";
import { Commands, Config, StoreTypes } from "../types";
import { join } from "path";
import { CustomCommandEditor } from "./customCommandEditor";
import { CommandSync } from "../github/commandSync";
import { CommandPoller } from "../github/poller";
import type { ProposalService } from "../proposals/service";
import { AccentColor } from "../utils/cv2";
import { clampText } from "../utils/format";
import { validateConfig } from "../config/validate";

export class KrytenClient extends Client {
    commands: Store<StoreTypes.COMMANDS>;
    contexts: Store<StoreTypes.CONTEXTS>;
    config: Config;
    feedback_webhook?: Webhook;
    custom_commands: Commands;
    commandEditor: CustomCommandEditor;
    /** Per-command-file GitHub sync (loads, SHAs, digest, cache fallback). */
    commandSync: CommandSync;
    poller: CommandPoller;
    proposalService?: ProposalService;
    /** Product/persona name, surfaced on the health endpoint. */
    readonly name = "Kryten";
    version: string;
    commandsHandled: number;
    errorCount: number;
    lastErrorTime: string | null;
    /**
     * True when config.json could not be read/parsed and the bot is running on
     * an empty config. Staff gates already fail closed without staff_roles, but
     * the message pipeline checks this flag too — moderation features must not
     * run on defaults nobody configured (crosspost defaults to enabled and its
     * exact-match warning is public even in dry-run). Cleared by a successful
     * loadConfig() (e.g. /reload_config after fixing the file).
     */
    configLoadFailed = false;

    constructor(options: ClientOptions) {
        super(options);
        this.commands = new Store<StoreTypes.COMMANDS>({
            files_folder: "/commands",
            load_classes_on_init: false,
            storetype: StoreTypes.COMMANDS,
        });
        this.contexts = new Store<StoreTypes.CONTEXTS>({
            files_folder: "/contexts",
            load_classes_on_init: false,
            storetype: StoreTypes.CONTEXTS,
        });
        this.config = {};
        this.custom_commands = [];
        this.commandEditor = new CustomCommandEditor();
        this.commandSync = new CommandSync(this);
        this.poller = new CommandPoller(this);
        this.version = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")).version ?? "0.0.0";
        this.commandsHandled = 0;
        this.errorCount = 0;
        this.lastErrorTime = null;
        try {
            this.loadConfig();
        } catch (error) {
            console.error(
                `[config] ${error instanceof Error ? error.message : String(error)} — starting with empty config; the message pipeline is disabled until /reload_config succeeds.`,
            );
            this.config = {};
            this.configLoadFailed = true;
        }
    }

    loadConfig() {
        let raw: string;
        try {
            raw = readFileSync("./config.json", "utf-8");
        } catch (error) {
            throw new Error(
                `Could not read config.json (cwd: ${process.cwd()}): ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw) as unknown;
        } catch (error) {
            throw new Error(`config.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.config = validateConfig(parsed);
        this.configLoadFailed = false;
    }

    async logError(title: string, error: string | Error, critical: boolean = false): Promise<void> {
        this.errorCount++;
        this.lastErrorTime = new Date().toISOString();

        // Only log if error channel is configured
        if (!this.config.error_log_channel_id) {
            return;
        }

        try {
            const channel = await this.channels.fetch(this.config.error_log_channel_id).catch(() => null);
            if (!channel || !channel.isTextBased()) {
                console.error(`Error log channel ${this.config.error_log_channel_id} not found or not text-based`);
                return;
            }

            const message = error instanceof Error ? error.message : error;
            const container = new ContainerBuilder()
                .setAccentColor(critical ? AccentColor.Red : AccentColor.Amber)
                .addTextDisplayComponents(
                    new TextDisplayBuilder().setContent(
                        `## ${critical ? `🚨 Critical Error: ${title}` : `⚠️ Error: ${title}`}`,
                    ),
                    new TextDisplayBuilder().setContent(`\`\`\`${clampText(message, 1500)}\`\`\``),
                );

            // Add stack trace for Error objects
            if (error instanceof Error && error.stack) {
                const stackLines = error.stack.split("\n").slice(1, 4).join("\n");
                container
                    .addSeparatorComponents(new SeparatorBuilder())
                    .addTextDisplayComponents(
                        new TextDisplayBuilder().setContent(
                            `**Stack Trace**\n\`\`\`${clampText(stackLines, 1000)}\`\`\``,
                        ),
                    );
            }
            container.addTextDisplayComponents(
                new TextDisplayBuilder().setContent(`-# <t:${Math.floor(Date.now() / 1000)}:F>`),
            );

            await (channel as TextChannel).send({
                components: [container],
                flags: MessageFlags.IsComponentsV2,
                allowedMentions: { parse: [] },
            });
        } catch (err) {
            // Don't let error logging errors crash the bot
            console.error("Failed to log error to Discord channel:", err);
        }
    }

    /** Whether a name is backed by a loaded built-in chat command. */
    isBuiltinCommandName(name: string): boolean {
        return this.commands.loaded_classes.has(name);
    }

    /** Slash-command payload for the current custom commands. */
    buildCustomCommandPayload(): ApplicationCommandDataResolvable[] {
        // Final guard against a name that also backs a built-in: a duplicate
        // (type:1, name) makes application.commands.set 400 the whole batch.
        // loadAll already filters these, but a colliding command reaching the
        // live set by any other path would take down every slash command.
        return this.custom_commands
            .filter(c => {
                if (this.commands.loaded_classes.has(c.name)) {
                    console.error(`Excluding custom command '${c.name}' from registration: collides with a built-in.`);
                    return false;
                }
                return true;
            })
            .map(c => ({
                type: ApplicationCommandType.ChatInput,
                name: c.name,
                description: c.description,
                options: [
                    {
                        type: ApplicationCommandOptionType.Boolean,
                        name: "hidden",
                        description: "Reply privately to the invoker",
                    },
                ],
            }));
    }

    /**
     * Register built-in + context-menu + custom commands as guild commands.
     * No-ops (with a warning) when the application or GUILD_ID is unavailable so
     * we never accidentally register globally.
     */
    async registerApplicationCommands(): Promise<void> {
        const guildId = process.env["GUILD_ID"];
        if (!this.application || !guildId) {
            console.warn("Skipping command registration: missing client.application or GUILD_ID.");
            return;
        }
        const payload: ApplicationCommandDataResolvable[] = [
            ...this.commands.createPostBody(),
            ...this.contexts.createPostBody(),
            ...this.buildCustomCommandPayload(),
        ];
        await this.application.commands.set(payload, guildId);
    }

    /**
     * Startup-only registration for when the custom corpus could not be loaded
     * (`lastLoadSource === "none"`: GitHub unreachable/unconfigured AND no usable
     * snapshot). Registering the empty in-memory corpus would deregister every
     * custom command Discord persisted from a prior run — the same invariant the
     * poller and /reload_commands guard, which the unconditional startup register
     * used to violate. Instead register built-ins + contexts and PRESERVE the
     * custom chat-input commands already registered on Discord. On a genuine
     * first boot the fetch simply returns nothing custom, so built-ins still
     * register normally.
     */
    async registerBuiltinsPreservingCustom(): Promise<void> {
        const guildId = process.env["GUILD_ID"];
        if (!this.application || !guildId) {
            console.warn("Skipping command registration: missing client.application or GUILD_ID.");
            return;
        }
        let preservedCustom: ApplicationCommandDataResolvable[];
        try {
            const existing = await this.application.commands.fetch({ guildId });
            preservedCustom = existing
                .filter(
                    cmd => cmd.type === ApplicationCommandType.ChatInput && !this.commands.loaded_classes.has(cmd.name),
                )
                .map(cmd => ({
                    type: ApplicationCommandType.ChatInput,
                    name: cmd.name,
                    description: cmd.description,
                    options: [
                        {
                            type: ApplicationCommandOptionType.Boolean,
                            name: "hidden",
                            description: "Reply privately to the invoker",
                        },
                    ],
                }));
        } catch (error) {
            // Can't read the current set — leave registration entirely untouched
            // rather than risk wiping live custom commands. Built-ins from a prior
            // run stay as-is; a genuine first boot in this state has none anyway.
            console.error(
                "Could not fetch existing guild commands to preserve custom commands; leaving registration unchanged:",
                error,
            );
            return;
        }
        if (preservedCustom.length) {
            console.warn(
                `Custom corpus unavailable (source "none"); preserving ${preservedCustom.length} custom command(s) already registered on Discord instead of deregistering them.`,
            );
        }
        const payload: ApplicationCommandDataResolvable[] = [
            ...this.commands.createPostBody(),
            ...this.contexts.createPostBody(),
            ...preservedCustom,
        ];
        await this.application.commands.set(payload, guildId);
    }

    /**
     * Re-register slash commands only when the registration payload actually
     * changed — it depends solely on each custom command's (name, description).
     * Gates the poller and proposal-approve paths so hourly polls and
     * embed-only edits don't hammer application.commands.set.
     * Returns whether a re-registration happened.
     */
    async registerIfChanged(previous: Commands): Promise<boolean> {
        const signature = (commands: Commands): string =>
            JSON.stringify(
                commands.map(c => [c.name, c.description] as const).sort((a, b) => a[0].localeCompare(b[0])),
            );
        if (signature(previous) === signature(this.custom_commands)) return false;
        await this.registerApplicationCommands();
        return true;
    }

    /** Load the custom-command corpus (GitHub → snapshot → empty). */
    async loadCustomCommands(): Promise<Commands> {
        return this.commandSync.loadAll();
    }
}
