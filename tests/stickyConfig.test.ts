import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/config/validate";

const channel = "123456789012345678";
const config = (entry: unknown) => ({ sticky_posts: { enabled: true, channels: { [channel]: entry } } });
describe("sticky config", () => {
    it.each([
        { interval_messages: 0, embed: { description: "x" } },
        { interval_messages: "10", embed: { description: "x" } },
        { interval_messages: 1.5, embed: { description: "x" } },
        { embed: { description: "x" }, components: [] },
        { embed: { description: "x", video: { url: "https://example.com" } } },
        { embed: { title: "x".repeat(257) } },
        { embed: { description: "x".repeat(4097) } },
        { embed: { fields: [{ name: "x", value: "x".repeat(1025) }] } },
        {
            embed: {
                description: "x".repeat(4000),
                fields: [
                    { name: "x", value: "x".repeat(1000) },
                    { name: "y", value: "y".repeat(1000) },
                ],
            },
        },
        { embed: {} },
    ])("rejects invalid entries %#", entry => expect(() => validateConfig(config(entry))).toThrow());
    it("rejects invalid snowflakes and boolean values", () => {
        expect(() => validateConfig({ sticky_posts: { enabled: "yes" } })).toThrow();
        expect(() => validateConfig({ sticky_posts: { channels: { bad: { embed: { title: "x" } } } } })).toThrow();
    });
    it.each([
        { enabled: true, channels: null },
        { enabled: true, channels: { [channel]: { interval_messages: null, embed: { title: "x" } } } },
    ])("rejects explicit nulls rather than applying defaults", sticky_posts => {
        expect(() => validateConfig({ sticky_posts })).toThrow();
    });
    it("bounds configured channels", () => {
        const channels = Object.fromEntries(
            Array.from({ length: 101 }, (_, i) => [String(123456789012345678n + BigInt(i)), { embed: { title: "x" } }]),
        );
        expect(() => validateConfig({ sticky_posts: { enabled: true, channels } })).toThrow();
    });
    it("loads an embed and defaults to ten messages", () => {
        expect(validateConfig(config({ embed: { description: "Information" } })).sticky_posts).toEqual({
            enabled: true,
            channels: { [channel]: { interval_messages: 10, embed: { description: "Information" } } },
        });
    });
});
