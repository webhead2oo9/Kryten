import { describe, expect, it, vi } from "vitest";
import type { Message } from "discord.js";
import type { KrytenClient } from "../src/classes/client";
import { BetaClassifier } from "../src/features/betaClassifier/betaClassifier";
import { LlmClassifier, type ClassificationResult, type ClassificationTask } from "../src/llm/classifier";
import type { ClassificationLogger } from "../src/llm/classificationLogger";
import type { ClassifierRun, UserInteractionStore } from "../src/features/userInteractions/store";

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
                campaign_id: "synthetic-beta",
                campaign_started_at: new Date(Date.now() - 1_000).toISOString(),
                included_channel_ids: ["support"],
                excluded_role_ids: ["excluded-role"],
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
        content: "Why does 1.34.20 only show Wi-Fi?",
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

function interactionStore(overrides: Record<string, unknown> = {}): UserInteractionStore {
    let sequence = 0;
    const active = new Set<ClassifierRun>();
    return {
        beginClassifierRun: vi.fn(async (userId: string, campaign: { classifierId: string; campaignId: string }) => {
            const run = {
                key: `${campaign.classifierId}:${userId}:${sequence++}`,
                classifierId: campaign.classifierId,
                userId,
                campaignId: campaign.campaignId,
                generation: 0,
            };
            active.add(run);
            return { status: "acquired", run };
        }),
        isClassifierRunCurrent: vi.fn((run: ClassifierRun) => active.has(run)),
        isUserGenerationCurrent: vi.fn(() => true),
        completeClassifierRun: vi.fn(async (run: ClassifierRun) => {
            active.delete(run);
            return "stored";
        }),
        releaseClassifierRun: vi.fn(async (run: ClassifierRun) => {
            active.delete(run);
        }),
        ...overrides,
    } as unknown as UserInteractionStore;
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
    it.each(["campaign_id", "campaign_started_at"] as const)(
        "does not admit classifier work when %s is missing",
        async missingField => {
            const testClient = client();
            delete testClient.config.beta_classifier![missingField];
            const beginClassifierRun = vi.fn();
            const classifyLazy = vi.fn();
            const feature = new BetaClassifier(
                testClient,
                { classifyLazy, drain: vi.fn(async () => undefined) } as unknown as LlmClassifier,
                auditLogger(),
                interactionStore({ beginClassifierRun }),
            );

            await feature.process(discordMessage());
            await feature.drain();

            expect(beginClassifierRun).not.toHaveBeenCalled();
            expect(classifyLazy).not.toHaveBeenCalled();
        },
    );

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
        const feature = new BetaClassifier(testClient, classifier, auditLogger(classificationLog), interactionStore());

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

    it("keeps excluded-role messages as pseudonymous surrounding context", async () => {
        const historical = discordMessage({
            id: "excluded-context",
            content: "The beta Streamer must also be installed.",
            createdTimestamp: 1,
            author: { id: "excluded-user-id", bot: false },
            member: {
                roles: { cache: { some: (fn: (role: { id: string }) => boolean) => fn({ id: "excluded-role" }) } },
            },
        });
        const message = discordMessage();
        (message.channel as any).messages.fetch = vi.fn(async () => new Map([[historical.id, historical]]));
        let request: ClassificationTask<"ROUTE" | "IGNORE"> | null = null;
        const feature = new BetaClassifier(
            client(),
            {
                classifyLazy: vi.fn(async (_fallback, buildTask) => {
                    request = await buildTask();
                    return result("IGNORE");
                }),
                drain: vi.fn(async () => undefined),
            } as unknown as LlmClassifier,
            auditLogger(),
            interactionStore(),
        );

        await feature.process(message);
        await feature.drain();

        expect(request!.input).toContain("The beta Streamer must also be installed.");
        expect(request!.input).not.toContain("excluded-user-id");
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
        const feature = new BetaClassifier(client(), classifier, auditLogger(), interactionStore());

        await feature.process(discordMessage());

        await vi.waitFor(() => expect(classifyLazy).toHaveBeenCalledTimes(1));
        expect(feature.getMetrics().pending).toBe(1);
        resolveClassification(result("IGNORE"));
        await feature.drain();
        expect(feature.getMetrics()).toMatchObject({ pending: 0, ignore: 1 });
    });

    it("skips staff, excluded roles, bots, other guilds, other channels, and false-positive text", async () => {
        const classifyLazy = vi.fn(async () => result("ROUTE"));
        const classifier = { classifyLazy, drain: vi.fn(async () => undefined) } as unknown as LlmClassifier;
        const feature = new BetaClassifier(client(), classifier, auditLogger(), interactionStore());
        const staffMember = {
            roles: { cache: { some: (fn: (role: { id: string }) => boolean) => fn({ id: "staff-role" }) } },
        };
        const excludedMember = {
            roles: { cache: { some: (fn: (role: { id: string }) => boolean) => fn({ id: "excluded-role" }) } },
        };

        await feature.process(discordMessage({ member: staffMember }));
        await feature.process(discordMessage({ member: excludedMember }));
        await feature.process(discordMessage({ member: null }));
        await feature.process(discordMessage({ author: { id: "bot", bot: true } }));
        await feature.process(discordMessage({ guildId: "elsewhere" }));
        await feature.process(discordMessage({ channelId: "random" }));
        await feature.process(discordMessage({ content: "Why does VD disconnect on Wi-Fi?" }));

        expect(classifyLazy).not.toHaveBeenCalled();
    });

    it("accepts a thread whose text or forum parent is explicitly included", async () => {
        const classifyLazy = vi.fn(async (_fallback, buildTask) => {
            await buildTask();
            return result("IGNORE");
        });
        const classifier = { classifyLazy, drain: vi.fn(async () => undefined) } as unknown as LlmClassifier;
        const feature = new BetaClassifier(client(), classifier, auditLogger(), interactionStore());
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

    it("accepts an individually included thread and rejects a thread under another parent", async () => {
        const testClient = client();
        testClient.config.beta_classifier!.included_channel_ids = ["specific-thread"];
        const classifyLazy = vi.fn(async (_fallback, buildTask) => {
            await buildTask();
            return result("IGNORE");
        });
        const feature = new BetaClassifier(
            testClient,
            { classifyLazy, drain: vi.fn(async () => undefined) } as unknown as LlmClassifier,
            auditLogger(),
            interactionStore(),
        );
        const channel = (id: string, parentId: string) => ({
            channelId: id,
            channel: {
                isThread: () => true,
                parentId,
                messages: { cache: new Map(), fetch: vi.fn(async () => new Map()) },
            },
        });

        await feature.process(discordMessage(channel("specific-thread", "forum")));
        await feature.process(discordMessage(channel("other-thread", "other-forum")));
        await feature.drain();

        expect(classifyLazy).toHaveBeenCalledTimes(1);
    });

    it("records provider failures as ignored fallbacks", async () => {
        const classifier = {
            classifyLazy: vi.fn(async () => result("IGNORE", "queue_full")),
            drain: vi.fn(async () => undefined),
        } as unknown as LlmClassifier;
        const feature = new BetaClassifier(client(), classifier, auditLogger(), interactionStore());

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
        const feature = new BetaClassifier(testClient, classifier, auditLogger(), interactionStore());

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
            interactionStore(),
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
        const staleFeature = new BetaClassifier(staleClient, staleClassifier, auditLogger(), interactionStore());
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
        const feature = new BetaClassifier(testClient, classifier, auditLogger(), interactionStore());

        await feature.process(message);
        await feature.drain();

        expect(feature.getMetrics()).toMatchObject({ responsesSent: 0, responseFailures: 1 });
    });

    it("logs a routed decision but does not respond when encrypted persistence fails", async () => {
        const testClient = client();
        testClient.config.beta_classifier!.response_enabled = true;
        const message = discordMessage();
        const classificationLog = vi.fn(async () => undefined);
        const feature = new BetaClassifier(
            testClient,
            {
                classifyLazy: vi.fn(async (_fallback, buildTask) => {
                    await buildTask();
                    return result("ROUTE");
                }),
                drain: vi.fn(async () => undefined),
            } as unknown as LlmClassifier,
            auditLogger(classificationLog),
            interactionStore({ completeClassifierRun: vi.fn(async () => Promise.reject(new Error("disk full"))) }),
        );

        await feature.process(message);
        await feature.drain();

        expect(classificationLog).toHaveBeenCalledTimes(1);
        expect(message.reply).not.toHaveBeenCalled();
        expect(testClient.logError).toHaveBeenCalledWith(
            "Beta classifier record save failed",
            expect.any(Error),
            false,
        );
        expect(feature.getMetrics().persistenceFailures).toBe(1);
    });

    it("contains synchronous failures locally without invoking Discord error logging", async () => {
        const testClient = client();
        const classifier = {
            classifyLazy: vi.fn(async () => result("IGNORE")),
            drain: vi.fn(async () => undefined),
        } as unknown as LlmClassifier;
        const feature = new BetaClassifier(testClient, classifier, auditLogger(), interactionStore());
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
        const feature = new BetaClassifier(client(), classifier, auditLogger(), interactionStore());

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
        const feature = new BetaClassifier(testClient, classifier, auditLogger(), interactionStore());

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
        const feature = new BetaClassifier(testClient, classifier, auditLogger(), interactionStore());

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
        const feature = new BetaClassifier(client(), classifier, auditLogger(), interactionStore());
        const relevantParent = discordMessage({
            id: "parent",
            content: "Why does 1.34.20 only show Wi-Fi?",
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
        expect(request!.input).toContain("Why does 1.34.20 only show Wi-Fi?");
        expect(request!.input).toContain("same here");
    });

    it("rejects a terse continuation when its parent is cross-channel or irrelevant", async () => {
        let request: ClassificationTask<"ROUTE" | "IGNORE"> | null = null;
        const classifyLazy = vi.fn(async (_fallback, buildTask) => {
            request = await buildTask();
            return result("IGNORE", request ? "ok" : "invalid_request");
        });
        const classifier = { classifyLazy, drain: vi.fn(async () => undefined) } as unknown as LlmClassifier;
        const feature = new BetaClassifier(client(), classifier, auditLogger(), interactionStore());
        const crossChannelParent = discordMessage({
            id: "parent",
            channelId: "other-channel",
            content: "Why does 1.34.20 only show Wi-Fi?",
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
