import { describe, expect, it, vi } from "vitest";
import type { Message } from "discord.js";
import type { KrytenClient } from "../src/classes/client";
import { BetaClassifier } from "../src/features/betaClassifier/betaClassifier";
import { LlmClassifier, type ClassificationResult, type ClassificationTask } from "../src/llm/classifier";
import type { ClassificationLogger } from "../src/llm/classificationLogger";

vi.mock("../src/features/betaClassifier/promptFile", () => ({
    loadBetaClassifierPrompt: vi.fn(async () => ({
        version: "synthetic-v1",
        systemInstruction: "Classify the synthetic conversation.",
    })),
}));

function client(overrides: Record<string, unknown> = {}): KrytenClient {
    return {
        config: {
            staff_roles: ["staff-role"],
            beta_classifier: {
                enabled: true,
                response_enabled: false,
                guild_id: "guild",
                watched_channel_ids: ["support"],
                target_channel_id: "beta",
                announcement_url: "https://discord.com/channels/guild/channel/message",
                prompt_file: "/private/beta-prompt.json",
                max_context_messages: 25,
            },
            llm_classifier: {
                enabled: true,
                provider: "fireworks",
                model: "accounts/fireworks/models/example",
                max_concurrency: 1,
                max_queue_depth: 1,
                classification_log_channel_id: "audit",
            },
        },
        logError: vi.fn(async () => undefined),
        ...overrides,
    } as unknown as KrytenClient;
}

function discordMessage(overrides: Record<string, unknown> = {}): Message {
    const cache = new Map<string, Message>();
    return {
        id: "target",
        guildId: "guild",
        channelId: "support",
        content: "Why does 1.34.19 only show Wi-Fi?",
        createdTimestamp: 2,
        author: { id: "author", bot: false },
        member: { roles: { cache: { some: () => false } } },
        reference: null,
        channel: {
            isThread: () => false,
            messages: {
                cache,
                fetch: vi.fn(async () => new Map()),
            },
        },
        fetchReference: vi.fn(),
        reply: vi.fn(),
        url: "https://discord.com/channels/guild/support/target",
        ...overrides,
    } as unknown as Message;
}

function auditLogger(log = vi.fn(async () => undefined)): ClassificationLogger {
    return { log, getMetrics: () => ({ sent: 0, failures: 0 }) } as unknown as ClassificationLogger;
}

function result(
    label: "ROUTE" | "IGNORE",
    status: ClassificationResult<"ROUTE" | "IGNORE">["status"] = "ok",
): ClassificationResult<"ROUTE" | "IGNORE"> {
    return {
        label,
        status,
        latencyMs: 1,
        usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, totalTokens: 2 },
    };
}

