import { CV2_MEDIA_GALLERY_ITEM_BUDGET, CV2_TEXT_BUDGET } from "./cv2";
import { NAME_PATTERN } from "./format";
import { isRecord } from "./isRecord";

// Block (format 2) limits — must stay in lockstep with the commands repo's
// commands.schema.json + validate-schema.js and the renderer in commandRender.ts.
// Exported ones double as the editor's typed block-modal input caps.
export const MAX_BLOCKS_PER_UNIT = 30;
export const MAX_BLOCK_HEADING = 256;
export const MAX_BLOCK_TEXT = 3800;
export const MAX_BLOCK_FIELD_NAME = 256;
export const MAX_BLOCK_FIELD_VALUE = 1024;
export const MAX_BLOCK_SMALL = 1024;
const MAX_BLOCK_IMAGES = CV2_MEDIA_GALLERY_ITEM_BUDGET;
const MAX_ACCENT_COLOR = 0xffffff;
// Discord string-select hard limit: the reply's page dropdown shows at most 25
// options, so a command with more pages silently hides the overflow.
const MAX_COMMAND_PAGES = 25;
const UNIT_TEXT_HEADROOM = 200;
const UNIT_TEXT_BUDGET = CV2_TEXT_BUDGET - UNIT_TEXT_HEADROOM;

/** Discord only accepts http(s) links in embeds; anything else 400s the message. */
export function isValidEmbedUrl(value: unknown): value is string {
    if (typeof value !== "string" || !value.trim().length) return false;
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
}

/** Rendered text cost of a block — must match commandRender's blockText(). */
function renderedBlockChars(block: Record<string, unknown>): number {
    const text = typeof block["text"] === "string" ? block["text"].length : 0;
    switch (block["type"]) {
        case "heading":
            return 3 + text + (typeof block["url"] === "string" ? block["url"].length + 4 : 0);
        case "text":
            return text;
        case "field":
            return (
                (typeof block["name"] === "string" ? block["name"].length : 0) +
                5 +
                (typeof block["value"] === "string" ? block["value"].length : 0)
            );
        case "small":
            return 3 + text;
        default:
            return 0; // divider, images
    }
}

/** Truncate an over-length block text property in place with a warning. */
function clampBlockText(block: Record<string, unknown>, key: string, max: number, ctx: string): void {
    const value = block[key];
    if (typeof value === "string" && value.length > max) {
        console.warn(`${ctx}: '${key}' exceeds ${max} chars. Truncating.`);
        block[key] = value.slice(0, max);
    }
}

/**
 * Validate + normalize a format-2 block list **in place**: truncate over-length
 * text and drop invalid URLs with a warning; error on anything that would lose
 * authored content or cannot render (wrong types, unknown block types, empty
 * galleries, over-count, and a unit whose rendered text exceeds the CV2 message
 * budget).
 */
