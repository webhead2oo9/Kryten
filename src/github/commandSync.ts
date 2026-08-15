/**
 * Orchestrates the custom-command corpus: loads the per-command files from
 * GitHub (falling back to the last-good snapshot `.commands-cache.json`,
 * else an empty corpus), tracks per-file blob SHAs + the directory digest,
 * and applies the results of individual commits/deletes so save paths don't
 * need a full reload.
 *
 * The snapshot is the ONLY local persistence artifact — the old aggregate
 * commands.json is neither read nor written.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join } from "path";
import { Commands, Config, CustomCommand } from "../types";
import { normalizeName } from "../utils/format";
import { jsonClone } from "../utils/jsonClone";
import { validateCustomCommand } from "../utils/validateCommand";
import { CommandFilesClient, computeDirectoryDigest } from "./commandFiles";

export type LoadSource = "github" | "cache" | "memory" | "none";

/** The slice of KrytenClient that CommandSync actually uses (test seam). */
export interface CommandSyncHost {
    config: Config;
    custom_commands: Commands;
    logError(title: string, error: string | Error, critical?: boolean): Promise<void>;
    /**
     * Whether a name is already backed by a built-in chat command. A custom
     * command with a colliding name makes Discord 400 the entire guild command
     * set on registration. Optional so tests can omit it.
     */
    isBuiltinCommandName?(name: string): boolean;
}

interface CacheFileV2 {
    version: 2;
    timestamp: string;
    digest?: string;
    files?: Record<string, { path: string; sha: string }>;
    commands: Commands;
}

type LoadedCache = Omit<CacheFileV2, "version" | "timestamp">;

// GitHub advises serial requests per token and enforces secondary rate limits on
// bursts; a large corpus firing N simultaneous GETs can trip a 403 that fails the
// whole load. Cap in-flight fetches while preserving result order.
const LOAD_CONCURRENCY = 8;
const EMPTY_LISTING_CONFIRMATIONS_REQUIRED = 2;

async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(items.length);
    let next = 0;
    const worker = async (): Promise<void> => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await fn(items[i]!, i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return results;
}

export class CommandSync {
    private readonly cachePath: string;
    private digest?: string;
    private fileShas = new Map<string, string>();
    private filePaths = new Map<string, string>();
    /** Exact parsed file bodies (pre-normalization) — the patch engine edits these. */
    private rawBodies = new Map<string, Record<string, unknown>>();
    private _lastLoadSource: LoadSource = "none";
    private allowEmptySnapshotWrite = false;
    private emptyListingConfirmations = 0;

    constructor(
        private readonly client: CommandSyncHost,
        options: { cachePath?: string } = {},
    ) {
        this.cachePath = options.cachePath ?? join(process.cwd(), ".commands-cache.json");
    }

    get lastLoadSource(): LoadSource {
        return this._lastLoadSource;
    }

    filesClient(): CommandFilesClient | null {
        return CommandFilesClient.fromConfig(this.client.config);
    }

    getDigest(): string | undefined {
        return this.digest;
    }

    /** Per-command blob SHAs, or undefined when the current revision is unknown. */
    snapshotShas(): Record<string, string> | undefined {
        if (this.fileShas.size === 0) return undefined;
        return Object.fromEntries(this.fileShas);
    }

    getRawBody(name: string): Record<string, unknown> | undefined {
        return this.rawBodies.get(normalizeName(name));
    }

    getFileSha(name: string): string | undefined {
        return this.fileShas.get(normalizeName(name));
    }

    /** Record the result of a successful single-file commit without a full reload. */
    applyCommit(name: string, newSha: string | undefined, rawBody: Record<string, unknown>): void {
        this.allowEmptySnapshotWrite = false;
        this.emptyListingConfirmations = 0;
        const key = normalizeName(name);
        if (newSha) this.fileShas.set(key, newSha);
        else this.fileShas.delete(key); // unknown revision for this file until next load
        // Defensive clone: callers (editor save, proposal approve) may hand in a
        // reference into live/mutable state. rawBodies is contractually the
        // exact parsed GitHub body — served by the read API and edited by the
        // patch engine — so it must never alias an object a later edit mutates.
        this.rawBodies.set(key, jsonClone(rawBody));
        const client = this.filesClient();
        if (client && !this.filePaths.has(key)) {
            try {
                this.filePaths.set(key, client.commandPath(key));
            } catch {
                // invalid name cannot have been committed
            }
        }
    }

