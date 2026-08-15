import { config as loadEnv } from "dotenv";
import { Server } from "http";
import { ActivityType, PresenceUpdateStatus, Message, Partials } from "discord.js";
import { KrytenClient } from "./classes/client";
import {
    getAutoResponder,
    getBetaClassifier,
    getImageFingerprintHandler,
    getMessageLogger,
    handleMessage,
    handleMessageDelete,
    handleMessageDeleteBulk,
    handleMessageUpdate,
    initFeatures,
} from "./handlers/messageHandler";
import { handleInteraction } from "./handlers/interactionRouter";
import { drainPendingSync } from "./handlers/editorHandler";
import { startHealthServer } from "./health";
import { ensureProposalService } from "./handlers/proposalHandler";

loadEnv();

const client = new KrytenClient({
    intents: ["Guilds", "GuildMessages", "GuildModeration", "MessageContent"],
    // Partials so messageDelete fires for messages no longer in cache
    // (crosspost warning cleanup needs deletes of older messages).
    partials: [Partials.Message, Partials.Channel],
});

// When an idle editor session is pruned, finish syncing any files an earlier
// partial save committed to GitHub but never registered as slash commands —
// otherwise they'd be silently orphaned (the poller can't heal that).
client.commandEditor.setPendingSyncDrainer(session => {
    void drainPendingSync(client, session).catch(error =>
        client.logError(
            "Draining editor pendingSync on eviction failed",
            error instanceof Error ? error : String(error),
        ),
    );
});

// A rejected login (revoked/invalid token, gateway unreachable) would otherwise
// surface only as an unhandled rejection and leave the process idling forever —
// the 'ready' handler never fires, so the health server never starts and nothing
// signals the failure. Fail fast so a supervisor can restart/alert.
client.login(process.env["DISCORD_TOKEN"]).catch(error => {
    console.error("FATAL: Discord login failed:", error instanceof Error ? error.message : error);
    process.exit(1);
});
// Command loading happens in the 'ready' handler below.

// Last-resort net: the interaction router and other async listeners are not
// awaited by discord.js, so a stray rejection (expired/already-acked token,
// transient 5xx) would otherwise terminate the process. Log and keep running,
// matching the bot's degrade-don't-crash posture.
process.on("unhandledRejection", reason => {
    console.error("Unhandled promise rejection:", reason);
    void client
        .logError("Unhandled promise rejection", reason instanceof Error ? reason : String(reason))
        .catch(() => undefined);
});

let healthServer: Server | undefined;

