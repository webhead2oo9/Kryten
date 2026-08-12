import type { Message } from "discord.js";
import type { KrytenClient } from "../../classes/client";
import type { BetaClassifierConfig, LlmClassifierConfig } from "../../types";
import { memberHasStaffRole } from "../../utils/staff";
import { channelOrParentListed } from "../../utils/channels";
import { LlmClassifier } from "../../llm/classifier";
import { ClassificationLogger } from "../../llm/classificationLogger";
import { betaCandidateDecision } from "./candidateGate";
import { buildClassificationTranscript, TranscriptMessage } from "./context";
import { loadBetaClassifierPrompt } from "./promptFile";

const LABELS = ["ROUTE", "IGNORE"] as const;
const CONTINUATION = /^(?:also\b|same\b|same here\b|same issue\b|me too\b|this too\b|that too\b)/i;

export interface BetaClassifierMetrics {
    messagesSeen: number;
    candidates: number;
    submitted: number;
    route: number;
    ignore: number;
    providerFallbacks: number;
    contextFetchFailures: number;
    promptLoadFailures: number;
    responsesSent: number;
    responseFailures: number;
    pending: number;
    responseEnabled: boolean;
    promptVersion: string | null;
}

interface BuiltContext {
    transcript: string;
    referencedParent?: Message;
}

export class BetaClassifier {
    private stopped = false;
    private promptVersion: string | null = null;
    private readonly pending = new Set<Promise<void>>();
    private readonly metrics = {
        messagesSeen: 0,
        candidates: 0,
        submitted: 0,
        route: 0,
        ignore: 0,
        providerFallbacks: 0,
        contextFetchFailures: 0,
        promptLoadFailures: 0,
        responsesSent: 0,
        responseFailures: 0,
    };

    constructor(
        private readonly client: KrytenClient,
        private readonly classifier: LlmClassifier,
        private readonly classificationLogger: ClassificationLogger,
    ) {}

    async process(message: Message): Promise<void> {
        try {
            const config = this.client.config.beta_classifier;
            const llmConfig = this.client.config.llm_classifier;
            if (!this.isEligible(message, config) || !llmConfig?.enabled) return;
            this.metrics.messagesSeen++;

            const decision = betaCandidateDecision(message.content);
            const referencedContinuation =
                !decision.candidate && CONTINUATION.test(message.content.trim()) && !!message.reference?.messageId;
            if (!decision.candidate && !referencedContinuation) return;
            this.metrics.candidates++;

            const task = this.classify(message, config!, llmConfig, referencedContinuation);
            this.pending.add(task);
            void task.then(
                () => this.pending.delete(task),
                () => this.pending.delete(task),
            );
        } catch {
            this.metrics.providerFallbacks++;
        }
    }

    getMetrics(): BetaClassifierMetrics {
        return {
            ...this.metrics,
            pending: this.pending.size,
            responseEnabled: this.client.config.beta_classifier?.response_enabled ?? false,
            promptVersion: this.promptVersion,
        };
    }

    async drain(): Promise<void> {
        await Promise.allSettled([...this.pending]);
        await this.classifier.drain();
    }

    stop(): void {
        this.stopped = true;
        this.classifier.close();
    }

    private isEligible(message: Message, config: BetaClassifierConfig | undefined): boolean {
        if (this.stopped) return false;
        if (!config?.enabled) return false;
        if (message.author.bot) return false;
        if (!config.guild_id || message.guildId !== config.guild_id) return false;
        if (!message.member) return false;
        if (!channelOrParentListed(message.channel, message.channelId, config.watched_channel_ids ?? [])) return false;
        if (channelOrParentListed(message.channel, message.channelId, [config.target_channel_id ?? ""])) return false;
        if (memberHasStaffRole(message.member, this.client.config)) return false;
        return true;
    }

