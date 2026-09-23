import { Colors, EmbedBuilder, type Message } from "discord.js";
import type { KrytenClient } from "../classes/client";
import type { ClassificationResult, ClassificationTask } from "./classifier";
import type { TypeSafeShadowConfig } from "../types";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const DEFAULT_MODEL = "jev-1.13.0";
const MAX_RESPONSE_BYTES = 64 * 1024;
const PROBABILITY_SUM_TOLERANCE = 0.01 + Number.EPSILON;

export type TypeSafeShadowStatus =
    | "ok"
    | "disabled"
    | "missing_api_key"
    | "invalid_request"
    | "queue_full"
    | "rate_limited"
    | "stale"
    | "timeout"
    | "http_error"
    | "invalid_response"
    | "cancelled";

export interface TypeSafeShadowTask<Label extends string> {
    systemInstruction: string;
    input: string;
    allowedLabels: readonly Label[];
    fallbackLabel: Label;
    criteria: Record<Label, string>;
}

export interface TypeSafeShadowUsage {
    inputTokens: number;
    outputTokens: number;
}

export interface TypeSafeShadowResult<Label extends string> {
    label: Label;
    status: TypeSafeShadowStatus;
    model?: string;
    probabilities?: Record<Label, number>;
    confidence?: number;
    latencyMs: number;
    usage: TypeSafeShadowUsage;
    errorCategory?: string;
}

export interface TypeSafeShadowClientMetrics extends TypeSafeShadowUsage {
    submitted: number;
    completed: number;
    successful: number;
    failures: number;
    skipped: number;
    queueDrops: number;
    rateDrops: number;
    staleDrops: number;
    inFlight: number;
    queued: number;
    totalLatencyMs: number;
    maxLatencyMs: number;
}

interface EffectiveConfig {
    source: TypeSafeShadowConfig;
    model: string;
    timeoutMs: number;
    maxConcurrency: number;
    maxQueueDepth: number;
    maxQueueAgeMs: number;
    maxRequestsPerMinute: number;
}

interface QueuedJob {
    config: EffectiveConfig;
    enqueuedAt: number;
    run: () => Promise<void>;
    cancel: () => void;
}

const EMPTY_USAGE: TypeSafeShadowUsage = { inputTokens: 0, outputTokens: 0 };

export class TypeSafeShadowClient {
    private closed = false;
    private inFlight = 0;
    private readonly queue: QueuedJob[] = [];
    private readonly acceptedTimestamps: number[] = [];
    private readonly controllers = new Set<AbortController>();
    private readonly idleWaiters = new Set<() => void>();
    private readonly metrics: Omit<TypeSafeShadowClientMetrics, "inFlight" | "queued"> = {
        submitted: 0,
        completed: 0,
        successful: 0,
        failures: 0,
        skipped: 0,
        queueDrops: 0,
        rateDrops: 0,
        staleDrops: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalLatencyMs: 0,
        maxLatencyMs: 0,
    };

    constructor(
        private readonly getConfig: () => TypeSafeShadowConfig | undefined,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly environment: NodeJS.ProcessEnv = process.env,
    ) {}

