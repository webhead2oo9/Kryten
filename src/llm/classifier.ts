import { TypeSafeShadowClient, criteriaFor, DEFAULT_JEV_MODEL, JEV_PRIMARY_BOUNDS } from "./typesafeShadow";
import type { LlmClassifierConfig } from "../types";

const FIREWORKS_CHAT_COMPLETIONS_URL = "https://api.fireworks.ai/inference/v1/chat/completions";
const CLEF_SYSTEMONE_URL = "http://127.0.0.1:58756/v1/systemone";
const CLEF_MODEL = "Cloudflare/clef-flash";
const CLEF_REQUEST_MODEL = "clef-flash";
const CLEF_TIMEOUT_MS = 15_000;
const CLEF_MAX_QUEUE_DEPTH = 2;
const CLEF_MAX_BODY_BYTES = 16_384;
const CLEF_MAX_RESPONSE_BYTES = 16_384;
const CLEF_MAX_MESSAGE_CHARACTERS = 4_000;
const CLEF_MAX_GREETING_CHARACTERS = 10_000;
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
    clef?: {
        taskType: "beta_routing" | "beta_greeting";
        messages: string[];
    };
}

export interface ClassificationOptions {
    /** Absolute lifecycle deadline for local Clef greeting work, including queue time. */
    clefGreetingDeadlineAt?: number;
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
    provider?: "fireworks" | "typesafe" | "clef";
    model?: string;
    label: Label;
    status: ClassificationStatus;
    latencyMs: number;
    usage: ClassificationTokenUsage;
    providerFailure?: ProviderFailure;
}

