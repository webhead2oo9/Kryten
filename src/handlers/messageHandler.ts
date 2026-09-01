import { Message, PartialMessage } from "discord.js";
import { KrytenClient } from "../classes/client";
import { Feature } from "../features/feature";
import { handleModPing } from "../features/moderation/modPing";
import { CrosspostHandler, crosspostEnabled } from "../features/crosspost/crosspostHandler";
import { ImageFingerprintHandler, imageFingerprintEnabled } from "../features/imageFingerprint/imageFingerprintHandler";
import { AutoResponder } from "../features/autoresponder/autoResponder";
import { BetaClassifier } from "../features/betaClassifier/betaClassifier";
import { BetaResponder } from "../features/betaResponder/betaResponder";
import { handleTwitterLinks } from "../features/twitter/twitterHandler";
import { LlmClassifier } from "../llm/classifier";
import { ClassificationLogger } from "../llm/classificationLogger";
import { channelOrParentListed } from "../utils/channels";
import { UserInteractionStore } from "../features/userInteractions/store";

// Stateful handlers are built once; the registry is the single place to wire
// features into the message pipeline.
let crosspost: CrosspostHandler | null = null;
let imageFingerprint: ImageFingerprintHandler | null = null;
let autoResponder: AutoResponder | null = null;
let llmClassifier: LlmClassifier | null = null;
let classificationLogger: ClassificationLogger | null = null;
let betaClassifier: BetaClassifier | null = null;
let betaResponder: BetaResponder | null = null;
let userInteractions: UserInteractionStore | null = null;
let features: Feature[] | null = null;

function build(client: KrytenClient): void {
    crosspost = new CrosspostHandler(client);
    imageFingerprint = new ImageFingerprintHandler(client);
    userInteractions = new UserInteractionStore(client);
    autoResponder = new AutoResponder(client, userInteractions);
    llmClassifier = new LlmClassifier(() => client.config.llm_classifier);
    classificationLogger = new ClassificationLogger(client);
    betaClassifier = new BetaClassifier(client, llmClassifier, classificationLogger, userInteractions);
    betaResponder = new BetaResponder(client, userInteractions, llmClassifier, classificationLogger);

    features = [
        {
            // Scam-image fingerprinting: known-bad matches are actioned here and
            // image crossposts raise a staff review. Runs before text crosspost so
            // a known-bad image is deleted/enforced first.
            name: "image-fingerprint",
            enabled: c => imageFingerprintEnabled(c.config),
            // process() resolves true when enforcement deleted the message —
            // that stops the pipeline so crosspost never tracks a gone message.
            onMessage: message => imageFingerprint!.process(message),
        },
        {
            name: "mod-ping",
            enabled: c => !!c.config.moderation?.mod_role_id,
            onMessage: (message, c) => handleModPing(message, c),
        },
        {
            name: "beta-classifier",
            enabled: c => (c.config.beta_classifier?.enabled ?? false) && (c.config.llm_classifier?.enabled ?? false),
            onMessage: message => betaClassifier!.process(message),
        },
        {
            name: "beta-responder",
            enabled: c => c.config.beta_classifier?.target_greeting_enabled ?? false,
            onMessage: message => betaResponder!.process(message),
        },
        {
            name: "auto-responder",
            enabled: () => autoResponder!.isConfigured(),
            onMessage: message => autoResponder!.process(message),
        },
        {
            name: "crosspost",
            enabled: c => crosspostEnabled(c.config),
            onMessage: message => crosspost!.process(message),
            onMessageDelete: message => crosspost!.handleMessageDeletion(message),
        },
        {
            name: "twitter",
            enabled: c => !!c.config.twitter?.enabled,
            onMessage: (message, c) => handleTwitterLinks(message, c),
        },
    ];
}

function ensure(client: KrytenClient): Feature[] {
    if (!features) build(client);
    return features!;
}

/**
 * Eagerly construct all stateful feature handlers. An unreadable interaction
 * store or missing encryption key is fatal when the greeter or a persistent
 * classifier is enabled.
 */
export async function initFeatures(client: KrytenClient): Promise<void> {
    ensure(client);
    await userInteractions!.reconcileClassifierCampaigns();
}

/** Crosspost handler accessor (used by the health endpoint for metrics). */
export function getCrosspostHandler(client: KrytenClient): CrosspostHandler {
    ensure(client);
    return crosspost!;
}

/** Image-fingerprint handler accessor (health metrics + button routing). */
export function getImageFingerprintHandler(client: KrytenClient): ImageFingerprintHandler {
    ensure(client);
    return imageFingerprint!;
}

/** Greeter accessor (graceful shutdown flushes its debounced store write). */
export function getAutoResponder(client: KrytenClient): AutoResponder {
    ensure(client);
    return autoResponder!;
}

export function getLlmClassifier(client: KrytenClient): LlmClassifier {
    ensure(client);
    return llmClassifier!;
}

export function getClassificationLogger(client: KrytenClient): ClassificationLogger {
    ensure(client);
    return classificationLogger!;
}

export function getBetaClassifier(client: KrytenClient): BetaClassifier {
    ensure(client);
    return betaClassifier!;
}

export function getBetaResponder(client: KrytenClient): BetaResponder {
    ensure(client);
    return betaResponder!;
}

export function getUserInteractionStore(client: KrytenClient): UserInteractionStore {
    ensure(client);
    return userInteractions!;
}

/**
 * Central messageCreate pipeline: shared bot-author + channel-blacklist
 * short-circuits, then each enabled feature's onMessage hook, with errors
 * routed to logError so one feature can't take down the pipeline.
 */
export async function handleMessage(message: Message, client: KrytenClient): Promise<void> {
    if (message.author.bot) return;
    // config.json failed to load: don't run moderation features on defaults
    // nobody configured (crosspost defaults to enabled). Cleared by a
    // successful /reload_config.
    if (client.configLoadFailed) return;

    const blacklist = client.config.moderation?.channel_blacklist ?? [];
    if (channelOrParentListed(message.channel, message.channelId, blacklist)) return;

    for (const feature of ensure(client)) {
        if (!feature.onMessage) continue;
        try {
            if (feature.enabled && !feature.enabled(client)) continue;
            // A feature that handled the message terminally (e.g. deleted it
            // as a known scam image) stops the pipeline: later features must
            // not track, warn about, or act on a message that's gone.
            if ((await feature.onMessage(message, client)) === true) break;
        } catch (error) {
            await client
                .logError(
                    `Feature '${feature.name}' failed (onMessage)`,
                    error instanceof Error ? error : String(error),
                )
                .catch(() => undefined);
        }
    }
}

/** messageDelete / bulk-delete pipeline (e.g. crosspost warning cleanup). */
export async function handleMessageDelete(message: Message | PartialMessage, client: KrytenClient): Promise<void> {
    if (client.configLoadFailed) return;
    for (const feature of ensure(client)) {
        if (!feature.onMessageDelete) continue;
        try {
            if (feature.enabled && !feature.enabled(client)) continue;
            await feature.onMessageDelete(message, client);
        } catch (error) {
            await client
                .logError(
                    `Feature '${feature.name}' failed (onMessageDelete)`,
                    error instanceof Error ? error : String(error),
                )
                .catch(() => undefined);
        }
    }
}
