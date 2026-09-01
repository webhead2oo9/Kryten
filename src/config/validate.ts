import type {
    AutoResponderConfig,
    BetaClassifierConfig,
    Config,
    CrosspostConfig,
    ImageFingerprintConfig,
    LlmClassifierConfig,
    ModerationConfig,
    ModerationTimeoutConfig,
    ProposalsConfig,
    TwitterConfig,
} from "../types";
import { isRecord } from "../utils/isRecord";

type JsonObject = Record<string, unknown>;
type NumberOptions = { integer?: boolean; min?: number; max?: number };
type NumericKey<T> = {
    [K in keyof T]-?: NonNullable<T[K]> extends number ? K : never;
}[keyof T] &
    string;

const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;
const IMAGE_CATEGORIES = ["scam", "nsfw", "crypto", "phishing", "other"] as const;
const LLM_CLASSIFIER_NUMBER_FIELDS: ReadonlyArray<readonly [NumericKey<LlmClassifierConfig>, NumberOptions]> = [
    ["timeout_ms", { integer: true, min: 1_000, max: 300_000 }],
    ["max_output_tokens", { integer: true, min: 1, max: 131_072 }],
    ["max_concurrency", { integer: true, min: 1, max: 16 }],
    ["max_queue_depth", { integer: true, min: 0, max: 10_000 }],
    ["max_queue_age_ms", { integer: true, min: 1_000, max: 300_000 }],
    ["max_requests_per_minute", { integer: true, min: 1, max: 10_000 }],
    ["temperature", { min: 0, max: 2 }],
    ["top_k", { integer: true, min: 1, max: 200 }],
    ["presence_penalty", { min: -2, max: 2 }],
    ["frequency_penalty", { min: -2, max: 2 }],
];

export class ConfigValidationError extends Error {
    constructor(readonly issues: string[]) {
        super(`config.json has invalid values:\n- ${issues.join("\n- ")}`);
        this.name = "ConfigValidationError";
    }
}

function optionalEnvironmentVariable(
    parent: JsonObject,
    key: string,
    path: string,
    issues: string[],
): string | undefined {
    const value = optionalString(parent, key, path, issues);
    if (value === undefined) return undefined;
    if (/^[A-Z_][A-Z0-9_]*$/.test(value)) return value;
    issues.push(`${path} must be an uppercase environment-variable name`);
    return undefined;
}

function optionalSection(parent: JsonObject, key: string, path: string, issues: string[]): JsonObject | undefined {
    const value = parent[key];
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
        issues.push(`${path} must be an object`);
        return undefined;
    }
    return value;
}

function optionalString(parent: JsonObject, key: string, path: string, issues: string[]): string | undefined {
    const value = parent[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
        issues.push(`${path} must be a string`);
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
}

function optionalStringArray(parent: JsonObject, key: string, path: string, issues: string[]): string[] | undefined {
    const value = parent[key];
    if (value === undefined) return undefined;
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed ? [trimmed] : [];
    }
    if (!Array.isArray(value)) {
        issues.push(`${path} must be an array of strings`);
        return undefined;
    }
    const out: string[] = [];
    value.forEach((entry, index) => {
        if (typeof entry !== "string") {
            issues.push(`${path}[${index}] must be a string`);
            return;
        }
        const trimmed = entry.trim();
        if (trimmed) out.push(trimmed);
    });
    return out;
}

function optionalBoolean(parent: JsonObject, key: string, path: string, issues: string[]): boolean | undefined {
    const value = parent[key];
    if (value === undefined) return undefined;
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true") return true;
        if (normalized === "false") return false;
    }
    if (value === 1) return true;
    if (value === 0) return false;
    issues.push(`${path} must be a boolean`);
    return undefined;
}

