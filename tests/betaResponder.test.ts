import type { Message } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KrytenClient } from "../src/classes/client";
import { BetaResponder } from "../src/features/betaResponder/betaResponder";
import type { UserInteractionStore } from "../src/features/userInteractions/store";
import type { LlmClassifier, ClassificationResult, ClassificationTask } from "../src/llm/classifier";
import type { ClassificationLogger } from "../src/llm/classificationLogger";

vi.mock("../src/features/betaClassifier/promptFile", () => ({
    loadBetaClassifierPrompt: vi.fn(async () => ({
        version: "synthetic-retention-v1",
        systemInstruction: "Keep only relevant greetings.",
    })),
}));

const EMPTY_USAGE = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
};

interface GreetingPayload {
    content: string;
    allowedMentions: { parse: string[]; users: string[] };
}

describe("BetaResponder", () => {
    beforeEach(() => vi.useFakeTimers({ now: new Date("2026-08-12T06:00:00.000Z") }));
    afterEach(() => vi.useRealTimers());

    it("sends one plain campaign greeting, records it, and deletes it after the configured delay", async () => {
        const deleted = vi.fn(async () => undefined);
        const send = vi.fn(async (_payload: GreetingPayload) => ({ delete: deleted }) as unknown as Message);
        const setCampaignGreeting = vi.fn(async () => true);
        const interactions = interactionStore({ setCampaignGreeting });
        const responder = new BetaResponder(makeClient(), interactions, classifier(vi.fn()), logger());

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

    it("keeps a greeting when the relevance classifier returns KEEP", async () => {
        const deleted = vi.fn(async () => undefined);
        const send = vi.fn(async (_payload: GreetingPayload) => ({ delete: deleted }) as unknown as Message);
        let request: ClassificationTask<"KEEP" | "DELETE"> | null = null;
        const classifyLazy = vi.fn(async (_fallback, buildTask) => {
            request = await buildTask();
            return result("KEEP");
        });
        const classificationLog = vi.fn(async () => undefined);
        const responder = new BetaResponder(
            makeClient({ retention: true }),
            interactionStore(),
            classifier(classifyLazy),
            logger(classificationLog),
        );

        await responder.process(
            makeMessage(send, {
                content: "My direct USB connection keeps disconnecting.",
            }),
        );
        await responder.drain();
        await vi.advanceTimersByTimeAsync(45_000);

        expect(request).toMatchObject({
            systemInstruction: "Keep only relevant greetings.",
            allowedLabels: ["KEEP", "DELETE"],
            fallbackLabel: "DELETE",
        });
        expect(request!.input).toContain("My direct USB connection keeps disconnecting.");
        expect(request!.input).not.toContain("user-1");
        expect(deleted).not.toHaveBeenCalled();
        expect(classificationLog).toHaveBeenCalledWith(
            expect.objectContaining({ id: "message-1" }),
            expect.objectContaining({ label: "KEEP" }),
            expect.any(Function),
            { includeRawOutput: false },
        );
        const logCalls = classificationLog.mock.calls as unknown as Array<[unknown, unknown, () => boolean]>;
        expect(logCalls[0]?.[2]()).toBe(true);
        expect(responder.getMetrics()).toMatchObject({
            greetingsSent: 1,
            kept: 1,
            deleted: 0,
            submitted: 1,
            keep: 1,
            delete: 0,
            pendingGreetings: 0,
            pendingClassifications: 0,
            promptVersion: "synthetic-retention-v1",
            retentionEnabled: true,
        });
    });

    it("leaves the deletion timer active when the relevance classifier returns DELETE", async () => {
        const deleted = vi.fn(async () => undefined);
        const send = vi.fn(async (_payload: GreetingPayload) => ({ delete: deleted }) as unknown as Message);
        const responder = new BetaResponder(
            makeClient({ retention: true }),
            interactionStore(),
            classifier(vi.fn(async (_fallback, buildTask) => (await buildTask(), result("DELETE")))),
            logger(),
        );

        await responder.process(makeMessage(send, { content: "Hello everyone" }));
        await responder.drain();
        await vi.advanceTimersByTimeAsync(45_000);

        expect(deleted).toHaveBeenCalledOnce();
        expect(responder.getMetrics()).toMatchObject({ kept: 0, deleted: 1, keep: 0, delete: 1 });
    });

    it("can keep the original greeting when a follow-up becomes relevant during the decision window", async () => {
        const deleted = vi.fn(async () => undefined);
        const send = vi.fn(async (_payload: GreetingPayload) => ({ delete: deleted }) as unknown as Message);
        const labels = ["DELETE", "KEEP"] as const;
        let call = 0;
        const classifyLazy = vi.fn(async (_fallback, buildTask) => {
            await buildTask();
            return result(labels[call++] ?? "DELETE");
        });
        const responder = new BetaResponder(
            makeClient({ retention: true }),
            interactionStore(),
            classifier(classifyLazy),
            logger(),
        );

        await responder.process(makeMessage(send, { content: "I need help" }));
        await responder.drain();
        await vi.advanceTimersByTimeAsync(20_000);
        await responder.process(
            makeMessage(send, {
                id: "message-2",
                content: "The wired Quest connection resets every 15 minutes.",
                createdTimestamp: 2,
            }),
        );
        await responder.drain();
        await vi.advanceTimersByTimeAsync(25_000);

        expect(send).toHaveBeenCalledOnce();
        expect(classifyLazy).toHaveBeenCalledTimes(2);
        expect(deleted).not.toHaveBeenCalled();
        expect(responder.getMetrics()).toMatchObject({ greetingsSent: 1, kept: 1, submitted: 2, keep: 1, delete: 1 });
    });

    it("coalesces follow-ups that arrive while classification is in flight", async () => {
        const deleted = vi.fn(async () => undefined);
        const send = vi.fn(async (_payload: GreetingPayload) => ({ delete: deleted }) as unknown as Message);
        let resolveFirst!: (value: ClassificationResult<"KEEP" | "DELETE">) => void;
        const firstResult = new Promise<ClassificationResult<"KEEP" | "DELETE">>(resolve => {
            resolveFirst = resolve;
        });
        const requests: ClassificationTask<"KEEP" | "DELETE">[] = [];
        let call = 0;
        const classifyLazy = vi.fn(async (_fallback, buildTask) => {
            const request = await buildTask();
            if (request) requests.push(request);
            return call++ === 0 ? firstResult : result("KEEP");
        });
        const responder = new BetaResponder(
            makeClient({ retention: true }),
            interactionStore(),
            classifier(classifyLazy),
            logger(),
        );

        await responder.process(makeMessage(send, { content: "I need help" }));
        await responder.process(
            makeMessage(send, {
                id: "message-2",
                content: "It is the direct USB connection.",
                createdTimestamp: 2,
            }),
        );

        expect(classifyLazy).toHaveBeenCalledOnce();
        resolveFirst(result("DELETE"));
        await vi.waitFor(() => expect(classifyLazy).toHaveBeenCalledTimes(2));
        await responder.drain();

        expect(requests[1]?.input).toContain("I need help");
        expect(requests[1]?.input).toContain("It is the direct USB connection.");
        expect(deleted).not.toHaveBeenCalled();
        expect(responder.getMetrics()).toMatchObject({ kept: 1, submitted: 2, pendingClassifications: 0 });
    });

    it("uses at most the trigger and first follow-up for a greeting", async () => {
        const deleted = vi.fn(async () => undefined);
        const send = vi.fn(async (_payload: GreetingPayload) => ({ delete: deleted }) as unknown as Message);
        const requests: ClassificationTask<"KEEP" | "DELETE">[] = [];
        const classifyLazy = vi.fn(async (_fallback, buildTask) => {
            const request = await buildTask();
            if (request) requests.push(request);
            return result("DELETE");
        });
        const responder = new BetaResponder(
            makeClient({ retention: true }),
            interactionStore(),
            classifier(classifyLazy),
            logger(),
        );

        await responder.process(makeMessage(send, { content: "Initial question" }));
        await responder.drain();
        await responder.process(
            makeMessage(send, { id: "message-2", content: "First follow-up", createdTimestamp: 2 }),
        );
        await responder.drain();
        await responder.process(
            makeMessage(send, { id: "message-3", content: "Second follow-up", createdTimestamp: 3 }),
        );
        await responder.drain();

        expect(classifyLazy).toHaveBeenCalledTimes(2);
        expect(requests[1]?.input).toContain("Initial question");
        expect(requests[1]?.input).toContain("First follow-up");
        expect(requests[1]?.input).not.toContain("Second follow-up");
    });

    it("does not keep a greeting when classification finishes after the deletion window", async () => {
        const deleted = vi.fn(async () => undefined);
        const send = vi.fn(async (_payload: GreetingPayload) => ({ delete: deleted }) as unknown as Message);
        let resolveClassification!: (value: ClassificationResult<"KEEP" | "DELETE">) => void;
        const provider = new Promise<ClassificationResult<"KEEP" | "DELETE">>(resolve => {
            resolveClassification = resolve;
        });
        const classifyLazy = vi.fn(async (_fallback, buildTask) => {
            await buildTask();
            return provider;
        });
        const responder = new BetaResponder(
            makeClient({ retention: true }),
            interactionStore(),
            classifier(classifyLazy),
            logger(),
        );

        await responder.process(makeMessage(send));
        await vi.advanceTimersByTimeAsync(45_000);
        resolveClassification(result("KEEP"));
        await responder.drain();

        expect(deleted).toHaveBeenCalledOnce();
        expect(responder.getMetrics()).toMatchObject({ kept: 0, deleted: 1 });
    });

    it("rejects an overdue KEEP even when the deletion timer callback is delayed", async () => {
        const deleted = vi.fn(async () => undefined);
        const send = vi.fn(async (_payload: GreetingPayload) => ({ delete: deleted }) as unknown as Message);
        let resolveClassification!: (value: ClassificationResult<"KEEP" | "DELETE">) => void;
        const provider = new Promise<ClassificationResult<"KEEP" | "DELETE">>(resolve => {
            resolveClassification = resolve;
        });
        const responder = new BetaResponder(
            makeClient({ retention: true }),
            interactionStore(),
            classifier(
                vi.fn(async (_fallback, buildTask) => {
                    await buildTask();
                    return provider;
                }),
            ),
            logger(),
        );

        await responder.process(makeMessage(send));
        vi.setSystemTime(new Date("2026-08-12T06:00:46.000Z"));
        resolveClassification(result("KEEP"));
        await responder.drain();
        await vi.runOnlyPendingTimersAsync();

        expect(deleted).toHaveBeenCalledOnce();
        expect(responder.getMetrics()).toMatchObject({ kept: 0, ignoredLateKeeps: 1, deleted: 1 });
    });

    it("deletes pending greetings during graceful shutdown", async () => {
        const deleted = vi.fn(async () => undefined);
        const send = vi.fn(async (_payload: GreetingPayload) => ({ delete: deleted }) as unknown as Message);
        const responder = new BetaResponder(
            makeClient({ retention: true }),
            interactionStore(),
            classifier(vi.fn(async (_fallback, buildTask) => (await buildTask(), result("DELETE")))),
            logger(),
        );

        await responder.process(makeMessage(send));
        await responder.drain();
        await responder.stop();

        expect(deleted).toHaveBeenCalledOnce();
        expect(responder.getMetrics()).toMatchObject({ pendingGreetings: 0, deleted: 1 });
    });

    it("deletes retention-disabled greetings during graceful shutdown", async () => {
        const deleted = vi.fn(async () => undefined);
        const send = vi.fn(async (_payload: GreetingPayload) => ({ delete: deleted }) as unknown as Message);
        const responder = new BetaResponder(makeClient(), interactionStore(), classifier(vi.fn()), logger());

        await responder.process(makeMessage(send));
        await responder.stop();

        expect(deleted).toHaveBeenCalledOnce();
        expect(responder.getMetrics()).toMatchObject({ pendingGreetings: 0, deleted: 1 });
    });

    it("deletes a greeting whose send completes while shutdown is in progress", async () => {
        const deleted = vi.fn(async () => undefined);
        let resolveSend!: (message: Message) => void;
        const sent = new Promise<Message>(resolve => {
            resolveSend = resolve;
        });
        const send = vi.fn(async (_payload: GreetingPayload) => sent);
        const responder = new BetaResponder(makeClient(), interactionStore(), classifier(vi.fn()), logger());

        const processing = responder.process(makeMessage(send));
        await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
        const stopping = responder.stop();
        resolveSend({ delete: deleted } as unknown as Message);
        await Promise.all([processing, stopping]);

        expect(deleted).toHaveBeenCalledOnce();
        expect(responder.getMetrics()).toMatchObject({ pendingGreetings: 0, pendingDeletions: 0, deleted: 1 });
    });

    it("does not replace an active greeting after a campaign reload", async () => {
        const deleted = vi.fn(async () => undefined);
        const send = vi.fn(async (_payload: GreetingPayload) => ({ delete: deleted }) as unknown as Message);
        const client = makeClient({ retention: true });
        const responder = new BetaResponder(
            client,
            interactionStore(),
            classifier(vi.fn(async (_fallback, buildTask) => (await buildTask(), result("DELETE")))),
            logger(),
        );

        await responder.process(makeMessage(send));
        await responder.drain();
        client.config.beta_classifier = {
            ...client.config.beta_classifier,
            campaign_id: "replacement-campaign",
        };
        await responder.process(makeMessage(send, { id: "message-2" }));

        expect(send).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(45_000);
        expect(deleted).toHaveBeenCalledOnce();
    });

    it("revokes queued retention work when the user generation changes", async () => {
        const deleted = vi.fn(async () => undefined);
        const send = vi.fn(async (_payload: GreetingPayload) => ({ delete: deleted }) as unknown as Message);
        let current = true;
        let release!: () => void;
        const gate = new Promise<void>(resolve => {
            release = resolve;
        });
        let request: ClassificationTask<"KEEP" | "DELETE"> | null = null;
        const interactions = interactionStore({ isUserGeneration: vi.fn(() => current) });
        const responder = new BetaResponder(
            makeClient({ retention: true }),
            interactions,
            classifier(
                vi.fn(async (_fallback, buildTask) => {
                    await gate;
                    request = await buildTask();
                    return result("KEEP");
                }),
            ),
            logger(),
        );

        await responder.process(makeMessage(send));
        current = false;
        release();
        await responder.drain();
        await vi.advanceTimersByTimeAsync(45_000);

        expect(request).toBeNull();
        expect(deleted).toHaveBeenCalledOnce();
        expect(responder.getMetrics()).toMatchObject({ kept: 0, ignoredStaleKeeps: 1, deleted: 1 });
    });

    it("retries transient greeting deletion failures", async () => {
        const deleted = vi
            .fn<() => Promise<void>>()
            .mockRejectedValueOnce(new Error("transient one"))
            .mockRejectedValueOnce(new Error("transient two"))
            .mockResolvedValue(undefined);
        const send = vi.fn(async (_payload: GreetingPayload) => ({ delete: deleted }) as unknown as Message);
        const responder = new BetaResponder(makeClient(), interactionStore(), classifier(vi.fn()), logger());

        await responder.process(makeMessage(send));
        await vi.advanceTimersByTimeAsync(45_000);
        await vi.runAllTimersAsync();

        expect(deleted).toHaveBeenCalledTimes(3);
        expect(responder.getMetrics()).toMatchObject({ deleted: 1, deletionRetries: 2, deletionFailures: 0 });
    });

    it("deletes immediately when the greeting marker generation was revoked", async () => {
        const deleted = vi.fn(async () => undefined);
        const send = vi.fn(async (_payload: GreetingPayload) => ({ delete: deleted }) as unknown as Message);
        const responder = new BetaResponder(
            makeClient({ retention: true }),
            interactionStore({ setCampaignGreeting: vi.fn(async () => false) }),
            classifier(vi.fn()),
            logger(),
        );

        await responder.process(makeMessage(send));
        await responder.drain();

        expect(deleted).toHaveBeenCalledOnce();
        expect(responder.getMetrics()).toMatchObject({ pendingGreetings: 0, deleted: 1, submitted: 0 });
    });

    it("leaves pending greetings on the deletion path when retention is disabled by config reload", async () => {
        const deleted = vi.fn(async () => undefined);
        const send = vi.fn(async (_payload: GreetingPayload) => ({ delete: deleted }) as unknown as Message);
        let resolveClassification!: (value: ClassificationResult<"KEEP" | "DELETE">) => void;
        const provider = new Promise<ClassificationResult<"KEEP" | "DELETE">>(resolve => {
            resolveClassification = resolve;
        });
        const testClient = makeClient({ retention: true });
        const responder = new BetaResponder(
            testClient,
            interactionStore(),
            classifier(
                vi.fn(async (_fallback, buildTask) => {
                    await buildTask();
                    return provider;
                }),
            ),
            logger(),
        );

        await responder.process(makeMessage(send));
        testClient.config.beta_classifier = {
            ...testClient.config.beta_classifier,
            target_greeting_retention_enabled: false,
        };
        resolveClassification(result("KEEP"));
        await responder.drain();
        await vi.advanceTimersByTimeAsync(45_000);

        expect(deleted).toHaveBeenCalledOnce();
        expect(responder.getMetrics()).toMatchObject({ kept: 0, deleted: 1, retentionEnabled: false });
    });

    it("suppresses users present in the campaign backfill", async () => {
        const send = vi.fn();
        const interactions = interactionStore({
            getCampaignGreeting: vi.fn(async () => ({
                record: { campaignId: "direct-usb-beta-v1" },
                generation: 0,
            })),
        });

        await new BetaResponder(makeClient(), interactions, classifier(vi.fn()), logger()).process(makeMessage(send));

        expect(send).not.toHaveBeenCalled();
        expect(interactions.setCampaignGreeting).not.toHaveBeenCalled();
    });
});

function makeClient(options: { retention?: boolean } = {}): KrytenClient {
    return {
        config: {
            beta_classifier: {
                target_greeting_enabled: true,
                target_greeting_retention_enabled: options.retention ?? false,
                target_greeting_delete_after_seconds: 45,
                target_greeting_prompt_file: options.retention ? "/private/beta-greeting-prompt.json" : undefined,
                announcements_channel_id: "announcements-1",
                target_channel_id: "beta-1",
                campaign_id: "direct-usb-beta-v1",
                campaign_started_at: "2026-08-12T05:00:00.000Z",
            },
            llm_classifier: options.retention
                ? {
                      enabled: true,
                      provider: "fireworks",
                      model: "accounts/fireworks/models/example",
                  }
                : undefined,
        },
    } as KrytenClient;
}

function makeMessage(send: ReturnType<typeof vi.fn>, overrides: Record<string, unknown> = {}): Message {
    return {
        id: "message-1",
        guildId: "guild-1",
        author: { id: "user-1", bot: false },
        member: null,
        channelId: "beta-1",
        content: "A message",
        createdTimestamp: 1,
        reference: null,
        channel: { send },
        url: "https://discord.com/channels/guild-1/beta-1/message-1",
        ...overrides,
    } as unknown as Message;
}

function interactionStore(overrides: Record<string, unknown> = {}): UserInteractionStore {
    return {
        getCampaignGreeting: vi.fn(async () => ({ generation: 3 })),
        setCampaignGreeting: vi.fn(async () => true),
        isUserGeneration: vi.fn(() => true),
        ...overrides,
    } as unknown as UserInteractionStore;
}

function classifier(classifyLazy: ReturnType<typeof vi.fn>): LlmClassifier {
    return {
        classifyLazy,
        drain: vi.fn(async () => undefined),
    } as unknown as LlmClassifier;
}

function logger(log = vi.fn(async () => undefined)): ClassificationLogger {
    return { log } as unknown as ClassificationLogger;
}

function result(
    label: "KEEP" | "DELETE",
    status: ClassificationResult<"KEEP" | "DELETE">["status"] = "ok",
): ClassificationResult<"KEEP" | "DELETE"> {
    return { label, status, latencyMs: 1, usage: { ...EMPTY_USAGE } };
}
