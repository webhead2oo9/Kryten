import { describe, expect, it, vi } from "vitest";
import type { Message } from "discord.js";
import type { KrytenClient } from "../src/classes/client";
import { ClassificationLogger } from "../src/llm/classificationLogger";
import type { ClassificationResult } from "../src/llm/classifier";

function setup() {
    const send = vi.fn(async () => undefined);
    const channel = { guildId: "guild", isTextBased: () => true, send };
    const fetch = vi.fn(async () => channel);
    const client = {
        config: { llm_classifier: { classification_log_channel_id: "audit" } },
        channels: { fetch },
    } as unknown as KrytenClient;
    const message = {
        guildId: "guild",
        url: "https://discord.com/channels/guild/support/message",
        content: "private synthetic message",
        author: { username: "private-name" },
    } as unknown as Message;
    return { client, message, channel, fetch, send };
}

function result(
    overrides: Partial<ClassificationResult<"ROUTE" | "IGNORE">> = {},
): ClassificationResult<"ROUTE" | "IGNORE"> {
    return {
        label: "ROUTE",
        status: "ok",
        latencyMs: 1,
        usage: { inputTokens: 2, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 3, totalTokens: 6 },
        ...overrides,
    };
}

describe("ClassificationLogger", () => {
    it("sends the minimal classification card", async () => {
        const { client, message, send } = setup();
        const logger = new ClassificationLogger(client);

        await logger.log(message, result());

        const payload = send.mock.calls[0]![0];
        const embed = payload.embeds[0].toJSON();
        expect(embed.title).toBe("LLM Classification");
        expect(embed.fields).toEqual([
            { name: "Decision", value: "ROUTE", inline: true },
            { name: "Status", value: "OK", inline: true },
            { name: "Source", value: "[Open message](https://discord.com/channels/guild/support/message)" },
        ]);
        expect(JSON.stringify(payload)).not.toContain("private synthetic message");
        expect(JSON.stringify(payload)).not.toContain("private-name");
        expect(payload.allowedMentions).toEqual({ parse: [] });
        expect(logger.getMetrics()).toEqual({ sent: 1, failures: 0 });
    });

    it("includes bounded raw output only for provider failures", async () => {
        const { client, message, send } = setup();
        const logger = new ClassificationLogger(client);
        const fireworksToken = `fw_${"a".repeat(26)}`;

        await logger.log(
            message,
            result({
                label: "IGNORE",
                status: "rate_limited",
                providerFailure: {
                    provider: "fireworks",
                    code: "rate_limited",
                    summary: "Rate limited",
                    httpStatus: 429,
                    rawOutput: JSON.stringify({
                        error: "capacity",
                        email: "me@example.com",
                        token: fireworksToken,
                    }),
                },
            }),
        );

        const fields = send.mock.calls[0]![0].embeds[0].toJSON().fields;
        expect(fields).toContainEqual({ name: "Status", value: "Rate limited (429)", inline: true });
        const raw = fields.find((field: { name: string }) => field.name === "Raw output")?.value;
        expect(raw).toContain("[email omitted]");
        expect(raw).toContain("[secret omitted]");
        expect(raw).not.toContain("me@example.com");
        expect(raw).not.toContain(fireworksToken);
    });

    it("does nothing when no channel is configured or authorization is revoked", async () => {
        const { client, message, fetch, send } = setup();
        const logger = new ClassificationLogger(client);
        client.config.llm_classifier!.classification_log_channel_id = undefined;
        await logger.log(message, result());
        expect(fetch).not.toHaveBeenCalled();

        client.config.llm_classifier!.classification_log_channel_id = "audit";
        await logger.log(message, result(), () => false);
        expect(send).not.toHaveBeenCalled();
        expect(logger.getMetrics()).toEqual({ sent: 0, failures: 0 });
    });

    it("suppresses a log when the LLM configuration changes during channel lookup", async () => {
        const { client, message, channel, fetch, send } = setup();
        const logger = new ClassificationLogger(client);
        fetch.mockImplementationOnce(async () => {
            client.config.llm_classifier = { ...client.config.llm_classifier! };
            return channel as never;
        });

        await logger.log(message, result());

        expect(send).not.toHaveBeenCalled();
        expect(logger.getMetrics()).toEqual({ sent: 0, failures: 0 });
    });

    it("rejects a cross-guild channel and contains send failures", async () => {
        const { client, message, channel, send } = setup();
        const logger = new ClassificationLogger(client);
        channel.guildId = "other-guild";
        await logger.log(message, result());
        expect(send).not.toHaveBeenCalled();

        channel.guildId = "guild";
        send.mockRejectedValueOnce(new Error("synthetic send failure"));
        await expect(logger.log(message, result())).resolves.toBeUndefined();
        expect(logger.getMetrics()).toEqual({ sent: 0, failures: 2 });
    });
});