function optionalNumber(
    parent: JsonObject,
    key: string,
    path: string,
    issues: string[],
    options: NumberOptions = {},
): number | undefined {
    const value = parent[key];
    if (value === undefined) return undefined;
    const parsed =
        typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.trim()) : NaN;
    if (!Number.isFinite(parsed)) {
        issues.push(`${path} must be a finite number`);
        return undefined;
    }
    if (options.integer && !Number.isInteger(parsed)) {
        issues.push(`${path} must be an integer`);
        return undefined;
    }
    if (options.min !== undefined && parsed < options.min) {
        issues.push(`${path} must be >= ${options.min}`);
        return undefined;
    }
    if (options.max !== undefined && parsed > options.max) {
        issues.push(`${path} must be <= ${options.max}`);
        return undefined;
    }
    return parsed;
}

function optionalEnum<T extends string>(
    parent: JsonObject,
    key: string,
    path: string,
    issues: string[],
    values: readonly T[],
): T | undefined {
    const value = optionalString(parent, key, path, issues);
    if (value === undefined) return undefined;
    if (values.includes(value as T)) return value as T;
    issues.push(`${path} must be one of: ${values.join(", ")}`);
    return undefined;
}

function optionalUrl(parent: JsonObject, key: string, path: string, issues: string[]): string | undefined {
    const value = optionalString(parent, key, path, issues);
    if (value === undefined) return undefined;
    try {
        new URL(value);
        return value.replace(/\/+$/, "");
    } catch {
        issues.push(`${path} must be a valid URL`);
        return undefined;
    }
}

function optionalIsoTimestamp(parent: JsonObject, key: string, path: string, issues: string[]): string | undefined {
    const value = optionalString(parent, key, path, issues);
    if (value === undefined) return undefined;
    const timestamp = Date.parse(value);
    const normalized = value.endsWith("Z") && !value.includes(".") ? value.replace(/Z$/u, ".000Z") : value;
    if (
        !Number.isFinite(timestamp) ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value) ||
        new Date(timestamp).toISOString() !== normalized
    ) {
        issues.push(`${path} must be an ISO-8601 UTC timestamp such as 2026-08-05T16:01:00Z`);
        return undefined;
    }
    return value;
}

function optionalHost(parent: JsonObject, key: string, path: string, issues: string[]): string | undefined {
    const value = optionalString(parent, key, path, issues);
    if (value === undefined) return undefined;
    if (/^[a-z0-9.-]+(?::\d{1,5})?$/i.test(value)) return value;
    issues.push(`${path} must be a hostname, not a full URL or path`);
    return undefined;
}

function assignString<T extends object, K extends keyof T>(target: T, key: K, value: string | undefined): void {
    if (value !== undefined) target[key] = value as T[K];
}

function assignStringArray<T extends object, K extends keyof T>(target: T, key: K, value: string[] | undefined): void {
    if (value !== undefined) target[key] = value as T[K];
}

function assignBoolean<T extends object, K extends keyof T>(target: T, key: K, value: boolean | undefined): void {
    if (value !== undefined) target[key] = value as T[K];
}

function assignNumber<T extends object, K extends keyof T>(target: T, key: K, value: number | undefined): void {
    if (value !== undefined) target[key] = value as T[K];
}

function assignOptionalNumbers<T extends object>(
    target: T,
    input: JsonObject,
    path: string,
    issues: string[],
    fields: ReadonlyArray<readonly [NumericKey<T>, NumberOptions]>,
): void {
    for (const [key, options] of fields) {
        assignNumber(target, key, optionalNumber(input, key, `${path}.${key}`, issues, options));
    }
}

function validateTimeout(input: JsonObject, issues: string[]): ModerationTimeoutConfig {
    const out: ModerationTimeoutConfig = {};
    assignString(out, "channel_id", optionalString(input, "channel_id", "moderation.timeout.channel_id", issues));
    assignString(out, "role_id", optionalString(input, "role_id", "moderation.timeout.role_id", issues));
    assignStringArray(
        out,
        "allowed_role_ids",
        optionalStringArray(input, "allowed_role_ids", "moderation.timeout.allowed_role_ids", issues),
    );
    assignString(
        out,
        "notification_channel_id",
        optionalString(input, "notification_channel_id", "moderation.timeout.notification_channel_id", issues),
    );
    return out;
}