client.on("ready", async () => {
    // Start the health endpoint before the fallible load/register sequence:
    // the external dashboard needs it most exactly when startup is broken —
    // a load failure below must not leave it connection-refused. Guarded so a
    // re-emitted ready (gateway re-identify) doesn't orphan the first server.
    if (!healthServer) {
        // A non-numeric/out-of-range HEALTH_PORT would make server.listen throw
        // ERR_SOCKET_BAD_PORT synchronously and abort the whole ready handler
        // (feature init, command registration, poller). Validate and fall back.
        const parsedPort = Number(process.env["HEALTH_PORT"]);
        const healthPort = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 9010;
        if (process.env["HEALTH_PORT"] && healthPort !== parsedPort) {
            console.warn(`Invalid HEALTH_PORT "${process.env["HEALTH_PORT"]}"; falling back to ${healthPort}.`);
        }
        healthServer = startHealthServer(client, healthPort);
    }

    // Stateful features that cannot initialize (encrypted interaction state,
    // fingerprint DB) fail startup instead of processing with missing state.
    try {
        await initFeatures(client);
    } catch (error) {
        console.error("FATAL: feature initialization failed:", error instanceof Error ? error.message : error);
        process.exit(1);
    }

    try {
        console.log("Client ready, loading commands...");
        // Load built-in commands first
        await client.commands.loadClasses();
        console.log("Built-in commands loaded.");

        // Load context-menu (right-click) commands
        await client.contexts.loadClasses();
        console.log("Context-menu commands loaded.");

        // Load custom commands from GitHub
        try {
            await client.loadCustomCommands();
        } catch (error) {
            console.error("Failed to load custom commands during startup:", error);
            console.log("Bot will continue with built-in commands only.");

            // Log startup errors
            await client.logError("Startup Command Load Failed", error instanceof Error ? error : String(error), false);
        }

        // Set presence after commands are potentially loaded
        client.user?.setPresence({
            activities: [{ type: ActivityType.Listening, name: "to your questions" }],
            status: PresenceUpdateStatus.DoNotDisturb,
        });
        console.log(`Presence set. Bot is ready! Logged in as ${client.user?.tag}`);

        // Register application commands (both built-in and custom)
        try {
            console.log(
                `Registering application commands (${client.commands.loaded_classes.size} built-in, ${client.contexts.loaded_classes.size} context-menu, ${client.custom_commands.length} custom)...`,
            );
            if (client.commandSync.lastLoadSource === "none") {
                // The custom corpus could not be loaded (GitHub down/unconfigured
                // AND no usable snapshot). Registering the empty corpus would
                // deregister every custom command Discord kept from a prior run —
                // preserve them and only (re)register built-ins + contexts.
                await client.registerBuiltinsPreservingCustom();
            } else {
                await client.registerApplicationCommands();
            }
            console.log("Application commands registered successfully.");
        } catch (error) {
            console.error("Failed to register commands with Discord:", error);
            // The bot can still function, just without slash commands
            console.log("Bot will continue but slash commands may not work properly.");

            // The corpus loaded and its digest was adopted, so the poller
            // would see "no change" forever — hand the failure to its
            // per-tick retry. Skip the "none" fallback case: its retry path
            // (registerApplicationCommands) would push an empty custom corpus
            // and deregister the commands Discord kept from a prior run.
            if (client.commandSync.lastLoadSource !== "none") {
                client.poller.markRegistrationPending();
            }

            await client.logError(
                "Discord Command Registration Failed",
                error instanceof Error ? error : String(error),
                true,
            );
        }

        // Poll the commands repo for external edits (LLM proposals landing via
        // GitHub, direct commits, PR merges) and hot-reload on change.
        client.poller.start();

        // LLM command-proposal review pipeline (opt-in via config + env key;
        // idempotent, so a re-emitted ready or /reload_config is safe).
        ensureProposalService(client);

        // Start the scam-image fingerprint hub sync loop (no-op unless the hub
        // is configured + the API key env is set). Local matching works without
        // it; this only pulls peer fingerprints in the background.
        getImageFingerprintHandler(client).startBackgroundTasks();
    } catch (error) {
        console.error("Critical error during ready event processing:", error);
        console.error("The bot may not function properly. Please check your configuration.");
        // Bot will still run but with limited functionality
    }
});

client.on("messageCreate", async (message: Message) => {
    await handleMessage(message, client).catch(console.error);
});

client.on("messageDelete", async message => {
    await handleMessageDelete(message, client).catch(console.error);
});

client.on("messageDeleteBulk", async messages => {
    await handleMessageDeleteBulk(messages, client).catch(console.error);
});

client.on("messageUpdate", async (oldMessage, newMessage) => {
    await handleMessageUpdate(oldMessage, newMessage, client).catch(console.error);
});

client.on("guildAuditLogEntryCreate", (entry, guild) => {
    getMessageLogger(client).recordAudit(entry, guild);
});

async function shutdown(signal: string): Promise<void> {
    console.log(`Received ${signal}, shutting down...`);
    // try/finally so a throw from any step (e.g. a feature constructed on
    // demand here failing) can't leave the process alive with its default
    // signal handling replaced — shutdown must always exit.
    try {
        client.poller.stop();
        client.proposalService?.stop();
        getImageFingerprintHandler(client).stop();
        const messageLogger = getMessageLogger(client);
        messageLogger.stop();
        const betaClassifier = getBetaClassifier(client);
        betaClassifier.stop();
        healthServer?.close();
        // Ship queued log events BEFORE destroying the client: destroy() clears
        // the REST token, after which every send fails. A clean drain means no
        // send is in flight, so the SQLite handle can be closed; if the bound
        // elapsed instead, process.exit below preserves the durable outbox.
        const loggerDrained = await Promise.race([
            messageLogger.drain().then(() => true),
            new Promise<false>(resolve => {
                setTimeout(() => resolve(false), 5000).unref();
            }),
        ]);
        if (loggerDrained) messageLogger.close();
        // Destroy the client BEFORE flushing the greeter: the gateway stops
        // delivering messages, so a greeting completing mid-shutdown can't
        // queue a save behind the flush and lose it to process.exit.
        await client.destroy();
        await Promise.race([
            betaClassifier.drain(),
            new Promise<void>(resolve => {
                setTimeout(resolve, 5000).unref();
            }),
        ]);
        // Flush debounced interaction state before the unref'd timer dies.
        await Promise.race([
            getAutoResponder(client).flushNow(),
            new Promise<void>(resolve => {
                setTimeout(resolve, 5000).unref();
            }),
        ]);
    } finally {
        process.exit(0);
    }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

client.on("interactionCreate", async interaction => {
    await handleInteraction(interaction, client);
});