describe("BetaClassifier", () => {
    it("submits an anonymous transcript, writes an audit result, and leaves responses disabled", async () => {
        const historical = discordMessage({
            id: "prior",
            content: "Have you installed both sides? https://example.test/details",
            createdTimestamp: 1,
            author: { id: "helper-id", bot: false },
        });
        const message = discordMessage();
        const fetchHistory = vi.fn(async () => new Map([["prior", historical]]));
        (message.channel as any).messages.fetch = fetchHistory;
        let request: ClassificationTask<"ROUTE" | "IGNORE"> | null = null;
        const classifyLazy = vi.fn(async (_fallback, buildTask) => {
            request = await buildTask();
            return result("ROUTE");
        });
        const classifier = { classifyLazy, drain: vi.fn(async () => undefined) } as unknown as LlmClassifier;
        const testClient = client();
        const classificationLog = vi.fn(async () => undefined);
        const feature = new BetaClassifier(testClient, classifier, auditLogger(classificationLog));

        await feature.process(message);
        await feature.drain();

        expect(classifyLazy).toHaveBeenCalledTimes(1);
        expect(request!.input).toContain("TARGET");
        expect(request!.input).toContain("[link omitted]");
        expect(request!.input).not.toContain("helper-id");
        expect(message.reply).not.toHaveBeenCalled();
        expect(classificationLog).toHaveBeenCalledWith(
            message,
            expect.objectContaining({ label: "ROUTE" }),
            expect.any(Function),
        );
        expect(testClient.logError).not.toHaveBeenCalled();
        expect(feature.getMetrics()).toMatchObject({
            messagesSeen: 1,
            candidates: 1,
            submitted: 1,
            route: 1,
            ignore: 0,
            responseEnabled: false,
            promptVersion: "synthetic-v1",
            pending: 0,
        });
    });

    it("returns from the message pipeline without waiting for provider latency", async () => {
        let resolveClassification!: (value: ClassificationResult<"ROUTE" | "IGNORE">) => void;
        const provider = new Promise<ClassificationResult<"ROUTE" | "IGNORE">>(resolve => {
            resolveClassification = resolve;
        });
        const classifyLazy = vi.fn(async (_fallback, buildTask) => {
            await buildTask();
            return provider;
        });
        const classifier = { classifyLazy, drain: vi.fn(async () => undefined) } as unknown as LlmClassifier;
        const feature = new BetaClassifier(client(), classifier, auditLogger());

        await feature.process(discordMessage());

        await vi.waitFor(() => expect(classifyLazy).toHaveBeenCalledTimes(1));
        expect(feature.getMetrics().pending).toBe(1);
        resolveClassification(result("IGNORE"));
        await feature.drain();
        expect(feature.getMetrics()).toMatchObject({ pending: 0, ignore: 1 });
    });

    it("skips staff, bots, other guilds, other channels, and known false-positive text", async () => {
        const classifyLazy = vi.fn(async () => result("ROUTE"));
        const classifier = { classifyLazy, drain: vi.fn(async () => undefined) } as unknown as LlmClassifier;
        const feature = new BetaClassifier(client(), classifier, auditLogger());
        const staffMember = {
            roles: { cache: { some: (fn: (role: { id: string }) => boolean) => fn({ id: "staff-role" }) } },
        };

        await feature.process(discordMessage({ member: staffMember }));
        await feature.process(discordMessage({ member: null }));
        await feature.process(discordMessage({ author: { id: "bot", bot: true } }));
        await feature.process(discordMessage({ guildId: "elsewhere" }));
        await feature.process(discordMessage({ channelId: "random" }));
        await feature.process(discordMessage({ content: "Why does VD disconnect on Wi-Fi?" }));

        expect(classifyLazy).not.toHaveBeenCalled();
    });

    it("accepts a thread whose parent is an explicitly watched support channel", async () => {
        const classifyLazy = vi.fn(async (_fallback, buildTask) => {
            await buildTask();
            return result("IGNORE");
        });
        const classifier = { classifyLazy, drain: vi.fn(async () => undefined) } as unknown as LlmClassifier;
        const feature = new BetaClassifier(client(), classifier, auditLogger());
        const message = discordMessage({
            channelId: "support-thread",
            channel: {
                isThread: () => true,
                parentId: "support",
                messages: { cache: new Map(), fetch: vi.fn(async () => new Map()) },
            },
        });

        await feature.process(message);
        await feature.drain();

        expect(classifyLazy).toHaveBeenCalledTimes(1);
    });

    it("records provider failures as ignored fallbacks", async () => {
        const classifier = {
            classifyLazy: vi.fn(async () => result("IGNORE", "queue_full")),
            drain: vi.fn(async () => undefined),
        } as unknown as LlmClassifier;
        const feature = new BetaClassifier(client(), classifier, auditLogger());

        await feature.process(discordMessage());
        await feature.drain();

        expect(feature.getMetrics()).toMatchObject({ ignore: 1, providerFallbacks: 1 });
    });

    it("posts the beta redirect only when responses are enabled and the result is ROUTE", async () => {
        const testClient = client();
        testClient.config.beta_classifier!.response_enabled = true;
        const classifier = {
            classifyLazy: vi.fn(async (_fallback, buildTask) => {
                await buildTask();
                return result("ROUTE");
            }),
            drain: vi.fn(async () => undefined),
        } as unknown as LlmClassifier;
        const message = discordMessage();
        const feature = new BetaClassifier(testClient, classifier, auditLogger());

        await feature.process(message);
        await feature.drain();

        expect(message.reply).toHaveBeenCalledWith({
            content: expect.stringContaining("<#beta>"),
            allowedMentions: { parse: [], repliedUser: false },
        });
        expect(message.reply).toHaveBeenCalledWith({
            content: expect.stringContaining("https://discord.com/channels/guild/channel/message"),
            allowedMentions: { parse: [], repliedUser: false },
        });
        expect(feature.getMetrics()).toMatchObject({ responseEnabled: true, responsesSent: 1, responseFailures: 0 });
    });

    it("does not respond to IGNORE or a stale configuration", async () => {
        const ignoredClient = client();
        ignoredClient.config.beta_classifier!.response_enabled = true;
        const ignoreMessage = discordMessage();
        const ignoreFeature = new BetaClassifier(
            ignoredClient,
            {
                classifyLazy: vi.fn(async () => result("IGNORE")),
                drain: vi.fn(async () => undefined),
            } as unknown as LlmClassifier,
            auditLogger(),
        );
        await ignoreFeature.process(ignoreMessage);
        await ignoreFeature.drain();
        expect(ignoreMessage.reply).not.toHaveBeenCalled();

        const staleClient = client();
        staleClient.config.beta_classifier!.response_enabled = true;
        const staleMessage = discordMessage();
        const staleClassifier = {
            classifyLazy: vi.fn(async (_fallback, buildTask) => {
                await buildTask();
                staleClient.config.beta_classifier = { ...staleClient.config.beta_classifier! };
                return result("ROUTE");
            }),
            drain: vi.fn(async () => undefined),
        } as unknown as LlmClassifier;
        const staleFeature = new BetaClassifier(staleClient, staleClassifier, auditLogger());
        await staleFeature.process(staleMessage);
        await staleFeature.drain();
        expect(staleMessage.reply).not.toHaveBeenCalled();
    });

    it("contains response failures", async () => {
        const testClient = client();
        testClient.config.beta_classifier!.response_enabled = true;
        const classifier = {
            classifyLazy: vi.fn(async (_fallback, buildTask) => {
                await buildTask();
                return result("ROUTE");
            }),
            drain: vi.fn(async () => undefined),
        } as unknown as LlmClassifier;
        const message = discordMessage({ reply: vi.fn(async () => Promise.reject(new Error("synthetic failure"))) });
        const feature = new BetaClassifier(testClient, classifier, auditLogger());

        await feature.process(message);
        await feature.drain();

        expect(feature.getMetrics()).toMatchObject({ responsesSent: 0, responseFailures: 1 });
    });

    it("contains synchronous failures locally without invoking Discord error logging", async () => {
        const testClient = client();
        const classifier = {
            classifyLazy: vi.fn(async () => result("IGNORE")),
            drain: vi.fn(async () => undefined),
        } as unknown as LlmClassifier;
        const feature = new BetaClassifier(testClient, classifier, auditLogger());
        const malformedMessage = discordMessage({
            channel: { messages: { cache: new Map(), fetch: vi.fn() } },
        });

        await expect(feature.process(malformedMessage)).resolves.toBeUndefined();

        expect(testClient.logError).not.toHaveBeenCalled();
        expect(classifier.classifyLazy).not.toHaveBeenCalled();
        expect(feature.getMetrics().providerFallbacks).toBe(1);
    });

    it("stops admission and closes the shared queue for shutdown", async () => {
        const close = vi.fn();
        const classifyLazy = vi.fn(async () => result("ROUTE"));
        const classifier = {
            classifyLazy,
            close,
            drain: vi.fn(async () => undefined),
        } as unknown as LlmClassifier;
        const feature = new BetaClassifier(client(), classifier, auditLogger());

        feature.stop();
        await feature.process(discordMessage());

        expect(close).toHaveBeenCalledTimes(1);
        expect(classifyLazy).not.toHaveBeenCalled();
    });

    it("invalidates accepted work when the beta config generation is reloaded", async () => {
        const testClient = client();
        const message = discordMessage();
        const fetchHistory = (message.channel as any).messages.fetch as ReturnType<typeof vi.fn>;
        const classifyLazy = vi.fn(async (_fallback, buildTask, isAuthorized) => {
            expect(isAuthorized()).toBe(true);
            testClient.config.beta_classifier = { ...testClient.config.beta_classifier! };
            expect(isAuthorized()).toBe(false);
            expect(await buildTask()).toBeNull();
            return result("IGNORE", "disabled");
        });
        const classifier = { classifyLazy, drain: vi.fn(async () => undefined) } as unknown as LlmClassifier;
        const feature = new BetaClassifier(testClient, classifier, auditLogger());

        await feature.process(message);
        await feature.drain();

        expect(fetchHistory).not.toHaveBeenCalled();
        expect(feature.getMetrics()).toMatchObject({ ignore: 1, providerFallbacks: 1 });
    });

    it("bounds history fetches behind the shared classifier queue", async () => {
        const testClient = client();
        let releaseHistory!: () => void;
        const blockedHistory = new Promise<void>(resolve => {
            releaseHistory = resolve;
        });
        const firstFetch = vi.fn(async () => {
            await blockedHistory;
            return new Map();
        });
        const secondFetch = vi.fn(async () => new Map());
        const thirdFetch = vi.fn(async () => new Map());
        const first = discordMessage({ id: "first" });
        const second = discordMessage({ id: "second" });
        const third = discordMessage({ id: "third" });
        (first.channel as any).messages.fetch = firstFetch;
        (second.channel as any).messages.fetch = secondFetch;
        (third.channel as any).messages.fetch = thirdFetch;
        const fetchImpl = vi.fn(async () => completion("IGNORE"));
        const classifier = new LlmClassifier(() => testClient.config.llm_classifier, fetchImpl as typeof fetch, {
            FIREWORKS_API_KEY: "test-key",
        });
        const feature = new BetaClassifier(testClient, classifier, auditLogger());

        await feature.process(first);
        await feature.process(second);
        await feature.process(third);

        expect(firstFetch).toHaveBeenCalledTimes(1);
        expect(secondFetch).not.toHaveBeenCalled();
        expect(thirdFetch).not.toHaveBeenCalled();
        releaseHistory();
        await feature.drain();
        expect(secondFetch).toHaveBeenCalledTimes(1);
        expect(thirdFetch).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(feature.getMetrics()).toMatchObject({ candidates: 3, submitted: 3, providerFallbacks: 1 });
    });

    it("builds an uncached continuation only when its parent passes the candidate gate", async () => {
        let request: ClassificationTask<"ROUTE" | "IGNORE"> | null = null;
        const classifyLazy = vi.fn(async (_fallback, buildTask) => {
            request = await buildTask();
            return result("IGNORE");
        });
        const classifier = { classifyLazy, drain: vi.fn(async () => undefined) } as unknown as LlmClassifier;
        const feature = new BetaClassifier(client(), classifier, auditLogger());
        const relevantParent = discordMessage({
            id: "parent",
            content: "Why does 1.34.19 only show Wi-Fi?",
            createdTimestamp: 1,
        });
        const message = discordMessage({
            content: "same here",
            reference: { messageId: "parent" },
            fetchReference: vi.fn(async () => relevantParent),
        });

        await feature.process(message);
        await feature.drain();

        expect(message.fetchReference).toHaveBeenCalledTimes(1);
        expect(request!.input).toContain("Why does 1.34.19 only show Wi-Fi?");
        expect(request!.input).toContain("same here");
    });

    it("rejects a terse continuation when its parent is cross-channel or irrelevant", async () => {
        let request: ClassificationTask<"ROUTE" | "IGNORE"> | null = null;
        const classifyLazy = vi.fn(async (_fallback, buildTask) => {
            request = await buildTask();
            return result("IGNORE", request ? "ok" : "invalid_request");
        });
        const classifier = { classifyLazy, drain: vi.fn(async () => undefined) } as unknown as LlmClassifier;
        const feature = new BetaClassifier(client(), classifier, auditLogger());
        const crossChannelParent = discordMessage({
            id: "parent",
            channelId: "other-channel",
            content: "Why does 1.34.19 only show Wi-Fi?",
            createdTimestamp: 1,
        });
        const message = discordMessage({
            content: "same here",
            reference: { messageId: "parent" },
            fetchReference: vi.fn(async () => crossChannelParent),
        });

        await feature.process(message);
        await feature.drain();

        expect(message.fetchReference).toHaveBeenCalledTimes(1);
        expect(request).toBeNull();

        const irrelevantParent = discordMessage({
            id: "irrelevant-parent",
            content: "What color should my wallpaper be?",
            createdTimestamp: 1,
        });
        const irrelevantReply = discordMessage({
            id: "irrelevant-reply",
            content: "same here",
            reference: { messageId: "irrelevant-parent" },
            fetchReference: vi.fn(async () => irrelevantParent),
        });
        request = null;
        await feature.process(irrelevantReply);
        await feature.drain();

        expect(irrelevantReply.fetchReference).toHaveBeenCalledTimes(1);
        expect(request).toBeNull();
        expect(feature.getMetrics()).toMatchObject({ providerFallbacks: 2, ignore: 2 });
    });
});

function completion(content: string): Response {
    return Response.json({ choices: [{ message: { content } }] });
}
