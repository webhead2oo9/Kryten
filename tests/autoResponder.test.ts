import type { Message } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { KrytenClient } from "../src/classes/client";
import { AutoResponder } from "../src/features/autoresponder/autoResponder";
import type { GreetingRecord, UserInteractionStore } from "../src/features/userInteractions/store";

describe("AutoResponder", () => {
    it("does not recreate a greeting record deleted while a greeting is in progress", async () => {
        let generation = 0;
        let setCalls = 0;
        const send = vi.fn(async () => undefined);
        const getGreeting = vi.fn(async () => ({ record: undefined, generation }));
        const setGreeting = vi.fn(async (_userId: string, _record: GreetingRecord, expected: number) => {
            setCalls++;
            if (setCalls === 1) {
                generation++;
                return true;
            }
            return expected === generation;
        });
        const interactions = { getGreeting, setGreeting } as unknown as UserInteractionStore;
        const client = {
            config: {
                auto_responder: {
                    auto_response_channel_ids: ["random"],
                    random_greeting_channel_id: "random",
                },
            },
        } as unknown as KrytenClient;
        const message = {
            author: { id: "42", bot: false, toString: () => "@member" },
            channelId: "random",
            channel: { send },
            createdTimestamp: 1_720_000_000_000,
        } as unknown as Message;

        await new AutoResponder(client, interactions).process(message);

        expect(getGreeting).toHaveBeenCalledTimes(1);
        expect(setGreeting).toHaveBeenCalledTimes(2);
        expect(setGreeting.mock.calls[1]?.[2]).toBe(0);
        expect(send).toHaveBeenCalledOnce();
    });
});