export function validateBlocksDetailed(value: unknown, ctx: string): string | null {
    if (!Array.isArray(value)) return `${ctx} 'blocks' must be an array`;
    if (value.length === 0) return `${ctx} 'blocks' must not be empty`;
    if (value.length > MAX_BLOCKS_PER_UNIT) {
        return `${ctx} has ${value.length} blocks (max ${MAX_BLOCKS_PER_UNIT} per view)`;
    }

    for (const [index, entry] of value.entries()) {
        if (!isRecord(entry)) return `${ctx} block ${index + 1} must be an object`;
        const blockCtx = `${ctx} block ${index + 1}`;
        switch (entry["type"]) {
            case "heading": {
                if (typeof entry["text"] !== "string" || !entry["text"].trim().length) {
                    return `${blockCtx} (heading) requires non-empty 'text'`;
                }
                clampBlockText(entry, "text", MAX_BLOCK_HEADING, blockCtx);
                if (entry["url"] !== undefined && !isValidEmbedUrl(entry["url"])) {
                    console.warn(`${blockCtx}: removing invalid 'url' (must be http/https)`);
                    delete entry["url"];
                }
                break;
            }
            case "text": {
                if (typeof entry["text"] !== "string" || !entry["text"].trim().length) {
                    return `${blockCtx} (text) requires non-empty 'text'`;
                }
                clampBlockText(entry, "text", MAX_BLOCK_TEXT, blockCtx);
                break;
            }
            case "field": {
                if (typeof entry["name"] !== "string" || !entry["name"].trim().length) {
                    return `${blockCtx} (field) requires non-empty 'name'`;
                }
                if (typeof entry["value"] !== "string" || !entry["value"].trim().length) {
                    return `${blockCtx} (field) requires non-empty 'value'`;
                }
                clampBlockText(entry, "name", MAX_BLOCK_FIELD_NAME, blockCtx);
                clampBlockText(entry, "value", MAX_BLOCK_FIELD_VALUE, blockCtx);
                break;
            }
            case "divider":
                break;
            case "images": {
                const urls = entry["urls"];
                if (!Array.isArray(urls) || urls.length === 0) {
                    return `${blockCtx} (images) requires a non-empty 'urls' array`;
                }
                if (urls.length > MAX_BLOCK_IMAGES) {
                    return `${blockCtx} (images) has ${urls.length} urls (max ${MAX_BLOCK_IMAGES})`;
                }
                const valid = urls.filter(url => isValidEmbedUrl(url));
                if (valid.length < urls.length) {
                    console.warn(`${blockCtx}: dropping ${urls.length - valid.length} invalid image url(s)`);
                    entry["urls"] = valid;
                }
                if (valid.length === 0) return `${blockCtx} (images) has no valid urls`;
                break;
            }
            case "small": {
                if (typeof entry["text"] !== "string" || !entry["text"].trim().length) {
                    return `${blockCtx} (small) requires non-empty 'text'`;
                }
                clampBlockText(entry, "text", MAX_BLOCK_SMALL, blockCtx);
                break;
            }
            default:
                return `${blockCtx} has unknown type '${String(entry["type"])}'`;
        }
    }

    // A view must carry at least one content-bearing block. A divider-only list
    // renders a container with no text/media, which Discord rejects at send time
    // — the interaction is then never acknowledged. The editor prevents this, but
    // a direct commit or a proposal patch reaches this shared validator instead.
    if (!value.some(entry => isRecord(entry) && entry["type"] !== "divider")) {
        return `${ctx} 'blocks' must contain at least one non-divider block`;
    }

    const total = value.reduce((sum: number, entry) => sum + (isRecord(entry) ? renderedBlockChars(entry) : 0), 0);
    if (total > UNIT_TEXT_BUDGET) {
        return `${ctx} renders ${total} text characters (max ${UNIT_TEXT_BUDGET} per view) — split content across pages`;
    }

    return null;
}

// Renderer contract: a thumbnail renders as a Section accessory beside the
// view's first run of text blocks, so it needs one of these to attach to.
const TEXT_BLOCK_TYPES = new Set(["heading", "text", "field", "small"]);
// URLs beyond this are pathological and would overflow the editor's modal input.
export const MAX_THUMBNAIL_URL = 1024;

/**
 * Drop an unusable thumbnail_url in place (repair, not reject, matching the
 * bad-URL policy): it must be http(s), within length, and the view must have
 * a text block for the thumbnail's Section to wrap — CV2 has no standalone
 * small image.
 */
function normalizeThumbnail(holder: Record<string, unknown>, ctx: string): void {
    const url = holder["thumbnail_url"];
    if (url === undefined) return;
    if (!isValidEmbedUrl(url) || url.length > MAX_THUMBNAIL_URL) {
        console.warn(`${ctx}: removing invalid 'thumbnail_url' (http/https, max ${MAX_THUMBNAIL_URL} chars)`);
        delete holder["thumbnail_url"];
        return;
    }
    const blocks = holder["blocks"];
    const hasText =
        Array.isArray(blocks) && blocks.some(entry => isRecord(entry) && TEXT_BLOCK_TYPES.has(String(entry["type"])));
    if (!hasText) {
        console.warn(`${ctx}: removing 'thumbnail_url' — the view has no text block to attach it to`);
        delete holder["thumbnail_url"];
    }
}

