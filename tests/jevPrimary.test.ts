import { describe, expect, it, vi } from "vitest";
import { createLlmClassifier } from "../src/llm/classifier";
import type { LlmClassifierConfig } from "../src/types";

const config = (): LlmClassifierConfig => ({ enabled: true, provider: "typesafe", model: "jev-1.13.0" });
const task = (greeting = false) => ({
    systemInstruction: "Apply the synthetic policy.",
    input: "[TARGET] synthetic input",
    allowedLabels: greeting ? ["KEEP", "DELETE"] : ["ROUTE", "IGNORE"],
    fallbackLabel: greeting ? "DELETE" : "IGNORE",
});
function response(greeting = false) {
    return Response.json({
        model: "jev-1.13.0",
        answers: {
            decision: {
                type: "choice",
                choice: greeting ? "KEEP" : "ROUTE",
                probabilities: greeting ? { KEEP: 0.8, DELETE: 0.2 } : { ROUTE: 0.8, IGNORE: 0.2 },
                confidence: 0.7,
            },
        },
        usage: { input_tokens: 12, output_tokens: 4 },
    });
}

describe("Jev primary", () => {
    it.each([false, true])("selects only Jev with shared task criteria (greeting=%s)", async greeting => {
        const source = config();
        const transport = vi.fn(async () => response(greeting));
        const classifier = createLlmClassifier(() => source, transport as typeof fetch, {
            TYPESAFE_API_KEY: "synthetic",
        });
        const observer = vi.fn();
        const result = await classifier.classifyLazy(
            task(greeting).fallbackLabel,
            async () => task(greeting),
            () => true,
            observer,
        );
        expect(result).toMatchObject({
            status: "ok",
            label: greeting ? "KEEP" : "ROUTE",
            provider: "typesafe",
            model: "jev-1.13.0",
            usage: { inputTokens: 12, outputTokens: 4, cachedInputTokens: 0, reasoningTokens: 0, totalTokens: 16 },
        });
        expect(observer).not.toHaveBeenCalled();
        expect(transport).toHaveBeenCalledTimes(1);
        expect(transport.mock.calls[0]![0]).toBe("https://api.typesafe.ai/v1/systemone");
        const body = JSON.parse(String(transport.mock.calls[0]![1].body));
        expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
        expect(body.questions.decision.criteria[greeting ? "KEEP" : "ROUTE"]).toContain(
            greeting ? "greeting should be kept" : "in scope for beta routing",
        );
        expect(classifier.getMetrics()).toMatchObject({
            provider: "typesafe",
            model: "jev-1.13.0",
            completed: 1,
            totalTokens: 16,
        });
    });
    it.each([false, true])("fails closed on malformed and unavailable Jev (greeting=%s)", async greeting => {
        for (const transport of [
            vi.fn(async () => Response.json({})),
            vi.fn(async () => {
                throw new Error("offline");
            }),
        ]) {
            const source = config();
            const classifier = createLlmClassifier(() => source, transport as typeof fetch, {
                TYPESAFE_API_KEY: "synthetic",
            });
            expect(await classifier.classify(task(greeting))).toMatchObject({ label: task(greeting).fallbackLabel });
            expect(transport).toHaveBeenCalledTimes(1);
        }
    });
    it("rejects work built across config replacement", async () => {
        let source = config();
        const transport = vi.fn();
        const classifier = createLlmClassifier(() => source, transport, { TYPESAFE_API_KEY: "synthetic" });
        const result = await classifier.classifyLazy("IGNORE", async () => {
            source = config();
            return task();
        });
        expect(result).toMatchObject({ label: "IGNORE", status: "disabled" });
        expect(transport).not.toHaveBeenCalled();
    });
    it("uses safe Jev defaults even when Fireworks limits remain", async () => {
        vi.useFakeTimers();
        try {
            const source = {
                ...config(),
                timeout_ms: 300000,
                max_output_tokens: 131072,
                max_concurrency: 20,
                max_queue_depth: 25,
            };
            const transport = vi.fn(
                (_url: unknown, init: RequestInit) =>
                    new Promise<Response>((_resolve, reject) => {
                        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
                    }),
            );
            const classifier = createLlmClassifier(() => source, transport as typeof fetch, {
                TYPESAFE_API_KEY: "synthetic",
            });
            const work = Array.from({ length: 7 }, () => classifier.classify(task()));
            await vi.advanceTimersByTimeAsync(0);
            expect(transport).toHaveBeenCalledTimes(2);
            expect(await work[6]).toMatchObject({ status: "queue_full", label: "IGNORE" });
            await vi.advanceTimersByTimeAsync(2500);
            expect(await work[0]).toMatchObject({ status: "timeout", label: "IGNORE" });
            classifier.close();
            await Promise.all(work);
            await classifier.drain();
        } finally {
            vi.useRealTimers();
        }
    });
    it("drops queued work across reload before building and rejects an old positive response", async () => {
        let source = { ...config(), max_concurrency: 1 };
        let release!: (response: Response) => void;
        const transport = vi.fn(
            () =>
                new Promise<Response>(resolve => {
                    release = resolve;
                }),
        );
        const classifier = createLlmClassifier(() => source, transport as typeof fetch, {
            TYPESAFE_API_KEY: "synthetic",
        });
        const first = classifier.classify(task());
        await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
        const build = vi.fn(async () => task());
        const queued = classifier.classifyLazy("IGNORE", build);
        source = { ...source };
        classifier.reconfigure();
        expect(await queued).toMatchObject({ status: "disabled", label: "IGNORE" });
        release(response());
        expect(await first).toMatchObject({ status: "disabled", label: "IGNORE" });
        expect(build).not.toHaveBeenCalled();
        await classifier.drain();
    });
    it("rejects an expired lazy build without transmitting it", async () => {
        vi.useFakeTimers();
        try {
            const source = config();
            const transport = vi.fn();
            const classifier = createLlmClassifier(() => source, transport, { TYPESAFE_API_KEY: "synthetic" });
            const result = classifier.classifyLazy("IGNORE", async () => {
                await new Promise(resolve => setTimeout(resolve, 3001));
                return task();
            });
            await vi.advanceTimersByTimeAsync(3001);
            expect(await result).toMatchObject({ status: "stale", label: "IGNORE" });
            expect(transport).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
    it("cancels active transport and queued builders at shutdown", async () => {
        const source = { ...config(), max_concurrency: 1 };
        let signal: AbortSignal | undefined;
        const transport = vi.fn(
            (_url: unknown, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    signal = init.signal!;
                    signal.addEventListener("abort", () => reject(signal!.reason), { once: true });
                }),
        );
        const classifier = createLlmClassifier(() => source, transport as typeof fetch, {
            TYPESAFE_API_KEY: "synthetic",
        });
        const first = classifier.classify(task());
        await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
        const build = vi.fn(async () => task());
        const queued = classifier.classifyLazy("IGNORE", build);
        classifier.close();
        expect(signal?.aborted).toBe(true);
        expect(await first).toMatchObject({ status: "disabled", label: "IGNORE" });
        expect(await queued).toMatchObject({ status: "disabled", label: "IGNORE" });
        expect(build).not.toHaveBeenCalled();
        await classifier.drain();
        expect(await classifier.classify(task())).toMatchObject({ status: "disabled" });
    });
    it("uses no provider fallback when the Jev credential is absent", async () => {
        const source = config();
        const transport = vi.fn();
        const classifier = createLlmClassifier(() => source, transport, { FIREWORKS_API_KEY: "synthetic" });
        expect(await classifier.classify(task())).toMatchObject({ status: "missing_api_key", label: "IGNORE" });
        expect(transport).not.toHaveBeenCalled();
    });
    it("rejects a positive result after the caller deadline", async () => {
        const source = config();
        let allowed = true;
        const transport = vi.fn(async () => {
            allowed = false;
            return response();
        });
        const classifier = createLlmClassifier(() => source, transport as typeof fetch, {
            TYPESAFE_API_KEY: "synthetic",
        });
        expect(
            await classifier.classifyLazy(
                "IGNORE",
                async () => task(),
                () => allowed,
            ),
        ).toMatchObject({ label: "IGNORE", status: "disabled" });
    });
    it("enforces the shared request-rate budget before building input", async () => {
        const source = { ...config(), max_requests_per_minute: 1 };
        const transport = vi.fn(async () => response());
        const classifier = createLlmClassifier(() => source, transport as typeof fetch, {
            TYPESAFE_API_KEY: "synthetic",
        });
        await classifier.classify(task());
        const build = vi.fn(async () => task());
        expect(await classifier.classifyLazy("IGNORE", build)).toMatchObject({
            status: "rate_limited",
            label: "IGNORE",
        });
        expect(build).not.toHaveBeenCalled();
        expect(transport).toHaveBeenCalledTimes(1);
    });
    it("rejects stale queued work before its builder runs", async () => {
        vi.useFakeTimers();
        try {
            const source = { ...config(), max_concurrency: 1 };
            let release!: (response: Response) => void;
            const transport = vi.fn(
                () =>
                    new Promise<Response>(resolve => {
                        release = resolve;
                    }),
            );
            const classifier = createLlmClassifier(() => source, transport as typeof fetch, {
                TYPESAFE_API_KEY: "synthetic",
            });
            const first = classifier.classify(task());
            await vi.advanceTimersByTimeAsync(0);
            const build = vi.fn(async () => task());
            const queued = classifier.classifyLazy("IGNORE", build);
            await vi.advanceTimersByTimeAsync(3001);
            release(response());
            expect(await first).toMatchObject({ label: "IGNORE" });
            expect(await queued).toMatchObject({ status: "stale", label: "IGNORE" });
            expect(build).not.toHaveBeenCalled();
            expect(transport).toHaveBeenCalledTimes(1);
            await classifier.drain();
        } finally {
            vi.useRealTimers();
        }
    });
    it("aborts the old Fireworks transport when reloading to Jev primary", async () => {
        let source: LlmClassifierConfig = { enabled: true, provider: "fireworks", model: "synthetic-model" };
        let signal: AbortSignal | undefined;
        const transport = vi.fn((url: unknown, init: RequestInit) => {
            if (url === "https://api.typesafe.ai/v1/systemone") return Promise.resolve(response());
            return new Promise<Response>((_resolve, reject) => {
                signal = init.signal!;
                signal.addEventListener("abort", () => reject(signal!.reason), { once: true });
            });
        });
        const classifier = createLlmClassifier(() => source, transport as typeof fetch, {
            FIREWORKS_API_KEY: "synthetic",
            TYPESAFE_API_KEY: "synthetic",
        });
        const old = classifier.classify(task());
        await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
        source = config();
        classifier.reconfigure();
        expect(signal?.aborted).toBe(true);
        expect(await old).toMatchObject({ provider: "fireworks", label: "IGNORE", status: "disabled" });
        expect(await classifier.classify(task())).toMatchObject({ provider: "typesafe", label: "ROUTE", status: "ok" });
        expect(transport).toHaveBeenCalledTimes(2);
        classifier.close();
        await classifier.drain();
    });
});
