import { TextChannel, type Message } from "discord.js";
import type { KrytenClient } from "../../classes/client";
import type { BetaClassifierConfig, LlmClassifierConfig } from "../../types";
import type { LlmClassifier } from "../../llm/classifier";
import type { ClassificationLogger } from "../../llm/classificationLogger";
import { buildClassificationTranscript, type TranscriptMessage } from "../betaClassifier/context";
import { loadBetaClassifierPrompt } from "../betaClassifier/promptFile";
import {
    BETA_GREETING_ID,
    classifierCampaignIsActive,
    type ClassifierCampaign,
    type UserInteractionStore,
} from "../userInteractions/store";

const DEFAULT_DELETE_AFTER_SECONDS = 45;
const RETENTION_LABELS = ["KEEP", "DELETE"] as const;
const MAX_RETENTION_CONTEXT_MESSAGES = 2;
const MAX_RETENTION_CONTEXT_CHARACTERS = 10_000;
const MAX_DELETE_ATTEMPTS = 3;
const DELETE_RETRY_DELAYS_MS = [250, 1_000] as const;

interface ActiveGreeting {
    readonly userId: string;
    readonly generation: number;
    readonly greeting: Message;
    readonly betaConfig: BetaClassifierConfig;
    readonly campaign: ClassifierCampaign;
    readonly messages: Message[];
    readonly timer: NodeJS.Timeout;
    readonly expiresAt: number;
    readonly llmConfig?: LlmClassifierConfig;
    classificationInFlight: boolean;
    rerunTarget?: Message;
    deletion?: Promise<void>;
}

export interface BetaResponderMetrics {
    greetingsSent: number;
    kept: number;
    deleted: number;
    deletionRetries: number;
    deletionFailures: number;
    submitted: number;
    keep: number;
    delete: number;
    classifierFallbacks: number;
    promptLoadFailures: number;
    ignoredLateKeeps: number;
    ignoredStaleKeeps: number;
    pendingGreetings: number;
    pendingClassifications: number;
    pendingDeletions: number;
    promptVersion: string | null;
    retentionEnabled: boolean;
}

export class BetaResponder {
    private stopped = false;
    private readonly greetingsInFlight = new Set<string>();
    private readonly activeGreetings = new Map<string, ActiveGreeting>();
    private readonly pendingProcesses = new Set<Promise<void>>();
    private readonly pendingClassifications = new Set<Promise<void>>();
    private readonly pendingDeletions = new Set<Promise<void>>();
    private promptVersion: string | null = null;
    private readonly metrics = {
        greetingsSent: 0,
        kept: 0,
        deleted: 0,
        deletionRetries: 0,
        deletionFailures: 0,
        submitted: 0,
        keep: 0,
        delete: 0,
        classifierFallbacks: 0,
        promptLoadFailures: 0,
        ignoredLateKeeps: 0,
        ignoredStaleKeeps: 0,
    };

    constructor(
        private readonly client: KrytenClient,
        private readonly interactions: UserInteractionStore,
        private readonly classifier: LlmClassifier,
        private readonly classificationLogger: ClassificationLogger,
    ) {}

    async process(message: Message): Promise<void> {
        if (this.stopped) return;
        const task = this.processMessage(message);
        this.pendingProcesses.add(task);
        try {
            await task;
        } finally {
            this.pendingProcesses.delete(task);
        }
    }

    getMetrics(): BetaResponderMetrics {
        return {
            ...this.metrics,
            pendingGreetings: this.activeGreetings.size,
            pendingClassifications: this.pendingClassifications.size,
            pendingDeletions: this.pendingDeletions.size,
            promptVersion: this.promptVersion,
            retentionEnabled: this.retentionEnabled(),
        };
    }

    async drain(): Promise<void> {
        while (
            this.pendingProcesses.size > 0 ||
            this.pendingClassifications.size > 0 ||
            this.pendingDeletions.size > 0
        ) {
            await Promise.allSettled([
                ...this.pendingProcesses,
                ...this.pendingClassifications,
                ...this.pendingDeletions,
            ]);
        }
    }

    async stop(): Promise<void> {
        this.stopped = true;
        for (const active of [...this.activeGreetings.values()]) this.beginDeletion(active);
        await this.drain();
    }