    classify<Label extends string>(
        task: TypeSafeShadowTask<Label>,
        isAuthorized: () => boolean = () => true,
    ): Promise<TypeSafeShadowResult<Label>> {
        this.metrics.submitted++;
        if (!validTask(task)) return Promise.resolve(this.finishFallback(task.fallbackLabel, "invalid_request"));
        const config = this.effectiveConfig();
        if (!config) return Promise.resolve(this.finishFallback(task.fallbackLabel, "disabled"));
        if (!authorized(isAuthorized)) return Promise.resolve(this.finishFallback(task.fallbackLabel, "cancelled"));
        if (!this.environment["TYPESAFE_API_KEY"]?.trim()) {
            return Promise.resolve(this.finishFallback(task.fallbackLabel, "missing_api_key"));
        }

        const mustQueue = this.queue.length > 0 || this.inFlight >= config.maxConcurrency;
        if (mustQueue && this.queue.length >= config.maxQueueDepth) {
            this.metrics.queueDrops++;
            return Promise.resolve(this.finishFallback(task.fallbackLabel, "queue_full"));
        }
        const now = Date.now();
        while (this.acceptedTimestamps[0] !== undefined && this.acceptedTimestamps[0] <= now - 60_000) {
            this.acceptedTimestamps.shift();
        }
        if (this.acceptedTimestamps.length >= config.maxRequestsPerMinute) {
            this.metrics.rateDrops++;
            return Promise.resolve(this.finishFallback(task.fallbackLabel, "rate_limited"));
        }
        this.acceptedTimestamps.push(now);

        return new Promise(resolve => {
            const job: QueuedJob = {
                config,
                enqueuedAt: now,
                cancel: () => resolve(this.finishFallback(task.fallbackLabel, "cancelled")),
                run: async () => {
                    if (Date.now() - now > config.maxQueueAgeMs) {
                        this.metrics.staleDrops++;
                        resolve(this.finishFallback(task.fallbackLabel, "stale"));
                        return;
                    }
                    if (this.effectiveConfig()?.source !== config.source || !authorized(isAuthorized)) {
                        resolve(this.finishFallback(task.fallbackLabel, "cancelled"));
                        return;
                    }
                    resolve(await this.request(task, config, isAuthorized));
                },
            };
            if (mustQueue) this.queue.push(job);
            else this.start(job);
        });
    }

    getMetrics(): TypeSafeShadowClientMetrics {
        return { ...this.metrics, inFlight: this.inFlight, queued: this.queue.length };
    }

