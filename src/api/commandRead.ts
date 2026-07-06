/**
 * Read side of the command-knowledge API. The endpoint shape matches the
 * contract the external LLM proposer bot's client already speaks, so that
 * client is drop-in:
 *
 *   GET /api/v1/commands                → { count, commands: [...] }  (?detail=full → raw bodies)
 *   GET /api/v1/commands/search?q=...   → { query, count, results: [...] }
 *   GET /api/v1/commands/{name}         → { command: <raw file body> } | 404 { error }
 *
 * Same master switch, X-API-Key auth (PROPOSAL_API_KEY), and shared rate-limit
 * budget as the proposal intake; error responses are `{ error }`.
 *
 * Reads serve the RAW file bodies (commandSync raw bodies), not the normalized
 * corpus — proposers copy patch `old` guards from these, so they must match
 * the GitHub files exactly.
 */
import { IncomingMessage, ServerResponse } from "http";
import type { KrytenClient } from "../classes/client";
import type { CommandBlock, Commands, CustomCommand } from "../types";
import { apiKeyRateLimited, keyMatches } from "./proposalIntake";

export const COMMANDS_READ_PATH = "/api/v1/commands";

const DEFAULT_RATE_LIMIT_PER_MINUTE = 100;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 50;
const DEFAULT_MIN_SCORE = 45;
const MAX_SEARCH_QUERY_CHARS = 256;
const MAX_SEARCH_QUERY_TOKENS = 16;

// Field weights give identifying fields (names/titles) a mild edge over
// long-form body text: a strong content match still outranks a weak name match.
const WEIGHT_NAME = 1.0;
const WEIGHT_DESCRIPTION = 0.95;
const WEIGHT_BLOCK_HEADING = 0.9;
const WEIGHT_BLOCK_TEXT = 0.8;
const WEIGHT_BLOCK_FIELD_NAME = 0.8;
const WEIGHT_BLOCK_FIELD_VALUE = 0.75;
const WEIGHT_BLOCK_SMALL = 0.5;
const WEIGHT_PAGE_NAME = 0.8;
const WEIGHT_PAGE_TITLE = 0.8;
const WEIGHT_PAGE_DESCRIPTION = 0.75;

// A field counts as a "match contributor" when its weighted score is within
// this fraction of the command's best score.
const CONTRIBUTOR_RATIO = 0.9;
// A whole-query substring hit is a strong match even with extra field words.
const PHRASE_BONUS_SCORE = 95;
// Minimum token length for prefix (stem) matching, both directions.
const PREFIX_MIN_CHARS = 4;
const PREFIX_MATCH_CREDIT = 0.9;
// Minimum token length for single-edit typo matching ("headst" → "headset").
const TYPO_MIN_CHARS = 5;
const TYPO_MATCH_CREDIT = 0.85;

interface SearchField {
    path: string;
    text: string;
    weight: number;
}

interface IndexedSearchField extends SearchField {
    tokens: string[];
    tokenSet: Set<string>;
    normalizedText: string;
}

export interface CommandSearchMatch {
    name: string;
    description: string;
    score: number;
    matchedFields: string[];
}

/** Lookup for the raw GitHub file body of one command (undefined → fall back to normalized). */
export type RawBodyLookup = (name: string) => Record<string, unknown> | undefined;

const searchableFieldCache = new WeakMap<CustomCommand, IndexedSearchField[]>();