    private async processMessage(message: Message): Promise<void> {
        const config = this.client.config.beta_classifier;
        if (!config?.target_greeting_enabled || message.author.bot) return;
        if (message.channelId !== config.target_channel_id || !config.announcements_channel_id) return;
        const campaign = this.campaign(config.campaign_id, config.campaign_started_at);
        if (!campaign || !classifierCampaignIsActive(campaign)) return;

        const userId = message.author.id;
        const active = this.activeGreetings.get(userId);
        if (active) {
            if (this.retentionIsAuthorized(active)) {
                if (active.messages.length >= MAX_RETENTION_CONTEXT_MESSAGES) return;
                active.messages.push(message);
                if (active.classificationInFlight) active.rerunTarget = message;
                else this.startClassification(active, message);
            }
            return;
        }

        const snapshot = await this.interactions.getCampaignGreeting(userId, BETA_GREETING_ID);
        if (this.stopped || !this.isAuthorized(message, config, campaign)) return;
        if (snapshot.record?.campaignId === campaign.campaignId || this.greetingsInFlight.has(userId)) return;

        this.greetingsInFlight.add(userId);
        try {
            const greeting = await (message.channel as TextChannel).send({
                content:
                    `Welcome, <@${userId}>! Direct USB support and the 15-minute stream restart are still in Beta. ` +
                    `To opt in, switch Virtual Desktop on your Quest to the **BETA** release channel; a separate ` +
                    `Beta Streamer installation is no longer required. For the latest information, check ` +
                    `<#${config.announcements_channel_id}>.`,
                allowedMentions: { parse: [], users: [userId] },
            });
            this.metrics.greetingsSent++;
            const activeGreeting = this.trackGreeting(greeting, message, config, campaign, snapshot.generation);
            if (this.stopped) {
                this.beginDeletion(activeGreeting);
                return;
            }

            const stored = await this.interactions.setCampaignGreeting(
                userId,
                BETA_GREETING_ID,
                { campaignId: campaign.campaignId },
                snapshot.generation,
            );
            if (!stored) {
                this.beginDeletion(activeGreeting);
                return;
            }
            if (this.retentionIsAuthorized(activeGreeting)) this.startClassification(activeGreeting, message);
        } finally {
            this.greetingsInFlight.delete(userId);
        }
    }

    private campaign(campaignId: string | undefined, startedAt: string | undefined): ClassifierCampaign | null {
        if (!campaignId || !startedAt) return null;
        return { classifierId: BETA_GREETING_ID, campaignId, startedAt };
    }

    private isAuthorized(message: Message, config: BetaClassifierConfig, campaign: ClassifierCampaign): boolean {
        return (
            !this.stopped &&
            this.client.config.beta_classifier === config &&
            config.target_greeting_enabled === true &&
            message.channelId === config.target_channel_id &&
            classifierCampaignIsActive(campaign)
        );
    }

    private retentionEnabled(): boolean {
        const config = this.client.config.beta_classifier;
        return Boolean(
            !this.stopped &&
            config?.target_greeting_enabled &&
            config.target_greeting_retention_enabled &&
            config.target_greeting_prompt_file &&
            this.client.config.llm_classifier?.enabled,
        );
    }

    private trackGreeting(
        greeting: Message,
        source: Message,
        config: BetaClassifierConfig,
        campaign: ClassifierCampaign,
        generation: number,
    ): ActiveGreeting {
        const afterSeconds = config.target_greeting_delete_after_seconds ?? DEFAULT_DELETE_AFTER_SECONDS;
        const createdAt = Date.now();
        const deleteAfterMs = afterSeconds * 1_000;
        const userId = source.author.id;
        const holder: { active?: ActiveGreeting } = {};
        const timer = setTimeout(() => {
            if (holder.active) this.beginDeletion(holder.active);
        }, deleteAfterMs);
        timer.unref();
        const active: ActiveGreeting = {
            userId,
            generation,
            greeting,
            betaConfig: config,
            campaign,
            messages: [source],
            timer,
            expiresAt: createdAt + deleteAfterMs,
            llmConfig: this.client.config.llm_classifier,
            classificationInFlight: false,
        };
        holder.active = active;
        this.activeGreetings.set(userId, active);
        return active;
    }

    private startClassification(active: ActiveGreeting, target: Message): void {
        active.classificationInFlight = true;
        const task = this.classify(active, target)
            .catch(() => {
                this.metrics.classifierFallbacks++;
            })
            .finally(() => {
                active.classificationInFlight = false;
                const rerunTarget = active.rerunTarget;
                active.rerunTarget = undefined;
                if (rerunTarget && this.retentionIsAuthorized(active)) this.startClassification(active, rerunTarget);
            });
        this.pendingClassifications.add(task);
        void task.then(
            () => this.pendingClassifications.delete(task),
            () => this.pendingClassifications.delete(task),
        );
    }