    private async classify(
        message: Message,
        acceptedConfig: BetaClassifierConfig,
        acceptedLlmConfig: LlmClassifierConfig,
        referencedContinuation: boolean,
    ): Promise<void> {
        try {
            this.metrics.submitted++;
            const result = await this.classifier.classifyLazy(
                "IGNORE",
                async () => {
                    if (!this.isAuthorized(message, acceptedConfig, acceptedLlmConfig)) return null;
                    let prompt;
                    try {
                        prompt = await loadBetaClassifierPrompt(acceptedConfig.prompt_file!);
                    } catch {
                        this.metrics.promptLoadFailures++;
                        return null;
                    }
                    this.promptVersion = prompt.version;
                    const context = await this.contextFor(message, acceptedConfig);
                    if (!context) return null;
                    if (
                        referencedContinuation &&
                        (!context.referencedParent ||
                            !betaCandidateDecision(`${context.referencedParent.content}\n${message.content}`).candidate)
                    ) {
                        return null;
                    }
                    return {
                        systemInstruction: prompt.systemInstruction,
                        input: context.transcript,
                        allowedLabels: LABELS,
                        fallbackLabel: "IGNORE",
                    };
                },
                () => this.isAuthorized(message, acceptedConfig, acceptedLlmConfig),
            );
            if (result.status !== "ok") this.metrics.providerFallbacks++;
            if (result.label === "ROUTE") this.metrics.route++;
            else this.metrics.ignore++;

            const isAuthorized = () => this.isAuthorized(message, acceptedConfig, acceptedLlmConfig);
            await this.classificationLogger.log(message, result, isAuthorized);

            if (
                result.status === "ok" &&
                result.label === "ROUTE" &&
                acceptedConfig.response_enabled &&
                isAuthorized()
            ) {
                try {
                    await message.reply({
                        content: `This looks related to the current Quest beta. Please continue in <#${acceptedConfig.target_channel_id}> and make sure both the headset Beta channel and Beta Streamer are installed.\n${acceptedConfig.announcement_url}`,
                        allowedMentions: { parse: [], repliedUser: false },
                    });
                    this.metrics.responsesSent++;
                } catch {
                    this.metrics.responseFailures++;
                }
            }
        } catch {
            this.metrics.providerFallbacks++;
        }
    }

    private isAuthorized(message: Message, betaConfig: BetaClassifierConfig, llmConfig: LlmClassifierConfig): boolean {
        return (
            this.client.config.beta_classifier === betaConfig &&
            this.client.config.llm_classifier === llmConfig &&
            llmConfig.enabled === true &&
            this.isEligible(message, betaConfig)
        );
    }

    private async contextFor(message: Message, config: BetaClassifierConfig): Promise<BuiltContext | null> {
        const maxMessages = config.max_context_messages ?? 25;
        const messages = new Map<string, Message>([[message.id, message]]);
        if (maxMessages > 1) {
            try {
                const history = await message.channel.messages.fetch({
                    before: message.id,
                    limit: maxMessages - 1,
                    cache: false,
                });
                for (const historical of history.values()) {
                    if (historical.guildId === message.guildId && historical.channelId === message.channelId) {
                        messages.set(historical.id, historical);
                    }
                }
            } catch {
                this.metrics.contextFetchFailures++;
            }
        }

        const referencedParentId = message.reference?.messageId;
        let referencedParent = referencedParentId ? messages.get(referencedParentId) : undefined;
        if (referencedParentId && !messages.has(referencedParentId)) {
            try {
                const referenced = await message.fetchReference();
                if (referenced.guildId === message.guildId && referenced.channelId === message.channelId) {
                    messages.set(referenced.id, referenced);
                    referencedParent = referenced;
                }
            } catch {
                this.metrics.contextFetchFailures++;
            }
        }

        const transcriptMessages: TranscriptMessage[] = [...messages.values()].map(item => {
            const transcriptMessage: TranscriptMessage = {
                id: item.id,
                authorId: item.author.id,
                content: item.content,
                createdTimestamp: item.createdTimestamp,
                isBot: item.author.bot,
                isStaff: memberHasStaffRole(item.member, this.client.config),
            };
            if (item.reference?.messageId) transcriptMessage.replyToId = item.reference.messageId;
            return transcriptMessage;
        });
        const transcript = buildClassificationTranscript(transcriptMessages, message.id, {
            maxMessages,
            maxCharacters: config.max_context_characters ?? 40_000,
            referencedParentId,
            channelLabels: config.target_channel_id ? { [config.target_channel_id]: "beta-testing" } : {},
        });
        return transcript ? { transcript, referencedParent } : null;
    }
}