export interface LlmClassifierMetrics extends ClassificationTokenUsage {
    provider?: "fireworks" | "typesafe" | "clef";
    model?: string;
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
    apiKeyEnv?: string;
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
    private readonly jev: TypeSafeShadowClient;
    private readonly controllers = new Set<AbortController>();
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
    ) {
        this.jev = new TypeSafeShadowClient(
            () => {
                const config = this.getConfig();
                return config?.provider === "typesafe" ? config : undefined;
            },
            fetchImpl,
            environment,
            "primary",
        );
    }

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
        onTaskReady?: (task: ClassificationTask<Label>) => unknown,
        options: ClassificationOptions = {},
    ): Promise<ClassificationResult<Label>> {
        this.metrics.submitted++;
        if (this.closed) return Promise.resolve(this.fallback(fallbackLabel, "disabled"));
        const config = this.effectiveConfig();
        if (!config || !authorized(isAuthorized)) {
            return Promise.resolve(this.fallback(fallbackLabel, "disabled"));
        }
        if (config.apiKeyEnv && !this.environment[config.apiKeyEnv]?.trim()) {
            return Promise.resolve(this.fallback(fallbackLabel, "missing_api_key"));
        }

        const mustQueue = this.queue.length > 0 || this.inFlight >= config.maxConcurrency;
        if (mustQueue && this.queue.length >= config.maxQueueDepth) {
            this.metrics.queueRejected++;
            return Promise.resolve(this.fallback(fallbackLabel, "queue_full"));
        }

        const enqueuedAt = Date.now();
        const queueDeadlineAt =
            config.source.provider === "clef" && options.clefGreetingDeadlineAt !== undefined
                ? options.clefGreetingDeadlineAt
                : enqueuedAt + config.maxQueueAgeMs;
        while (this.acceptedTimestamps[0] !== undefined && this.acceptedTimestamps[0] <= enqueuedAt - 60_000) {
            this.acceptedTimestamps.shift();
        }
        if (this.acceptedTimestamps.length >= config.maxRequestsPerMinute) {
            this.metrics.rateRejected++;
            return Promise.resolve(this.fallback(fallbackLabel, "rate_limited"));
        }
        this.acceptedTimestamps.push(enqueuedAt);

        return new Promise<ClassificationResult<Label>>(resolve => {
            const job: QueuedJob = {
                config,
                cancel: () => resolve(this.fallback(fallbackLabel, "disabled")),
                run: async () => {
                    try {
                        if (Date.now() >= queueDeadlineAt) {
                            this.metrics.staleRejected++;
                            resolve(this.fallback(fallbackLabel, "stale"));
                            return;
                        }
                        if (!authorized(isAuthorized)) {
                            resolve(this.fallback(fallbackLabel, "disabled"));
                            return;
                        }
                        const beforeBuild = this.effectiveConfig();
                        if (!beforeBuild || beforeBuild.source !== config.source) {
                            resolve(this.fallback(fallbackLabel, "disabled"));
                            return;
                        }
                        if (beforeBuild.apiKeyEnv && !this.environment[beforeBuild.apiKeyEnv]?.trim()) {
                            resolve(this.fallback(fallbackLabel, "missing_api_key"));
                            return;
                        }

                        const task = await buildTask();
                        if (!task || task.fallbackLabel !== fallbackLabel || !validTask(task)) {
                            resolve(this.fallback(fallbackLabel, "invalid_request"));
                            return;
                        }
                        const clefGreetingDeadlineAt =
                            config.source.provider === "clef" && task.clef?.taskType === "beta_greeting"
                                ? options.clefGreetingDeadlineAt
                                : undefined;
                        if (!authorized(isAuthorized)) {
                            resolve(this.fallback(fallbackLabel, "disabled"));
                            return;
                        }
                        const currentConfig = this.effectiveConfig();
                        if (!currentConfig || currentConfig.source !== config.source) {
                            resolve(this.fallback(fallbackLabel, "disabled"));
                            return;
                        }
                        if (Date.now() >= (clefGreetingDeadlineAt ?? enqueuedAt + config.maxQueueAgeMs)) {
                            this.metrics.staleRejected++;
                            resolve(this.fallback(fallbackLabel, "stale"));
                            return;
                        }
                        if (onTaskReady && config.source.provider === "fireworks") {
                            try {
                                onTaskReady(task);
                            } catch {
                                // Shadow observers are isolated from the authoritative provider.
                            }
                        }
                        resolve(
                            await this.request(task, currentConfig, isAuthorized, enqueuedAt, clefGreetingDeadlineAt),
                        );
                    } catch {
                        resolve(this.fallback(fallbackLabel, "http_error"));
                    }
                },
            };
            if (!mustQueue) this.start(job);
            else this.queue.push(job);
        }).then(result => ({ ...result, provider: config.source.provider, model: config.model }));
    }

    getMetrics(): LlmClassifierMetrics {
        return {
            ...this.metrics,
            provider: this.getConfig()?.provider,
            model: this.getConfig()?.model,
            inFlight: this.inFlight,
            queued: this.queue.length,
        };
    }

    drain(): Promise<void> {
        if (this.inFlight === 0 && this.queue.length === 0) return Promise.resolve();
        return new Promise(resolve => this.idleWaiters.add(resolve));
    }

    reconfigure(): void {
        this.jev.reconfigure();
        for (const controller of this.controllers) controller.abort();
        const source = this.getConfig();
        for (const job of this.queue.splice(0)) {
            if (job.config.source !== source || !source?.enabled) job.cancel();
            else this.queue.push(job);
        }
        this.pump();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.jev.close();
        for (const controller of this.controllers) controller.abort();
        for (const job of this.queue.splice(0)) job.cancel();
        this.resolveIdleWaiters();
    }

    private effectiveConfig(): EffectiveConfig | null {
        if (this.closed) return null;
        const config = this.getConfig();
        if (
            !config?.enabled ||
            !["fireworks", "typesafe", "clef"].includes(config.provider ?? "") ||
            !config.model?.trim()
        )
            return null;
        const jev = config.provider === "typesafe";
        const clef = config.provider === "clef";
        if (
            jev &&
            (config.model !== DEFAULT_JEV_MODEL || (config.api_key_env && config.api_key_env !== "TYPESAFE_API_KEY"))
        )
            return null;
        if (clef && (config.model !== CLEF_MODEL || config.api_key_env)) return null;
        const apiKeyEnv = clef
            ? undefined
            : jev
              ? "TYPESAFE_API_KEY"
              : config.api_key_env?.trim() || DEFAULT_API_KEY_ENV;
        if (!jev && !clef && (!apiKeyEnv || !/^FIREWORKS_[A-Z0-9_]*$/.test(apiKeyEnv))) return null;
        return {
            source: config,
            model: config.model.trim(),
            apiKeyEnv,
            timeoutMs: clef
                ? Math.min(config.timeout_ms ?? CLEF_TIMEOUT_MS, CLEF_TIMEOUT_MS)
                : jev
                  ? Math.min(config.timeout_ms ?? JEV_PRIMARY_BOUNDS.timeout_ms, JEV_PRIMARY_BOUNDS.timeout_ms)
                  : (config.timeout_ms ?? 30_000),
            maxOutputTokens: config.max_output_tokens ?? 131_072,
            maxConcurrency: clef
                ? 1
                : jev
                  ? Math.min(
                        config.max_concurrency ?? JEV_PRIMARY_BOUNDS.max_concurrency,
                        JEV_PRIMARY_BOUNDS.max_concurrency,
                    )
                  : (config.max_concurrency ?? 1),
            maxQueueDepth: clef
                ? Math.min(config.max_queue_depth ?? CLEF_MAX_QUEUE_DEPTH, CLEF_MAX_QUEUE_DEPTH)
                : jev
                  ? Math.min(
                        config.max_queue_depth ?? JEV_PRIMARY_BOUNDS.max_queue_depth,
                        JEV_PRIMARY_BOUNDS.max_queue_depth,
                    )
                  : (config.max_queue_depth ?? 25),
            maxQueueAgeMs: clef
                ? Math.min(config.max_queue_age_ms ?? CLEF_TIMEOUT_MS, CLEF_TIMEOUT_MS)
                : jev
                  ? Math.min(
                        config.max_queue_age_ms ?? JEV_PRIMARY_BOUNDS.max_queue_age_ms,
                        JEV_PRIMARY_BOUNDS.max_queue_age_ms,
                    )
                  : (config.max_queue_age_ms ?? 30_000),
            maxRequestsPerMinute: jev
                ? Math.min(
                      config.max_requests_per_minute ?? JEV_PRIMARY_BOUNDS.max_requests_per_minute,
                      JEV_PRIMARY_BOUNDS.max_requests_per_minute,
                  )
                : (config.max_requests_per_minute ?? 60),
            temperature: config.temperature ?? 0,
            topK: config.top_k ?? 40,
            presencePenalty: config.presence_penalty ?? 0,
            frequencyPenalty: config.frequency_penalty ?? 0,
        };
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
        enqueuedAt: number,
        clefGreetingDeadlineAt?: number,
    ): Promise<ClassificationResult<Label>> {
        const started = Date.now();
        if (this.closed || !authorized(isAuthorized)) {
            return this.finish(task.fallbackLabel, "disabled", started, EMPTY_USAGE);
        }
        if (config.source.provider === "typesafe") {
            const routing =
                task.fallbackLabel === "IGNORE" &&
                task.allowedLabels.length === 2 &&
                task.allowedLabels.includes("ROUTE" as Label);
            const greeting =
                task.fallbackLabel === "DELETE" &&
                task.allowedLabels.length === 2 &&
                task.allowedLabels.includes("KEEP" as Label);
            if (!routing && !greeting) return this.finish(task.fallbackLabel, "invalid_request", started, EMPTY_USAGE);
            const result = await this.jev.classify(
                { ...task, criteria: criteriaFor(routing ? "beta_routing" : "beta_greeting", task.allowedLabels) },
                () => !this.closed && this.getConfig() === config.source && authorized(isAuthorized),
            );
            const stillAuthorized = !this.closed && this.getConfig() === config.source && authorized(isAuthorized);
            const status = result.status === "cancelled" || !stillAuthorized ? "disabled" : result.status;
            return this.finish(status === "ok" ? result.label : task.fallbackLabel, status, started, {
                ...EMPTY_USAGE,
                ...result.usage,
                totalTokens: result.usage.inputTokens + result.usage.outputTokens,
            });
        }
        if (config.source.provider === "clef") {
            return this.requestClef(task, config, isAuthorized, enqueuedAt, started, clefGreetingDeadlineAt);
        }
        const apiKey = config.apiKeyEnv ? this.environment[config.apiKeyEnv]?.trim() : undefined;
        if (!apiKey) return this.finish(task.fallbackLabel, "missing_api_key", started, EMPTY_USAGE);
        const controller = new AbortController();
        this.controllers.add(controller);
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
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(config.timeoutMs)]),
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
            if (
                controller.signal.aborted ||
                this.closed ||
                this.getConfig() !== config.source ||
                !authorized(isAuthorized)
            )
                return this.finish(task.fallbackLabel, "disabled", started, usage);
            return this.finish(label as Label, "ok", started, usage);
        } catch (error) {
            if (controller.signal.aborted) return this.finish(task.fallbackLabel, "disabled", started, EMPTY_USAGE);
            const name = error instanceof Error ? error.name : "";
            const status: ClassificationStatus =
                name === "TimeoutError" || name === "AbortError" ? "timeout" : "http_error";
            return this.finish(task.fallbackLabel, status, started, EMPTY_USAGE);
        } finally {
            this.controllers.delete(controller);
        }
    }

    private async requestClef<Label extends string>(
        task: ClassificationTask<Label>,
        config: EffectiveConfig,
        isAuthorized: () => boolean,
        enqueuedAt: number,
        started: number,
        greetingDeadlineAt?: number,
    ): Promise<ClassificationResult<Label>> {
        const payload = clefPayload(task);
        if (!payload) return this.finish(task.fallbackLabel, "invalid_request", started, EMPTY_USAGE);
        const body = JSON.stringify(payload);
        if (Buffer.byteLength(body) > CLEF_MAX_BODY_BYTES) {
            return this.finish(task.fallbackLabel, "invalid_request", started, EMPTY_USAGE);
        }
        const remainingMs =
            task.clef?.taskType === "beta_greeting" && greetingDeadlineAt !== undefined
                ? greetingDeadlineAt - Date.now()
                : Math.min(config.timeoutMs, enqueuedAt + config.timeoutMs - Date.now());
        if (remainingMs <= 0) return this.finish(task.fallbackLabel, "stale", started, EMPTY_USAGE);
        const controller = new AbortController();
        const deadline = new AbortController();
        const deadlineTimer = setTimeout(
            () => deadline.abort(new DOMException("Timed out", "TimeoutError")),
            remainingMs,
        );
        deadlineTimer.unref();
        this.controllers.add(controller);
        try {
            const response = await this.fetchImpl(CLEF_SYSTEMONE_URL, {
                method: "POST",
                redirect: "error",
                headers: { Accept: "application/json", "Content-Type": "application/json" },
                body,
                signal: AbortSignal.any([controller.signal, deadline.signal]),
            });
            if (!response.ok) {
                await readTextBounded(response, CLEF_MAX_RESPONSE_BYTES);
                return this.finish(
                    task.fallbackLabel,
                    response.status === 408 || response.status === 504 ? "timeout" : "http_error",
                    started,
                    EMPTY_USAGE,
                );
            }
            const parsed = parseJson(await readTextBounded(response, CLEF_MAX_RESPONSE_BYTES));
            const validated = parseClefResponse(parsed, task.allowedLabels);
            if (!validated) return this.finish(task.fallbackLabel, "invalid_response", started, EMPTY_USAGE);
            if (this.closed || this.getConfig() !== config.source || !authorized(isAuthorized)) {
                return this.finish(task.fallbackLabel, "disabled", started, validated.usage);
            }
            return this.finish(validated.label, "ok", started, validated.usage);
        } catch (error) {
            if (controller.signal.aborted) return this.finish(task.fallbackLabel, "disabled", started, EMPTY_USAGE);
            const name = error instanceof Error ? error.name : "";
            return this.finish(
                task.fallbackLabel,
                name === "TimeoutError" || name === "AbortError" ? "timeout" : "http_error",
                started,
                EMPTY_USAGE,
            );
        } finally {
            clearTimeout(deadlineTimer);
            this.controllers.delete(controller);
        }
    }

    private fallback<Label extends string>(label: Label, status: ClassificationStatus): ClassificationResult<Label> {
        this.metrics.completed++;
        this.metrics.fallbacks++;
        return {
            label,
            status,
            latencyMs: 0,
            usage: { ...EMPTY_USAGE },
            provider: this.getConfig()?.provider,
            model: this.getConfig()?.model,
        };
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

function clefPayload<Label extends string>(task: ClassificationTask<Label>): object | null {
    const local = task.clef;
    if (!local || !validClefMessages(local.taskType, local.messages)) return null;
    const routing = local.taskType === "beta_routing";
    const expected = routing ? ["ROUTE", "IGNORE"] : ["KEEP", "DELETE"];
    if (task.allowedLabels.length !== 2 || !expected.every(label => task.allowedLabels.includes(label as Label))) {
        return null;
    }
    return {
        model: CLEF_REQUEST_MODEL,
        state: {
            policy_version: routing ? "kryten-beta-routing-v1" : "kryten-beta-greeting-v1",
            messages: local.messages,
        },
        questions: {
            decision: routing
                ? {
                      type: "choice",
                      instructions:
                          "Apply the IGNORE exclusions first, then decide whether this single message warrants a Virtual Desktop Quest beta support redirect. Do not invent missing context. Statements explicitly reporting an otherwise qualifying failure count as support requests; a question mark is not required.",
                      criteria: {
                          ROUTE: "An actionable Virtual Desktop Quest direct-USB/NCM setup, connection or performance issue, a current Quest Beta Streamer setup/download question, or a Virtual Desktop stream restart every 15 minutes. Link cables and charging cables can be used for direct USB. Mixed VD and Meta Link failures qualify if the VD USB issue is explicit.",
                          IGNORE: "Everything else. Always ignore greetings, success reports without a support question, Wi-Fi/Ethernet-only issues, Steam-edition Virtual Desktop, Meta Link alone, non-VD cable problems, vague wired issues without clear VD USB context, and ambiguous follow-ups, even when they mention failure, USB, or Quest.",
                      },
                  }
                : {
                      type: "choice",
                      instructions:
                          "Decide whether to retain a welcome message in a Virtual Desktop Quest beta-testing channel from only these same-member messages. Do not invent missing context.",
                      criteria: {
                          KEEP: "The messages clearly participate in the current Virtual Desktop Quest beta: a beta setup question, a beta issue report, feedback on beta testing, or a question about where to download the Beta Streamer for the current Quest beta. Success reports qualify.",
                          DELETE: "Generic greetings, unrelated discussion, stable-release-only support, or insufficient evidence of participation in the current Virtual Desktop Quest beta.",
                      },
                  },
        },
    };
}

function validClefMessages(taskType: "beta_routing" | "beta_greeting", messages: readonly string[]): boolean {
    if (messages.length < 1 || messages.length > (taskType === "beta_routing" ? 1 : 2)) return false;
    if (messages.some(message => !message.trim() || message.length > CLEF_MAX_MESSAGE_CHARACTERS)) return false;
    return messages.reduce((total, message) => total + message.length, 0) <= CLEF_MAX_GREETING_CHARACTERS;
}

function parseClefResponse<Label extends string>(
    value: unknown,
    allowedLabels: readonly Label[],
): { label: Label; usage: ClassificationTokenUsage } | null {
    if (!value || typeof value !== "object") return null;
    const payload = value as Record<string, unknown>;
    if (payload["model"] !== CLEF_MODEL || !payload["answers"] || typeof payload["answers"] !== "object") return null;
    const decision = (payload["answers"] as Record<string, unknown>)["decision"];
    if (!decision || typeof decision !== "object") return null;
    const answer = decision as Record<string, unknown>;
    const label = answer["choice"];
    const confidence = answer["confidence"];
    const probabilities = answer["probabilities"];
    if (
        answer["type"] !== "choice" ||
        typeof label !== "string" ||
        !allowedLabels.includes(label as Label) ||
        typeof confidence !== "number" ||
        !Number.isFinite(confidence) ||
        confidence < 0 ||
        confidence > 1 ||
        !probabilities ||
        typeof probabilities !== "object"
    )
        return null;
    const entries = Object.entries(probabilities as Record<string, unknown>);
    if (
        entries.length !== allowedLabels.length ||
        !allowedLabels.every(expected => entries.some(([key]) => key === expected)) ||
        entries.some(
            ([, probability]) =>
                typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1,
        ) ||
        Math.abs(entries.reduce((sum, [, probability]) => sum + (probability as number), 0) - 1) > 0.001
    )
        return null;
    const usage = payload["usage"];
    if (!usage || typeof usage !== "object") return null;
    const inputTokens = (usage as Record<string, unknown>)["input_tokens"];
    const outputTokens = (usage as Record<string, unknown>)["output_tokens"];
    if (!isNonnegativeInteger(inputTokens) || !isNonnegativeInteger(outputTokens)) return null;
    return {
        label: label as Label,
        usage: {
            ...EMPTY_USAGE,
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
        },
    };
}

function isNonnegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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

/** Fail-closed authorization re-check: a throwing gate means "not authorized". */
export function authorized(check: () => boolean): boolean {
    try {
        return check();
    } catch {
        return false;
    }
}

export function createLlmClassifier(
    getConfig: () => LlmClassifierConfig | undefined,
    fetchImpl: typeof fetch = fetch,
    environment: NodeJS.ProcessEnv = process.env,
): LlmClassifier {
    return new LlmClassifier(getConfig, fetchImpl, environment);
}
