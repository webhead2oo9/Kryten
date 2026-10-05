import { describe, expect, it, vi } from "vitest";
import { createLlmClassifier, type ClassificationTask } from "../src/llm/classifier";
import type { LlmClassifierConfig } from "../src/types";

const config = (): LlmClassifierConfig => ({
    enabled: true,
    provider: "clef",
    model: "Cloudflare/clef-flash",
});

function task(kind: "beta_routing" | "beta_greeting" = "beta_routing"): ClassificationTask<string> {
    return {
        systemInstruction: "This private cloud-provider prompt must not be sent.",
        input: "This transcript wrapper must not be sent.",
        allowedLabels: kind === "beta_routing" ? ["ROUTE", "IGNORE"] : ["KEEP", "DELETE"],
        fallbackLabel: kind === "beta_routing" ? "IGNORE" : "DELETE",
        clef: {
            taskType: kind,
            messages:
                kind === "beta_routing"
                    ? ["Where can I download the Beta Streamer for the current Quest beta?"]
                    : ["hello", "Where can I download the Beta Streamer for the current Quest beta?"],
        },
    };
}

function response(label: string, probabilities: Record<string, number>): Response {
    return Response.json({
        model: "Cloudflare/clef-flash",
        answers: { decision: { type: "choice", choice: label, probabilities, confidence: 0.8 } },
        usage: { input_tokens: 123, output_tokens: 0 },
    });
}