function tokenize(value: string): string[] {
    return value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function collectBlockFields(fields: SearchField[], prefix: string, blocks: CommandBlock[] | undefined): void {
    for (const [index, block] of (blocks ?? []).entries()) {
        switch (block.type) {
            case "heading":
                fields.push({ path: `${prefix}[${index}].text`, text: block.text, weight: WEIGHT_BLOCK_HEADING });
                break;
            case "text":
                fields.push({ path: `${prefix}[${index}].text`, text: block.text, weight: WEIGHT_BLOCK_TEXT });
                break;
            case "field":
                fields.push({ path: `${prefix}[${index}].name`, text: block.name, weight: WEIGHT_BLOCK_FIELD_NAME });
                fields.push({ path: `${prefix}[${index}].value`, text: block.value, weight: WEIGHT_BLOCK_FIELD_VALUE });
                break;
            case "small":
                fields.push({ path: `${prefix}[${index}].text`, text: block.text, weight: WEIGHT_BLOCK_SMALL });
                break;
            default:
                break; // divider, images
        }
    }
}

function searchableFields(command: CustomCommand): SearchField[] {
    const fields: SearchField[] = [
        { path: "name", text: command.name, weight: WEIGHT_NAME },
        { path: "description", text: command.description, weight: WEIGHT_DESCRIPTION },
    ];
    collectBlockFields(fields, "blocks", command.blocks);
    for (const [pageIndex, page] of (command.pages ?? []).entries()) {
        fields.push({ path: `pages[${pageIndex}].name`, text: page.name, weight: WEIGHT_PAGE_NAME });
        if (page.title) {
            fields.push({ path: `pages[${pageIndex}].title`, text: page.title, weight: WEIGHT_PAGE_TITLE });
        }
        if (page.description) {
            fields.push({
                path: `pages[${pageIndex}].description`,
                text: page.description,
                weight: WEIGHT_PAGE_DESCRIPTION,
            });
        }
        collectBlockFields(fields, `pages[${pageIndex}].blocks`, page.blocks);
    }
    return fields;
}

function indexedSearchableFields(command: CustomCommand): IndexedSearchField[] {
    const cached = searchableFieldCache.get(command);
    if (cached) return cached;
    const indexed = searchableFields(command).map(field => {
        const tokens = tokenize(field.text);
        return {
            ...field,
            tokens,
            tokenSet: new Set(tokens),
            normalizedText: tokens.join(" "),
        };
    });
    searchableFieldCache.set(command, indexed);
    return indexed;
}

/** Whether two tokens are within one insert/delete/substitute of each other. */
function withinOneEdit(a: string, b: string): boolean {
    if (Math.abs(a.length - b.length) > 1) return false;
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < short.length && j < long.length) {
        if (short[i] === long[j]) {
            i += 1;
            j += 1;
            continue;
        }
        if (edits > 0) return false;
        edits = 1;
        if (short.length === long.length) i += 1; // substitution
        j += 1; // insertion into the longer token
    }
    return edits + (long.length - j) + (short.length - i) <= 1;
}

function queryTokensFor(query: string): string[] {
    return tokenize(query).slice(0, MAX_SEARCH_QUERY_TOKENS);
}

/** Raw 0-100 relevance of the query tokens against one indexed field. */
function fieldScore(queryTokens: string[], field: IndexedSearchField): number {
    const textTokens = field.tokens;
    if (!textTokens.length || !queryTokens.length) return 0;
    let matched = 0;
    for (const queryToken of queryTokens) {
        if (field.tokenSet.has(queryToken)) {
            matched += 1;
            continue;
        }
        const prefixHit = textTokens.some(
            textToken =>
                (queryToken.length >= PREFIX_MIN_CHARS && textToken.startsWith(queryToken)) ||
                (textToken.length >= PREFIX_MIN_CHARS && queryToken.startsWith(textToken)),
        );
        if (prefixHit) {
            matched += PREFIX_MATCH_CREDIT;
            continue;
        }
        if (
            queryToken.length >= TYPO_MIN_CHARS &&
            textTokens.some(textToken => textToken.length >= TYPO_MIN_CHARS && withinOneEdit(queryToken, textToken))
        ) {
            matched += TYPO_MATCH_CREDIT;
        }
    }
    let score = (matched / queryTokens.length) * 100;
    // Whole-query substring bonus — but only for a substantive phrase. A raw
    // includes() on a 1-3 char query matches *inside* unrelated tokens (e.g. "in"
    // inside "link"), scoring 95 and sailing past min_score. Length-gate it like
    // the prefix/typo matchers above.
    const phrase = queryTokens.join(" ");
    if (phrase.length >= PREFIX_MIN_CHARS && field.normalizedText.includes(phrase)) {
        score = Math.max(score, PHRASE_BONUS_SCORE);
    }
    return Math.min(100, score);
}

/** Rank commands by fuzzy relevance; sorted by descending score, then name. */
export function searchCommands(
    commands: Commands,
    query: string,
    limit: number = DEFAULT_SEARCH_LIMIT,
    minScore: number = DEFAULT_MIN_SCORE,
): CommandSearchMatch[] {
    const queryTokens = queryTokensFor(query);
    if (!queryTokens.length) return [];

    const matches: CommandSearchMatch[] = [];
    for (const command of commands) {
        let best = 0;
        const contributors: { path: string; weighted: number }[] = [];
        for (const field of indexedSearchableFields(command)) {
            const weighted = fieldScore(queryTokens, field) * field.weight;
            contributors.push({ path: field.path, weighted });
            if (weighted > best) best = weighted;
        }
        if (best <= 0 || best < minScore) continue;
        const threshold = best * CONTRIBUTOR_RATIO;
        matches.push({
            name: command.name,
            description: command.description,
            score: Math.round(best * 100) / 100,
            matchedFields: contributors.filter(entry => entry.weighted >= threshold).map(entry => entry.path),
        });
    }

    matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    return matches.slice(0, Math.max(0, limit));
}

