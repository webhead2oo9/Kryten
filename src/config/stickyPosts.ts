import type { APIEmbed } from "discord.js";
import type { StickyPostsConfig } from "../types";
import { isRecord } from "../utils/isRecord";

export const SNOWFLAKE = /^[1-9][0-9]{16,19}$/;

function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key))) throw new Error("Invalid keys");
    return value;
}

export function validateStickyEmbed(value: unknown): APIEmbed {
    const embed = object(value, [
        "title",
        "description",
        "url",
        "color",
        "timestamp",
        "footer",
        "image",
        "thumbnail",
        "author",
        "fields",
    ]);
    let length = 0;
    const text = (value: unknown, max: number): void => {
        if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid embed text");
        length += value.length;
    };
    const url = (value: unknown): void => {
        if (typeof value !== "string" || !["https:", "http:"].includes(new URL(value).protocol))
            throw new Error("Invalid URL");
    };
    if (embed["title"] !== undefined) text(embed["title"], 256);
    if (embed["description"] !== undefined) text(embed["description"], 4096);
    if (embed["url"] !== undefined) url(embed["url"]);
    if (
        embed["color"] !== undefined &&
        (typeof embed["color"] !== "number" ||
            !Number.isInteger(embed["color"]) ||
            embed["color"] < 0 ||
            embed["color"] > 0xffffff)
    )
        throw new Error("Invalid color");
    if (
        embed["timestamp"] !== undefined &&
        (typeof embed["timestamp"] !== "string" || !Number.isFinite(Date.parse(embed["timestamp"])))
    )
        throw new Error("Invalid timestamp");
    for (const key of ["image", "thumbnail"]) {
        if (embed[key] !== undefined) url(object(embed[key], ["url"])["url"]);
    }
    if (embed["footer"] !== undefined) {
        const footer = object(embed["footer"], ["text", "icon_url"]);
        text(footer["text"], 2048);
        if (footer["icon_url"] !== undefined) url(footer["icon_url"]);
    }
    if (embed["author"] !== undefined) {
        const author = object(embed["author"], ["name", "url", "icon_url"]);
        text(author["name"], 256);
        for (const key of ["url", "icon_url"]) if (author[key] !== undefined) url(author[key]);
    }
    if (embed["fields"] !== undefined) {
        if (!Array.isArray(embed["fields"]) || embed["fields"].length > 25) throw new Error("Invalid fields");
        for (const item of embed["fields"]) {
            const field = object(item, ["name", "value", "inline"]);
            text(field["name"], 256);
            text(field["value"], 1024);
            if (field["inline"] !== undefined && typeof field["inline"] !== "boolean")
                throw new Error("Invalid inline");
        }
    }
    if (length > 6000 || (!length && !embed["image"] && !embed["thumbnail"])) throw new Error("Empty/oversized embed");
    return structuredClone(embed) as APIEmbed;
}

export function validateStickyPosts(value: unknown): StickyPostsConfig {
    const input = object(value, ["enabled", "channels"]);
    if (input["enabled"] !== undefined && typeof input["enabled"] !== "boolean") throw new Error("Invalid enabled");
    const channels = input["channels"] === undefined ? {} : input["channels"];
    if (!isRecord(channels) || Object.keys(channels).length > 100) throw new Error("Invalid channels");
    const out: StickyPostsConfig = { enabled: input["enabled"] === true, channels: {} };
    for (const [id, value] of Object.entries(channels)) {
        if (!SNOWFLAKE.test(id)) throw new Error("Invalid channel ID");
        const entry = object(value, ["interval_messages", "embed"]);
        const interval = entry["interval_messages"] === undefined ? 10 : entry["interval_messages"];
        if (typeof interval !== "number" || !Number.isSafeInteger(interval) || interval < 1)
            throw new Error("Invalid interval");
        out.channels[id] = { interval_messages: interval, embed: validateStickyEmbed(entry["embed"]) };
    }
    return out;
}
