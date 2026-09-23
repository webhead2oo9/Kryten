import { describe, expect, it, vi } from "vitest";
import { TypeSafeShadowClient, type TypeSafeShadowTask } from "../src/llm/typesafeShadow";
import type { TypeSafeShadowConfig } from "../src/types";

const task: TypeSafeShadowTask<"ROUTE" | "IGNORE"> = {
    systemInstruction: "Apply the private routing policy.",
    input: "[TARGET]\nAUTHOR_1: sanitized synthetic text",
    allowedLabels: ["ROUTE", "IGNORE"],
    fallbackLabel: "IGNORE",
    criteria: {
        ROUTE: "The TARGET message is in scope for beta routing under the supplied policy.",
        IGNORE: "The TARGET message is out of scope for beta routing under the supplied policy.",
    },
};

function config(overrides: TypeSafeShadowConfig = {}): TypeSafeShadowConfig {
    return {
        enabled: true,
        log_channel_id: "shadow-log",
        model: "jev-1.13.0",
        timeout_ms: 1_000,
        max_concurrency: 1,
        max_queue_depth: 1,
        max_queue_age_ms: 1_000,
        max_requests_per_minute: 60,
        ...overrides,
    };
}

function configSource(overrides: TypeSafeShadowConfig = {}): () => TypeSafeShadowConfig {
    const value = config(overrides);
    return () => value;
}

function response(overrides: Record<string, unknown> = {}): Response {
    return Response.json({
        model: "jev-1.13.0",
        answers: {
            decision: {
                type: "choice",
                choice: "ROUTE",
                probabilities: { ROUTE: 0.75, IGNORE: 0.25 },
                confidence: 0.6,
            },
        },
        usage: { input_tokens: 12, output_tokens: 4 },
        ...overrides,
    });
}