    applyDelete(name: string): void {
        this.allowEmptySnapshotWrite = false;
        this.emptyListingConfirmations = 0;
        const key = normalizeName(name);
        this.fileShas.delete(key);
        this.filePaths.delete(key);
        this.rawBodies.delete(key);
    }

    /** Re-derive the directory digest from a fresh listing (post-commit). */
    async refreshDigest(): Promise<void> {
        const client = this.filesClient();
        if (!client) return;
        const listing = await client.listCommandDir();
        if ("error" in listing) {
            console.error(listing.error);
            return;
        }

        const remoteDigest = computeDirectoryDigest(listing.entries);
        const knownEntries = [...this.fileShas]
            .map(([name, sha]) => {
                const path = this.filePaths.get(name);
                return path ? { path, sha } : undefined;
            })
            .filter((entry): entry is { path: string; sha: string } => entry !== undefined);
        // If the remote listing has files/SHAs we do not know about, leave the
        // old digest in place so the poller performs a full reload.
        if (computeDirectoryDigest(knownEntries) === remoteDigest) {
            this.digest = remoteDigest;
            this.allowEmptySnapshotWrite =
                listing.entries.length === 0 && knownEntries.length === 0 && this.client.custom_commands.length === 0;
            if (this.allowEmptySnapshotWrite) this.emptyListingConfirmations = 0;
        }
    }

    /**
     * Persist the CURRENT in-memory corpus to the snapshot — used by
     * single-file save paths (editor/proposal approve) after
     * applyCommit/applyDelete so a restart before the next poll doesn't
     * regress to the pre-change snapshot.
     */
    saveSnapshot(): void {
        this.saveCache(this.client.custom_commands);
    }

