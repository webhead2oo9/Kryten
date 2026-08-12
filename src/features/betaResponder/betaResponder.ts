import { TextChannel, type Message } from "discord.js";
import type { KrytenClient } from "../../classes/client";
import {
    BETA_GREETING_ID,
    classifierCampaignIsActive,
    type ClassifierCampaign,
    type UserInteractionStore,
} from "../userInteractions/store";

const WINDOWS_STREAMER_URL = "https://download.vrdesktop.net/files/beta/VirtualDesktop.Streamer.Setup.exe";
const DEFAULT_DELETE_AFTER_SECONDS = 45;

export class BetaResponder {
    private readonly greetingsInFlight = new Set<string>();

    constructor(
        private readonly client: KrytenClient,
        private readonly interactions: UserInteractionStore,
    ) {}

    async process(message: Message): Promise<void> {
        const config = this.client.config.beta_classifier;
        if (!config?.target_greeting_enabled || message.author.bot) return;
        if (message.channelId !== config.target_channel_id || !config.announcements_channel_id) return;
        const campaign = this.campaign(config.campaign_id, config.campaign_started_at);
        if (!campaign || !classifierCampaignIsActive(campaign)) return;

        const userId = message.author.id;
        const snapshot = await this.interactions.getCampaignGreeting(userId, BETA_GREETING_ID);
        if (!this.isAuthorized(message, config, campaign)) return;
        if (snapshot.record?.campaignId === campaign.campaignId || this.greetingsInFlight.has(userId)) return;

        this.greetingsInFlight.add(userId);
        try {
            const greeting = await (message.channel as TextChannel).send({
                content:
                    `Welcome, <@${userId}>! Please complete both beta setup steps: install the ` +
                    `[Beta Streamer](${WINDOWS_STREAMER_URL}) on your computer and set Virtual Desktop on your Quest ` +
                    `to the **BETA** release channel. For the latest information, check ` +
                    `<#${config.announcements_channel_id}>.`,
                allowedMentions: { parse: [], users: [userId] },
            });
            this.scheduleDeletion(
                greeting,
                config.target_greeting_delete_after_seconds ?? DEFAULT_DELETE_AFTER_SECONDS,
            );
            await this.interactions.setCampaignGreeting(
                userId,
                BETA_GREETING_ID,
                { campaignId: campaign.campaignId },
                snapshot.generation,
            );
        } finally {
            this.greetingsInFlight.delete(userId);
        }
    }

    private campaign(campaignId: string | undefined, startedAt: string | undefined): ClassifierCampaign | null {
        if (!campaignId || !startedAt) return null;
        return { classifierId: BETA_GREETING_ID, campaignId, startedAt };
    }

    private isAuthorized(
        message: Message,
        config: NonNullable<KrytenClient["config"]["beta_classifier"]>,
        campaign: ClassifierCampaign,
    ): boolean {
        return (
            this.client.config.beta_classifier === config &&
            config.target_greeting_enabled === true &&
            message.channelId === config.target_channel_id &&
            classifierCampaignIsActive(campaign)
        );
    }

    private scheduleDeletion(message: Message, afterSeconds: number): void {
        const timer = setTimeout(() => void message.delete().catch(() => undefined), afterSeconds * 1_000);
        timer.unref();
    }
}