    private async classify(active: ActiveGreeting, target: Message): Promise<void> {
        this.metrics.submitted++;
        const result = await this.classifier.classifyLazy(
            "DELETE",
            async () => {
                if (!this.retentionIsAuthorized(active)) return null;
                let prompt;
                try {
                    prompt = await loadBetaClassifierPrompt(active.betaConfig.target_greeting_prompt_file!);
                } catch {
                    this.metrics.promptLoadFailures++;
                    return null;
                }
                if (!this.retentionIsAuthorized(active)) return null;
                this.promptVersion = prompt.version;
                const transcript = this.transcript(active.messages, target);
                if (!transcript) return null;
                return {
                    systemInstruction: prompt.systemInstruction,
                    input: transcript,
                    allowedLabels: RETENTION_LABELS,
                    fallbackLabel: "DELETE",
                };
            },
            () => this.retentionIsAuthorized(active),
        );
        if (result.status !== "ok") this.metrics.classifierFallbacks++;
        if (result.label === "KEEP") this.metrics.keep++;
        else this.metrics.delete++;

        let keepApplied = false;
        const authorized = () =>
            keepApplied
                ? this.configurationIsCurrent(active) &&
                  this.interactions.isUserGeneration(active.userId, active.generation)
                : this.retentionIsAuthorized(active);
        if (result.status === "ok" && result.label === "KEEP" && Date.now() >= active.expiresAt) {
            this.metrics.ignoredLateKeeps++;
        } else if (result.status === "ok" && result.label === "KEEP" && this.retentionIsAuthorized(active)) {
            clearTimeout(active.timer);
            if (this.activeGreetings.get(active.userId) === active) this.activeGreetings.delete(active.userId);
            this.metrics.kept++;
            keepApplied = true;
        } else if (result.status === "ok" && result.label === "KEEP") {
            this.metrics.ignoredStaleKeeps++;
        }
        await this.classificationLogger.log(target, result, authorized, { includeRawOutput: false });
    }

    private retentionIsAuthorized(active: ActiveGreeting): boolean {
        return (
            this.activeGreetings.get(active.userId) === active &&
            Date.now() < active.expiresAt &&
            this.configurationIsCurrent(active) &&
            this.interactions.isUserGeneration(active.userId, active.generation)
        );
    }

    private configurationIsCurrent(active: ActiveGreeting): boolean {
        return (
            !this.stopped &&
            this.client.config.beta_classifier === active.betaConfig &&
            this.client.config.llm_classifier === active.llmConfig &&
            active.betaConfig.target_greeting_enabled === true &&
            active.betaConfig.target_greeting_retention_enabled === true &&
            active.llmConfig?.enabled === true &&
            classifierCampaignIsActive(active.campaign)
        );
    }

    private transcript(messages: readonly Message[], target: Message): string | null {
        const transcriptMessages: TranscriptMessage[] = messages.map(message => ({
            id: message.id,
            authorId: message.author.id,
            content: message.content,
            createdTimestamp: message.createdTimestamp,
            isBot: message.author.bot,
            isStaff: false,
        }));
        return buildClassificationTranscript(transcriptMessages, target.id, {
            maxMessages: MAX_RETENTION_CONTEXT_MESSAGES,
            maxCharacters: MAX_RETENTION_CONTEXT_CHARACTERS,
            channelLabels: { [target.channelId]: "beta-testing" },
        });
    }

    private beginDeletion(active: ActiveGreeting): Promise<void> {
        if (active.deletion) return active.deletion;
        clearTimeout(active.timer);
        if (this.activeGreetings.get(active.userId) === active) this.activeGreetings.delete(active.userId);
        const deletion = this.deleteGreeting(active.greeting).finally(() => this.pendingDeletions.delete(deletion));
        active.deletion = deletion;
        this.pendingDeletions.add(deletion);
        return deletion;
    }

    private async deleteGreeting(greeting: Message): Promise<void> {
        for (let attempt = 1; attempt <= MAX_DELETE_ATTEMPTS; attempt++) {
            try {
                await greeting.delete();
                this.metrics.deleted++;
                return;
            } catch (error) {
                if (discordErrorCode(error) === 10_008) {
                    this.metrics.deleted++;
                    return;
                }
                if (attempt < MAX_DELETE_ATTEMPTS) {
                    this.metrics.deletionRetries++;
                    await delay(DELETE_RETRY_DELAYS_MS[attempt - 1] ?? 0);
                }
            }
        }
        this.metrics.deletionFailures++;
    }
}

function discordErrorCode(error: unknown): number | undefined {
    if (!error || typeof error !== "object" || !("code" in error)) return undefined;
    return typeof error.code === "number" ? error.code : undefined;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => {
        const timer = setTimeout(resolve, milliseconds);
        timer.unref();
    });
}
