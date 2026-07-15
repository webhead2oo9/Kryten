/**
 * Local known-bad image fingerprint cache with optional FingerprintHub sync,
 * using the same better-sqlite3 discipline as {@link ../../proposals/store.ts}.
 *
 * Cache model: match locally and in-memory on the hot path — the hub is a
 * background sync source + contribution target, never on the moderation path.
 * Boot loads from local SQLite so there's no hard dependency on the hub being
 * reachable.
 *
 *   origin='local'  we contributed it (delete → hub delete)
 *   origin='hub'    synced from a peer   (remove → local suppression + hub flag)
 */
import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { ImageFingerprintConfig } from "../../types";
import { FingerprintHubClient, DEFAULT_HUB_BASE_URL, HubSyncRow } from "./hubClient";

export const DEFAULT_ALGORITHM = "phash";
export const DEFAULT_ALGORITHM_VERSION = "imagehash.phash";
export const DEFAULT_NORMALIZATION_VERSION = "alpha_white_v1";
export const DEFAULT_PROVENANCE = "manual_staff";
export const CROSSPOST_REVIEW_PROVENANCE = "crosspost_review_approved";
export const VALID_ACTIONS = new Set(["kick", "timeout"]);
export const VALID_CATEGORIES = new Set(["scam", "nsfw", "crypto", "phishing", "other"]);
const PHASH_HEX_PATTERN = /^[0-9a-f]{16}$/i;

const HUB_SYNC_PAGE_LIMIT = 200;
const DEFAULT_HUB_API_KEY_ENV = "FINGERPRINT_HUB_API_KEY";

export interface FingerprintHit {
    rowId: number;
    phashHex: string;
    action: string;
    category: string;
    distance: number;
    hubFingerprintId: number | null;
    origin: string;
    provenance: string;
}

interface Entry {
    rowId: number;
    phashHex: string;
    phash: bigint;
    action: string;
    category: string;
    sourceUrl: string | null;
    addedBy: string | null;
    autoAdded: boolean;
    addedAtMs: number;
    algorithm: string;
    algorithmVersion: string;
    normalizationVersion: string;
    provenance: string;
    hubFingerprintId: number | null;
    origin: "local" | "hub";
}

interface Row {
    id: number;
    phash_hex: string;
    action: string;
    category: string;
    added_by: string | null;
    added_at_ms: number;
    source_url: string | null;
    reason: string | null;
    auto_added: number;
    algorithm: string;
    algorithm_version: string;
    normalization_version: string;
    provenance: string;
    hub_fingerprint_id: number | null;
    origin: string;
}

export class DuplicateFingerprintError extends Error {
    constructor(
        readonly hit: FingerprintHit,
        readonly tolerance: number,
    ) {
        super(`fingerprint overlaps row #${hit.rowId} (distance=${hit.distance}, tolerance=${tolerance})`);
        this.name = "DuplicateFingerprintError";
    }
}