describe("Clef primary", () => {
    it.each([
        ["beta_routing", "ROUTE", { ROUTE: 0.8, IGNORE: 0.2 }],
        ["beta_greeting", "KEEP", { KEEP: 0.8, DELETE: 0.2 }],
    ] as const)("uses only the pinned local endpoint and compact %s policy", async (kind, label, probabilities) => {
        const source = config();
        const transport = vi.fn(async () => response(label, probabilities));
        const observer = vi.fn();
        const classifier = createLlmClassifier(() => source, transport as typeof fetch, {
            FIREWORKS_API_KEY: "must-not-be-used",
            TYPESAFE_API_KEY: "must-not-be-used",
        });

        const result = await classifier.classifyLazy(
            kind === "beta_routing" ? "IGNORE" : "DELETE",
            async () => task(kind),
            () => true,
            observer,
        );

        expect(result).toMatchObject({
            status: "ok",
            label,
            provider: "clef",
            model: "Cloudflare/clef-flash",
            usage: { inputTokens: 123, outputTokens: 0, totalTokens: 123 },
        });
        expect(observer).not.toHaveBeenCalled();
        expect(transport).toHaveBeenCalledOnce();
        const [url, init] = transport.mock.calls[0]!;
        expect(url).toBe("http://127.0.0.1:58756/v1/systemone");
        expect(init).toMatchObject({ method: "POST", redirect: "error" });
        expect((init as RequestInit).headers).not.toHaveProperty("Authorization");
        const body = JSON.parse(String((init as RequestInit).body));
        expect(body.model).toBe("clef-flash");
        expect(body.state).toEqual({
            policy_version: kind === "beta_routing" ? "kryten-beta-routing-v1" : "kryten-beta-greeting-v1",
            messages: task(kind).clef!.messages,
        });
        expect(JSON.stringify(body)).not.toContain("private cloud-provider prompt");
        expect(JSON.stringify(body)).not.toContain("transcript wrapper");
        if (kind === "beta_routing") {
            expect(body.questions.decision.instructions).toContain("otherwise qualifying failure");
            expect(body.questions.decision.criteria.ROUTE).toContain("Link cables and charging cables");
            expect(body.questions.decision.criteria.IGNORE).toContain("Steam-edition Virtual Desktop");
        } else {
            expect(body.questions.decision.criteria.KEEP).toContain("Beta Streamer");
        }
    });

    it("requires no credential and never falls back or retries", async () => {
        const transport = vi.fn(async () => new Response("unavailable", { status: 503 }));
        const source = config();
        const classifier = createLlmClassifier(() => source, transport as typeof fetch, {});
        await expect(classifier.classify(task())).resolves.toMatchObject({
            provider: "clef",
            label: "IGNORE",
            status: "http_error",
        });
        expect(transport).toHaveBeenCalledOnce();
    });

    it.each([
        [{ model: "wrong", answers: {} }, "invalid_response"],
        [
            {
                model: "Cloudflare/clef-flash",
                answers: {
                    decision: {
                        type: "choice",
                        choice: "ROUTE",
                        probabilities: { ROUTE: 1.1, IGNORE: -0.1 },
                        confidence: 1,
                    },
                },
                usage: { input_tokens: 1, output_tokens: 0 },
            },
            "invalid_response",
        ],
    ])("rejects malformed identity, labels, probabilities, and usage", async (payload, status) => {
        const source = config();
        const classifier = createLlmClassifier(
            () => source,
            vi.fn(async () => Response.json(payload)) as typeof fetch,
            {},
        );
        await expect(classifier.classify(task())).resolves.toMatchObject({ status, label: "IGNORE" });
    });

    it("bounds request and response bodies before accepting a result", async () => {
        const oversized = task();
        oversized.clef!.messages = ["x".repeat(4_001)];
        const transport = vi.fn(async () => new Response("{}", { headers: { "content-length": "16385" } }));
        const source = config();
        const classifier = createLlmClassifier(() => source, transport as typeof fetch, {});
        await expect(classifier.classify(oversized)).resolves.toMatchObject({ status: "invalid_request" });
        expect(transport).not.toHaveBeenCalled();

        await expect(classifier.classify(task())).resolves.toMatchObject({ status: "invalid_response" });
    });

    it("shares one request slot, a two-item queue, and an inclusive 15-second deadline", async () => {
        vi.useFakeTimers();
        try {
            let firstSignal: AbortSignal | undefined;
            const transport = vi.fn(
                (_url: unknown, init: RequestInit) =>
                    new Promise<Response>((_resolve, reject) => {
                        firstSignal ??= init.signal!;
                        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
                    }),
            );
            const source = config();
            const classifier = createLlmClassifier(() => source, transport as typeof fetch, {});
            const work = Array.from({ length: 4 }, () => classifier.classify(task()));
            await vi.advanceTimersByTimeAsync(0);
            expect(transport).toHaveBeenCalledTimes(1);
            expect(await work[3]).toMatchObject({ status: "queue_full" });
            await vi.advanceTimersByTimeAsync(15_000);
            expect(firstSignal?.aborted).toBe(true);
            expect(await work[0]).toMatchObject({ status: "timeout" });
            expect(await work[1]).toMatchObject({ status: "stale" });
            expect(await work[2]).toMatchObject({ status: "stale" });
            expect(transport).toHaveBeenCalledTimes(1);
            await classifier.drain();
        } finally {
            vi.useRealTimers();
        }
    });

    it("lets greeting work use its remaining absolute window across queue and request time", async () => {
        vi.useFakeTimers({ now: new Date("2026-08-12T06:00:00.000Z") });
        try {
            const deadlineAt = Date.now() + 240_000;
            let resolveFirst!: () => void;
            const firstBlocked = new Promise<void>(resolve => {
                resolveFirst = resolve;
            });
            let secondSignal: AbortSignal | undefined;
            let calls = 0;
            const transport = vi.fn(async (_url: unknown, init: RequestInit) => {
                calls++;
                if (calls === 1) {
                    await firstBlocked;
                    return response("KEEP", { KEEP: 0.8, DELETE: 0.2 });
                }
                secondSignal = init.signal;
                return new Promise<Response>((_resolve, reject) => {
                    init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
                });
            });
            const source = config();
            const classifier = createLlmClassifier(() => source, transport as typeof fetch, {});
            const first = classifier.classifyLazy("DELETE", async () => task("beta_greeting"), () => true, undefined, {
                clefGreetingDeadlineAt: deadlineAt,
            });
            const second = classifier.classifyLazy("DELETE", async () => task("beta_greeting"), () => true, undefined, {
                clefGreetingDeadlineAt: deadlineAt,
            });

            await vi.advanceTimersByTimeAsync(30_000);
            resolveFirst();
            await expect(first).resolves.toMatchObject({ status: "ok", label: "KEEP" });
            await vi.advanceTimersByTimeAsync(0);
            expect(transport).toHaveBeenCalledTimes(2);
            expect(secondSignal?.aborted).toBe(false);

            await vi.advanceTimersByTimeAsync(209_999);
            expect(secondSignal?.aborted).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(secondSignal?.aborted).toBe(true);
            await expect(second).resolves.toMatchObject({ status: "timeout", label: "DELETE" });
        } finally {
            vi.useRealTimers();
        }
    });
});