/** Drop an invalid accent_color in place (repair, not reject). */
function normalizeAccentColor(holder: Record<string, unknown>, ctx: string): void {
    const color = holder["accent_color"];
    if (
        color !== undefined &&
        (typeof color !== "number" || !Number.isInteger(color) || color < 0 || color > MAX_ACCENT_COLOR)
    ) {
        console.warn(`${ctx}: removing invalid 'accent_color' (integer 0-${MAX_ACCENT_COLOR} required)`);
        delete holder["accent_color"];
    }
}

/**
 * Validate + normalize a custom command **in place** (lowercases names, trims /
 * truncates the description, strips the legacy `ephemeral` field, and holds
 * every block view — top-level and per-page — to the Components-V2 budgets).
 * Valid commands come back already normalized; safely repairable problems
 * (over-length text, bad urls/colors) are fixed with a warning rather than
 * rejected, so a stray bad value never deregisters a live command.
 *
 * Shared by the GitHub load path (CommandSync, which also filters snapshot
 * entries through it) and the proposal patch engine so all apply the same
 * rules.
 *
 * Returns the first human-readable problem, or null when valid. Use the
 * boolean wrapper {@link validateCustomCommand} on load paths that just
 * filter; proposal paths surface the reason to the submitter/reviewer.
 */