function popcount32(v: number): number {
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Hamming distance between two 64-bit pHashes held as bigints. */
export function hammingBig(a: bigint, b: bigint): number {
    const x = a ^ b;
    const lo = Number(x & 0xffffffffn);
    const hi = Number((x >> 32n) & 0xffffffffn);
    return popcount32(lo) + popcount32(hi);
}

export function phashFromHex(hex: string): bigint {
    const normalized = normalizePhashHex(hex);
    if (!normalized) throw new Error(`invalid pHash hex: ${hex}`);
    return BigInt("0x" + normalized);
}

function normalizePhashHex(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    return PHASH_HEX_PATTERN.test(normalized) ? normalized : null;
}

export interface StoreDeps {
    /** Route background/transport failures somewhere visible; defaults to console. */
    onError?: (context: string, error: unknown) => void;
}

export class ImageFingerprintStore {
    private readonly db: Database.Database;
    private entries: Entry[] = [];
    private loaded = false;

    private readonly compat: readonly [string, string, string] = [
        DEFAULT_ALGORITHM,
        DEFAULT_ALGORITHM_VERSION,
        DEFAULT_NORMALIZATION_VERSION,
    ];

    /** Action stamped on synced (peer) rows — a local intent hint, not the peer's. */
    defaultAction: string;

    private readonly hub: FingerprintHubClient | null;
    private readonly hubEnabled: boolean;
    private readonly syncIntervalMs: number;
    private syncTimer: NodeJS.Timeout | null = null;
    private syncing = false;

    private readonly onError: (context: string, error: unknown) => void;

    constructor(config: ImageFingerprintConfig, deps: StoreDeps = {}) {
        this.onError = deps.onError ?? ((context, error) => console.warn(`[image-fingerprint] ${context}:`, error));

        const dbPath = config.db_path ?? "./data/image_fingerprints.db";
        mkdirSync(dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.initSchema();

        this.defaultAction = VALID_ACTIONS.has(config.default_action ?? "")
            ? (config.default_action as string)
            : "kick";

        const apiKeyEnv = config.hub_api_key_env ?? DEFAULT_HUB_API_KEY_ENV;
        const apiKey = process.env[apiKeyEnv] ?? process.env["FINGERPRINT_HUB_API_KEY"];
        const baseUrl = (config.hub_base_url ?? DEFAULT_HUB_BASE_URL).replace(/\/+$/, "");
        this.syncIntervalMs = Math.max(1, config.hub_sync_interval_seconds ?? 300) * 1000;
        this.hubEnabled = Boolean(config.hub_enabled && baseUrl && apiKey);
        this.hub = this.hubEnabled
            ? new FingerprintHubClient(baseUrl, apiKey!, (config.hub_request_timeout_seconds ?? 5) * 1000)
            : null;

        this.reload();
    }

    get size(): number {
        return this.entries.length;
    }

    get hubActive(): boolean {
        return this.hubEnabled;
    }

    close(): void {
        this.stopSync();
        this.db.close();
    }

    private initSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS known_bad_image_fingerprints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                phash_hex TEXT NOT NULL CHECK (length(phash_hex) = 16 AND phash_hex NOT GLOB '*[^0-9a-fA-F]*'),
                action TEXT NOT NULL CHECK (action IN ('kick','timeout')),
                category TEXT NOT NULL CHECK (category IN ('scam','nsfw','crypto','phishing','other')),
                added_by TEXT NOT NULL,
                added_at_ms INTEGER NOT NULL,
                source_url TEXT,
                reason TEXT,
                hit_count INTEGER NOT NULL DEFAULT 0,
                last_hit_at_ms INTEGER,
                auto_added INTEGER NOT NULL DEFAULT 0,
                algorithm TEXT NOT NULL DEFAULT 'phash',
                algorithm_version TEXT NOT NULL DEFAULT 'imagehash.phash',
                normalization_version TEXT NOT NULL DEFAULT 'alpha_white_v1',
                provenance TEXT NOT NULL DEFAULT 'manual_staff',
                hub_fingerprint_id INTEGER UNIQUE,
                origin TEXT NOT NULL DEFAULT 'local' CHECK (origin IN ('local','hub')),
                hub_synced_at_ms INTEGER
            );
            CREATE TABLE IF NOT EXISTS fingerprint_hub_sync_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                last_sync_seq INTEGER NOT NULL DEFAULT 0
            );
            INSERT OR IGNORE INTO fingerprint_hub_sync_state (id, last_sync_seq) VALUES (1, 0);
            CREATE TABLE IF NOT EXISTS fingerprint_hub_suppressions (
                hub_fingerprint_id INTEGER PRIMARY KEY,
                suppressed_at_ms INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_image_fingerprints_phash ON known_bad_image_fingerprints(phash_hex);
            CREATE INDEX IF NOT EXISTS idx_image_fingerprints_category ON known_bad_image_fingerprints(category);
        `);
    }

    /** Rebuild the in-memory index from SQLite. */
    reload(): void {
        if (!this.db.open) return;
        const rows = this.db.prepare("SELECT * FROM known_bad_image_fingerprints ORDER BY id").all() as Row[];
        const entries: Entry[] = [];
        for (const row of rows) {
            try {
                entries.push(this.entryFromRow(row));
            } catch (error) {
                this.onError(`skipping invalid local fingerprint row id=${row.id}`, error);
            }
        }
        this.entries = entries;
        this.loaded = true;
    }

    private entryFromRow(row: Row): Entry {
        const phashHex = normalizePhashHex(row.phash_hex);
        if (!phashHex) throw new Error(`invalid pHash hex '${row.phash_hex}'`);
        return {
            rowId: row.id,
            phashHex,
            phash: phashFromHex(phashHex),
            action: row.action,
            category: row.category,
            sourceUrl: row.source_url,
            addedBy: row.added_by,
            autoAdded: Boolean(row.auto_added),
            addedAtMs: row.added_at_ms,
            algorithm: row.algorithm || DEFAULT_ALGORITHM,
            algorithmVersion: row.algorithm_version || DEFAULT_ALGORITHM_VERSION,
            normalizationVersion: row.normalization_version || DEFAULT_NORMALIZATION_VERSION,
            provenance: row.provenance || DEFAULT_PROVENANCE,
            hubFingerprintId: row.hub_fingerprint_id,
            origin: row.origin === "hub" ? "hub" : "local",
        };
    }

    /** Nearest known-bad fingerprint within `tolerance` bits, or null. */
    match(phash: bigint, tolerance: number): FingerprintHit | null {
        if (!this.loaded) return null;
        const limit = Math.max(0, Math.trunc(tolerance));
        let best: Entry | null = null;
        let bestDist = limit + 1;
        for (const entry of this.entries) {
            if (
                entry.algorithm !== this.compat[0] ||
                entry.algorithmVersion !== this.compat[1] ||
                entry.normalizationVersion !== this.compat[2]
            ) {
                continue;
            }
            const dist = hammingBig(phash, entry.phash);
            if (dist < bestDist) {
                best = entry;
                bestDist = dist;
                if (dist === 0) break;
            }
        }
        if (!best) return null;
        return {
            rowId: best.rowId,
            phashHex: best.phashHex,
            action: best.action,
            category: best.category,
            distance: bestDist,
            hubFingerprintId: best.hubFingerprintId,
            origin: best.origin,
            provenance: best.provenance,
        };
    }

    /**
     * Insert a locally-authored fingerprint. Throws {@link DuplicateFingerprintError}
     * when it overlaps an existing row within `duplicateTolerance`. When the hub
     * is active, contribution is kicked off in the background (local-first).
     */
    add(options: {
        phash: bigint;
        action: string;
        category: string;
        addedBy: string;
        sourceUrl?: string | null;
        reason?: string | null;
        autoAdded?: boolean;
        provenance?: string;
        duplicateTolerance?: number;
        sourceGuildId?: string | null;
    }): number {
        if (!VALID_ACTIONS.has(options.action)) throw new Error(`invalid action: ${options.action}`);
        if (!VALID_CATEGORIES.has(options.category)) throw new Error(`invalid category: ${options.category}`);
        if (options.duplicateTolerance !== undefined) {
            const tol = Math.max(0, Math.trunc(options.duplicateTolerance));
            const existing = this.match(options.phash, tol);
            if (existing) throw new DuplicateFingerprintError(existing, tol);
        }

        const now = Date.now();
        const phashHex = options.phash.toString(16).padStart(16, "0");
        const provenance = options.provenance?.trim() || DEFAULT_PROVENANCE;
        const info = this.db
            .prepare(
                `INSERT INTO known_bad_image_fingerprints
                 (phash_hex, action, category, added_by, added_at_ms, source_url, reason, auto_added,
                  algorithm, algorithm_version, normalization_version, provenance, origin)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')`,
            )
            .run(
                phashHex,
                options.action,
                options.category,
                options.addedBy,
                now,
                options.sourceUrl ?? null,
                options.reason ?? null,
                options.autoAdded ? 1 : 0,
                DEFAULT_ALGORITHM,
                DEFAULT_ALGORITHM_VERSION,
                DEFAULT_NORMALIZATION_VERSION,
                provenance,
            );
        const rowId = Number(info.lastInsertRowid);

        this.entries.push({
            rowId,
            phashHex,
            phash: options.phash,
            action: options.action,
            category: options.category,
            sourceUrl: options.sourceUrl ?? null,
            addedBy: options.addedBy,
            autoAdded: Boolean(options.autoAdded),
            addedAtMs: now,
            algorithm: DEFAULT_ALGORITHM,
            algorithmVersion: DEFAULT_ALGORITHM_VERSION,
            normalizationVersion: DEFAULT_NORMALIZATION_VERSION,
            provenance,
            hubFingerprintId: null,
            origin: "local",
        });

        if (this.hub) {
            void this.contributeToHub(rowId, phashHex, options, provenance);
        }
        return rowId;
    }

    /** Bump local hit stats and, when linked, report the hit to the hub. */
    incrementHit(
        rowId: number,
        opts: { guildId?: string; distance?: number; reportToHub?: boolean } = {},
    ): number | null {
        const now = Date.now();
        this.db
            .prepare(
                "UPDATE known_bad_image_fingerprints SET hit_count = hit_count + 1, last_hit_at_ms = ? WHERE id = ?",
            )
            .run(now, rowId);
        const row = this.db.prepare("SELECT hit_count FROM known_bad_image_fingerprints WHERE id = ?").get(rowId) as
            | { hit_count: number }
            | undefined;
        if (!row) return null;

        // Callers decide whether dry-run detections should count as shared
        // telemetry; local hit_count always tracks for observation.
        if (this.hub && opts.reportToHub !== false) {
            const hubId = this.entries.find(e => e.rowId === rowId)?.hubFingerprintId ?? null;
            if (hubId !== null) {
                void this.hub.reportHit(hubId, { guild_id: opts.guildId, distance: opts.distance });
            }
        }
        return row.hit_count;
    }

    /**
     * Staff removed a fingerprint locally. For local rows this deletes ours from
     * the hub; for synced rows it records a suppression (so the next sync can't
     * resurrect it) and flags the peer's row. Returns true if a local row went.
     */
    async remove(rowId: number): Promise<boolean> {
        const entry = this.entries.find(e => e.rowId === rowId) ?? null;
        this.db.prepare("DELETE FROM known_bad_image_fingerprints WHERE id = ?").run(rowId);
        this.entries = this.entries.filter(e => e.rowId !== rowId);
        if (!entry) return false;

        if (entry.hubFingerprintId !== null) {
            if (entry.origin === "local" && this.hub) {
                void this.hub.remove(entry.hubFingerprintId);
            } else if (entry.origin === "hub") {
                // Suppress before the next sync can re-ingest it; a single flag
                // won't hide it hub-side until the flag threshold is reached.
                this.db
                    .prepare(
                        "INSERT OR REPLACE INTO fingerprint_hub_suppressions (hub_fingerprint_id, suppressed_at_ms) VALUES (?, ?)",
                    )
                    .run(entry.hubFingerprintId, Date.now());
                if (this.hub) void this.hub.flag(entry.hubFingerprintId);
            }
        }
        return true;
    }

    // ---- hub contribution / sync -------------------------------------------

    private async contributeToHub(
        rowId: number,
        phashHex: string,
        options: {
            action: string;
            category: string;
            sourceUrl?: string | null;
            reason?: string | null;
            autoAdded?: boolean;
            sourceGuildId?: string | null;
        },
        provenance: string,
    ): Promise<void> {
        if (!this.hub) return;
        const result = await this.hub.contribute({
            phash_hex: phashHex,
            action: options.action,
            category: options.category,
            algorithm: DEFAULT_ALGORITHM,
            algorithm_version: DEFAULT_ALGORITHM_VERSION,
            normalization_version: DEFAULT_NORMALIZATION_VERSION,
            auto_added: Boolean(options.autoAdded),
            provenance,
            ...(options.sourceUrl ? { source_url: options.sourceUrl } : {}),
            ...(options.reason ? { reason: options.reason } : {}),
            ...(options.sourceGuildId ? { source_guild_id: String(options.sourceGuildId) } : {}),
        });
        if (result.status !== "linked") {
            this.onError("hub contribute failed", result.detail);
            return;
        }
        // The store may have been closed while we were contributing (shutdown).
        if (!this.db.open) return;
        try {
            const info = this.db
                .prepare(
                    "UPDATE known_bad_image_fingerprints SET hub_fingerprint_id = ?, origin = 'local', hub_synced_at_ms = ? WHERE id = ?",
                )
                .run(result.hubId, Date.now(), rowId);
            if (info.changes === 0) {
                // The local row was removed (staff remove()) during the contribute
                // round-trip, so remove() saw a null hub link and skipped the hub
                // delete. Delete the now-orphaned hub row so it isn't left dangling.
                void this.hub.remove(result.hubId);
                return;
            }
            const entry = this.entries.find(e => e.rowId === rowId);
            if (entry) entry.hubFingerprintId = result.hubId;
        } catch (error) {
            this.onError("failed to stamp hub link", error);
        }
    }

    /** Start the background sync loop (no-op when the hub is inactive). */
    startSync(): void {
        if (!this.hub || this.syncTimer) return;
        const tick = async (): Promise<void> => {
            try {
                await this.syncOnce();
            } catch (error) {
                this.onError("hub sync cycle failed", error);
            } finally {
                if (this.syncTimer) this.syncTimer = setTimeout(() => void tick(), this.syncIntervalMs);
            }
        };
        // Sentinel so stopSync() during the first await still cancels rescheduling.
        this.syncTimer = setTimeout(() => void tick(), this.syncIntervalMs);
    }

    stopSync(): void {
        if (this.syncTimer) clearTimeout(this.syncTimer);
        this.syncTimer = null;
    }

    /** One full drain of the sync feed (paged). Public for manual/initial sync. */
    async syncOnce(): Promise<void> {
        if (!this.hub || this.syncing) return;
        this.syncing = true;
        try {
            const suppressions = this.loadSuppressions();
            let watermark = this.readWatermark();
            let changed = false;
            let pages = 0;
            for (;;) {
                const page = await this.hub.sync({
                    since: watermark,
                    limit: HUB_SYNC_PAGE_LIMIT,
                    algorithm: this.compat[0],
                    algorithm_version: this.compat[1],
                    normalization_version: this.compat[2],
                });
                // close() can fire while we're awaiting the hub (shutdown); stop
                // before touching the DB so we never write to a closed handle.
                if (!this.db.open) return;
                if (!page) break;
                for (const row of page.fingerprints) {
                    try {
                        if (this.applySyncRow(row, suppressions)) changed = true;
                    } catch (error) {
                        this.onError(`failed to apply hub row id=${row.id}`, error);
                    }
                }
                const advanced = page.next_since > watermark;
                if (advanced) {
                    watermark = page.next_since;
                    this.writeWatermark(watermark);
                }
                pages++;
                if (!page.has_more || pages > 1000) break;
                if (!advanced) {
                    // has_more=true but the cursor did not move past our watermark
                    // (a boundary tie at >= the page limit, or a hub bug).
                    // Re-requesting the same `since` would replay this page up to
                    // the 1000-page cap — re-applying rows, never persisting
                    // progress. Stop and report rather than spin; the next cycle
                    // retries from the same watermark.
                    this.onError(
                        "hub sync stalled: has_more=true but next_since did not advance",
                        new Error(`watermark=${watermark} next_since=${page.next_since}`),
                    );
                    break;
                }
            }
            if (changed) this.reload();
        } finally {
            this.syncing = false;
        }
    }

    private applySyncRow(row: HubSyncRow, suppressions: Set<number>): boolean {
        if (
            row.algorithm !== this.compat[0] ||
            row.algorithm_version !== this.compat[1] ||
            row.normalization_version !== this.compat[2]
        ) {
            return false;
        }
        const hubId = row.id;
        if (row.status === "hidden" || row.status === "deleted") {
            const removed = this.deleteByHubId(hubId) > 0;
            // A permanent 'deleted' retires the hub id for good, so its local
            // suppression is moot — prune it to bound fingerprint_hub_suppressions.
            // A transient 'hidden' can be reversed, so KEEP the suppression to
            // preserve staff's local removal across a hide→unhide cycle.
            if (row.status === "deleted") {
                this.db.prepare("DELETE FROM fingerprint_hub_suppressions WHERE hub_fingerprint_id = ?").run(hubId);
            }
            return removed;
        }
        if (row.status !== "active") return false;
        if (suppressions.has(hubId)) return false;
        // Only the category is persisted; upsertHubRow overrides the peer's action
        // to our configured default. So a peer action outside {kick,timeout} must
        // NOT skip an otherwise-valid known-bad fingerprint — doing so silently
        // drops shared scam coverage across the hub.
        if (!VALID_CATEGORIES.has(row.category)) {
            this.onError("skipping invalid hub row", `id=${hubId} category=${row.category}`);
            return false;
        }
        this.upsertHubRow(row);
        return true;
    }

    private upsertHubRow(row: HubSyncRow): void {
        // Validate at the write chokepoint so every (current and future) caller
        // is covered; the sync loop's per-row try/catch turns this into a
        // logged skip.
        const phashHex = normalizePhashHex(row.phash_hex);
        if (!phashHex) throw new Error(`invalid pHash hex '${String(row.phash_hex)}'`);
        const now = Date.now();
        this.db
            .prepare(
                `INSERT INTO known_bad_image_fingerprints
                 (phash_hex, action, category, added_by, added_at_ms, source_url, reason, auto_added,
                  algorithm, algorithm_version, normalization_version, provenance, hub_fingerprint_id,
                  origin, hub_synced_at_ms)
                 VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, 'hub', ?)
                 ON CONFLICT(hub_fingerprint_id) DO UPDATE SET
                    phash_hex = excluded.phash_hex,
                    action = excluded.action,
                    category = excluded.category,
                    auto_added = excluded.auto_added,
                    algorithm = excluded.algorithm,
                    algorithm_version = excluded.algorithm_version,
                    normalization_version = excluded.normalization_version,
                    provenance = excluded.provenance,
                    hub_synced_at_ms = excluded.hub_synced_at_ms`,
            )
            .run(
                phashHex,
                // The peer's action is a hint; we enforce our own configured action.
                this.defaultAction,
                row.category,
                `hub:${row.consumer_id}`,
                row.added_at_ms ?? now,
                row.auto_added ? 1 : 0,
                row.algorithm || DEFAULT_ALGORITHM,
                row.algorithm_version || DEFAULT_ALGORITHM_VERSION,
                row.normalization_version || DEFAULT_NORMALIZATION_VERSION,
                row.provenance || DEFAULT_PROVENANCE,
                row.id,
                now,
            );
    }

    private deleteByHubId(hubId: number): number {
        return this.db.prepare("DELETE FROM known_bad_image_fingerprints WHERE hub_fingerprint_id = ?").run(hubId)
            .changes;
    }

    private readWatermark(): number {
        const row = this.db.prepare("SELECT last_sync_seq FROM fingerprint_hub_sync_state WHERE id = 1").get() as
            | { last_sync_seq: number }
            | undefined;
        return row ? row.last_sync_seq : 0;
    }

    private writeWatermark(seq: number): void {
        if (!this.db.open) return;
        this.db
            .prepare(
                "INSERT INTO fingerprint_hub_sync_state (id, last_sync_seq) VALUES (1, ?) " +
                    "ON CONFLICT(id) DO UPDATE SET last_sync_seq = excluded.last_sync_seq",
            )
            .run(seq);
    }

    private loadSuppressions(): Set<number> {
        const rows = this.db.prepare("SELECT hub_fingerprint_id FROM fingerprint_hub_suppressions").all() as {
            hub_fingerprint_id: number;
        }[];
        return new Set(rows.map(r => r.hub_fingerprint_id));
    }
}