    reconfigure(): void {
        const source = this.getConfig();
        for (const job of this.queue.splice(0)) {
            if (job.config.source !== source || !source?.enabled) job.cancel();
            else this.queue.push(job);
        }
        for (const controller of this.controllers) controller.abort();
        this.pump();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const job of this.queue.splice(0)) job.cancel();
        for (const controller of this.controllers) controller.abort();
        this.resolveIdle();
    }

    drain(): Promise<void> {
        if (this.inFlight === 0 && this.queue.length === 0) return Promise.resolve();
        return new Promise(resolve => this.idleWaiters.add(resolve));
    }

    private effectiveConfig(): EffectiveConfig | null {
        if (this.closed) return null;
        const config = this.getConfig();
        if (!config?.enabled || !config.log_channel_id?.trim()) return null;
        return {
            source: config,
            model: config.model?.trim() || DEFAULT_MODEL,
            timeoutMs: config.timeout_ms ?? 5_000,
            maxConcurrency: config.max_concurrency ?? 2,
            maxQueueDepth: config.max_queue_depth ?? 25,
            maxQueueAgeMs: config.max_queue_age_ms ?? 10_000,
            maxRequestsPerMinute: config.max_requests_per_minute ?? 60,
        };
    }

    private start(job: QueuedJob): void {
        this.inFlight++;
        void job.run().finally(() => {
            this.inFlight--;
            this.pump();
        });
    }

    private pump(): void {
        for (;;) {
            const job = this.queue[0];
            const current = this.effectiveConfig();
            if (!job || !current || this.inFlight >= Math.min(job.config.maxConcurrency, current.maxConcurrency)) break;
            this.queue.shift();
            this.start(job);
        }
        this.resolveIdle();
    }

    private resolveIdle(): void {
        if (this.inFlight || this.queue.length) return;
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
    }

    private async request<Label extends string>(
        task: TypeSafeShadowTask<Label>,
        config: EffectiveConfig,
        isAuthorized: () => boolean,
    ): Promise<TypeSafeShadowResult<Label>> {
        const started = Date.now();
        const apiKey = this.environment["TYPESAFE_API_KEY"]?.trim();
        if (!apiKey || this.effectiveConfig()?.source !== config.source || !authorized(isAuthorized)) {
            return this.finishFallback(task.fallbackLabel, apiKey ? "cancelled" : "missing_api_key");
        }
        const controller = new AbortController();
        const timeout = setTimeout(
            () => controller.abort(new DOMException("Timed out", "TimeoutError")),
            config.timeoutMs,
        );
        timeout.unref();
        this.controllers.add(controller);
        try {
            const response = await this.fetchImpl(ENDPOINT, {
                method: "POST",
                redirect: "error",
                headers: {
                    Accept: "application/json",
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: config.model,
                    state: task.input,
                    questions: {
                        decision: {
                            type: "choice",
                            instructions: `${task.systemInstruction.trim()}\n\nApply this policy to TARGET in the state.`,
                            criteria: task.criteria,
                        },
                    },
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                void response.body?.cancel().catch(() => undefined);
                const status =
                    response.status === 408 || response.status === 504
                        ? "timeout"
                        : response.status === 429
                          ? "rate_limited"
                          : "http_error";
                return this.finish(task.fallbackLabel, status, started, EMPTY_USAGE, `http_${response.status}`);
            }
            const raw = await readTextBounded(response, MAX_RESPONSE_BYTES);
            if (raw === "oversize") {
                return this.finish(task.fallbackLabel, "invalid_response", started, EMPTY_USAGE, "oversize");
            }
            const parsed = parseResponse(raw, task.allowedLabels, config.model);
            if (!parsed) {
                return this.finish(task.fallbackLabel, "invalid_response", started, EMPTY_USAGE, "invalid_shape");
            }
            return this.finish(
                parsed.label,
                "ok",
                started,
                parsed.usage,
                undefined,
                parsed.model,
                parsed.probabilities,
                parsed.confidence,
            );
        } catch (error) {
            const name = error instanceof Error ? error.name : "";
            const timedOut = name === "TimeoutError";
            const cancelled = controller.signal.aborted && !timedOut;
            return this.finish(
                task.fallbackLabel,
                timedOut ? "timeout" : cancelled ? "cancelled" : "http_error",
                started,
                EMPTY_USAGE,
                timedOut ? "timeout" : cancelled ? "cancelled" : "transport",
            );
        } finally {
            clearTimeout(timeout);
            this.controllers.delete(controller);
        }
    }

    private finishFallback<Label extends string>(
        label: Label,
        status: TypeSafeShadowStatus,
    ): TypeSafeShadowResult<Label> {
        return this.finish(label, status, Date.now(), EMPTY_USAGE);
    }

    private finish<Label extends string>(
        label: Label,
        status: TypeSafeShadowStatus,
        started: number,
        usage: TypeSafeShadowUsage,
        errorCategory?: string,
        model?: string,
        probabilities?: Record<Label, number>,
        confidence?: number,
    ): TypeSafeShadowResult<Label> {
        const latencyMs = Math.max(0, Date.now() - started);
        this.metrics.completed++;
        if (status === "ok") this.metrics.successful++;
        else if (status === "disabled" || status === "missing_api_key" || status === "cancelled")
            this.metrics.skipped++;
        else this.metrics.failures++;
        this.metrics.inputTokens += usage.inputTokens;
        this.metrics.outputTokens += usage.outputTokens;
        this.metrics.totalLatencyMs += latencyMs;
        this.metrics.maxLatencyMs = Math.max(this.metrics.maxLatencyMs, latencyMs);
        return {
            label,
            status,
            ...(model ? { model } : {}),
            ...(probabilities ? { probabilities } : {}),
            ...(confidence !== undefined ? { confidence } : {}),
            latencyMs,
            usage: { ...usage },
            ...(errorCategory ? { errorCategory } : {}),
        };
    }
}

function authorized(check: () => boolean): boolean {
    try {
        return check();
    } catch {
        return false;
    }
}

function validTask<Label extends string>(task: TypeSafeShadowTask<Label>): boolean {
    const labels = new Set(task.allowedLabels);
    return (
        !!task.systemInstruction.trim() &&
        !!task.input.trim() &&
        labels.size >= 2 &&
        labels.size === task.allowedLabels.length &&
        labels.has(task.fallbackLabel) &&
        Object.keys(task.criteria).length === labels.size &&
        [...labels].every(label => Object.hasOwn(task.criteria, label) && !!task.criteria[label]?.trim())
    );
}

interface ParsedResponse<Label extends string> {
    label: Label;
    model: string;
    probabilities: Record<Label, number>;
    confidence: number;
    usage: TypeSafeShadowUsage;
}

function parseResponse<Label extends string>(
    raw: string | null,
    allowedLabels: readonly Label[],
    expectedModel: string,
): ParsedResponse<Label> | null {
    if (raw === null) return null;
    let value: unknown;
    try {
        value = JSON.parse(raw) as unknown;
    } catch {
        return null;
    }
    if (!record(value) || value["model"] !== expectedModel || !record(value["answers"]) || !record(value["usage"])) {
        return null;
    }
    const answer = value["answers"]["decision"];
    if (!record(answer) || answer["type"] !== "choice" || !record(answer["probabilities"])) return null;
    const choice = answer["choice"];
    const confidence = answer["confidence"];
    if (typeof choice !== "string" || !allowedLabels.includes(choice as Label) || !finiteUnit(confidence)) return null;
    const keys = Object.keys(answer["probabilities"]);
    if (keys.length !== allowedLabels.length || !keys.every(key => allowedLabels.includes(key as Label))) return null;
    const probabilities = {} as Record<Label, number>;
    let sum = 0;
    for (const label of allowedLabels) {
        const probability = answer["probabilities"][label];
        if (!finiteUnit(probability)) return null;
        probabilities[label] = probability;
        sum += probability;
    }
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) return null;
    const inputTokens = value["usage"]["input_tokens"];
    const outputTokens = value["usage"]["output_tokens"];
    if (!nonnegativeInteger(inputTokens) || !nonnegativeInteger(outputTokens)) return null;
    return {
        label: choice as Label,
        model: expectedModel,
        probabilities,
        confidence,
        usage: { inputTokens, outputTokens },
    };
}