describe("TypeSafeShadowClient", () => {
    it("does not transmit when disabled or when TYPESAFE_API_KEY is absent", async () => {
        const fetchImpl = vi.fn();
        const disabled = new TypeSafeShadowClient(configSource({ enabled: false }), fetchImpl as typeof fetch, {
            TYPESAFE_API_KEY: "secret",
        });
        const missing = new TypeSafeShadowClient(configSource(), fetchImpl as typeof fetch, {});

        await expect(disabled.classify(task)).resolves.toMatchObject({ status: "disabled" });
        await expect(missing.classify(task)).resolves.toMatchObject({ status: "missing_api_key" });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("posts the shared sanitized snapshot and existing policy to the pinned endpoint", async () => {
        const fetchImpl = vi.fn(async () => response());
        const shadow = new TypeSafeShadowClient(configSource(), fetchImpl as typeof fetch, {
            TYPESAFE_API_KEY: "test-key",
        });

        await expect(shadow.classify(task)).resolves.toEqual({
            label: "ROUTE",
            status: "ok",
            model: "jev-1.13.0",
            probabilities: { ROUTE: 0.75, IGNORE: 0.25 },
            confidence: 0.6,
            latencyMs: expect.any(Number),
            usage: { inputTokens: 12, outputTokens: 4 },
        });

        const [url, init] = fetchImpl.mock.calls[0]!;
        expect(url).toBe("https://api.typesafe.ai/v1/systemone");
        expect(init).toMatchObject({ method: "POST", redirect: "error" });
        expect((init as RequestInit).headers).toEqual({
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: "Bearer test-key",
        });
        expect(JSON.parse(String((init as RequestInit).body))).toEqual({
            model: "jev-1.13.0",
            state: task.input,
            questions: {
                decision: {
                    type: "choice",
                    instructions: "Apply the private routing policy.\n\nApply this policy to TARGET in the state.",
                    criteria: task.criteria,
                },
            },
        });
    });

    it.each([
        ["wrong label", { answers: { decision: { type: "choice", choice: "MAYBE", probabilities: { ROUTE: 0.5, IGNORE: 0.5 }, confidence: 0.5 } } }],
        ["wrong keys", { answers: { decision: { type: "choice", choice: "ROUTE", probabilities: { ROUTE: 0.5, MAYBE: 0.5 }, confidence: 0.5 } } }],
        ["nonfinite probability", { answers: { decision: { type: "choice", choice: "ROUTE", probabilities: { ROUTE: null, IGNORE: 1 }, confidence: 0.5 } } }],
        ["bad sum", { answers: { decision: { type: "choice", choice: "ROUTE", probabilities: { ROUTE: 0.7, IGNORE: 0.5 }, confidence: 0.5 } } }],
        ["bad confidence", { answers: { decision: { type: "choice", choice: "ROUTE", probabilities: { ROUTE: 0.5, IGNORE: 0.5 }, confidence: 2 } } }],
        ["wrong model", { model: "jev-other" }],
        ["bad usage", { usage: { input_tokens: -1, output_tokens: 2 } }],
    ])("rejects a malformed response: %s", async (_name, overrides) => {
        const shadow = new TypeSafeShadowClient(
            configSource(),
            vi.fn(async () => response(overrides)) as typeof fetch,
            { TYPESAFE_API_KEY: "test-key" },
        );
        await expect(shadow.classify(task)).resolves.toMatchObject({ status: "invalid_response" });
    });

    it("categorizes HTTP, timeout, and oversized bodies without retaining bodies", async () => {
        const http = new TypeSafeShadowClient(
            configSource(),
            vi.fn(async () => new Response("private reflected body", { status: 429 })) as typeof fetch,
            { TYPESAFE_API_KEY: "test-key" },
        );
        const timeout = new TypeSafeShadowClient(
            configSource({ timeout_ms: 5 }),
            vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))) as typeof fetch,
            { TYPESAFE_API_KEY: "test-key" },
        );
        const oversized = new TypeSafeShadowClient(
            configSource(),
            vi.fn(async () => new Response("{}", { headers: { "content-length": "65537" } })) as typeof fetch,
            { TYPESAFE_API_KEY: "test-key" },
        );
        const transport = new TypeSafeShadowClient(
            configSource(),
            vi.fn(async () => {
                throw new Error("private transport diagnostic");
            }) as typeof fetch,
            { TYPESAFE_API_KEY: "test-key" },
        );

        await expect(http.classify(task)).resolves.toMatchObject({ status: "rate_limited", errorCategory: "http_429" });
        await expect(timeout.classify(task)).resolves.toMatchObject({ status: "timeout", errorCategory: "timeout" });
        await expect(oversized.classify(task)).resolves.toMatchObject({ status: "invalid_response", errorCategory: "oversize" });
        await expect(transport.classify(task)).resolves.toMatchObject({ status: "http_error", errorCategory: "transport" });
        expect(JSON.stringify(http.getMetrics())).not.toContain("private reflected body");
    });

    it("rejects non-finite JSON numbers after parsing", async () => {
        const body =
            '{"model":"jev-1.13.0","answers":{"decision":{"type":"choice","choice":"ROUTE","probabilities":{"ROUTE":1e400,"IGNORE":0},"confidence":0.5}},"usage":{"input_tokens":1,"output_tokens":1}}';
        const shadow = new TypeSafeShadowClient(
            configSource(),
            vi.fn(async () => new Response(body)) as typeof fetch,
            { TYPESAFE_API_KEY: "test-key" },
        );
        await expect(shadow.classify(task)).resolves.toMatchObject({ status: "invalid_response" });
    });

    it("uses an independent bounded queue and rate budget", async () => {
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            calls++;
            if (calls === 1) await blocked;
            return response();
        });
        const shadow = new TypeSafeShadowClient(configSource({ max_requests_per_minute: 2 }), fetchImpl as typeof fetch, {
            TYPESAFE_API_KEY: "test-key",
        });

        const first = shadow.classify(task);
        const second = shadow.classify(task);
        await expect(shadow.classify(task)).resolves.toMatchObject({ status: "queue_full" });
        release();
        await Promise.all([first, second]);
        await expect(shadow.classify(task)).resolves.toMatchObject({ status: "rate_limited" });
        expect(shadow.getMetrics()).toMatchObject({ queueDrops: 1, rateDrops: 1, inFlight: 0, queued: 0 });
    });

    it("cancels in-flight and queued work when hot reload replaces the config", async () => {
        let current = config();
        const fetchImpl = vi.fn((_url, init) =>
            new Promise<Response>((_resolve, reject) =>
                init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
            ),
        );
        const shadow = new TypeSafeShadowClient(() => current, fetchImpl as typeof fetch, {
            TYPESAFE_API_KEY: "test-key",
        });
        const first = shadow.classify(task);
        const second = shadow.classify(task);
        current = { ...current, enabled: false };
        shadow.reconfigure();

        await expect(first).resolves.toMatchObject({ status: "cancelled" });
        await expect(second).resolves.toMatchObject({ status: "cancelled" });
        await shadow.drain();
        expect(shadow.getMetrics()).toMatchObject({ inFlight: 0, queued: 0 });
    });
});
