import { describe, expect, it, vi } from "vitest";
import type { Message } from "discord.js";
import type { KrytenClient } from "../src/classes/client";
import type { ClassificationResult, ClassificationTask } from "../src/llm/classifier";
import { TypeSafeShadowService, type ShadowTaskType, type TypeSafeShadowResult } from "../src/llm/typesafeShadow";

const task: ClassificationTask<"ROUTE" | "IGNORE"> = {
    systemInstruction: "Private versioned policy",
    input: "[TARGET]\nAUTHOR_1: sanitized text",
    allowedLabels: ["ROUTE", "IGNORE"],
    fallbackLabel: "IGNORE",
};

function primary(status: ClassificationResult<"ROUTE" | "IGNORE">["status"] = "ok") {
    return {
        label: "ROUTE" as const,
        status,
        latencyMs: 31,
        usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 },
    };
}

function shadow(label: "ROUTE" | "IGNORE" = "ROUTE", status: TypeSafeShadowResult<string>["status"] = "ok") {
    return {
        label,
        status,
        model: "jev-1.13.0",
        probabilities: { ROUTE: 0.8, IGNORE: 0.2 },
        confidence: 0.7,
        latencyMs: 17,
        usage: { inputTokens: 9, outputTokens: 3 },
    };
}

function setup(result: TypeSafeShadowResult<"ROUTE" | "IGNORE"> = shadow()) {
    const send = vi.fn(async () => undefined);
    const channel = { guildId: "guild", isTextBased: () => true, send };
    const fetch = vi.fn(async () => channel);
    const client = {
        config: { typesafe_shadow: { enabled: true, log_channel_id: "shadow-log", model: "jev-1.13.0" } },
        channels: { fetch },
    } as unknown as KrytenClient;
    const provider = { classify: vi.fn(async () => result), close: vi.fn(), drain: vi.fn(async () => undefined) };
    const service = new TypeSafeShadowService(client, provider);
    const message = {
        guildId: "guild",
        url: "https://discord.com/channels/guild/support/message",
        content: "private content",
        author: { username: "private-user" },
    } as unknown as Message;
    return { client, provider, service, message, fetch, send, channel };
}

async function compare(
    service: TypeSafeShadowService,
    message: Message,
    primaryResult = primary(),
    taskType: ShadowTaskType = "beta_routing",
    isAuthorized: () => boolean = () => true,
    deadlineAt?: number,
) {
    const handle = service.begin({ taskType, message, task, isAuthorized, isLogAuthorized: isAuthorized, deadlineAt });
    service.complete(handle, primaryResult);
    await service.drain();
}