function validateCrosspost(input: JsonObject, issues: string[]): CrosspostConfig {
    const out: CrosspostConfig = {};
    assignBoolean(out, "enabled", optionalBoolean(input, "enabled", "moderation.crosspost.enabled", issues));
    assignNumber(
        out,
        "window_seconds",
        optionalNumber(input, "window_seconds", "moderation.crosspost.window_seconds", issues, {
            integer: true,
            min: 1,
            max: 86_400,
        }),
    );
    for (const key of ["sequence_ratio_threshold", "jaccard_threshold", "char_cosine_threshold"] as const) {
        assignNumber(out, key, optionalNumber(input, key, `moderation.crosspost.${key}`, issues, { min: 0, max: 1 }));
    }
    assignNumber(
        out,
        "min_normalized_length",
        optionalNumber(input, "min_normalized_length", "moderation.crosspost.min_normalized_length", issues, {
            integer: true,
            min: 1,
            max: 2_000,
        }),
    );
    assignNumber(
        out,
        "length_ratio_threshold",
        optionalNumber(input, "length_ratio_threshold", "moderation.crosspost.length_ratio_threshold", issues, {
            min: 1,
            max: 10,
        }),
    );
    assignNumber(
        out,
        "new_content_ratio_threshold",
        optionalNumber(
            input,
            "new_content_ratio_threshold",
            "moderation.crosspost.new_content_ratio_threshold",
            issues,
            {
                min: 0,
                max: 1,
            },
        ),
    );
    assignNumber(
        out,
        "min_algorithms_to_match",
        optionalNumber(input, "min_algorithms_to_match", "moderation.crosspost.min_algorithms_to_match", issues, {
            integer: true,
            min: 1,
            max: 3,
        }),
    );
    assignBoolean(out, "dry_run", optionalBoolean(input, "dry_run", "moderation.crosspost.dry_run", issues));
    assignNumber(
        out,
        "burst_channel_threshold",
        optionalNumber(input, "burst_channel_threshold", "moderation.crosspost.burst_channel_threshold", issues, {
            integer: true,
            min: 1,
            max: 100,
        }),
    );
    assignNumber(
        out,
        "burst_timeout_minutes",
        optionalNumber(input, "burst_timeout_minutes", "moderation.crosspost.burst_timeout_minutes", issues, {
            integer: true,
            min: 1,
            max: MAX_TIMEOUT_MINUTES,
        }),
    );
    assignString(
        out,
        "burst_alert_channel_id",
        optionalString(input, "burst_alert_channel_id", "moderation.crosspost.burst_alert_channel_id", issues),
    );
    assignStringArray(
        out,
        "ignored_channels",
        optionalStringArray(input, "ignored_channels", "moderation.crosspost.ignored_channels", issues),
    );
    assignStringArray(
        out,
        "whitelisted_role_ids",
        optionalStringArray(input, "whitelisted_role_ids", "moderation.crosspost.whitelisted_role_ids", issues),
    );
    return out;
}

