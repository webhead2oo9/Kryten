/**
 * Shared formatting helpers for custom-command / page names and Discord select
 * menu options. The single home for the name-validation pattern and the option
 * sanitizers, so every call site agrees on Discord's hard limits (label 100,
 * description 100, value 100 characters).
 */

/** Custom-command and page names: 1-32 chars, lowercase alnum + `_-`. */
export const NAME_PATTERN = /^[a-z0-9_-]{1,32}$/;

/**
 * The single authoritative name-normalization rule. GitHub file paths,
 * proposal targeting, and validation must all agree on this or a proposal
 * can resolve to a name that never matches the file it commits to.
 */
export function normalizeName(value: unknown): string {
    return String(value ?? "")
        .trim()
        .toLowerCase();
}

export const MAX_SELECT_LABEL = 100;
export const MAX_SELECT_DESCRIPTION = 100;
export const MAX_SELECT_VALUE = 100;
export const MAX_EMBED_FIELD_VALUE = 1024;

/**
 * Ellipsize text to a hard length bound. Guards the non-positive edges: with
 * max <= 0 the naive slice(0, max - 1) would drop only the last char and still
 * overflow the bound.
 */
export function ellipsize(text: string, max: number): string {
    if (text.length <= max) return text;
    if (max <= 0) return "";
    if (max === 1) return "…";
    return `${text.slice(0, max - 1)}…`;
}

/**
 * Clamp text to a length bound, substituting a fallback when empty. Discord
 * rejects over-long payloads (1024-char embed fields, ~4000 chars total across
 * a Components-V2 message), and message content can reach 2000-4000 chars — an
 * alert built from raw content would otherwise fail (suppressing the alert).
 */
export function clampText(text: string, max = MAX_EMBED_FIELD_VALUE, fallback = "No content"): string {
    return ellipsize(text || fallback, max);
}

/** Clamp text to Discord's 1024-char embed-field limit. */
export function embedFieldValue(text: string, fallback = "No content"): string {
    return clampText(text, MAX_EMBED_FIELD_VALUE, fallback);
}

/** Clamp a select-option label, falling back to a secondary then a constant. */
export function sanitizeSelectLabel(primary: string | undefined, fallback: string): string {
    const base = (primary ?? "").trim() || fallback.trim() || "Page";
    return base.slice(0, MAX_SELECT_LABEL) || fallback.slice(0, MAX_SELECT_LABEL) || "Page";
}

/** Clamp a select-option description, returning undefined when empty. */
export function sanitizeSelectDescription(description?: string): string | undefined {
    const trimmed = (description ?? "").trim();
    return trimmed ? trimmed.slice(0, MAX_SELECT_DESCRIPTION) : undefined;
}

/** Clamp a select-option value to Discord's limit. */
export function sanitizeSelectValue(value: string): string {
    return value.trim().slice(0, MAX_SELECT_VALUE);
}
