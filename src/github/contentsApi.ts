/**
 * Thin, typed GitHub Contents API client (extracted from client.ts when the
 * bot moved from one aggregate commands.json to one file per command).
 * Discord-free; all higher-level semantics live in commandFiles.ts.
 */

/** Abort GitHub requests that stall, so callers fall through to cache/local. */
const GITHUB_FETCH_TIMEOUT_MS = 15_000;

export interface RepoRef {
    owner: string;
    repo: string;
    branch: string;
}

export interface DirEntry {
    type: string;
    name: string;
    path: string;
    sha: string;
}

export type GetContentsResult =
    | { kind: "file"; content: string; sha: string }
    | { kind: "dir"; entries: DirEntry[] }
    | { kind: "not_found" }
    | { kind: "error"; status?: number; message: string };

export type WriteResult =
    | { status: "ok"; newSha?: string }
    /** The precondition SHA no longer matches (or a create hit an existing file). */
    | { status: "sha_conflict" }
    /** The request timed out — the write MAY have landed on GitHub. */
    | { status: "timeout" }
    | { status: "error"; message: string };

function pat(): string | undefined {
    return process.env["GITHUB_PAT"];
}

function headers(): Record<string, string> {
    return {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${pat()}`,
        "Content-Type": "application/json",
    };
}

/** Build the Contents API URL with each path segment percent-encoded. */
export function githubContentsUrl(ref: RepoRef, path: string, includeRef: boolean): string {
    const encodedPath = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const base = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/contents/${encodedPath}`;
    return includeRef ? `${base}?ref=${encodeURIComponent(ref.branch)}` : base;
}

export async function getContents(ref: RepoRef, path: string): Promise<GetContentsResult> {
    try {
        const response = await fetch(githubContentsUrl(ref, path, true), {
            headers: headers(),
            signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
        });
        if (response.status === 404) return { kind: "not_found" };
        if (!response.ok) {
            const body = await response.text().catch(() => "");
            return {
                kind: "error",
                status: response.status,
                message: `${response.status} ${response.statusText} ${body.slice(0, 300)}`,
            };
        }
        const data = await response.json();
        if (Array.isArray(data)) {
            const entries: DirEntry[] = data
                .filter(item => item && typeof item === "object")
                .map(item => ({
                    type: String(item.type ?? ""),
                    name: String(item.name ?? ""),
                    path: String(item.path ?? ""),
                    sha: String(item.sha ?? ""),
                }));
            return { kind: "dir", entries };
        }
        if (typeof data?.content !== "string" || typeof data?.sha !== "string") {
            return { kind: "error", message: "GitHub response missing content/sha fields" };
        }
        let content: string;
        try {
            content = Buffer.from(data.content, "base64").toString("utf-8");
        } catch (error) {
            return {
                kind: "error",
                message: `base64 decode failed: ${error instanceof Error ? error.message : String(error)}`,
            };
        }
        return { kind: "file", content, sha: data.sha };
    } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
            return { kind: "error", message: "GitHub request timed out" };
        }
        return { kind: "error", message: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Create or replace one file. Omit `sha` only when the file must not exist
 * yet — GitHub 422s ("sha wasn't supplied") if it does, which we surface as
 * sha_conflict so create-races are detected rather than overwritten.
 */
export async function putFile(
    ref: RepoRef,
    path: string,
    content: string,
    message: string,
    sha?: string,
): Promise<WriteResult> {
    const body: Record<string, unknown> = {
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        branch: ref.branch,
        committer: { name: "Commands Bot", email: "commands-bot@example.com" },
    };
    if (sha) body["sha"] = sha;

    try {
        const response = await fetch(githubContentsUrl(ref, path, false), {
            method: "PUT",
            headers: headers(),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
        });
        if (response.status === 200 || response.status === 201) {
            const data = await response.json().catch(() => null);
            const newSha = typeof data?.content?.sha === "string" ? data.content.sha : undefined;
            return newSha !== undefined ? { status: "ok", newSha } : { status: "ok" };
        }
        if (response.status === 409 || response.status === 422) {
            // 409: sha mismatch. 422: only a sha-shaped failure ("sha wasn't
            // supplied" on a create race / "does not match") is a precondition
            // conflict — other 422s (branch protection, invalid content) must
            // surface as errors or the user gets told to "reload" forever.
            const errBody = await response.text().catch(() => "");
            if (response.status === 409 || /sha/i.test(errBody)) {
                console.error(`GitHub putFile precondition failure ${response.status}: ${errBody.slice(0, 200)}`);
                return { status: "sha_conflict" };
            }
            return { status: "error", message: `422 ${errBody.slice(0, 300)}` };
        }
        const errBody = await response.text().catch(() => "");
        return { status: "error", message: `${response.status} ${response.statusText} ${errBody.slice(0, 300)}` };
    } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") return { status: "timeout" };
        return { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
}

export async function deleteFile(ref: RepoRef, path: string, message: string, sha: string): Promise<WriteResult> {
    try {
        const response = await fetch(githubContentsUrl(ref, path, false), {
            method: "DELETE",
            headers: headers(),
            body: JSON.stringify({ message, sha, branch: ref.branch }),
            signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
        });
        if (response.status === 200) return { status: "ok" };
        // The file is already gone — the intended end state (absent) is met, so
        // treat delete as idempotent rather than surfacing "sync failed: 404"
        // and telling the user to reload. Handles a file removed out-of-band
        // between the editor snapshot and the delete.
        if (response.status === 404) return { status: "ok" };
        const errBody = await response.text().catch(() => "");
        if (response.status === 409 || (response.status === 422 && /sha/i.test(errBody))) {
            return { status: "sha_conflict" };
        }
        return { status: "error", message: `${response.status} ${response.statusText} ${errBody.slice(0, 300)}` };
    } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") return { status: "timeout" };
        return { status: "error", message: error instanceof Error ? error.message : String(error) };
    }
}

/** Neutralize user-controlled text destined for a commit author label. */
export function sanitizeCommitAuthor(authorLabel: string): string {
    const fallback = "unknown";
    if (!authorLabel) return fallback;
    const cleaned = authorLabel
        .replace(/[\r\n]+/g, " ")
        .replace(/\s+/g, " ")
        .replace(/[^\p{L}\p{N}\s._-]/gu, "")
        .trim();
    return cleaned.length ? cleaned.slice(0, 40) : fallback;
}

export function clampCommitMessage(message: string): string {
    return message.length > 80 ? `${message.slice(0, 77)}...` : message;
}
