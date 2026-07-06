import type {
    AutoResponderConfig,
    Config,
    CrosspostConfig,
    ImageFingerprintConfig,
    ModerationConfig,
    ModerationTimeoutConfig,
    ProposalsConfig,
    TwitterConfig,
} from "../types";

type JsonObject = Record<string, unknown>;

const MAX_TIMEOUT_MINUTES = 28 * 24 * 60;
const IMAGE_CATEGORIES = ["scam", "nsfw", "crypto", "phishing", "other"] as const;

export class ConfigValidationError extends Error {
    constructor(readonly issues: string[]) {
        super(`config.json has invalid values:\n- ${issues.join("\n- ")}`);
        this.name = "ConfigValidationError";
    }
}

function isObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalSection(parent: JsonObject, key: string, path: string, issues: string[]): JsonObject | undefined {
    const value = parent[key];
    if (value === undefined) return undefined;
    if (!isObject(value)) {
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
    options: { integer?: boolean; min?: number; max?: number } = {},
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
    if (!isObject(value)) throw new ConfigValidationError(["config root must be an object"]);

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
    const twitter = optionalSection(value, "twitter", "twitter", issues);
    if (twitter) out.twitter = validateTwitter(twitter, issues);
    const proposals = optionalSection(value, "proposals", "proposals", issues);
    if (proposals) out.proposals = validateProposals(proposals, issues);

    if (issues.length) throw new ConfigValidationError(issues);
    return out;
}
