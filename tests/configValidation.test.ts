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
        }
    });
});
