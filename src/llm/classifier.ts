import type { LlmClassifierConfig } from "../types";

const FIREWORKS_CHAT_COMPLETIONS_URL = "https://api.fireworks.ai/inference/v1/chat/completions";
const DEFAULT_API_KEY_ENV = "FIREWORKS_API_KEY";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_FAILURE_OUTPUT_CHARACTERS = 4_000;

export type ClassificationStatus =
    | "ok"
    | "disabled"
    | "invalid_request"
    | "missing_api_key"
    | "queue_full"
    | "rate_limited"
    | "stale"
    | "timeout"
    | "http_error"
    | "invalid_response"
    | "invalid_label";

export interface ClassificationTask<Label extends string> {
    systemInstruction: string;
    input: string;
    allowedLabels: readonly Label[];
    fallbackLabel: Label;
}

export interface ClassificationTokenUsage {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
}

export type FireworksFailureCode =
    | "bad_request"
    | "unauthorized"
    | "payment_required"
    | "forbidden"
    | "not_found"
    | "method_not_allowed"
    | "request_timeout"
    | "precondition_failed"
    | "payload_too_large"
    | "rate_limited"
    | "internal_server_error"
    | "bad_gateway"
    | "service_unavailable"
    | "gateway_timeout"
    | "unknown_error"
    | "http_error"
    | "invalid_response"
    | "invalid_label";

export interface ProviderFailure {
    provider: "fireworks";
    code: FireworksFailureCode;
    summary: string;
    httpStatus?: number;
    rawOutput?: string;
}

export interface ClassificationResult<Label extends string> {
    label: Label;
    status: ClassificationStatus;
    latencyMs: number;
    usage: ClassificationTokenUsage;
    providerFailure?: ProviderFailure;
}

export interface LlmClassifierMetrics extends ClassificationTokenUsage {
    submitted: number;
    completed: number;
    fallbacks: number;
    queueRejected: number;
    rateRejected: number;
    staleRejected: number;
    inFlight: number;
    queued: number;
    totalLatencyMs: number;
    maxLatencyMs: number;
}

interface EffectiveConfig {
    source: LlmClassifierConfig;
    model: string;
    apiKeyEnv: string;
    timeoutMs: number;
    maxOutputTokens: number;
    maxConcurrency: number;
    maxQueueDepth: number;
    maxQueueAgeMs: number;
    maxRequestsPerMinute: number;
    temperature: number;
    topK: number;
    presencePenalty: number;
    frequencyPenalty: number;
}

interface QueuedJob {
    config: EffectiveConfig;
    run: () => Promise<void>;
    cancel: () => void;
}

interface ChatCompletionResponse {
    choices?: Array<{ message?: { content?: unknown } }>;
    usage?: {
        prompt_tokens?: unknown;
        prompt_tokens_details?: { cached_tokens?: unknown };
        completion_tokens?: unknown;
        total_tokens?: unknown;
        completion_tokens_details?: { reasoning_tokens?: unknown };
    };
}

const EMPTY_USAGE: ClassificationTokenUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
};

export class LlmClassifier {
    private inFlight = 0;
    private closed = false;
    private readonly queue: QueuedJob[] = [];
    private readonly acceptedTimestamps: number[] = [];
    private readonly idleWaiters = new Set<() => void>();
    private readonly metrics: Omit<LlmClassifierMetrics, "inFlight" | "queued"> = {
        submitted: 0,
        completed: 0,
        fallbacks: 0,
        queueRejected: 0,
        rateRejected: 0,
        staleRejected: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        totalLatencyMs: 0,
        maxLatencyMs: 0,
    };

    constructor(
        private readonly getConfig: () => LlmClassifierConfig | undefined,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly environment: NodeJS.ProcessEnv = process.env,
    ) {}

    classify<Label extends string>(task: ClassificationTask<Label>): Promise<ClassificationResult<Label>> {
        if (!validTask(task)) {
            this.metrics.submitted++;
            return Promise.resolve(this.fallback(task.fallbackLabel, "invalid_request"));
        }
        return this.classifyLazy(task.fallbackLabel, async () => task);
    }