    /**
     * Load the full corpus. GitHub → snapshot → empty:
     * - a transport failure on the listing or ANY single file fails the whole
     *   GitHub load (a partial corpus would silently deregister live commands);
     * - a file that fetches but fails validation is skipped (logged);
     * - a non-empty directory yielding zero valid commands falls back
     *   ("bad remote never wipes").
     */
    async loadAll(): Promise<Commands> {
        const files = this.filesClient();
        if (!files) {
            console.warn(
                "GitHub commands repo not configured (owner/repo/GITHUB_PAT). Booting from the local snapshot.",
            );
            return this.snapshotFallback("GitHub not configured");
        }

        const listing = await files.listCommandDir();
        if ("error" in listing) {
            this.emptyListingConfirmations = 0;
            // Preserve the old loader's operator-actionable specificity: an
            // expired PAT or a wrong repo is a critical page, not a shrug.
            if (listing.status === 401) {
                await this.client.logError(
                    "GitHub Authentication Failed",
                    "GitHub returned 401 Unauthorized — the GITHUB_PAT may be expired or invalid. Falling back to the local snapshot.",
                    true,
                );
            } else if (listing.status === 404) {
                await this.client.logError(
                    "GitHub Repository Not Found",
                    `GitHub returned 404 — check githubRepoOwner/githubRepoName/githubCommandsDir. ${listing.error}. Falling back to the local snapshot.`,
                    true,
                );
            } else {
                await this.client.logError(
                    "GitHub Commands Load Failed",
                    `Could not list the commands directory (${listing.error}). Falling back to the local snapshot.`,
                    false,
                );
            }
            return this.snapshotFallback("directory listing failed");
        }
        const entries = listing.entries;
        if (entries.length === 0) {
            const cached = this.loadCache();
            if (!this.shouldAdoptEmptyGithubListing(cached)) {
                await this.client.logError(
                    "GitHub Commands Empty Listing Deferred",
                    "GitHub listed zero command JSON files while the bot still has a non-empty live/snapshot corpus. Preserving the existing commands until a second consecutive empty listing confirms the full delete.",
                    false,
                );
                return this.preserveExistingCommandsFallback("empty GitHub listing awaiting confirmation", cached);
            }
            // The listing SUCCEEDED and was corroborated as an authoritative empty
            // corpus (or there is no non-empty live/snapshot corpus to preserve).
            // Load it as empty so a delete of the last command converges; otherwise
            // the poller resurrects the snapshot every tick and never adopts the
            // empty digest. A listing FAILURE returns an error above and still falls
            // back to the snapshot.
            this.emptyListingConfirmations = 0;
            this.digest = computeDirectoryDigest([]);
            this.fileShas = new Map();
            this.filePaths = new Map();
            this.rawBodies = new Map();
            this._lastLoadSource = "github";
            this.allowEmptySnapshotWrite = true;
            this.client.custom_commands = [];
            this.saveCache([]);
            console.log("Loaded 0 commands from GitHub (commands directory is empty).");
            return [];
        }

        const results = await mapWithConcurrency(entries, LOAD_CONCURRENCY, entry =>
            files.fetchCommandFile(entry.path),
        );
        this.emptyListingConfirmations = 0;

        const commands: Commands = [];
        const shas = new Map<string, string>();
        const paths = new Map<string, string>();
        const raws = new Map<string, Record<string, unknown>>();
        const invalidPaths: string[] = [];

        for (let i = 0; i < results.length; i++) {
            const result = results[i]!;
            if (result === "not_found" || result === "error") {
                // Transport/consistency failure: fail the WHOLE load to cache
                // (a partial corpus would silently deregister live commands).
                await this.client.logError(
                    "GitHub Commands Load Failed",
                    `Command file '${entries[i]!.path}' could not be fetched. Falling back to the local snapshot.`,
                    false,
                );
                return this.snapshotFallback("command file fetch failed");
            }
            // "invalid" (bad JSON / name-filename mismatch) and schema-invalid
            // files are authoring errors: skip just that file.
            if (result === "invalid") {
                invalidPaths.push(entries[i]!.path);
                continue;
            }
            const raw = result.raw;
            const command = jsonClone(raw) as unknown as CustomCommand;
            if (!validateCustomCommand(command)) {
                invalidPaths.push(result.path);
                continue;
            }
            // A custom command sharing a built-in chat command's name produces a
            // duplicate (type:1, name) entry in the registration payload, and
            // Discord 400s the ENTIRE guild command set — taking down every slash
            // command, including the ones needed to remove the offender. The
            // in-app create/proposal paths already block this; a direct repo
            // commit bypasses them, so skip it here as the final safety net.
            if (this.client.isBuiltinCommandName?.(command.name)) {
                console.error(
                    `Command file '${result.path}' collides with built-in command '${command.name}'; skipping.`,
                );
                invalidPaths.push(result.path);
                continue;
            }
            commands.push(command);
            shas.set(command.name, result.sha);
            paths.set(command.name, result.path);
            raws.set(command.name, raw);
        }

        if (invalidPaths.length > 0) {
            console.warn(`Filtered out ${invalidPaths.length} invalid command file(s): ${invalidPaths.join(", ")}`);
            await this.client.logError(
                "Invalid Command Files",
                `${invalidPaths.length} command file(s) failed validation and were skipped: ${invalidPaths.slice(0, 10).join(", ")}${invalidPaths.length > 10 ? ", …" : ""}. Check the commands repo CI.`,
                false,
            );
        }
        if (commands.length === 0) {
            await this.client.logError(
                "All Remote Commands Invalid",
                "Every command file failed validation. Falling back to the local snapshot.",
                true,
            );
            return this.snapshotFallback("all remote commands invalid");
        }

        this.digest = computeDirectoryDigest(entries);
        this.fileShas = shas;
        this.filePaths = paths;
        this.rawBodies = raws;

        this._lastLoadSource = "github";
        this.allowEmptySnapshotWrite = false;
        this.client.custom_commands = commands;
        this.saveCache(commands);
        console.log(`Loaded ${commands.length} commands from GitHub directory (digest ${this.digest.slice(0, 12)}…)`);
        return commands;
    }

    // ---------------------------------------------------------------- fallback