function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteUnit(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function nonnegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

async function readTextBounded(response: Response, maxBytes: number): Promise<string | null | "oversize"> {
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
        void response.body?.cancel().catch(() => undefined);
        return "oversize";
    }
    if (!response.body) {
        const text = await response.text();
        return Buffer.byteLength(text) <= maxBytes ? text : "oversize";
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
            return "oversize";
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks, received).toString("utf8");
}

export type ShadowTaskType = "beta_routing" | "beta_greeting";

export interface ShadowAgreementMetrics {
    compared: number;
    matches: number;
    mismatches: number;
    matchPercent: number | null;
    primaryFailures: number;
    shadowFailures: number;
    suppressed: number;
    late: number;
}

export interface TypeSafeShadowServiceMetrics {
    since: "process_start";
    provider: TypeSafeShadowClientMetrics;
    tasks: Record<ShadowTaskType, ShadowAgreementMetrics>;
    pendingComparisons: number;
    logSent: number;
    logFailures: number;
    logDrops: number;
}

interface ShadowProvider {
    classify<Label extends string>(
        task: TypeSafeShadowTask<Label>,
        isAuthorized?: () => boolean,
    ): Promise<TypeSafeShadowResult<Label>>;
    close(): void;
    drain(): Promise<void>;
    getMetrics?: () => TypeSafeShadowClientMetrics;
}

export interface ShadowBeginOptions<Label extends string> {
    taskType: ShadowTaskType;
    message: Message;
    task: ClassificationTask<Label>;
    isAuthorized: () => boolean;
    isLogAuthorized: () => boolean;
    deadlineAt?: number;
}

export interface ShadowComparisonHandle<Label extends string> {
    readonly taskType: ShadowTaskType;
    readonly message: Message;
    readonly shadowConfig: TypeSafeShadowConfig | undefined;
    readonly shadow: Promise<{ result: TypeSafeShadowResult<Label>; completedAt: number }>;
    readonly isLogAuthorized: () => boolean;
    readonly deadlineAt?: number;
}

const EMPTY_PROVIDER_METRICS: TypeSafeShadowClientMetrics = {
    submitted: 0,
    completed: 0,
    successful: 0,
    failures: 0,
    skipped: 0,
    queueDrops: 0,
    rateDrops: 0,
    staleDrops: 0,
    inputTokens: 0,
    outputTokens: 0,
    inFlight: 0,
    queued: 0,
    totalLatencyMs: 0,
    maxLatencyMs: 0,
};

function emptyAgreement(): Omit<ShadowAgreementMetrics, "matchPercent"> {
    return {
        compared: 0,
        matches: 0,
        mismatches: 0,
        primaryFailures: 0,
        shadowFailures: 0,
        suppressed: 0,
        late: 0,
    };
}

