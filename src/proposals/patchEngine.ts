/**
 * Pure semantic-patch engine for command proposals. No Discord or GitHub
 * imports; operates on raw parsed command-file bodies so approved patches
 * produce minimal GitHub diffs (edits mutate a deep clone of the existing
 * body — never rebuild objects via spread in this path).
 *
 * Two error classes map to distinct outcomes:
 * - ProposalValidationError → the proposal itself is malformed (HTTP 400)
 * - ProposalConflictError   → it no longer applies to the live body (HTTP 409)
 */
import { deepEqual } from "../utils/deepEqual";
import { normalizeName } from "../utils/format";
import { jsonClone } from "../utils/jsonClone";
import { validateCustomCommandDetailed } from "../utils/validateCommand";

export class ProposalValidationError extends Error {}
export class ProposalConflictError extends Error {}

type Json = Record<string, unknown>;

/** Keys whose string values count as user-visible text for replace_text. */
const VISIBLE_TEXT_KEYS = new Set(["title", "description", "value", "name", "text", "url"]);
const UNSAFE_PROPERTY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function isObject(value: unknown): value is Json {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

// ------------------------------------------------------------------ targeting

function positionOf(value: unknown, length: number): number {
    if (value === undefined || value === null || value === "end") return length;
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new ProposalValidationError("position must be an integer or 'end'");
    }
    if (value < 0 || value > length) throw new ProposalConflictError("position is outside the target list");
    return value;
}

function indexOf(value: unknown, length: number, label: string): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new ProposalValidationError(`${label} must be an integer index`);
    }
    if (value < 0 || value >= length) throw new ProposalConflictError(`${label} index is outside the target list`);
    return value;
}

function getPages(command: Json): Json[] {
    const pages = command["pages"];
    return Array.isArray(pages) ? (pages as Json[]) : [];
}

function resolvePage(command: Json, pageRef: unknown): { page: Json; idx: number } {
    const pages = getPages(command);
    if (typeof pageRef === "number" && Number.isInteger(pageRef)) {
        const idx = indexOf(pageRef, pages.length, "page");
        const page = pages[idx];
        if (!isObject(page)) throw new ProposalConflictError("target page is not a JSON object");
        return { page, idx };
    }

    const target = normalizeName(pageRef);
    if (!target) throw new ProposalValidationError("page target is required");
    const matches = pages
        .map((page, idx) => ({ page, idx }))
        .filter(
            ({ page }) =>
                isObject(page) && (normalizeName(page["name"]) === target || normalizeName(page["title"]) === target),
        );
    if (matches.length === 0) throw new ProposalConflictError(`page '${String(pageRef)}' not found`);
    if (matches.length > 1) throw new ProposalConflictError(`page '${String(pageRef)}' is ambiguous`);
    return matches[0]!;
}

/** The object owning the targeted block list: a page when `page` is given, else the command. */
function unitOwner(command: Json, target: Json): Json {
    if ("page" in target) {
        return resolvePage(command, target["page"]).page;
    }
    return command;
}

/** Read a format-2 owner's block list, or conflict when the file has none. */
function blocksOf(owner: Json): Json[] {
    const blocks = owner["blocks"];
    if (!Array.isArray(blocks)) {
        throw new ProposalConflictError("target has no 'blocks' (block edits require a format 2 command)");
    }
    return blocks as Json[];
}

function resolveBlock(command: Json, target: Json): { blocks: Json[]; block: Json; idx: number } {
    const owner = unitOwner(command, target);
    const blocks = blocksOf(owner);
    const blockRef = target["block"];
    if (typeof blockRef === "number" && Number.isInteger(blockRef)) {
        const idx = indexOf(blockRef, blocks.length, "block");
        const block = blocks[idx];
        if (!isObject(block)) throw new ProposalConflictError("target block is not a JSON object");
        return { blocks, block, idx };
    }

    const targetName = String(blockRef ?? "").trim();
    if (!targetName) throw new ProposalValidationError("block target is required");
    // Only field blocks carry a name; they match EXACTLY.
    const matches = blocks
        .map((block, idx) => ({ block, idx }))
        .filter(
            ({ block }) => isObject(block) && block["type"] === "field" && String(block["name"] ?? "") === targetName,
        );
    if (matches.length === 0) throw new ProposalConflictError(`block '${targetName}' not found`);
    if (matches.length > 1) throw new ProposalConflictError(`block '${targetName}' is ambiguous`);
    return { blocks, ...matches[0]! };
}

function resolveObject(command: Json, target: unknown): Json {
    if (target === undefined || target === null) return command;
    if (!isObject(target)) throw new ProposalValidationError("target must be an object");
    const kind = String(target["kind"] ?? "command")
        .trim()
        .toLowerCase();
    if (kind === "command") return command;
    if (kind === "page") return resolvePage(command, target["page"]).page;
    if (kind === "block") return resolveBlock(command, target).block;
    throw new ProposalValidationError(`unknown target kind: '${kind}' (expected command, page, or block)`);
}

