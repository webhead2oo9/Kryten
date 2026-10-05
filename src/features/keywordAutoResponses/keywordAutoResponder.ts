import type { Message } from "discord.js";
import type { KrytenClient } from "../../classes/client";
import type { KeywordAutoResponseRule } from "../../types";
import { messageAuthorHasExemptRole } from "../../utils/staff";
import type { KeywordCooldownClaim, UserInteractionStore } from "../userInteractions/store";

export function containsLiteralKeyword(content: string, keyword: string): boolean {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu").test(content);
}

export class KeywordAutoResponder {
    private accepting = true;
    private drainExpired = false;
    private readonly activeMessageIds = new Set<string>();
    private readonly inFlight = new Set<Promise<void>>();

    constructor(
        private readonly client: KrytenClient,
        private readonly interactions: UserInteractionStore,
    ) {}

    isConfigured(): boolean {
        const config = this.client.config.keyword_auto_responses;
        if (!config?.enabled) return false;
        return !!config.rules?.length;
    }

    process(message: Message): Promise<boolean> {
        if (
            !this.accepting ||
            message.author.bot ||
            message.channel.isThread() ||
            !this.isConfigured() ||
            this.activeMessageIds.has(message.id)
        ) {
            return Promise.resolve(false);
        }
        const rules = this.matchingRules(message);
        if (!rules.length) return Promise.resolve(false);

        this.activeMessageIds.add(message.id);
        const work = this.processRules(message, rules);
        const tracked = work
            .then(
                () => undefined,
                () => undefined,
            )
            .finally(() => {
                this.activeMessageIds.delete(message.id);
                this.inFlight.delete(tracked);
            });
        this.inFlight.add(tracked);
        return work;
    }

    async stop(timeoutMs = 5_000): Promise<void> {
        this.accepting = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                Promise.all(this.inFlight),
                new Promise<void>(resolve => {
                    timer = setTimeout(() => {
                        this.drainExpired = true;
                        resolve();
                    }, timeoutMs);
                    timer.unref();
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }

    private async processRules(message: Message, rules: readonly KeywordAutoResponseRule[]): Promise<boolean> {
        const isStaff = await messageAuthorHasExemptRole(message, this.client.config, []);
        if (isStaff !== false) return false;

        for (const rule of rules) {
            const admission = await this.interactions.claimKeywordCooldown(message.author.id, rule.id);
            if (admission.status !== "acquired") continue;
            if (
                !this.ruleIsCurrent(rule) ||
                !this.interactions.isUserGeneration(message.author.id, admission.claim.generation) ||
                (this.drainExpired && !this.accepting)
            ) {
                await this.releaseAndLog(admission.claim);
                return false;
            }

            try {
                await message.reply({
                    content: rule.response.replaceAll("{user}", `<@${message.author.id}>`),
                    allowedMentions: { parse: [], users: [message.author.id], repliedUser: false },
                });
                return true;
            } catch (error) {
                await this.releaseAndLog(admission.claim);
                throw error;
            }
        }
        return false;
    }

    private matchingRules(message: Message): KeywordAutoResponseRule[] {
        return (this.client.config.keyword_auto_responses?.rules ?? []).filter(
            rule =>
                rule.channel_ids.includes(message.channelId) &&
                rule.keywords.some(keyword => containsLiteralKeyword(message.content, keyword)),
        );
    }

    private ruleIsCurrent(expected: KeywordAutoResponseRule): boolean {
        if (!this.isConfigured()) return false;
        const current = this.client.config.keyword_auto_responses?.rules?.find(rule => rule.id === expected.id);
        return (
            current !== undefined &&
            current.response === expected.response &&
            arraysEqual(current.channel_ids, expected.channel_ids) &&
            arraysEqual(current.keywords, expected.keywords)
        );
    }

    private async releaseAndLog(claim: KeywordCooldownClaim): Promise<void> {
        await this.interactions
            .releaseKeywordCooldown(claim)
            .catch(error =>
                this.client
                    .logError(
                        "Keyword auto-response cooldown release failed",
                        error instanceof Error ? error : String(error),
                    )
                    .catch(() => undefined),
            );
    }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