    /**
     * Boot from the last-good snapshot, or an empty corpus when no usable
     * snapshot exists. A v2 snapshot restores the digest and per-file SHAs so
     * conflict-checked saves keep working across a GitHub outage; without one
     * the sha state stays cleared and GitHub save paths refuse blind writes.
     */
    private snapshotFallback(reason: string, alreadyLoadedCache?: LoadedCache | null): Commands {
        const cached = alreadyLoadedCache === undefined ? this.loadCache() : alreadyLoadedCache;
        if (cached && cached.commands.length > 0) {
            console.log(`Using snapshot as fallback (${reason})`);
            this.fileShas.clear();
            this.filePaths.clear();
            this.rawBodies.clear();
            this.allowEmptySnapshotWrite = false;
            this._lastLoadSource = "cache";
            this.digest = cached.digest;
            for (const [name, info] of Object.entries(cached.files ?? {})) {
                this.fileShas.set(name, info.sha);
                this.filePaths.set(name, info.path);
            }
            // Snapshot commands were written normalized, so they double as the
            // raw bodies until the next successful GitHub load.
            for (const command of cached.commands) {
                this.rawBodies.set(command.name, command as unknown as Record<string, unknown>);
            }
            this.client.custom_commands = cached.commands;
            return cached.commands;
        }

        if (this.client.custom_commands.length > 0) {
            console.warn(
                `[CustomCommands] No usable snapshot (${reason}) — preserving the current in-memory command corpus.`,
            );
            this._lastLoadSource = "memory";
            this.allowEmptySnapshotWrite = false;
            return this.client.custom_commands;
        }

        this.digest = undefined;
        this.fileShas.clear();
        this.filePaths.clear();
        this.rawBodies.clear();
        this.allowEmptySnapshotWrite = false;
        console.warn(`[CustomCommands] No usable snapshot (${reason}) — starting with an empty command corpus.`);
        this._lastLoadSource = "none";
        this.client.custom_commands = [];
        return [];
    }

    private shouldAdoptEmptyGithubListing(cached: LoadedCache | null): boolean {
        if (this.allowEmptySnapshotWrite) return true;
        if (this.client.custom_commands.length === 0 && (!cached || cached.commands.length === 0)) return true;

        this.emptyListingConfirmations += 1;
        if (this.emptyListingConfirmations >= EMPTY_LISTING_CONFIRMATIONS_REQUIRED) {
            console.warn(
                `[CustomCommands] Adopting empty GitHub corpus after ${this.emptyListingConfirmations} consecutive empty listings.`,
            );
            return true;
        }
        return false;
    }

    private preserveExistingCommandsFallback(reason: string, cached: LoadedCache | null): Commands {
        return this.snapshotFallback(reason, cached);
    }

    // ------------------------------------------------------------ persistence

    private saveCache(commands: Commands): void {
        if (commands.length === 0 && this._lastLoadSource !== "github" && !this.allowEmptySnapshotWrite) {
            // Never wipe the recovery snapshot with an empty corpus while we're
            // running from a fallback (GitHub unreachable) — a transient empty
            // state must not destroy the last-good snapshot. An authoritative
            // empty from GitHub (every command legitimately deleted, or a delete
            // that just committed and was verified by refreshDigest) IS
            // persisted so the delete converges.
            console.warn("Refusing to overwrite the snapshot with an empty corpus (not sourced from GitHub).");
            return;
        }
        try {
            const cacheData: CacheFileV2 = {
                version: 2,
                timestamp: new Date().toISOString(),
                commands,
            };
            if (this.digest !== undefined) cacheData.digest = this.digest;
            const files: Record<string, { path: string; sha: string }> = {};
            for (const [name, sha] of this.fileShas) {
                const path = this.filePaths.get(name);
                if (path) files[name] = { path, sha };
            }
            cacheData.files = files;
            // The snapshot is the only local artifact — write atomically so a
            // crash mid-write can't corrupt it.
            const tmpPath = `${this.cachePath}.tmp`;
            writeFileSync(tmpPath, JSON.stringify(cacheData, null, 2));
            renameSync(tmpPath, this.cachePath);
            console.log(`Saved ${commands.length} commands to snapshot`);
        } catch (error) {
            console.error("Failed to save commands to snapshot:", error);
        }
    }

    private loadCache(): LoadedCache | null {
        try {
            if (!existsSync(this.cachePath)) return null;
            const data = JSON.parse(readFileSync(this.cachePath, "utf-8"));
            if (!data || data.version !== 2 || !Array.isArray(data.commands)) {
                console.error("Invalid snapshot format");
                return null;
            }
            const commands = (data.commands as unknown[])
                .map(entry => ({ ...(entry as object) }) as CustomCommand)
                .filter(entry => validateCustomCommand(entry));
            console.log(`Loaded ${commands.length} commands from snapshot (saved ${data.timestamp})`);
            return {
                commands,
                digest: typeof data.digest === "string" ? data.digest : undefined,
                files: data.files && typeof data.files === "object" ? data.files : undefined,
            };
        } catch (error) {
            console.error("Failed to load commands from snapshot:", error);
            return null;
        }
    }
}
