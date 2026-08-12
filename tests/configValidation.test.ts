import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigValidationError, validateConfig } from "../src/config/validate";

describe("validateConfig", () => {
    it("accepts the checked-in template config", () => {
        const raw = JSON.parse(readFileSync(join(process.cwd(), "template.config.json"), "utf8")) as unknown;

        expect(() => validateConfig(raw)).not.toThrow();
    });

    it("coerces safe string forms used in hand-edited JSON", () => {
        const config = validateConfig({
            staff_roles: "staff-role",
            githubPollMinutes: "15",
            moderation: {
                crosspost: {
                    enabled: "false",
                    dry_run: "true",
                    min_algorithms_to_match: "3",
                },
                image_fingerprint: {
                    enabled: "true",
                    match_tolerance: "6",
                    default_action: "timeout",
                    default_category: "phishing",
                    hub_base_url: "http://127.0.0.1:58751/",
                },
            },
            twitter: {
                enabled: "false",
                enabled_channels: "twitter-channel",
                embed_service: "vxtwitter.com",
            },
            proposals: {
                max_pending: "2",
                ttl_hours: "12.5",
                rate_limit_per_minute: "60",
            },
            llm_classifier: {
                enabled: "true",
                provider: "fireworks",
                model: "accounts/fireworks/models/example",
                classification_log_channel_id: "llm-log",
                timeout_ms: "45000",
                max_concurrency: "2",
                max_queue_age_ms: "30000",
                max_requests_per_minute: "60",
            },
            beta_classifier: {
                enabled: "true",
                response_enabled: "false",
                guild_id: "guild",
                campaign_id: "synthetic-beta",
                campaign_started_at: "2026-08-05T16:01:00.000Z",
                included_channel_ids: "support",
                excluded_role_ids: "excluded-role",
                target_channel_id: "beta",
                announcement_url: "https://discord.com/channels/guild/channel/message",
                prompt_file: "/private/beta-prompt.json",
                max_context_messages: "25",
            },
        });

        expect(config.staff_roles).toEqual(["staff-role"]);
        expect(config.githubPollMinutes).toBe(15);
        expect(config.moderation?.crosspost?.enabled).toBe(false);
        expect(config.moderation?.crosspost?.dry_run).toBe(true);
        expect(config.moderation?.crosspost?.min_algorithms_to_match).toBe(3);
        expect(config.moderation?.image_fingerprint?.enabled).toBe(true);
        expect(config.moderation?.image_fingerprint?.match_tolerance).toBe(6);
        expect(config.moderation?.image_fingerprint?.default_action).toBe("timeout");
        expect(config.moderation?.image_fingerprint?.default_category).toBe("phishing");
        expect(config.moderation?.image_fingerprint?.hub_base_url).toBe("http://127.0.0.1:58751");
        expect(config.twitter?.enabled).toBe(false);
        expect(config.twitter?.enabled_channels).toEqual(["twitter-channel"]);
        expect(config.proposals?.max_pending).toBe(2);
        expect(config.proposals?.ttl_hours).toBe(12.5);
        expect(config.proposals?.rate_limit_per_minute).toBe(60);
        expect(config.llm_classifier?.enabled).toBe(true);
        expect(config.llm_classifier?.timeout_ms).toBe(45_000);
        expect(config.llm_classifier?.max_concurrency).toBe(2);
        expect(config.llm_classifier?.max_queue_age_ms).toBe(30_000);
        expect(config.llm_classifier?.max_requests_per_minute).toBe(60);
        expect(config.llm_classifier?.classification_log_channel_id).toBe("llm-log");
        expect(config.beta_classifier?.included_channel_ids).toEqual(["support"]);
        expect(config.beta_classifier?.excluded_role_ids).toEqual(["excluded-role"]);
        expect(config.beta_classifier?.campaign_id).toBe("synthetic-beta");
        expect(config.beta_classifier?.response_enabled).toBe(false);
        expect(config.beta_classifier?.prompt_file).toBe("/private/beta-prompt.json");
        expect(config.beta_classifier?.max_context_messages).toBe(25);
    });

    it("rejects unsafe or malformed known settings", () => {
        expect(() =>
            validateConfig({
                staff_roles: [123],
                moderation: {
                    crosspost: {
                        sequence_ratio_threshold: 1.5,
                        min_algorithms_to_match: 4,
                    },
                    image_fingerprint: {
                        default_action: "ban",
                        match_tolerance: -1,
                        hub_base_url: "not a url",
                    },
                },
                twitter: {
                    embed_service: "https://vxtwitter.com/path",
                },
                proposals: {
                    ttl_hours: 0,
                },
                llm_classifier: {
                    enabled: true,
                    provider: "arbitrary-provider",
                    model: "",
                    api_key_env: "not-portable",
                    max_concurrency: 0,
                },
                beta_classifier: {
                    enabled: true,
                    response_enabled: "not-a-boolean",
                    included_channel_ids: [],
                    campaign_id: "bad campaign id",
                    campaign_started_at: "not-a-date",
                    max_context_messages: 26,
                },
            }),
        ).toThrow(ConfigValidationError);

        try {
            validateConfig({
                staff_roles: [123],
                moderation: {
                    crosspost: {
                        sequence_ratio_threshold: 1.5,
                        min_algorithms_to_match: 4,
                    },
                    image_fingerprint: {
                        default_action: "ban",
                        match_tolerance: -1,
                        hub_base_url: "not a url",
                    },
                },
                twitter: {
                    embed_service: "https://vxtwitter.com/path",
                },
                proposals: {
                    ttl_hours: 0,
                },
                llm_classifier: {
                    enabled: true,
                    provider: "arbitrary-provider",
                    model: "",
                    api_key_env: "not-portable",
                    max_concurrency: 0,
                },
                beta_classifier: {
                    enabled: true,
                    response_enabled: "not-a-boolean",
                    included_channel_ids: [],
                    campaign_id: "bad campaign id",
                    campaign_started_at: "not-a-date",
                    max_context_messages: 26,
                },
            });
        } catch (error) {
            expect(error).toBeInstanceOf(ConfigValidationError);
            const message = String(error);
            expect(message).toContain("staff_roles[0]");
            expect(message).toContain("moderation.crosspost.sequence_ratio_threshold");
            expect(message).toContain("moderation.crosspost.min_algorithms_to_match");
            expect(message).toContain("moderation.image_fingerprint.default_action");
            expect(message).toContain("moderation.image_fingerprint.match_tolerance");
            expect(message).toContain("moderation.image_fingerprint.hub_base_url");
            expect(message).toContain("twitter.embed_service");
            expect(message).toContain("proposals.ttl_hours");
            expect(message).toContain("llm_classifier.provider");
            expect(message).toContain("llm_classifier.model is required");
            expect(message).toContain("llm_classifier.api_key_env");
            expect(message).toContain("llm_classifier.max_concurrency");
            expect(message).toContain("beta_classifier.response_enabled");
            expect(message).toContain("beta_classifier.guild_id is required");
            expect(message).toContain("beta_classifier.included_channel_ids");
            expect(message).toContain("beta_classifier.campaign_id");
            expect(message).toContain("beta_classifier.campaign_started_at");
            expect(message).toContain("beta_classifier.max_context_messages");
            expect(message).toContain("beta_classifier.prompt_file is required");
        }
    });

    it("rejects the removed beta watched-channel field", () => {
        expect(() => validateConfig({ beta_classifier: { watched_channel_ids: ["support"] } })).toThrow(
            /use included_channel_ids/,
        );
    });

    it("rejects normalized-but-impossible campaign dates", () => {
        expect(() =>
            validateConfig({
                beta_classifier: {
                    enabled: true,
                    guild_id: "guild",
                    included_channel_ids: ["support"],
                    campaign_id: "synthetic-beta",
                    campaign_started_at: "2026-02-31T12:00:00Z",
                    target_channel_id: "beta",
                    announcement_url: "https://discord.com/channels/guild/channel/message",
                    prompt_file: "/private/beta-prompt.json",
                },
            }),
        ).toThrow(/campaign_started_at/);
    });

    it("rejects selecting a non-Fireworks secret for the Fireworks provider", () => {
        expect(() =>
            validateConfig({
                llm_classifier: {
                    enabled: true,
                    provider: "fireworks",
                    model: "accounts/fireworks/models/example",
                    api_key_env: "DISCORD_TOKEN",
                },
            }),
        ).toThrow(/FIREWORKS_\* variable/);
    });
});