function validateImageFingerprint(input: JsonObject, issues: string[]): ImageFingerprintConfig {
    const out: ImageFingerprintConfig = {};
    assignBoolean(out, "enabled", optionalBoolean(input, "enabled", "moderation.image_fingerprint.enabled", issues));
    assignBoolean(out, "dry_run", optionalBoolean(input, "dry_run", "moderation.image_fingerprint.dry_run", issues));
    assignBoolean(
        out,
        "report_hits_in_dry_run",
        optionalBoolean(input, "report_hits_in_dry_run", "moderation.image_fingerprint.report_hits_in_dry_run", issues),
    );
    assignString(out, "db_path", optionalString(input, "db_path", "moderation.image_fingerprint.db_path", issues));
    for (const key of ["match_tolerance", "duplicate_tolerance", "crosspost_tolerance"] as const) {
        assignNumber(
            out,
            key,
            optionalNumber(input, key, `moderation.image_fingerprint.${key}`, issues, {
                integer: true,
                min: 0,
                max: 64,
            }),
        );
    }
    const action = optionalEnum(input, "default_action", "moderation.image_fingerprint.default_action", issues, [
        "kick",
        "timeout",
    ] as const);
    if (action !== undefined) out.default_action = action;
    const category = optionalEnum(
        input,
        "default_category",
        "moderation.image_fingerprint.default_category",
        issues,
        IMAGE_CATEGORIES,
    );
    if (category !== undefined) out.default_category = category;
    assignNumber(
        out,
        "timeout_minutes",
        optionalNumber(input, "timeout_minutes", "moderation.image_fingerprint.timeout_minutes", issues, {
            integer: true,
            min: 1,
            max: MAX_TIMEOUT_MINUTES,
        }),
    );
    for (const key of ["delete_on_match", "enforce_known_bad", "review_crossposts", "hub_enabled"] as const) {
        assignBoolean(out, key, optionalBoolean(input, key, `moderation.image_fingerprint.${key}`, issues));
    }
    assignNumber(
        out,
        "recent_window_seconds",
        optionalNumber(input, "recent_window_seconds", "moderation.image_fingerprint.recent_window_seconds", issues, {
            integer: true,
            min: 1,
            max: 86_400,
        }),
    );
    assignNumber(
        out,
        "review_channel_threshold",
        optionalNumber(
            input,
            "review_channel_threshold",
            "moderation.image_fingerprint.review_channel_threshold",
            issues,
            {
                integer: true,
                min: 1,
                max: 100,
            },
        ),
    );
    assignString(
        out,
        "review_channel_id",
        optionalString(input, "review_channel_id", "moderation.image_fingerprint.review_channel_id", issues),
    );
    assignString(
        out,
        "alert_channel_id",
        optionalString(input, "alert_channel_id", "moderation.image_fingerprint.alert_channel_id", issues),
    );
    assignStringArray(
        out,
        "ignored_channels",
        optionalStringArray(input, "ignored_channels", "moderation.image_fingerprint.ignored_channels", issues),
    );
    assignStringArray(
        out,
        "whitelisted_role_ids",
        optionalStringArray(input, "whitelisted_role_ids", "moderation.image_fingerprint.whitelisted_role_ids", issues),
    );
    assignString(
        out,
        "hub_base_url",
        optionalUrl(input, "hub_base_url", "moderation.image_fingerprint.hub_base_url", issues),
    );
    assignNumber(
        out,
        "hub_sync_interval_seconds",
        optionalNumber(
            input,
            "hub_sync_interval_seconds",
            "moderation.image_fingerprint.hub_sync_interval_seconds",
            issues,
            {
                integer: true,
                min: 1,
                max: 86_400,
            },
        ),
    );
    assignNumber(
        out,
        "hub_request_timeout_seconds",
        optionalNumber(
            input,
            "hub_request_timeout_seconds",
            "moderation.image_fingerprint.hub_request_timeout_seconds",
            issues,
            {
                min: 0.1,
                max: 120,
            },
        ),
    );
    assignString(
        out,
        "hub_api_key_env",
        optionalString(input, "hub_api_key_env", "moderation.image_fingerprint.hub_api_key_env", issues),
    );
    return out;
}

function validateModeration(input: JsonObject, issues: string[]): ModerationConfig {
    const out: ModerationConfig = {};
    assignString(out, "mod_role_id", optionalString(input, "mod_role_id", "moderation.mod_role_id", issues));
    assignString(
        out,
        "alert_channel_id",
        optionalString(input, "alert_channel_id", "moderation.alert_channel_id", issues),
    );
    assignStringArray(
        out,
        "channel_blacklist",
        optionalStringArray(input, "channel_blacklist", "moderation.channel_blacklist", issues),
    );
    const timeout = optionalSection(input, "timeout", "moderation.timeout", issues);
    if (timeout) out.timeout = validateTimeout(timeout, issues);
    const crosspost = optionalSection(input, "crosspost", "moderation.crosspost", issues);
    if (crosspost) out.crosspost = validateCrosspost(crosspost, issues);
    const imageFingerprint = optionalSection(input, "image_fingerprint", "moderation.image_fingerprint", issues);
    if (imageFingerprint) out.image_fingerprint = validateImageFingerprint(imageFingerprint, issues);
    return out;
}