describe("TypeSafeShadowService", () => {
    it.each(["typesafe", "clef"] as const)(
        "skips all calls and comparison cards when %s is primary even if shadow is enabled",
        async providerName => {
            const { client, service, message, provider, fetch, send } = setup();
            client.config.llm_classifier = {
                enabled: true,
                provider: providerName,
                model: providerName === "typesafe" ? "jev-1.13.0" : "Cloudflare/clef-flash",
            };
            await compare(service, message);
            expect(provider.classify).not.toHaveBeenCalled();
            expect(fetch).not.toHaveBeenCalled();
            expect(send).not.toHaveBeenCalled();
        },
    );
    it("does not call the provider when shadow config is replaced before deferred admission", async () => {
        const { client, service, message, provider, send } = setup();
        const handle = service.begin({
            taskType: "beta_routing",
            message,
            task,
            isAuthorized: () => true,
            isLogAuthorized: () => true,
        });
        client.config.typesafe_shadow = { ...client.config.typesafe_shadow! };
        service.complete(handle, primary());
        await service.drain();

        expect(provider.classify).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    it("counts agreement only when both providers succeed, with independent task denominators", async () => {
        const { service, message, provider } = setup();
        await compare(service, message);
        provider.classify.mockResolvedValueOnce(shadow("IGNORE"));
        await compare(service, message, primary(), "beta_greeting");
        provider.classify.mockResolvedValueOnce(shadow("ROUTE", "http_error"));
        await compare(service, message);
        await compare(service, message, primary("timeout"));

        expect(service.getMetrics().tasks).toEqual({
            beta_routing: expect.objectContaining({
                compared: 1,
                matches: 1,
                mismatches: 0,
                matchPercent: 100,
                shadowFailures: 1,
                primaryFailures: 1,
            }),
            beta_greeting: expect.objectContaining({
                compared: 1,
                matches: 0,
                mismatches: 1,
                matchPercent: 0,
            }),
        });
    });

    it("reports N/A with a null percentage when there are no successful pairs", async () => {
        const { service, message } = setup(shadow("IGNORE", "invalid_response"));
        await compare(service, message);
        expect(service.getMetrics().tasks.beta_routing).toMatchObject({ compared: 0, matchPercent: null });
    });

    it("is fully inert when the shadow opt-in is disabled", async () => {
        const { client, service, message, provider, send } = setup();
        client.config.typesafe_shadow!.enabled = false;
        const handle = service.begin({
            taskType: "beta_routing",
            message,
            task,
            isAuthorized: () => true,
            isLogAuthorized: () => true,
        });
        service.complete(handle, primary());
        await service.drain();
        expect(handle).toBeNull();
        expect(provider.classify).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
    });

    it("suppresses revoked results before counting or logging", async () => {
        const { service, message, send } = setup();
        let authorized = true;
        const handle = service.begin({
            taskType: "beta_routing",
            message,
            task,
            isAuthorized: () => authorized,
            isLogAuthorized: () => authorized,
        });
        service.complete(handle, primary());
        authorized = false;
        await service.drain();

        expect(service.getMetrics().tasks.beta_routing).toMatchObject({ compared: 0, suppressed: 1 });
        expect(send).not.toHaveBeenCalled();
    });

    it("allows queued egress after primary completion without treating completion as revocation", async () => {
        const { service, message, provider } = setup();
        let activeRun = true;
        const handle = service.begin({
            taskType: "beta_routing",
            message,
            task,
            isAuthorized: () => activeRun,
            isLogAuthorized: () => true,
        });
        activeRun = false;
        service.complete(handle, primary());
        await service.drain();

        const egressGate = provider.classify.mock.calls[0]?.[1] as (() => boolean) | undefined;
        expect(egressGate?.()).toBe(true);
        expect(service.getMetrics().tasks.beta_routing).toMatchObject({ compared: 1, suppressed: 0 });
    });

    it("counts a Jev greeting result completed after its deadline as late", async () => {
        const { service, message } = setup();
        await compare(service, message, primary(), "beta_greeting", () => true, Date.now() - 1);
        expect(service.getMetrics().tasks.beta_greeting).toMatchObject({ compared: 1, late: 1 });
    });

    it("logs a bounded metadata-only card with no content, prompt, raw body, or username", async () => {
        const { service, message, send } = setup();
        await compare(service, message);

        const payload = send.mock.calls[0]![0];
        const serialized = JSON.stringify(payload);
        expect(payload.allowedMentions).toEqual({ parse: [] });
        expect(serialized).toContain("Beta routing");
        expect(serialized).toContain("ROUTE");
        expect(serialized).toContain("jev-1.13.0");
        expect(serialized).toContain("100.0% (1/1)");
        expect(serialized).toContain(message.url);
        expect(serialized).not.toContain(message.content);
        expect(serialized).not.toContain(message.author.username);
        expect(serialized).not.toContain(task.systemInstruction);
        expect(serialized).not.toContain(task.input);
    });

    it("rejects a text-capable destination in another guild", async () => {
        const { service, message, channel, send } = setup();
        channel.guildId = "other-guild";
        await compare(service, message);
        expect(send).not.toHaveBeenCalled();
        expect(service.getMetrics()).toMatchObject({ logFailures: 1 });
    });

    it("keeps logging slots occupied until timed-out send promises settle", async () => {
        const { client, service, message, send } = setup();
        client.config.typesafe_shadow!.timeout_ms = 5;
        const releases: Array<() => void> = [];
        send.mockImplementation(
            () =>
                new Promise<void>(resolve => {
                    releases.push(resolve);
                }),
        );

        for (let index = 0; index < 2; index++) {
            const handle = service.begin({
                taskType: "beta_routing",
                message,
                task,
                isAuthorized: () => true,
                isLogAuthorized: () => true,
            });
            service.complete(handle, primary());
        }
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
        await new Promise(resolve => setTimeout(resolve, 15));

        const later = service.begin({
            taskType: "beta_routing",
            message,
            task,
            isAuthorized: () => true,
            isLogAuthorized: () => true,
        });
        service.complete(later, primary());
        await vi.waitFor(() => expect(service.getMetrics().logDrops).toBe(1));
        expect(send).toHaveBeenCalledTimes(2);

        for (const release of releases) release();
        await service.drain();
        expect(service.getMetrics()).toMatchObject({ logSent: 0, logFailures: 2 });
    });

    it("keeps hung fetches in logging slots and never sends after their deadline", async () => {
        const { client, service, message, fetch, send, channel } = setup();
        client.config.typesafe_shadow!.timeout_ms = 5;
        const releases: Array<() => void> = [];
        fetch.mockImplementation(
            () =>
                new Promise(resolve => {
                    releases.push(() => resolve(channel));
                }),
        );

        for (let index = 0; index < 2; index++) {
            const handle = service.begin({
                taskType: "beta_routing",
                message,
                task,
                isAuthorized: () => true,
                isLogAuthorized: () => true,
            });
            service.complete(handle, primary());
        }
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
        await new Promise(resolve => setTimeout(resolve, 15));

        const later = service.begin({
            taskType: "beta_routing",
            message,
            task,
            isAuthorized: () => true,
            isLogAuthorized: () => true,
        });
        service.complete(later, primary());
        await vi.waitFor(() => expect(service.getMetrics().logDrops).toBe(1));
        for (const release of releases) release();
        await service.drain();

        expect(send).not.toHaveBeenCalled();
        expect(service.getMetrics()).toMatchObject({ logSent: 0, logDrops: 1 });
    });

    it("closes admission and drains provider and bounded comparison tasks", async () => {
        const { service, provider, message } = setup();
        service.close();
        const handle = service.begin({
            taskType: "beta_routing",
            message,
            task,
            isAuthorized: () => true,
            isLogAuthorized: () => true,
        });
        expect(handle).toBeNull();
        await service.drain();
        expect(provider.close).toHaveBeenCalledOnce();
        expect(provider.drain).toHaveBeenCalledOnce();
    });
});