/** Walk all (container, key) slots holding user-visible text, recursively. */
function* iterTextSlots(value: unknown): Generator<{ obj: Json; key: string; text: string }> {
    if (isObject(value)) {
        for (const [key, child] of Object.entries(value)) {
            if (typeof child === "string" && VISIBLE_TEXT_KEYS.has(key)) {
                yield { obj: value, key, text: child };
            } else {
                yield* iterTextSlots(child);
            }
        }
    } else if (Array.isArray(value)) {
        for (const child of value) yield* iterTextSlots(child);
    }
}

function countOccurrences(haystack: string, needle: string): number {
    let count = 0;
    let pos = haystack.indexOf(needle);
    while (pos !== -1) {
        count++;
        pos = haystack.indexOf(needle, pos + 1);
    }
    return count;
}

// ------------------------------------------------------------------ edit types

function replaceText(command: Json, edit: Json): void {
    const old = edit["old"];
    const replacement = edit["new"];
    if (typeof old !== "string" || !old) {
        throw new ProposalValidationError("replace_text requires non-empty string 'old'");
    }
    if (typeof replacement !== "string") {
        throw new ProposalValidationError("replace_text requires string 'new'");
    }

    const targetObj = resolveObject(command, edit["target"]);
    const prop = edit["property"];
    if (prop !== undefined && prop !== null) {
        if (typeof prop !== "string" || !prop) {
            throw new ProposalValidationError("property must be a non-empty string");
        }
        const current = targetObj[prop];
        if (typeof current !== "string") {
            throw new ProposalConflictError(`target property '${prop}' is not text`);
        }
        const count = countOccurrences(current, old);
        if (count !== 1) {
            throw new ProposalConflictError(`replace_text expected one match in '${prop}', found ${count}`);
        }
        // A function replacer inserts `replacement` literally; a string
        // replacer would interpret $&, $$, $`, $' patterns and silently corrupt
        // output (e.g. a price "$5" or a snippet containing "$&"). We already
        // proved exactly one occurrence, so first-match replace is correct.
        targetObj[prop] = current.replace(old, () => replacement);
        return;
    }

    // No property: 'old' must occur exactly once across ALL visible text
    // slots of the target — total occurrences, not matching slots.
    const matches: { obj: Json; key: string; text: string }[] = [];
    let count = 0;
    for (const slot of iterTextSlots(targetObj)) {
        const occurrences = countOccurrences(slot.text, old);
        if (occurrences > 0) {
            matches.push(slot);
            count += occurrences;
        }
    }
    if (count !== 1) {
        throw new ProposalConflictError(`replace_text expected one match, found ${count}`);
    }
    const slot = matches[0]!;
    // Function replacer so `$`-patterns in the replacement stay literal (see note above).
    slot.obj[slot.key] = slot.text.replace(old, () => replacement);
}

function setProperty(command: Json, edit: Json): void {
    const targetObj = resolveObject(command, edit["target"]);
    const prop = edit["property"];
    if (typeof prop !== "string" || !prop) {
        throw new ProposalValidationError("set_property requires property");
    }
    if (UNSAFE_PROPERTY_NAMES.has(prop)) {
        throw new ProposalValidationError(`set_property cannot target '${prop}'`);
    }
    if (!("old" in edit)) {
        throw new ProposalValidationError("set_property requires old guard");
    }
    // Optimistic-concurrency guard: the live value must still equal 'old'.
    // JSON has no way to say "property absent", so a null guard also matches
    // a missing property — otherwise a proposer could never ADD an optional
    // property (e.g. a view's first thumbnail_url).
    const current = targetObj[prop];
    const guardMatches =
        edit["old"] === null ? current === undefined || current === null : deepEqual(current, edit["old"]);
    if (!guardMatches) {
        throw new ProposalConflictError(`target property '${prop}' no longer matches old value`);
    }
    targetObj[prop] = edit["new"];
}

function insertItem(command: Json, edit: Json): void {
    const itemType = String(edit["item_type"] ?? "")
        .trim()
        .toLowerCase();
    const item = edit["item"];
    if (!isObject(item)) throw new ProposalValidationError("insert_item requires object item");
    const target = edit["target"] ?? { kind: "command" };
    if (!isObject(target)) throw new ProposalValidationError("target must be an object");

    if (itemType === "page") {
        let pages = command["pages"];
        if (!Array.isArray(pages)) {
            pages = [];
            command["pages"] = pages;
        }
        const pageList = pages as Json[];
        pageList.splice(positionOf(edit["position"], pageList.length), 0, jsonClone(item));
        return;
    }

    if (itemType === "block") {
        const owner = unitOwner(command, target);
        const blocks = blocksOf(owner);
        blocks.splice(positionOf(edit["position"], blocks.length), 0, jsonClone(item));
        return;
    }

    throw new ProposalValidationError("insert_item item_type must be page or block");
}

