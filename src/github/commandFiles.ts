/**
 * Per-command-repo semantics on top of the raw Contents API: one JSON file
 * per command under a directory (default "commands/"), filename == command
 * name, per-file blob SHAs for optimistic concurrency, and a directory
 * digest used by the poller for cheap change detection.
 */
import { createHash } from "crypto";
import { Config } from "../types";
import { NAME_PATTERN, normalizeName } from "../utils/format";
import { DirEntry, RepoRef, WriteResult, deleteFile, getContents, putFile } from "./contentsApi";

/**
 * Stable digest over the command directory listing (path + blob sha pairs).
 * MUST stay bit-identical everywhere it's computed (full load, poller tick,
 * post-commit refresh) or the poller reloads forever / never: sha256 over
 * entries sorted by path, feeding "path\0sha\n" per entry.
 */
export function computeDirectoryDigest(entries: { path: string; sha: string }[]): string {
    const hasher = createHash("sha256");
    for (const entry of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        hasher.update(entry.path, "utf8");
        hasher.update("\0");
        hasher.update(entry.sha, "utf8");
        hasher.update("\n");
    }
    return hasher.digest("hex");
}

export interface CommandFile {
    raw: Record<string, unknown>;
    sha: string;
    path: string;
}

/**
 * "invalid" = the file fetched fine but its content is unusable (bad JSON,
 * non-object root, filename/name mismatch) — skip just that file.
 * "error" = transport/consistency failure — callers must treat the whole
 * corpus as unknown.
 */
export type CommandFileResult = CommandFile | "not_found" | "invalid" | "error";

export type ListResult = { entries: DirEntry[] } | { error: string; status?: number };

export class CommandFilesClient {
    constructor(
        private readonly ref: RepoRef,
        private readonly dir: string,
    ) {}

    /** null when the repo/PAT configuration is incomplete. */
    static fromConfig(config: Config): CommandFilesClient | null {
        const owner = config.githubRepoOwner;
        const repo = config.githubRepoName;
        if (!owner || !repo || !process.env["GITHUB_PAT"]) return null;
        return new CommandFilesClient(
            { owner, repo, branch: config.githubBranch ?? "main" },
            (config.githubCommandsDir ?? "commands").replace(/^\/+|\/+$/g, ""),
        );
    }

    /** GitHub path for one command's file; throws on invalid names. */
    commandPath(commandName: unknown): string {
        const name = normalizeName(commandName);
        if (!NAME_PATTERN.test(name)) {
            throw new Error("command name must be 1-32 chars of lowercase letters, digits, hyphens, or underscores");
        }
        return this.dir ? `${this.dir}/${name}.json` : `${name}.json`;
    }

    /** Sorted .json file entries of the command directory, or the failure (with HTTP status when known). */
    async listCommandDir(): Promise<ListResult> {
        const result = await getContents(this.ref, this.dir);
        if (result.kind === "not_found") {
            // Git doesn't track empty directories, so deleting the LAST command
            // file makes the commands dir vanish and this GET 404s — on its face
            // indistinguishable from a wrong owner/repo/branch. Probe the parent
            // (the repo root for a top-level dir): if it resolves, the repo is
            // healthy and the corpus is simply empty, so report an empty listing
            // (letting the last delete converge) instead of a misleading "repo
            // not found" that pins the old corpus and pages operators.
            const parent = this.dir.includes("/") ? this.dir.slice(0, this.dir.lastIndexOf("/")) : "";
            const probe = await getContents(this.ref, parent);
            if (probe.kind === "dir") {
                return { entries: [] };
            }
            return {
                error: `commands directory not found: ${this.ref.owner}/${this.ref.repo}/${this.dir}`,
                status: 404,
            };
        }
        if (result.kind === "error") {
            const failure: ListResult = { error: `directory listing failed: ${result.message}` };
            if (result.status !== undefined) failure.status = result.status;
            return failure;
        }
        if (result.kind !== "dir") {
            return { error: `commands path is not a directory: ${this.dir}` };
        }
        if (result.entries.length >= 1000) {
            // The Contents API silently truncates directory listings at 1000
            // entries (no pagination) — past that, loadAll and the poller's
            // digest would both silently drop the overflow.
            console.warn(
                `[CustomCommands] GitHub listed ${result.entries.length} entries — the Contents API truncates at 1000, so the corpus may be incomplete. Migrate to the Trees API before growing further.`,
            );
        }
        return {
            entries: result.entries
                .filter(entry => entry.type === "file" && entry.name.endsWith(".json"))
                .sort((a, b) => a.name.localeCompare(b.name)),
        };
    }

    /**
     * Fetch + parse one command file. Enforces the repo invariant that the
     * filename equals the command's normalized name — a mismatched file is an
     * authoring error, not a loadable command.
     */
    async fetchCommandFile(path: string): Promise<CommandFileResult> {
        const result = await getContents(this.ref, path);
        if (result.kind === "not_found") return "not_found";
        if (result.kind !== "file") {
            console.error(
                `GitHub command file fetch failed for ${path}: ${result.kind === "error" ? result.message : result.kind}`,
            );
            return "error";
        }

        let raw: unknown;
        try {
            raw = JSON.parse(result.content);
        } catch (error) {
            console.error(`Invalid JSON in command file ${path}:`, error);
            return "invalid";
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            console.error(`Command file ${path} root is not an object`);
            return "invalid";
        }

        const expectedName = path
            .split("/")
            .pop()!
            .replace(/\.json$/, "");
        const actualName = normalizeName((raw as Record<string, unknown>)["name"]);
        if (expectedName !== actualName) {
            console.error(`Command file ${path} has name '${actualName}'; expected '${expectedName}'`);
            return "invalid";
        }

        return { raw: raw as Record<string, unknown>, sha: result.sha, path };
    }

    async loadCommand(commandName: unknown): Promise<CommandFileResult> {
        return this.fetchCommandFile(this.commandPath(commandName));
    }

    /** Create (sha omitted) or replace (sha required) one command file. */
    async commitCommand(
        commandName: unknown,
        body: Record<string, unknown>,
        message: string,
        sha?: string,
    ): Promise<WriteResult> {
        const content = JSON.stringify(body, null, 2) + "\n";
        return putFile(this.ref, this.commandPath(commandName), content, message, sha);
    }

    async deleteCommand(commandName: unknown, message: string, sha: string): Promise<WriteResult> {
        return deleteFile(this.ref, this.commandPath(commandName), message, sha);
    }

    /** Current directory digest from a listing only — no file contents downloaded. */
    async fetchRemoteDigest(): Promise<string | null> {
        const listing = await this.listCommandDir();
        if ("error" in listing) {
            console.error(`GitHub command ${listing.error}`);
            return null;
        }
        return computeDirectoryDigest(listing.entries);
    }
}