function validateAutoResponder(input: JsonObject, issues: string[]): AutoResponderConfig {
    const out: AutoResponderConfig = {};
    assignStringArray(
        out,
        "auto_response_channel_ids",
        optionalStringArray(input, "auto_response_channel_ids", "auto_responder.auto_response_channel_ids", issues),
    );
    assignString(
        out,
        "random_greeting_channel_id",
        optionalString(input, "random_greeting_channel_id", "auto_responder.random_greeting_channel_id", issues),
    );
    assignString(out, "store_path", optionalString(input, "store_path", "auto_responder.store_path", issues));
    assignString(
        out,
        "encryption_key_env",
        optionalString(input, "encryption_key_env", "auto_responder.encryption_key_env", issues),
    );
    return out;
}

function validateLlmClassifier(input: JsonObject, issues: string[]): LlmClassifierConfig {
    const out: LlmClassifierConfig = {};
    assignBoolean(out, "enabled", optionalBoolean(input, "enabled", "llm_classifier.enabled", issues));

    const provider = optionalEnum(input, "provider", "llm_classifier.provider", issues, ["fireworks"] as const);
    if (provider !== undefined) out.provider = provider;

    assignString(out, "model", optionalString(input, "model", "llm_classifier.model", issues));
    assignString(
        out,
        "api_key_env",
        optionalEnvironmentVariable(input, "api_key_env", "llm_classifier.api_key_env", issues),
    );
    assignString(
        out,
        "classification_log_channel_id",
        optionalString(input, "classification_log_channel_id", "llm_classifier.classification_log_channel_id", issues),
    );

    if (provider === "fireworks" && out.api_key_env && !/^FIREWORKS_[A-Z0-9_]*$/.test(out.api_key_env)) {
        issues.push("llm_classifier.api_key_env must name a FIREWORKS_* variable for the Fireworks provider");
    }

    assignOptionalNumbers(out, input, "llm_classifier", issues, LLM_CLASSIFIER_NUMBER_FIELDS);

    if (out.enabled && !out.provider) issues.push("llm_classifier.provider is required when enabled");
    if (out.enabled && !out.model) issues.push("llm_classifier.model is required when enabled");
    return out;
}

