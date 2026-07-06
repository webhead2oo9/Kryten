import {
    ChatInputCommandInteraction,
    Interaction,
    RESTPostAPIChatInputApplicationCommandsJSONBody,
    RESTPostAPIContextMenuApplicationCommandsJSONBody,
} from "discord.js";
import { KrytenClient } from "./classes/client";

export enum StoreTypes {
    COMMANDS,
    CONTEXTS,
}

export interface StoreInitOptions {
    files_folder: string;
    load_classes_on_init?: boolean;
    storetype: StoreTypes;
}

export interface CommandInitOptions {
    name: string;
    command_data: RESTPostAPIChatInputApplicationCommandsJSONBody | RESTPostAPIContextMenuApplicationCommandsJSONBody;
    staff_only: boolean;
}

export interface BaseContextInitOptions {
    interaction: Interaction;
    client: KrytenClient;
}

export interface CommandContextInitOptions extends BaseContextInitOptions {
    interaction: ChatInputCommandInteraction;
}

export interface ModerationTimeoutConfig {
    channel_id?: string; // Channel where timeout threads are created
    role_id?: string; // Role applied to timed-out users
    allowed_role_ids?: string[]; // Roles permitted to use the Timeout Corner command
    notification_channel_id?: string; // Channel for timeout notifications
}

export interface CrosspostConfig {
    enabled?: boolean; // Master switch (default true)
    window_seconds?: number; // Detection window (default 900)
    sequence_ratio_threshold?: number; // difflib ratio threshold (default 0.85)
    jaccard_threshold?: number; // token Jaccard threshold (default 0.65)
    char_cosine_threshold?: number; // char n-gram cosine threshold (default 0.88)
    min_normalized_length?: number; // min normalized length for similarity (default 80)
    length_ratio_threshold?: number; // max length ratio for similarity (default 1.18)
    new_content_ratio_threshold?: number; // novelty needed to treat as an update (default 0.30)
    min_algorithms_to_match?: number; // votes required of the 3 algorithms (default 2)
    dry_run?: boolean; // observe-only; warns on exacts only (default true)
    burst_channel_threshold?: number; // > this many channels triggers burst enforcement (default 3)
    burst_timeout_minutes?: number; // timeout duration for first burst offense (default 30)
    burst_alert_channel_id?: string; // channel for burst-spam moderator alerts
    ignored_channels?: string[]; // channels excluded from crosspost detection
    whitelisted_role_ids?: string[]; // roles exempt from crosspost warnings
}

export interface ImageFingerprintConfig {
    enabled?: boolean; // Master switch (default false)
    dry_run?: boolean; // Observe-only; detect + log but never enforce (default true)
    report_hits_in_dry_run?: boolean; // Send observational /hit telemetry while dry-run is enabled (default true)
    db_path?: string; // SQLite path (default ./data/image_fingerprints.db)
    match_tolerance?: number; // Hamming distance for a known-bad match (default 5)
    duplicate_tolerance?: number; // Overlap distance that counts as "already known" (default match_tolerance)
    crosspost_tolerance?: number; // Distance for same-image crosspost grouping (default match_tolerance)
    default_action?: "kick" | "timeout"; // Enforcement on a known-bad match (default kick)
    default_category?: string; // Category stamped on staff-approved fingerprints (default scam)
    timeout_minutes?: number; // Timeout duration when action=timeout (default 30)
    delete_on_match?: boolean; // Delete the offending message on match (default true)
    enforce_known_bad?: boolean; // Apply the member action on match (default true)
    recent_window_seconds?: number; // Crosspost memory window (default 900)
    review_channel_threshold?: number; // Distinct channels before a crosspost review is raised (default 2)
    review_crossposts?: boolean; // Raise staff review cards for image crossposts (default true)
    review_channel_id?: string; // Staff channel for image crosspost review cards
    alert_channel_id?: string; // Channel for known-bad match alerts (default review_channel_id)
    ignored_channels?: string[]; // Channels excluded from image scanning
    whitelisted_role_ids?: string[]; // Roles exempt from image scanning
    // FingerprintHub sync (all inert unless hub_enabled AND the API key env is set)
    hub_enabled?: boolean; // Sync with the shared hub (default false)
    hub_base_url?: string; // Hub base URL (default http://127.0.0.1:58751)
    hub_sync_interval_seconds?: number; // Background pull cadence (default 300)
    hub_request_timeout_seconds?: number; // Per-request timeout (default 5)
    hub_api_key_env?: string; // Env var holding the fph_… key (default FINGERPRINT_HUB_API_KEY)
}

export interface ModerationConfig {
    mod_role_id?: string; // Role monitored for pings / mentioned in alerts
    alert_channel_id?: string; // Channel that receives report + mod-ping alerts
    channel_blacklist?: string[]; // Channels ignored by reports and mod-ping detection
    timeout?: ModerationTimeoutConfig;
    crosspost?: CrosspostConfig;
    image_fingerprint?: ImageFingerprintConfig;
}

export interface AutoResponderConfig {
    auto_response_channel_ids?: string[]; // Channels where first-seen time is tracked (empty = all)
    random_greeting_channel_id?: string; // Channel where newcomers are greeted (greeting off if unset)
    store_path?: string; // JSON store path (default ./data/user_interactions.json)
    encryption_key_env?: string; // Env var holding the 32-byte AES key (default USER_INTERACTIONS_ENCRYPTION_KEY)
}

export interface TwitterConfig {
    enabled?: boolean; // Master switch (default false)
    enabled_channels?: string[]; // Channels where Twitter/X links are reposted
    embed_service?: string; // Embed-friendly domain (default vxtwitter.com)
}

export interface ProposalsConfig {
    enabled?: boolean; // Master switch (default false); also requires PROPOSAL_API_KEY in the env
    review_channel_id?: string; // Staff channel that receives review cards
    max_pending?: number; // Reject new proposals past this many pending (default 5)
    ttl_hours?: number; // Pending proposals expire after this long (default 72)
    rate_limit_per_minute?: number; // Intake API per-key rate limit (default 100)
    db_path?: string; // SQLite path (default ./data/proposals.db)
}

export interface Config {
    staff_roles?: string[];
    githubRepoOwner?: string; // e.g., "webhead2oo9"
    githubRepoName?: string; // e.g., "VirtualDesktopCommands"
    githubCommandsDir?: string; // Directory of per-command JSON files (default "commands")
    githubBranch?: string; // Branch to read/commit (default "main")
    githubPollMinutes?: number; // Poll for repo changes every N minutes (default 60; 0 disables)
    error_log_channel_id?: string; // Channel ID for error logging
    moderation?: ModerationConfig;
    auto_responder?: AutoResponderConfig;
    twitter?: TwitterConfig;
    proposals?: ProposalsConfig;
}

/**
 * Command content blocks — the block-based layout (format 2) that renders
 * natively as Components V2. See the commands repo's AUTHORING.md.
 */
export type CommandBlock =
    | { type: "heading"; text: string; url?: string }
    | { type: "text"; text: string }
    | { type: "field"; name: string; value: string }
    | { type: "divider" }
    | { type: "images"; urls: string[] }
    | { type: "small"; text: string };

export interface CommandPage {
    name: string;
    title?: string;
    description?: string;
    accent_color?: number;
    thumbnail_url?: string;
    blocks?: CommandBlock[];
}

export interface CustomCommand {
    format?: number;
    name: string;
    description: string;
    accent_color?: number;
    thumbnail_url?: string;
    blocks?: CommandBlock[];
    pages?: CommandPage[];
}

export type Commands = CustomCommand[];