function removeItem(command: Json, edit: Json): void {
    if (!("old" in edit)) throw new ProposalValidationError("remove_item requires old guard");
    const target = edit["target"];
    if (!isObject(target)) throw new ProposalValidationError("remove_item requires target");
    const kind = String(target["kind"] ?? "")
        .trim()
        .toLowerCase();

    if (kind === "page") {
        const { page, idx } = resolvePage(command, target["page"]);
        if (!deepEqual(page, edit["old"])) throw new ProposalConflictError("target page no longer matches old guard");
        getPages(command).splice(idx, 1);
        return;
    }

    if (kind === "block") {
        const { blocks, block, idx } = resolveBlock(command, target);
        if (!deepEqual(block, edit["old"])) throw new ProposalConflictError("target block no longer matches old guard");
        blocks.splice(idx, 1);
        return;
    }

    throw new ProposalValidationError("remove_item target kind must be page or block");
}

function moveItem(command: Json, edit: Json): void {
    const target = edit["target"];
    if (!isObject(target)) throw new ProposalValidationError("move_item requires target");
    const kind = String(target["kind"] ?? "")
        .trim()
        .toLowerCase();

    if (kind === "page") {
        const { idx } = resolvePage(command, target["page"]);
        const pages = getPages(command);
        const [item] = pages.splice(idx, 1);
        pages.splice(positionOf(edit["position"], pages.length), 0, item!);
        return;
    }

    if (kind === "block") {
        const { blocks, idx } = resolveBlock(command, target);
        const [item] = blocks.splice(idx, 1);
        blocks.splice(positionOf(edit["position"], blocks.length), 0, item!);
        return;
    }

    throw new ProposalValidationError("move_item target kind must be page or block");
}

// ------------------------------------------------------------------ public API

/**
 * Apply semantic patch edits to one raw command body, returning a new body.
 * The input is never mutated. The patched result is re-validated (and
 * normalized in place — lowercased names etc. — so it is committable as-is);
 * an invalid result raises ProposalValidationError.
 */
export function applyPatchEdits(command: unknown, edits: unknown): Json {
    if (!isObject(command)) throw new ProposalValidationError("patch target command must be a JSON object");
    if (!Array.isArray(edits) || edits.length === 0) {
        throw new ProposalValidationError("patch requires a non-empty edits array");
    }

    const patched = jsonClone(command);
    edits.forEach((rawEdit, index) => {
        if (!isObject(rawEdit)) throw new ProposalValidationError(`edit ${index} must be an object`);
        const editType = String(rawEdit["type"] ?? "")
            .trim()
            .toLowerCase();
        if (editType === "replace_text") replaceText(patched, rawEdit);
        else if (editType === "set_property") setProperty(patched, rawEdit);
        else if (editType === "insert_item") insertItem(patched, rawEdit);
        else if (editType === "remove_item") removeItem(patched, rawEdit);
        else if (editType === "move_item") moveItem(patched, rawEdit);
        else throw new ProposalValidationError(`unknown patch edit type: '${editType}'`);
    });

    // The module contract is that every failure leaves as a Proposal* error
    // (→ 400/409). validateCustomCommandDetailed returns a string and is null-safe,
    // but wrap it so any future/unexpected throw can't leak out as a raw 500.
    let validationError: string | null;
    try {
        validationError = validateCustomCommandDetailed(patched);
    } catch (error) {
        throw new ProposalValidationError(
            `patched command is invalid: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    if (validationError) {
        throw new ProposalValidationError(`patched command is invalid: ${validationError}`);
    }
    return patched;
}

/** Concise human-readable summary of patch edits for the review card. */
export function summarizePatchEdits(edits: unknown, limit = 6): string | null {
    if (!Array.isArray(edits) || edits.length === 0) return null;
    const lines: string[] = [];
    for (const edit of edits.slice(0, limit)) {
        if (!isObject(edit)) continue;
        const editType = String(edit["type"] ?? "edit");
        const target = isObject(edit["target"]) ? (edit["target"] as Json) : {};
        const targetBits: string[] = [];
        if (target["page"] !== undefined && target["page"] !== null)
            targetBits.push(`page \`${String(target["page"])}\``);
        if (target["block"] !== undefined && target["block"] !== null)
            targetBits.push(`block \`${String(target["block"])}\``);
        const targetText = targetBits.length ? targetBits.join(" · ") : "command";
        if (editType === "replace_text") {
            const old = String(edit["old"] ?? "").slice(0, 80);
            const replacement = String(edit["new"] ?? "").slice(0, 80);
            lines.push(`\`replace_text\` in ${targetText}: "${old}" → "${replacement}"`);
        } else if (editType === "set_property") {
            lines.push(`\`set_property\` \`${String(edit["property"])}\` on ${targetText}`);
        } else {
            const itemType = edit["item_type"] ?? target["kind"] ?? "item";
            lines.push(`\`${editType}\` ${String(itemType)} on ${targetText}`);
        }
    }
    if (edits.length > limit) lines.push(`…and ${edits.length - limit} more edit(s)`);
    return lines.length ? lines.join("\n").slice(0, 1024) : null;
}
