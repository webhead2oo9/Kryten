import { describe, expect, it, vi } from "vitest";
import { LlmClassifier } from "../src/llm/classifier";
import type { LlmClassifierConfig } from "../src/types";

const task = {
    systemInstruction: "Classify the supplied conversation.",
    input: "A synthetic conversation.",
    allowedLabels: ["ROUTE", "IGNORE"] as const,
    fallbackLabel: "IGNORE" as const,
};

function config(overrides: LlmClassifierConfig = {}): LlmClassifierConfig {
    return {
        enabled: true,
        provider: "fireworks",
        model: "accounts/fireworks/models/example",
        timeout_ms: 1_000,
        max_concurrency: 1,
        max_queue_depth: 1,
        ...overrides,
    };
}

function configSource(overrides: LlmClassifierConfig = {}): () => LlmClassifierConfig {
    const value = config(overrides);
    return () => value;
}

function completion(content: unknown, usage?: object): Response {
    return Response.json({ choices: [{ message: { content } }], usage });
}

describe("LlmClassifier", () => {
    it("uses the fixed Fireworks endpoint and accepts a whitespace-padded exact label", async () => {
        const fetchImpl = vi.fn(async () =>
            completion("  ROUTE\n", {
                prompt_tokens: 12,
                prompt_tokens_details: { cached_tokens: 4 },
                completion_tokens: 20,
                total_tokens: 32,
                completion_tokens_details: { reasoning_tokens: 18 },
            }),
        );
        const classifier = new LlmClassifier(configSource(), fetchImpl as typeof fetch, {
            FIREWORKS_API_KEY: "test-key",
        });

        const result = await classifier.classify(task);

        expect(result).toMatchObject({ label: "ROUTE", status: "ok" });
        expect(result.usage).toEqual({
            inputTokens: 12,
            cachedInputTokens: 4,
            outputTokens: 20,
            reasoningTokens: 18,
            totalTokens: 32,
        });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0]!;
        expect(url).toBe("https://api.fireworks.ai/inference/v1/chat/completions");
        expect(init).toMatchObject({ method: "POST", redirect: "error" });
        expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer test-key" });
        const body = JSON.parse(String((init as RequestInit).body)) as Record<string, unknown>;
        expect(body).toMatchObject({
            model: "accounts/fireworks/models/example",
            max_tokens: 131_072,
            temperature: 0,
            top_k: 40,
            stream: false,
        });
        expect(body).not.toHaveProperty("reasoning_effort");
        expect(classifier.getMetrics()).toMatchObject({
            submitted: 1,
            completed: 1,
            fallbacks: 0,
            inputTokens: 12,
            cachedInputTokens: 4,
            outputTokens: 20,
            reasoningTokens: 18,
            totalTokens: 32,
        });
    });

    it("fails closed when the provider adds prose to an otherwise allowed label", async () => {
        const classifier = new LlmClassifier(
            configSource(),
            vi.fn(async () => completion("ROUTE because this is relevant")) as typeof fetch,
            { FIREWORKS_API_KEY: "test-key" },
        );

        await expect(classifier.classify(task)).resolves.toMatchObject({
            label: "IGNORE",
            status: "invalid_label",
            providerFailure: {
                provider: "fireworks",
                code: "invalid_label",
                rawOutput: "ROUTE because this is relevant",
            },
        });
    });

    it.each([
        [400, "bad_request", "http_error"],
        [401, "unauthorized", "http_error"],
        [402, "payment_required", "http_error"],
        [403, "forbidden", "http_error"],
        [404, "not_found", "http_error"],
        [405, "method_not_allowed", "http_error"],
        [408, "request_timeout", "timeout"],
        [412, "precondition_failed", "http_error"],
        [413, "payload_too_large", "http_error"],
        [429, "rate_limited", "rate_limited"],
        [500, "internal_server_error", "http_error"],
        [502, "bad_gateway", "http_error"],
        [503, "service_unavailable", "http_error"],
        [504, "gateway_timeout", "timeout"],
        [520, "unknown_error", "http_error"],
    ] as const)("maps Fireworks HTTP %i to %s", async (httpStatus, code, status) => {
        const rawOutput = JSON.stringify({ error: { message: `synthetic ${httpStatus}` } });
        const classifier = new LlmClassifier(
            configSource(),
            vi.fn(async () => new Response(rawOutput, { status: httpStatus })) as typeof fetch,
            { FIREWORKS_API_KEY: "test-key" },
        );

        await expect(classifier.classify(task)).resolves.toMatchObject({
            label: "IGNORE",
            status,
            providerFailure: { provider: "fireworks", code, httpStatus, rawOutput },
        });
    });

    it("maps undocumented Fireworks HTTP failures without discarding the body", async () => {
        const classifier = new LlmClassifier(
            configSource(),
            vi.fn(async () => new Response("synthetic error", { status: 418 })) as typeof fetch,
            { FIREWORKS_API_KEY: "test-key" },
        );

        await expect(classifier.classify(task)).resolves.toMatchObject({
            status: "http_error",
            providerFailure: { code: "http_error", httpStatus: 418, rawOutput: "synthetic error" },
        });
    });

    it("does not call the provider when disabled, misconfigured, or missing its key", async () => {
        const fetchImpl = vi.fn();
        const disabledConfig = { enabled: false };
        const disabled = new LlmClassifier(() => disabledConfig, fetchImpl as typeof fetch, {});
        const missingKey = new LlmClassifier(configSource(), fetchImpl as typeof fetch, {});
        const unsafeKeySelection = new LlmClassifier(
            configSource({ api_key_env: "DISCORD_TOKEN" }),
            fetchImpl as typeof fetch,
            { DISCORD_TOKEN: "must-not-leave" },
        );

        await expect(disabled.classify(task)).resolves.toMatchObject({ status: "disabled", label: "IGNORE" });
        await expect(missingKey.classify(task)).resolves.toMatchObject({
            status: "missing_api_key",
            label: "IGNORE",
        });
        await expect(unsafeKeySelection.classify(task)).resolves.toMatchObject({
            status: "disabled",
            label: "IGNORE",
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("bounds concurrency and fails closed immediately when the queue is full", async () => {
        let releaseFirst!: () => void;
        const firstResponse = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            calls++;
            if (calls === 1) await firstResponse;
            return completion("ROUTE");
        });
        const classifier = new LlmClassifier(configSource(), fetchImpl as typeof fetch, {
            FIREWORKS_API_KEY: "test-key",
        });

        const first = classifier.classify(task);
        const second = classifier.classify(task);
        const rejected = await classifier.classify(task);

        expect(rejected).toMatchObject({ label: "IGNORE", status: "queue_full" });
        expect(classifier.getMetrics()).toMatchObject({ inFlight: 1, queued: 1, queueRejected: 1 });
        releaseFirst();
        await expect(Promise.all([first, second])).resolves.toHaveLength(2);
        await classifier.drain();
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(classifier.getMetrics()).toMatchObject({ inFlight: 0, queued: 0 });
    });

    it("maps aborts and malformed response bodies to the fallback without throwing", async () => {
        const abortingFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            });
        });
        const timeoutClassifier = new LlmClassifier(configSource({ timeout_ms: 5 }), abortingFetch as typeof fetch, {
            FIREWORKS_API_KEY: "test-key",
        });
        const malformedClassifier = new LlmClassifier(
            configSource(),
            vi.fn(async () => new Response("not json", { status: 200 })) as typeof fetch,
            { FIREWORKS_API_KEY: "test-key" },
        );

        await expect(timeoutClassifier.classify(task)).resolves.toMatchObject({ status: "timeout", label: "IGNORE" });
        await expect(malformedClassifier.classify(task)).resolves.toMatchObject({
            status: "invalid_response",
            label: "IGNORE",
            providerFailure: { code: "invalid_response", rawOutput: "not json" },
        });
    });

    it("rejects a provider response whose declared body exceeds the one-megabyte cap", async () => {
        const oversizedClassifier = new LlmClassifier(
            configSource(),
            vi.fn(
                async () => new Response("{}", { status: 200, headers: { "content-length": "1048577" } }),
            ) as typeof fetch,
            { FIREWORKS_API_KEY: "test-key" },
        );

        await expect(oversizedClassifier.classify(task)).resolves.toMatchObject({
            status: "invalid_response",
            label: "IGNORE",
        });
    });

    it("rechecks hot-disable authorization after lazy context building and before egress", async () => {
        let authorized = true;
        let releaseBuilder!: () => void;
        let markStarted!: () => void;
        const builderStarted = new Promise<void>(resolve => {
            markStarted = resolve;
        });
        const builderBlocked = new Promise<void>(resolve => {
            releaseBuilder = resolve;
        });
        const fetchImpl = vi.fn(async () => completion("ROUTE"));
        const classifier = new LlmClassifier(configSource(), fetchImpl as typeof fetch, {
            FIREWORKS_API_KEY: "test-key",
        });

        const pending = classifier.classifyLazy(
            "IGNORE",
            async () => {
                markStarted();
                await builderBlocked;
                return task;
            },
            () => authorized,
        );
        await builderStarted;
        authorized = false;
        releaseBuilder();

        await expect(pending).resolves.toMatchObject({ status: "disabled", label: "IGNORE" });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("does not build queued input after the provider is hot-disabled", async () => {
        let currentConfig = config();
        let releaseFirst!: () => void;
        let markStarted!: () => void;
        const firstStarted = new Promise<void>(resolve => {
            markStarted = resolve;
        });
        const firstBlocked = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        const fetchImpl = vi.fn(async () => completion("ROUTE"));
        const classifier = new LlmClassifier(() => currentConfig, fetchImpl as typeof fetch, {
            FIREWORKS_API_KEY: "test-key",
        });
        const secondBuilder = vi.fn(async () => task);

        const first = classifier.classifyLazy("IGNORE", async () => {
            markStarted();
            await firstBlocked;
            return task;
        });
        const second = classifier.classifyLazy("IGNORE", secondBuilder);
        await firstStarted;
        currentConfig = { ...currentConfig, enabled: false };
        releaseFirst();

        await expect(Promise.all([first, second])).resolves.toEqual([
            expect.objectContaining({ status: "disabled", label: "IGNORE" }),
            expect.objectContaining({ status: "disabled", label: "IGNORE" }),
        ]);
        expect(secondBuilder).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("invalidates locally building work when the provider config generation changes", async () => {
        let currentConfig = config();
        let releaseBuilder!: () => void;
        let markStarted!: () => void;
        const builderStarted = new Promise<void>(resolve => {
            markStarted = resolve;
        });
        const builderBlocked = new Promise<void>(resolve => {
            releaseBuilder = resolve;
        });
        const fetchImpl = vi.fn(async () => completion("ROUTE"));
        const classifier = new LlmClassifier(() => currentConfig, fetchImpl as typeof fetch, {
            FIREWORKS_API_KEY: "test-key",
        });

        const pending = classifier.classifyLazy("IGNORE", async () => {
            markStarted();
            await builderBlocked;
            return task;
        });
        await builderStarted;
        currentConfig = { ...currentConfig };
        releaseBuilder();

        await expect(pending).resolves.toMatchObject({ status: "disabled", label: "IGNORE" });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("enforces a shared per-minute admission budget", async () => {
        const fetchImpl = vi.fn(async () => completion("IGNORE"));
        const classifier = new LlmClassifier(configSource({ max_requests_per_minute: 1 }), fetchImpl as typeof fetch, {
            FIREWORKS_API_KEY: "test-key",
        });

        await expect(classifier.classify(task)).resolves.toMatchObject({ status: "ok" });
        await expect(classifier.classify(task)).resolves.toMatchObject({ status: "rate_limited", label: "IGNORE" });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(classifier.getMetrics()).toMatchObject({ rateRejected: 1 });
    });

    it("drops stale queued work before building its input", async () => {
        let releaseFirst!: () => void;
        const firstBlocked = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            calls++;
            if (calls === 1) await firstBlocked;
            return completion("IGNORE");
        });
        const classifier = new LlmClassifier(configSource({ max_queue_age_ms: 1 }), fetchImpl as typeof fetch, {
            FIREWORKS_API_KEY: "test-key",
        });
        const secondBuilder = vi.fn(async () => task);

        const first = classifier.classify(task);
        const second = classifier.classifyLazy("IGNORE", secondBuilder);
        await new Promise(resolve => setTimeout(resolve, 5));
        releaseFirst();

        await expect(first).resolves.toMatchObject({ status: "ok" });
        await expect(second).resolves.toMatchObject({ status: "stale", label: "IGNORE" });
        expect(secondBuilder).not.toHaveBeenCalled();
        expect(classifier.getMetrics()).toMatchObject({ staleRejected: 1 });
    });

    it("rejects an invalid static task before it consumes rate admission", async () => {
        const fetchImpl = vi.fn(async () => completion("IGNORE"));
        const classifier = new LlmClassifier(configSource({ max_requests_per_minute: 1 }), fetchImpl as typeof fetch, {
            FIREWORKS_API_KEY: "test-key",
        });

        await expect(classifier.classify({ ...task, input: "" })).resolves.toMatchObject({
            status: "invalid_request",
            label: "IGNORE",
        });
        await expect(classifier.classify(task)).resolves.toMatchObject({ status: "ok" });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("does not call the provider when a lazy policy adapter rejects its context", async () => {
        const fetchImpl = vi.fn(async () => completion("ROUTE"));
        const classifier = new LlmClassifier(configSource(), fetchImpl as typeof fetch, {
            FIREWORKS_API_KEY: "test-key",
        });

        await expect(classifier.classifyLazy("IGNORE", async () => null)).resolves.toMatchObject({
            status: "invalid_request",
            label: "IGNORE",
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("cancels queued work and blocks in-progress local work from egress after close", async () => {
        let releaseFirst!: () => void;
        let markStarted!: () => void;
        const firstStarted = new Promise<void>(resolve => {
            markStarted = resolve;
        });
        const firstBlocked = new Promise<void>(resolve => {
            releaseFirst = resolve;
        });
        const fetchImpl = vi.fn(async () => completion("ROUTE"));
        const classifier = new LlmClassifier(configSource(), fetchImpl as typeof fetch, {
            FIREWORKS_API_KEY: "test-key",
        });
        const secondBuilder = vi.fn(async () => task);

        const first = classifier.classifyLazy("IGNORE", async () => {
            markStarted();
            await firstBlocked;
            return task;
        });
        const second = classifier.classifyLazy("IGNORE", secondBuilder);
        await firstStarted;
        classifier.close();
        releaseFirst();

        await expect(Promise.all([first, second])).resolves.toEqual([
            expect.objectContaining({ status: "disabled", label: "IGNORE" }),
            expect.objectContaining({ status: "disabled", label: "IGNORE" }),
        ]);
        await classifier.drain();
        expect(secondBuilder).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
        await expect(classifier.classify(task)).resolves.toMatchObject({ status: "disabled" });
    });
});
