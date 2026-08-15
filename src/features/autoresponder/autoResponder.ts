import { Message, TextChannel } from "discord.js";
import { KrytenClient } from "../../classes/client";
import { GreetingRecord, UserInteractionStore } from "../userInteractions/store";

export class AutoResponder {
    private readonly greetInFlight = new Set<string>();

    constructor(
        private readonly client: KrytenClient,
        private readonly interactions: UserInteractionStore,
    ) {}

    async flushNow(): Promise<void> {
        await this.interactions.flushNow();
    }

    /** Registry gate and process() share this so the enable check can't drift. */
    isConfigured(): boolean {
        return this.settings().randomGreetingChannelId !== "";
    }

    private settings(): { trackChannelIds: string[]; randomGreetingChannelId: string } {
        const config = this.client.config.auto_responder ?? {};
        return {
            trackChannelIds: config.auto_response_channel_ids ?? [],
            randomGreetingChannelId: config.random_greeting_channel_id ?? "",
        };
    }

    private shouldTrack(channelId: string, trackChannelIds: string[]): boolean {
        return trackChannelIds.length === 0 || trackChannelIds.includes(channelId);
    }

    async process(message: Message): Promise<void> {
        if (message.author.bot) return;
        if (!this.isConfigured()) return;
        const settings = this.settings();

        const currentTime = Math.floor(message.createdTimestamp / 1_000);
        const userId = message.author.id;
        let snapshot = await this.interactions.getGreeting(userId);
        if (this.shouldTrack(message.channelId, settings.trackChannelIds) && !snapshot.record) {
            const created: GreetingRecord = { firstMessageTimestamp: currentTime, greetedInRandom: false };
            if (!(await this.interactions.setGreeting(userId, created, snapshot.generation))) return;
            snapshot = { record: created, generation: snapshot.generation };
        }

        await this.handleRandomGreeting(
            message,
            settings.randomGreetingChannelId,
            currentTime,
            snapshot.record,
            snapshot.generation,
        );
    }

    private async handleRandomGreeting(
        message: Message,
        randomChannelId: string,
        currentTime: number,
        record: GreetingRecord | undefined,
        generation: number,
    ): Promise<void> {
        if (message.channelId !== randomChannelId) return;
        const userId = message.author.id;
        if (record?.greetedInRandom || this.greetInFlight.has(userId)) return;

        let greeting: string;
        let isFullWelcome = false;
        if (!record) {
            greeting = `Welcome to the server, ${message.author}! It's great to have you here!`;
        } else if (record.owedFullWelcome || Math.abs(record.firstMessageTimestamp - currentTime) <= 2) {
            greeting =
                `Welcome to the Virtual Desktop Discord server, ${message.author}! We're glad you've joined our Discord. ` +
                "If you have any questions or need assistance with Virtual Desktop, please head over to the 'Virtual Desktop Help' category " +
                "and post in one of the support channels there. Our team and community members will be happy to help you out. " +
                "Feel free to explore the other channels and get involved in discussions once your issue is resolved. Enjoy your stay!";
            isFullWelcome = true;
        } else {
            greeting =
                `Hey ${message.author}! Welcome to the random channel! Feel free to chat about anything here, as long as it follows the server rules. ` +
                "If you have any Virtual Desktop related questions, the 'Virtual Desktop Help' category is the perfect place to ask.";
        }

        this.greetInFlight.add(userId);
        try {
            await (message.channel as TextChannel).send(greeting);
            await this.interactions.setGreeting(
                userId,
                {
                    firstMessageTimestamp: record?.firstMessageTimestamp ?? currentTime,
                    greetedInRandom: true,
                },
                generation,
            );
        } catch (error) {
            console.error("AutoResponder: error handling random greeting:", error);
            if (isFullWelcome && record && !record.owedFullWelcome) {
                await this.interactions.setGreeting(userId, { ...record, owedFullWelcome: true }, generation);
            }
        } finally {
            this.greetInFlight.delete(userId);
        }
    }
}
