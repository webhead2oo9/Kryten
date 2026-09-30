import { describe, expect, it } from "vitest";
import { renderCampaignTemplate } from "../src/utils/campaignTemplate";
import { validateConfig } from "../src/config/validate";

describe("operator campaign templates", () => {
    it("interpolates only named values without interpreting replacement syntax", () => {
        expect(
            renderCampaignTemplate("Hi {user}; {target}; {announcements}", {
                user: "<@123>",
                target: "<#456>",
                announcements: "$&",
            }),
        ).toBe("Hi <@123>; <#456>; $&");
    });
    it("keeps templates in validated config", () => {
        expect(
            validateConfig({
                beta_classifier: {
                    target_channel_id: "123",
                    routing_template: "Route {target}",
                    greeting_template: "Hi {user}",
                },
            }).beta_classifier,
        ).toMatchObject({ routing_template: "Route {target}", greeting_template: "Hi {user}" });
    });
    describe.each(["greeting_template", "routing_template"])("%s config validation", field => {
        it.each(["target", "announcements"])("requires the channel value for {%s}", variable => {
            for (const value of [undefined, "", "   "]) {
                expect(() =>
                    validateConfig({
                        beta_classifier: {
                            [field]: `{${variable}}`,
                            [`${variable}_channel_id`]: value,
                        },
                    }),
                ).toThrow(new RegExp(`beta_classifier.${field}`));
            }
        });
        it.each(["user", "target", "announcements"])("budgets repeated {%s} with 20-digit snowflakes", variable => {
            const config = { target_channel_id: "123", announcements_channel_id: "456" };
            const template = `{${variable}}`.repeat(2) + "x".repeat(2000 - 2 * 23);
            expect(validateConfig({ beta_classifier: { ...config, [field]: template } }).beta_classifier?.[field]).toBe(
                template,
            );
            expect(() => validateConfig({ beta_classifier: { ...config, [field]: template + "x" } })).toThrow(
                new RegExp(`beta_classifier.${field}`),
            );
        });
        it("rejects a raw 2000-character template that expands beyond the limit", () => {
            expect(() => validateConfig({ beta_classifier: { [field]: "{user}" + "x".repeat(1994) } })).toThrow();
        });
        it("does not require unused channel values", () => {
            expect(validateConfig({ beta_classifier: { [field]: "Hello {user}" } }).beta_classifier?.[field]).toBe(
                "Hello {user}",
            );
        });
    });
    it.each(["", "Bad {unknown}", "Bad {user", "x".repeat(2001)])(
        "rejects malformed or oversized templates",
        template => {
            expect(() => validateConfig({ beta_classifier: { greeting_template: template } })).toThrow();
        },
    );
    it("rejects unresolved variables and oversized rendered messages", () => {
        expect(() => renderCampaignTemplate("{target}", {})).toThrow();
        expect(() => renderCampaignTemplate("{user}".repeat(100), { user: "x".repeat(30) })).toThrow();
    });
});