    classifyLazy<Label extends string>(
        fallbackLabel: Label,
        buildTask: () => Promise<ClassificationTask<Label> | null>,
        isAuthorized: () => boolean = () => true,
    ): Promise<ClassificationResult<Label>> {
        this.metrics.submitted++;
        if (this.closed) return Promise.resolve(this.fallback(fallbackLabel, "disabled"));
        const config = this.effectiveConfig();
        if (!config || !this.authorized(isAuthorized)) {
            return Promise.resolve(this.fallback(fallbackLabel, "disabled"));
        }
        if (!this.environment[config.apiKeyEnv]?.trim()) {
            return Promise.resolve(this.fallback(fallbackLabel, "missing_api_key"));
        }

        const mustQueue = this.queue.length > 0 || this.inFlight >= config.maxConcurrency;
        if (mustQueue && this.queue.length >= config.maxQueueDepth) {
            this.metrics.queueRejected++;
            return Promise.resolve(this.fallback(fallbackLabel, "queue_full"));
        }

        const enqueuedAt = Date.now();
        while (this.acceptedTimestamps[0] !== undefined && this.acceptedTimestamps[0] <= enqueuedAt - 60_000) {
            this.acceptedTimestamps.shift();
        }
        if (this.acceptedTimestamps.length >= config.maxRequestsPerMinute) {
            this.metrics.rateRejected++;
            return Promise.resolve(this.fallback(fallbackLabel, "rate_limited"));
        }
        this.acceptedTimestamps.push(enqueuedAt);

        return new Promise(resolve => {
            const job: QueuedJob = {
                config,
                cancel: () => resolve(this.fallback(fallbackLabel, "disabled")),
                run: async () => {
                    try {
                        if (Date.now() - enqueuedAt > config.maxQueueAgeMs) {
                            this.metrics.staleRejected++;
                            resolve(this.fallback(fallbackLabel, "stale"));
                            return;
                        }
                        if (!this.authorized(isAuthorized)) {
                            resolve(this.fallback(fallbackLabel, "disabled"));
                            return;
                        }
                        const beforeBuild = this.effectiveConfig();
                        if (!beforeBuild || beforeBuild.source !== config.source) {
                            resolve(this.fallback(fallbackLabel, "disabled"));
                            return;
                        }
                        if (!this.environment[beforeBuild.apiKeyEnv]?.trim()) {
                            resolve(this.fallback(fallbackLabel, "missing_api_key"));
                            return;
                        }

                        const task = await buildTask();
                        if (!task || task.fallbackLabel !== fallbackLabel || !validTask(task)) {
                            resolve(this.fallback(fallbackLabel, "invalid_request"));
                            return;
                        }
                        if (!this.authorized(isAuthorized)) {
                            resolve(this.fallback(fallbackLabel, "disabled"));
                            return;
                        }
                        const currentConfig = this.effectiveConfig();
                        if (!currentConfig || currentConfig.source !== config.source) {
                            resolve(this.fallback(fallbackLabel, "disabled"));
                            return;
                        }
                        resolve(await this.request(task, currentConfig, isAuthorized));
                    } catch {
                        resolve(this.fallback(fallbackLabel, "http_error"));
                    }
                },
            };
            if (!mustQueue) this.start(job);
            else this.queue.push(job);
        });
    }

    getMetrics(): LlmClassifierMetrics {
        return { ...this.metrics, inFlight: this.inFlight, queued: this.queue.length };
    }