export class TypeSafeShadowService {
    private closed = false;
    private readonly pending = new Set<Promise<void>>();
    private readonly tasks: Record<ShadowTaskType, Omit<ShadowAgreementMetrics, "matchPercent">> = {
        beta_routing: emptyAgreement(),
        beta_greeting: emptyAgreement(),
    };
    private logSent = 0;
    private logFailures = 0;
    private logDrops = 0;
    private loggingInFlight = 0;

    constructor(
        private readonly client: KrytenClient,
        private readonly provider: ShadowProvider,
    ) {}

    begin<Label extends string>(options: ShadowBeginOptions<Label>): ShadowComparisonHandle<Label> | null {
        const shadowConfig = this.client.config.typesafe_shadow;
        if (this.closed || shadowConfig?.enabled !== true || !authorized(options.isAuthorized)) {
            return null;
        }
        const shadowTask: TypeSafeShadowTask<Label> = {
            ...options.task,
            criteria: criteriaFor(options.taskType, options.task.allowedLabels),
        };
        const requestAuthorized = (): boolean =>
            !this.closed &&
            shadowConfig.enabled === true &&
            this.client.config.typesafe_shadow === shadowConfig &&
            authorized(options.isLogAuthorized);
        const shadow = new Promise<{ result: TypeSafeShadowResult<Label>; completedAt: number }>(resolve => {
            queueMicrotask(() => {
                if (!requestAuthorized()) {
                    resolve({ result: cancelledShadowResult(shadowTask.fallbackLabel), completedAt: Date.now() });
                    return;
                }
                void this.provider
                    .classify(shadowTask, requestAuthorized)
                    .then(result => resolve({ result, completedAt: Date.now() }));
            });
        });
        return {
            taskType: options.taskType,
            message: options.message,
            shadowConfig,
            shadow,
            isLogAuthorized: options.isLogAuthorized,
            ...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {}),
        };
    }

    complete<Label extends string>(
        handle: ShadowComparisonHandle<Label> | null,
        primary: ClassificationResult<Label>,
    ): void {
        if (!handle) return;
        const comparison = this.finishComparison(handle, primary).finally(() => this.pending.delete(comparison));
        this.pending.add(comparison);
    }

    getMetrics(): TypeSafeShadowServiceMetrics {
        return {
            since: "process_start",
            provider: this.provider.getMetrics?.() ?? { ...EMPTY_PROVIDER_METRICS },
            tasks: {
                beta_routing: withPercentage(this.tasks.beta_routing),
                beta_greeting: withPercentage(this.tasks.beta_greeting),
            },
            pendingComparisons: this.pending.size,
            logSent: this.logSent,
            logFailures: this.logFailures,
            logDrops: this.logDrops,
        };
    }

    reconfigure(): void {
        if (this.provider instanceof TypeSafeShadowClient) this.provider.reconfigure();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.provider.close();
    }

    async drain(): Promise<void> {
        await this.provider.drain();
        while (this.pending.size) await Promise.allSettled([...this.pending]);
    }

    private async finishComparison<Label extends string>(
        handle: ShadowComparisonHandle<Label>,
        primary: ClassificationResult<Label>,
    ): Promise<void> {
        const { result: shadowResult, completedAt } = await handle.shadow;
        const taskMetrics = this.tasks[handle.taskType];
        if (
            this.closed ||
            this.client.config.typesafe_shadow !== handle.shadowConfig ||
            !authorized(handle.isLogAuthorized)
        ) {
            taskMetrics.suppressed++;
            return;
        }
        if (handle.deadlineAt !== undefined && completedAt >= handle.deadlineAt) taskMetrics.late++;
        if (primary.status !== "ok") taskMetrics.primaryFailures++;
        if (shadowResult.status !== "ok") taskMetrics.shadowFailures++;
        if (primary.status === "ok" && shadowResult.status === "ok") {
            taskMetrics.compared++;
            if (primary.label === shadowResult.label) taskMetrics.matches++;
            else taskMetrics.mismatches++;
        }
        await this.log(handle, primary, shadowResult, taskMetrics);
    }

    private async log<Label extends string>(
        handle: ShadowComparisonHandle<Label>,
        primary: ClassificationResult<Label>,
        shadow: TypeSafeShadowResult<Label>,
        metrics: Omit<ShadowAgreementMetrics, "matchPercent">,
    ): Promise<void> {
        const channelId = handle.shadowConfig?.log_channel_id;
        if (!channelId) return;
        if (this.loggingInFlight >= 2) {
            this.logDrops++;
            return;
        }
        this.loggingInFlight++;
        try {
            const deadlineAt = Date.now() + Math.min(handle.shadowConfig?.timeout_ms ?? 5_000, 10_000);
            const channel = await this.client.channels.fetch(channelId).catch(() => null);
            if (
                this.closed ||
                this.client.config.typesafe_shadow !== handle.shadowConfig ||
                !authorized(handle.isLogAuthorized)
            ) {
                return;
            }
            if (
                !channel ||
                !channel.isTextBased() ||
                !("guildId" in channel) ||
                channel.guildId !== handle.message.guildId ||
                !("send" in channel)
            ) {
                this.logFailures++;
                return;
            }
            if (Date.now() >= deadlineAt) {
                this.logFailures++;
                return;
            }
            const comparable = primary.status === "ok" && shadow.status === "ok";
            const matches = comparable && primary.label === shadow.label;
            const outcome = comparable ? (matches ? "Match" : "Mismatch") : "Not comparable";
            const agreement = metrics.compared
                ? `${((metrics.matches / metrics.compared) * 100).toFixed(1)}% (${metrics.matches}/${metrics.compared})`
                : "N/A (0/0)";
            const probabilityText = shadow.probabilities
                ? Object.entries(shadow.probabilities as Record<string, number>)
                      .map(([label, probability]) => `${label}: ${(probability * 100).toFixed(1)}%`)
                      .join(" · ")
                : "N/A";
            const embed = new EmbedBuilder()
                .setTitle("TypeSafe Jev Shadow Comparison")
                .setColor(!comparable ? Colors.Orange : matches ? Colors.Green : Colors.Red)
                .addFields(
                    { name: "Task", value: taskName(handle.taskType), inline: true },
                    { name: "Outcome", value: outcome, inline: true },
                    { name: "Running agreement", value: agreement, inline: true },
                    { name: "Fireworks", value: `${primary.label} (${primary.status})`, inline: true },
                    { name: "Jev", value: `${shadow.label} (${shadow.status})`, inline: true },
                    { name: "Model", value: shadow.model ?? "N/A", inline: true },
                    { name: "Jev probabilities", value: probabilityText },
                    {
                        name: "Confidence",
                        value: shadow.confidence === undefined ? "N/A" : shadow.confidence.toFixed(3),
                        inline: true,
                    },
                    { name: "Latency", value: `Fireworks ${primary.latencyMs} ms · Jev ${shadow.latencyMs} ms` },
                    { name: "Source", value: `[Open message](${handle.message.url})` },
                );
            await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
            if (Date.now() >= deadlineAt) {
                this.logFailures++;
                return;
            }
            this.logSent++;
        } catch {
            this.logFailures++;
        } finally {
            this.loggingInFlight--;
        }
    }
}