function validateBetaClassifier(input: JsonObject, issues: string[]): BetaClassifierConfig {
    const out: BetaClassifierConfig = {};
    assignBoolean(out, "enabled", optionalBoolean(input, "enabled", "beta_classifier.enabled", issues));
    assignBoolean(
        out,
        "response_enabled",
        optionalBoolean(input, "response_enabled", "beta_classifier.response_enabled", issues),
    );
    assignBoolean(
        out,
        "target_greeting_enabled",
        optionalBoolean(input, "target_greeting_enabled", "beta_classifier.target_greeting_enabled", issues),
    );
    assignBoolean(
        out,
        "target_greeting_retention_enabled",
        optionalBoolean(
            input,
            "target_greeting_retention_enabled",
            "beta_classifier.target_greeting_retention_enabled",
            issues,
        ),
    );
    assignNumber(
        out,
        "target_greeting_delete_after_seconds",
        optionalNumber(
            input,
            "target_greeting_delete_after_seconds",
            "beta_classifier.target_greeting_delete_after_seconds",
            issues,
            { integer: true, min: 5, max: 3_600 },
        ),
    );
    assignString(
        out,
        "target_greeting_prompt_file",
        optionalString(input, "target_greeting_prompt_file", "beta_classifier.target_greeting_prompt_file", issues),
    );
    assignString(
        out,
        "announcements_channel_id",
        optionalString(input, "announcements_channel_id", "beta_classifier.announcements_channel_id", issues),
    );
    assignString(out, "guild_id", optionalString(input, "guild_id", "beta_classifier.guild_id", issues));
    if (input["watched_channel_ids"] !== undefined) {
        issues.push("beta_classifier.watched_channel_ids was removed; use included_channel_ids");
    }
    assignStringArray(
        out,
        "included_channel_ids",
        optionalStringArray(input, "included_channel_ids", "beta_classifier.included_channel_ids", issues),
    );
    assignStringArray(
        out,
        "excluded_role_ids",
        optionalStringArray(input, "excluded_role_ids", "beta_classifier.excluded_role_ids", issues),
    );
    const campaignId = optionalString(input, "campaign_id", "beta_classifier.campaign_id", issues);
    if (campaignId && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(campaignId)) {
        issues.push("beta_classifier.campaign_id must be 1-64 letters, numbers, dots, underscores, or hyphens");
    } else if (campaignId) {
        out.campaign_id = campaignId;
    }
    assignString(
        out,
        "campaign_started_at",
        optionalIsoTimestamp(input, "campaign_started_at", "beta_classifier.campaign_started_at", issues),
    );
    assignString(
        out,
        "target_channel_id",
        optionalString(input, "target_channel_id", "beta_classifier.target_channel_id", issues),
    );
    assignString(
        out,
        "announcement_url",
        optionalUrl(input, "announcement_url", "beta_classifier.announcement_url", issues),
    );
    assignString(out, "prompt_file", optionalString(input, "prompt_file", "beta_classifier.prompt_file", issues));
    assignNumber(
        out,
        "max_context_messages",
        optionalNumber(input, "max_context_messages", "beta_classifier.max_context_messages", issues, {
            integer: true,
            min: 1,
            max: 25,
        }),
    );
    assignNumber(
        out,
        "max_context_characters",
        optionalNumber(input, "max_context_characters", "beta_classifier.max_context_characters", issues, {
            integer: true,
            min: 1_000,
            max: 200_000,
        }),
    );
    if (out.enabled) {
        if (!out.guild_id) issues.push("beta_classifier.guild_id is required when enabled");
        if (!out.included_channel_ids?.length) {
            issues.push("beta_classifier.included_channel_ids must not be empty when enabled");
        }
        if (!out.campaign_id) issues.push("beta_classifier.campaign_id is required when enabled");
        if (!out.campaign_started_at) issues.push("beta_classifier.campaign_started_at is required when enabled");
        if (!out.target_channel_id) issues.push("beta_classifier.target_channel_id is required when enabled");
        if (!out.announcement_url) issues.push("beta_classifier.announcement_url is required when enabled");
        if (!out.prompt_file) issues.push("beta_classifier.prompt_file is required when enabled");
    }
    if (out.target_greeting_enabled) {
        if (!out.target_channel_id) {
            issues.push("beta_classifier.target_channel_id is required when target greeting is enabled");
        }
        if (!out.announcements_channel_id) {
            issues.push("beta_classifier.announcements_channel_id is required when target greeting is enabled");
        }
        if (!out.campaign_id) {
            issues.push("beta_classifier.campaign_id is required when target greeting is enabled");
        }
        if (!out.campaign_started_at) {
            issues.push("beta_classifier.campaign_started_at is required when target greeting is enabled");
        }
    }
    if (out.target_greeting_retention_enabled) {
        if (!out.target_greeting_enabled) {
            issues.push("beta_classifier target greeting must be enabled when greeting retention is enabled");
        }
        if (!out.target_greeting_prompt_file) {
            issues.push("beta_classifier.target_greeting_prompt_file is required when greeting retention is enabled");
        }
    }
    return out;
}