function rawOrNormalized(command: CustomCommand, getRaw: RawBodyLookup): Record<string, unknown> {
    return getRaw(command.name) ?? (command as unknown as Record<string, unknown>);
}

export function listPayload(commands: Commands, getRaw: RawBodyLookup, detail: string): Record<string, unknown> {
    if (detail === "full") {
        return { count: commands.length, commands: commands.map(command => rawOrNormalized(command, getRaw)) };
    }
    return {
        count: commands.length,
        commands: commands.map(command => ({
            name: command.name,
            description: command.description,
            has_pages: Boolean(command.pages?.length),
        })),
    };
}

export function getPayload(
    commands: Commands,
    getRaw: RawBodyLookup,
    name: string,
): Record<string, unknown> | undefined {
    const normalized = name.trim().toLowerCase();
    const command = commands.find(entry => entry.name === normalized);
    if (!command) return undefined;
    return { command: rawOrNormalized(command, getRaw) };
}

export function searchPayload(
    commands: Commands,
    getRaw: RawBodyLookup,
    query: string,
    limit: number,
    minScore: number,
): Record<string, unknown> {
    const byName = new Map(commands.map(command => [command.name, command]));
    const results = searchCommands(commands, query, limit, minScore).map(match => ({
        name: match.name,
        description: match.description,
        score: match.score,
        matched_fields: match.matchedFields,
        command: rawOrNormalized(byName.get(match.name) as CustomCommand, getRaw),
    }));
    return { query, count: results.length, results };
}

function respond(res: ServerResponse, http: number, payload: Record<string, unknown>): void {
    if (res.headersSent || res.writableEnded) return;
    res.writeHead(http, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
}

function boundedInt(raw: string | null, fallback: number, minimum: number, maximum: number): number {
    const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

export function handleCommandRead(client: KrytenClient, req: IncomingMessage, res: ServerResponse, url: URL): void {
    const service = client.proposalService;
    const apiKey = process.env["PROPOSAL_API_KEY"];
    if (!service || !apiKey) {
        respond(res, 503, { error: "Command knowledge is not available" });
        return;
    }
    const presented = req.headers["x-api-key"];
    if (typeof presented !== "string" || !keyMatches(presented, apiKey)) {
        respond(res, 401, { error: "Invalid or missing API key" });
        return;
    }
    const limit = client.config.proposals?.rate_limit_per_minute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
    if (apiKeyRateLimited(presented, limit)) {
        respond(res, 429, { error: "Rate limit exceeded" });
        return;
    }

    const commands = client.custom_commands;
    const getRaw: RawBodyLookup = name => client.commandSync.getRawBody(name);

    if (url.pathname === COMMANDS_READ_PATH) {
        respond(res, 200, listPayload(commands, getRaw, url.searchParams.get("detail") ?? "summary"));
        return;
    }
    // Only treat /search as the search endpoint when a query is actually present.
    // Otherwise a custom command legally named "search" (names allow [a-z0-9_-])
    // would be permanently unreachable via GET /{name}: the bare /search path
    // falls through to the by-name lookup below.
    if (
        url.pathname === `${COMMANDS_READ_PATH}/search` &&
        (url.searchParams.has("q") || url.searchParams.has("query"))
    ) {
        const query = (url.searchParams.get("q") ?? url.searchParams.get("query") ?? "").trim();
        if (!query) {
            respond(res, 400, { error: "Query parameter 'q' is required" });
            return;
        }
        if (query.length > MAX_SEARCH_QUERY_CHARS) {
            respond(res, 400, { error: `Query is too long (max ${MAX_SEARCH_QUERY_CHARS} characters)` });
            return;
        }
        if (tokenize(query).length > MAX_SEARCH_QUERY_TOKENS) {
            respond(res, 400, { error: `Query has too many terms (max ${MAX_SEARCH_QUERY_TOKENS})` });
            return;
        }
        const searchLimit = boundedInt(url.searchParams.get("limit"), DEFAULT_SEARCH_LIMIT, 1, MAX_SEARCH_LIMIT);
        const minScore = boundedInt(url.searchParams.get("min_score"), DEFAULT_MIN_SCORE, 0, 100);
        respond(res, 200, searchPayload(commands, getRaw, query, searchLimit, minScore));
        return;
    }

    let name: string;
    try {
        name = decodeURIComponent(url.pathname.slice(`${COMMANDS_READ_PATH}/`.length));
    } catch {
        respond(res, 404, { error: "Command not found" });
        return;
    }
    const payload = getPayload(commands, getRaw, name);
    if (!payload) {
        respond(res, 404, { error: `Command '${name}' not found` });
        return;
    }
    respond(res, 200, payload);
}
