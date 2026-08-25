import type { Message } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KrytenClient } from "../src/classes/client";
import { BetaResponder } from "../src/features/betaResponder/betaResponder";
import type { UserInteractionStore } from "../src/features/userInteractions/store";

describe("BetaResponder", () => {
    beforeEach(() => vi.useFakeTimers({ now: new Date("2026-08-12T06:00:00.000Z") }));
    afterEach(() => vi.useRealTimers());

    it("sends one plain campaign greeting, records it, and deletes it after the configured delay", async () => {
        const deleted = vi.fn(async () => undefined);
        const send = vi.fn(async () => ({ delete: deleted }) as unknown as Message);
        const setCampaignGreeting = vi.fn(async () => true);
        const interactions = {
            getCampaignGreeting: vi.fn(async () => ({ generation: 3 })),
            setCampaignGreeting,
        } as unknown as UserInteractionStore;
        const client = makeClient();
        const responder = new BetaResponder(client, interactions);

        await responder.process(makeMessage(send));

        expect(send).toHaveBeenCalledOnce();
        const payload = send.mock.calls[0]?.[0];
        expect(payload).toMatchObject({ allowedMentions: { parse: [], users: ["user-1"] } });
        expect(payload).not.toHaveProperty("embeds");
        expect(payload?.content).toContain("<@user-1>");
        expect(payload?.content).toContain("<#announcements-1>");
        expect(payload?.content).toBe(
            "Welcome, <@user-1>! Direct USB support and the 15-minute stream restart are still in Beta. To opt in, switch Virtual Desktop on your Quest to the **BETA** release channel; a separate Beta Streamer installation is no longer required. For the latest information, check <#announcements-1>.",
        );
        expect(setCampaignGreeting).toHaveBeenCalledWith("user-1", "beta", { campaignId: "direct-usb-beta-v1" }, 3);

        await vi.advanceTimersByTimeAsync(44_999);
        expect(deleted).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(deleted).toHaveBeenCalledOnce();
    });

    it("suppresses users present in the campaign backfill", async () => {
        const send = vi.fn();
        const interactions = {
            getCampaignGreeting: vi.fn(async () => ({
                record: { campaignId: "direct-usb-beta-v1" },
                generation: 0,
            })),
            setCampaignGreeting: vi.fn(),
        } as unknown as UserInteractionStore;

        await new BetaResponder(makeClient(), interactions).process(makeMessage(send));

        expect(send).not.toHaveBeenCalled();
        expect(interactions.setCampaignGreeting).not.toHaveBeenCalled();
    });

});

function makeClient(): KrytenClient {
    return {
        config: {
            beta_classifier: {
                target_greeting_enabled: true,
                target_greeting_delete_after_seconds: 45,
                announcements_channel_id: "announcements-1",
                target_channel_id: "beta-1",
                campaign_id: "direct-usb-beta-v1",
                campaign_started_at: "2026-08-12T05:00:00.000Z",
            },
        },
    } as KrytenClient;
}

function makeMessage(send: ReturnType<typeof vi.fn>, overrides: Record<string, unknown> = {}): Message {
    return {
        author: { id: "user-1", bot: false },
        channelId: "beta-1",
        channel: { send },
        ...overrides,
    } as unknown as Message;
}