    drain(): Promise<void> {
        if (this.inFlight === 0 && this.queue.length === 0) return Promise.resolve();
        return new Promise(resolve => this.idleWaiters.add(resolve));
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const job of this.queue.splice(0)) job.cancel();
        this.resolveIdleWaiters();
    }

    private effectiveConfig(): EffectiveConfig | null {
        if (this.closed) return null;
        const config = this.getConfig();
        if (!config?.enabled || config.provider !== "fireworks" || !config.model?.trim()) return null;
        const apiKeyEnv = config.api_key_env?.trim() || DEFAULT_API_KEY_ENV;
        if (!/^FIREWORKS_[A-Z0-9_]*$/.test(apiKeyEnv)) return null;
        return {
            source: config,
            model: config.model.trim(),
            apiKeyEnv,
            timeoutMs: config.timeout_ms ?? 30_000,
            maxOutputTokens: config.max_output_tokens ?? 131_072,
            maxConcurrency: config.max_concurrency ?? 1,
            maxQueueDepth: config.max_queue_depth ?? 25,
            maxQueueAgeMs: config.max_queue_age_ms ?? 30_000,
            maxRequestsPerMinute: config.max_requests_per_minute ?? 60,
            temperature: config.temperature ?? 0,
            topK: config.top_k ?? 40,
            presencePenalty: config.presence_penalty ?? 0,
            frequencyPenalty: config.frequency_penalty ?? 0,
        };
    }

    private authorized(check: () => boolean): boolean {
        try {
            return check();
        } catch {
            return false;
        }
    }

    private start(job: QueuedJob): void {
        this.inFlight++;
        void job
            .run()
            .catch(() => undefined)
            .finally(() => {
                this.inFlight--;
                this.pump();
            });
    }

    private pump(): void {
        for (;;) {
            const next = this.queue[0];
            const currentConcurrency = this.effectiveConfig()?.maxConcurrency ?? 1;
            if (!next || this.inFlight >= Math.min(next.config.maxConcurrency, currentConcurrency)) break;
            this.queue.shift();
            this.start(next);
        }
        this.resolveIdleWaiters();
    }

    private resolveIdleWaiters(): void {
        if (this.inFlight !== 0 || this.queue.length !== 0) return;
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
    }

    private async request<Label extends string>(
        task: ClassificationTask<Label>,
        config: EffectiveConfig,
        isAuthorized: () => boolean,
    ): Promise<ClassificationResult<Label>> {
        const started = Date.now();
        if (this.closed || !this.authorized(isAuthorized)) {
            return this.finish(task.fallbackLabel, "disabled", started, EMPTY_USAGE);
        }
        const apiKey = this.environment[config.apiKeyEnv]?.trim();
        if (!apiKey) return this.finish(task.fallbackLabel, "missing_api_key", started, EMPTY_USAGE);
        try {
            const response = await this.fetchImpl(FIREWORKS_CHAT_COMPLETIONS_URL, {
                method: "POST",
                redirect: "error",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: config.model,
                    max_tokens: config.maxOutputTokens,
                    temperature: config.temperature,
                    top_k: config.topK,
                    presence_penalty: config.presencePenalty,
                    frequency_penalty: config.frequencyPenalty,
                    stream: false,
                    messages: [
                        {
                            role: "system",
                            content: `${task.systemInstruction.trim()}\n\nReturn exactly one of these labels and no other text: ${task.allowedLabels.join(" | ")}`,
                        },
                        { role: "user", content: task.input },
                    ],
                }),
                signal: AbortSignal.timeout(config.timeoutMs),
            });
            if (!response.ok) {
                const rawOutput = await readTextBounded(response, MAX_RESPONSE_BYTES);
                const failure = fireworksHttpFailure(response.status, rawOutput);
                const status: ClassificationStatus =
                    response.status === 408 || response.status === 504
                        ? "timeout"
                        : response.status === 429
                          ? "rate_limited"
                          : "http_error";
                return this.finish(task.fallbackLabel, status, started, EMPTY_USAGE, failure);
            }

            const rawOutput = await readTextBounded(response, MAX_RESPONSE_BYTES);
            const payload = parseJson(rawOutput);
            if (!payload || typeof payload !== "object") {
                return this.finish(task.fallbackLabel, "invalid_response", started, EMPTY_USAGE, {
                    provider: "fireworks",
                    code: "invalid_response",
                    summary: "Invalid response",
                    ...(rawOutput ? { rawOutput: boundedFailureOutput(rawOutput) } : {}),
                });
            }
            const parsed = payload as ChatCompletionResponse;
            const usage = parseUsage(parsed.usage);
            const content = parsed.choices?.[0]?.message?.content;
            if (typeof content !== "string") {
                return this.finish(task.fallbackLabel, "invalid_response", started, usage, {
                    provider: "fireworks",
                    code: "invalid_response",
                    summary: "Invalid response",
                    ...(rawOutput ? { rawOutput: boundedFailureOutput(rawOutput) } : {}),
                });
            }
            const label = content.trim();
            if (!task.allowedLabels.includes(label as Label)) {
                return this.finish(task.fallbackLabel, "invalid_label", started, usage, {
                    provider: "fireworks",
                    code: "invalid_label",
                    summary: "Invalid label",
                    rawOutput: boundedFailureOutput(content),
                });
            }
            return this.finish(label as Label, "ok", started, usage);
        } catch (error) {
            const name = error instanceof Error ? error.name : "";
            const status: ClassificationStatus =
                name === "TimeoutError" || name === "AbortError" ? "timeout" : "http_error";
            return this.finish(task.fallbackLabel, status, started, EMPTY_USAGE);
        }
    }

    private fallback<Label extends string>(label: Label, status: ClassificationStatus): ClassificationResult<Label> {
        this.metrics.completed++;
        this.metrics.fallbacks++;
        return { label, status, latencyMs: 0, usage: { ...EMPTY_USAGE } };
    }

    private finish<Label extends string>(
        label: Label,
        status: ClassificationStatus,
        started: number,
        usage: ClassificationTokenUsage,
        providerFailure?: ProviderFailure,
    ): ClassificationResult<Label> {
        const latencyMs = Date.now() - started;
        this.metrics.completed++;
        if (status !== "ok") this.metrics.fallbacks++;
        this.metrics.inputTokens += usage.inputTokens;
        this.metrics.cachedInputTokens += usage.cachedInputTokens;
        this.metrics.outputTokens += usage.outputTokens;
        this.metrics.reasoningTokens += usage.reasoningTokens;
        this.metrics.totalTokens += usage.totalTokens;
        this.metrics.totalLatencyMs += latencyMs;
        this.metrics.maxLatencyMs = Math.max(this.metrics.maxLatencyMs, latencyMs);
        return { label, status, latencyMs, usage, ...(providerFailure ? { providerFailure } : {}) };
    }
}