function validateTwitter(input: JsonObject, issues: string[]): TwitterConfig {
    const out: TwitterConfig = {};
    assignBoolean(out, "enabled", optionalBoolean(input, "enabled", "twitter.enabled", issues));
    assignStringArray(
        out,
        "enabled_channels",
        optionalStringArray(input, "enabled_channels", "twitter.enabled_channels", issues),
    );
    assignString(out, "embed_service", optionalHost(input, "embed_service", "twitter.embed_service", issues));
    return out;
}

function validateProposals(input: JsonObject, issues: string[]): ProposalsConfig {
    const out: ProposalsConfig = {};
    assignBoolean(out, "enabled", optionalBoolean(input, "enabled", "proposals.enabled", issues));
    assignString(
        out,
        "review_channel_id",
        optionalString(input, "review_channel_id", "proposals.review_channel_id", issues),
    );
    assignNumber(
        out,
        "max_pending",
        optionalNumber(input, "max_pending", "proposals.max_pending", issues, {
            integer: true,
            min: 1,
            max: 1_000,
        }),
    );
    assignNumber(
        out,
        "ttl_hours",
        optionalNumber(input, "ttl_hours", "proposals.ttl_hours", issues, {
            min: 0.1,
            max: 8_760,
        }),
    );
    assignNumber(
        out,
        "rate_limit_per_minute",
        optionalNumber(input, "rate_limit_per_minute", "proposals.rate_limit_per_minute", issues, {
            integer: true,
            min: 1,
            max: 10_000,
        }),
    );
    assignString(out, "db_path", optionalString(input, "db_path", "proposals.db_path", issues));
    return out;
}

export function validateConfig(value: unknown): Config {
    const issues: string[] = [];
    if (!isRecord(value)) throw new ConfigValidationError(["config root must be an object"]);

    const out: Config = {};
    assignStringArray(out, "staff_roles", optionalStringArray(value, "staff_roles", "staff_roles", issues));
    assignString(out, "githubRepoOwner", optionalString(value, "githubRepoOwner", "githubRepoOwner", issues));
    assignString(out, "githubRepoName", optionalString(value, "githubRepoName", "githubRepoName", issues));
    assignString(out, "githubCommandsDir", optionalString(value, "githubCommandsDir", "githubCommandsDir", issues));
    assignString(out, "githubBranch", optionalString(value, "githubBranch", "githubBranch", issues));
    assignNumber(
        out,
        "githubPollMinutes",
        optionalNumber(value, "githubPollMinutes", "githubPollMinutes", issues, {
            min: 0,
            max: 35_000,
        }),
    );
    assignString(
        out,
        "error_log_channel_id",
        optionalString(value, "error_log_channel_id", "error_log_channel_id", issues),
    );

    const moderation = optionalSection(value, "moderation", "moderation", issues);
    if (moderation) out.moderation = validateModeration(moderation, issues);
    const autoResponder = optionalSection(value, "auto_responder", "auto_responder", issues);
    if (autoResponder) out.auto_responder = validateAutoResponder(autoResponder, issues);
    const llmClassifier = optionalSection(value, "llm_classifier", "llm_classifier", issues);
    if (llmClassifier) out.llm_classifier = validateLlmClassifier(llmClassifier, issues);
    const betaClassifier = optionalSection(value, "beta_classifier", "beta_classifier", issues);
    if (betaClassifier) out.beta_classifier = validateBetaClassifier(betaClassifier, issues);
    if (out.beta_classifier?.target_greeting_retention_enabled && !out.llm_classifier?.enabled) {
        issues.push("llm_classifier.enabled is required when beta greeting retention is enabled");
    }
    const twitter = optionalSection(value, "twitter", "twitter", issues);
    if (twitter) out.twitter = validateTwitter(twitter, issues);
    const proposals = optionalSection(value, "proposals", "proposals", issues);
    if (proposals) out.proposals = validateProposals(proposals, issues);

    if (issues.length) throw new ConfigValidationError(issues);
    return out;
}