function cancelledShadowResult<Label extends string>(label: Label): TypeSafeShadowResult<Label> {
    return {
        label,
        status: "cancelled",
        latencyMs: 0,
        usage: { ...EMPTY_USAGE },
    };
}

function criteriaFor<Label extends string>(taskType: ShadowTaskType, labels: readonly Label[]): Record<Label, string> {
    const descriptions: Record<string, string> =
        taskType === "beta_routing"
            ? {
                  ROUTE: "The TARGET message is in scope for beta routing under the supplied policy.",
                  IGNORE: "The TARGET message is out of scope for beta routing under the supplied policy.",
              }
            : {
                  KEEP: "The TARGET message means the beta greeting should be kept under the supplied policy.",
                  DELETE: "The TARGET message means the beta greeting should be deleted under the supplied policy.",
              };
    return Object.fromEntries(labels.map(label => [label, descriptions[label] ?? `Select ${label}.`])) as Record<
        Label,
        string
    >;
}

function taskName(taskType: ShadowTaskType): string {
    return taskType === "beta_routing" ? "Beta routing" : "Beta greeting retention";
}

function withPercentage(metrics: Omit<ShadowAgreementMetrics, "matchPercent">): ShadowAgreementMetrics {
    return {
        ...metrics,
        matchPercent: metrics.compared ? (metrics.matches / metrics.compared) * 100 : null,
    };
}