function validTask<Label extends string>(task: ClassificationTask<Label>): boolean {
    const labels = new Set<string>(task.allowedLabels);
    return (
        !!task.systemInstruction.trim() &&
        !!task.input.trim() &&
        labels.size === task.allowedLabels.length &&
        [...labels].every(label => !!label && label === label.trim()) &&
        labels.has(task.fallbackLabel)
    );
}

function tokenCount(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseUsage(usage: ChatCompletionResponse["usage"]): ClassificationTokenUsage {
    return {
        inputTokens: tokenCount(usage?.prompt_tokens),
        cachedInputTokens: tokenCount(usage?.prompt_tokens_details?.cached_tokens),
        outputTokens: tokenCount(usage?.completion_tokens),
        reasoningTokens: tokenCount(usage?.completion_tokens_details?.reasoning_tokens),
        totalTokens: tokenCount(usage?.total_tokens),
    };
}

function parseJson(value: string | null): unknown | null {
    if (value === null) return null;
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

function boundedFailureOutput(value: string): string {
    return value.length <= MAX_FAILURE_OUTPUT_CHARACTERS
        ? value
        : `${value.slice(0, MAX_FAILURE_OUTPUT_CHARACTERS)}\n[truncated]`;
}

const FIREWORKS_HTTP_FAILURES: Record<number, readonly [FireworksFailureCode, string]> = {
    400: ["bad_request", "Bad request"],
    401: ["unauthorized", "Unauthorized"],
    402: ["payment_required", "Payment required"],
    403: ["forbidden", "Forbidden"],
    404: ["not_found", "Not found"],
    405: ["method_not_allowed", "Method not allowed"],
    408: ["request_timeout", "Request timeout"],
    412: ["precondition_failed", "Precondition failed"],
    413: ["payload_too_large", "Payload too large"],
    429: ["rate_limited", "Rate limited"],
    500: ["internal_server_error", "Internal server error"],
    502: ["bad_gateway", "Bad gateway"],
    503: ["service_unavailable", "Service unavailable"],
    504: ["gateway_timeout", "Gateway timeout"],
    520: ["unknown_error", "Unknown provider error"],
};

function fireworksHttpFailure(status: number, rawOutput: string | null): ProviderFailure {
    const [code, summary] = FIREWORKS_HTTP_FAILURES[status] ?? ["http_error", "HTTP error"];
    return {
        provider: "fireworks",
        code,
        summary,
        httpStatus: status,
        ...(rawOutput ? { rawOutput: boundedFailureOutput(rawOutput) } : {}),
    };
}

async function readTextBounded(response: Response, maxBytes: number): Promise<string | null> {
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        void response.body?.cancel().catch(() => undefined);
        return null;
    }
    if (!response.body) {
        const text = await response.text();
        if (Buffer.byteLength(text) > maxBytes) return null;
        return text;
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > maxBytes) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks, received).toString("utf8");
}