export function validateCustomCommandDetailed(command: any): string | null {
    // Check required fields. NOTE: never log the command body itself — this
    // runs on LLM/HTTP-submitted payloads via the proposal intake, and callers
    // already receive the reason to surface.
    if (!command.name || typeof command.name !== "string") {
        console.error(`Invalid command: missing or invalid 'name' field`);
        return "missing or invalid 'name' field";
    }
    delete (command as any).ephemeral;
    const normalizedName = command.name.trim().toLowerCase();
    if (!NAME_PATTERN.test(normalizedName)) {
        console.error(
            `Invalid command '${command.name}': name must be 1-32 characters (lowercase letters, numbers, underscores, hyphens)`,
        );
        return "name must be 1-32 characters (lowercase letters, numbers, underscores, hyphens)";
    }
    // A custom command's page select uses the command name as its custom-id,
    // and the interaction router matches the editor's own component ids
    // (all "cmd-editor-…") first — a command with that prefix could never
    // route its page selects. Reserve the prefix outright.
    if (normalizedName.startsWith("cmd-editor-")) {
        console.error(`Invalid command '${command.name}': names starting with 'cmd-editor-' are reserved`);
        return "names starting with 'cmd-editor-' are reserved for editor components";
    }
    command.name = normalizedName;

    if (!command.description || typeof command.description !== "string") {
        console.error(`Invalid command '${command.name}': missing or invalid 'description' field`);
        return "missing or invalid 'description' field";
    }
    let trimmedDescription = command.description.trim();
    if (!trimmedDescription.length) {
        console.warn(`Command '${command.name}' has empty description. Using fallback.`);
        trimmedDescription = "Describe this command";
    }
    if (trimmedDescription.length > 100) {
        console.warn(`Command '${command.name}' description too long. Truncating to 100 characters.`);
        trimmedDescription = trimmedDescription.slice(0, 100);
    }
    command.description = trimmedDescription;

    // Only block-based format 2 is supported (see the commands repo AUTHORING.md).
    if (command.format !== 2) {
        console.error(
            `Invalid command '${command.name}': requires "format": 2 (embed commands are no longer supported)`,
        );
        return `requires "format": 2 (embed commands are no longer supported)`;
    }
    if (command.embed !== undefined || command.embeds !== undefined) {
        console.error(`Invalid command '${command.name}': commands use 'blocks', not 'embed'/'embeds'`);
        return "commands use 'blocks', not 'embed'/'embeds'";
    }

    const hasPages = Array.isArray(command.pages) && command.pages.length > 0;
    if (command.blocks === undefined && !hasPages) {
        console.error(`Invalid command '${command.name}': requires 'blocks' or 'pages'`);
        return "requires 'blocks' or 'pages'";
    }
    normalizeAccentColor(command, `command '${command.name}'`);
    if (command.blocks !== undefined) {
        // "content" matches the editor's Content section, so the same failure
        // reads identically whether it surfaces inline or from the save path.
        const blocksError = validateBlocksDetailed(command.blocks, "content");
        if (blocksError) {
            console.error(`Invalid command '${command.name}': ${blocksError}`);
            return blocksError;
        }
    }
    normalizeThumbnail(command, `command '${command.name}'`);

    // Validate pages if present
    if (command.pages && !Array.isArray(command.pages)) {
        console.error(`Invalid command '${command.name}': 'pages' must be an array`);
        return "'pages' must be an array";
    }
    if (Array.isArray(command.pages) && command.pages.length > MAX_COMMAND_PAGES) {
        // Repair, don't reject (matching the over-length-text/bad-url policy): the
        // page dropdown only renders 25 options, so pages 26+ are already
        // unreachable. Drop the overflow with a warning rather than erroring —
        // returning here would skip the whole file on the load path and
        // deregister a live command.
        console.warn(
            `Command '${command.name}' has ${command.pages.length} pages; the dropdown shows at most ${MAX_COMMAND_PAGES}. Dropping the overflow.`,
        );
        command.pages = command.pages.slice(0, MAX_COMMAND_PAGES);
    }

    if (command.pages) {
        const seenPageNames = new Set<string>();
        for (const rawPage of command.pages) {
            // Guard object shape first (the block loop does the same above): a
            // null or non-object element — `"pages":[null]` is valid JSON —
            // would otherwise throw a TypeError on `page.name` and break the
            // "returns a problem string, never throws" contract every
            // load/proposal path relies on.
            if (!isRecord(rawPage)) {
                console.error(`Invalid command '${command.name}': a page entry must be an object`);
                return "a page entry must be an object";
            }
            const page: any = rawPage;
            if (!page.name || typeof page.name !== "string") {
                console.error(`Invalid command '${command.name}': page missing 'name' field`);
                return "a page is missing its 'name' field";
            }
            page.name = page.name.trim().toLowerCase();
            if (!NAME_PATTERN.test(page.name)) {
                console.error(`Invalid command '${command.name}': page '${page.name}' has invalid name format`);
                return `page '${page.name}' has an invalid name (1-32 chars, lowercase letters, numbers, underscores, hyphens)`;
            }
            // Non-string page title/description would crash the select-menu
            // sanitizers at render time (`.trim` on a non-string).
            if (page.title !== undefined && typeof page.title !== "string") {
                console.error(`Invalid command '${command.name}': page '${page.name}' 'title' must be a string`);
                return `page '${page.name}' 'title' must be a string`;
            }
            if (page.description !== undefined && typeof page.description !== "string") {
                console.error(`Invalid command '${command.name}': page '${page.name}' 'description' must be a string`);
                return `page '${page.name}' 'description' must be a string`;
            }
            if (page.embed !== undefined || page.embeds !== undefined) {
                console.error(`Invalid command '${command.name}': page '${page.name}' uses 'embed'/'embeds'`);
                return `page '${page.name}' uses 'embed'/'embeds' — pages use 'blocks'`;
            }
            normalizeAccentColor(page, `page '${page.name}'`);
            const pageBlocksError = validateBlocksDetailed(page.blocks, `page '${page.name}'`);
            if (pageBlocksError) {
                console.error(`Invalid command '${command.name}': ${pageBlocksError}`);
                return pageBlocksError;
            }
            normalizeThumbnail(page, `page '${page.name}'`);
            seenPageNames.add(page.name);
        }
        // Duplicate page names produce duplicate select-menu option values,
        // which Discord rejects (400) when the command is invoked or edited.
        if (seenPageNames.size < command.pages.length) {
            console.warn(`Command '${command.name}' has duplicate page names. Keeping the first of each.`);
            const kept = new Set<string>();
            command.pages = command.pages.filter((page: { name: string }) => {
                if (kept.has(page.name)) return false;
                kept.add(page.name);
                return true;
            });
        }
    }

    return null;
}

/** Boolean wrapper for load paths that filter invalid commands. */
export function validateCustomCommand(command: any): boolean {
    return validateCustomCommandDetailed(command) === null;
}
