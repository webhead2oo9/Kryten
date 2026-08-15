import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clampCommitMessage, sanitizeCommitAuthor } from "../src/github/commandFiles";
import { deleteFile, getContents, githubContentsUrl, putFile, RepoRef } from "../src/github/contentsApi";

const REF: RepoRef = { owner: "webhead", repo: "Commands", branch: "main" };
const PAT = "test-pat-abc123";

let savedPat: string | undefined;

beforeEach(() => {
    savedPat = process.env["GITHUB_PAT"];
    process.env["GITHUB_PAT"] = PAT;
    // putFile/deleteFile log to console.error on a precondition failure — keep the suite quiet.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    if (savedPat === undefined) delete process.env["GITHUB_PAT"];
    else process.env["GITHUB_PAT"] = savedPat;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

function stubFetch(handler: (...args: any[]) => any): any {
    const fetchMock = vi.fn(handler);
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
}

function timeoutError(): Error {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    return error;
}

describe("githubContentsUrl", () => {
    it("percent-encodes owner, repo, branch, and each path segment while slashes survive", () => {
        const url = githubContentsUrl(
            { owner: "web head", repo: "re#po", branch: "ma?in" },
            "commands/na me.json",
            true,
        );
        expect(url).toBe("https://api.github.com/repos/web%20head/re%23po/contents/commands/na%20me.json?ref=ma%3Fin");
    });

    it("omits the ?ref= query when includeRef is false", () => {
        expect(githubContentsUrl(REF, "commands/wifi.json", false)).toBe(
            "https://api.github.com/repos/webhead/Commands/contents/commands/wifi.json",
        );
    });

    it("appends ?ref= with the encoded branch when includeRef is true", () => {
        expect(githubContentsUrl(REF, "commands/wifi.json", true)).toBe(
            "https://api.github.com/repos/webhead/Commands/contents/commands/wifi.json?ref=main",
        );
    });

    it("drops empty path segments from leading and duplicate slashes", () => {
        expect(githubContentsUrl(REF, "/commands//wifi.json", false)).toBe(
            "https://api.github.com/repos/webhead/Commands/contents/commands/wifi.json",
        );
    });
});

describe("getContents", () => {
    it("maps 404 to not_found", async () => {
        stubFetch(async () => new Response("nope", { status: 404 }));
        expect(await getContents(REF, "commands/x.json")).toEqual({ kind: "not_found" });
    });

    it("maps a 500 to an error carrying the status and a body truncated to 300 chars", async () => {
        const body = "x".repeat(400);
        stubFetch(async () => new Response(body, { status: 500, statusText: "Server Error" }));
        expect(await getContents(REF, "commands/x.json")).toEqual({
            kind: "error",
            status: 500,
            message: `500 Server Error ${"x".repeat(300)}`,
        });
    });

    it("returns a dir result with normalized entries for a JSON array, filtering non-objects", async () => {
        const payload = [
            { type: "file", name: "a.json", path: "commands/a.json", sha: "sha-a" },
            { type: "dir", name: "sub", path: "commands/sub", sha: "sha-sub" },
            null,
            "junk",
            { name: "b.json" },
        ];
        stubFetch(async () => new Response(JSON.stringify(payload), { status: 200 }));
        expect(await getContents(REF, "commands")).toEqual({
            kind: "dir",
            entries: [
                { type: "file", name: "a.json", path: "commands/a.json", sha: "sha-a" },
                { type: "dir", name: "sub", path: "commands/sub", sha: "sha-sub" },
                { type: "", name: "b.json", path: "", sha: "" },
            ],
        });
    });

    it("decodes valid base64 file content", async () => {
        const content = Buffer.from("hello world", "utf-8").toString("base64");
        stubFetch(async () => new Response(JSON.stringify({ content, sha: "abc" }), { status: 200 }));
        expect(await getContents(REF, "commands/wifi.json")).toEqual({
            kind: "file",
            content: "hello world",
            sha: "abc",
        });
    });

    it("errors when the file response carries a non-string content field", async () => {
        stubFetch(async () => new Response(JSON.stringify({ content: 123, sha: "abc" }), { status: 200 }));
        expect(await getContents(REF, "commands/wifi.json")).toEqual({
            kind: "error",
            message: "GitHub response missing content/sha fields",
        });
    });

    it("errors when the file response carries a non-string sha field", async () => {
        stubFetch(async () => new Response(JSON.stringify({ content: "aGk=", sha: 5 }), { status: 200 }));
        expect(await getContents(REF, "commands/wifi.json")).toEqual({
            kind: "error",
            message: "GitHub response missing content/sha fields",
        });
    });

    it("returns an error, not a throw, when the success body is not valid JSON", async () => {
        stubFetch(async () => new Response("{ not json", { status: 200 }));
        const result = await getContents(REF, "commands/wifi.json");
        expect(result.kind).toBe("error");
        expect((result as any).message).not.toBe("GitHub request timed out");
        expect(typeof (result as any).message).toBe("string");
    });

    it("does not throw on non-base64 content — Node decodes it leniently", async () => {
        stubFetch(
            async () => new Response(JSON.stringify({ content: "!!!!not base64!!!!", sha: "abc" }), { status: 200 }),
        );
        expect((await getContents(REF, "commands/wifi.json")).kind).toBe("file");
    });

    it("maps a fetch TimeoutError to the distinct timed-out error message", async () => {
        stubFetch(async () => {
            throw timeoutError();
        });
        expect(await getContents(REF, "commands/wifi.json")).toEqual({
            kind: "error",
            message: "GitHub request timed out",
        });
    });

    it("maps a non-timeout fetch rejection to an error carrying its message", async () => {
        stubFetch(async () => {
            throw new Error("ECONNRESET");
        });
        expect(await getContents(REF, "commands/wifi.json")).toEqual({ kind: "error", message: "ECONNRESET" });
    });

    it("sends the PAT as a Bearer token and requests the ref-scoped URL", async () => {
        const fetchMock = stubFetch(async () => new Response("", { status: 404 }));
        await getContents(REF, "commands/wifi.json");
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.github.com/repos/webhead/Commands/contents/commands/wifi.json?ref=main");
        expect(options.headers.Authorization).toBe(`Bearer ${PAT}`);
        expect(options.headers.Accept).toBe("application/vnd.github+json");
    });
});

describe("putFile", () => {
    it("returns ok with the extracted newSha on 200", async () => {
        stubFetch(async () => new Response(JSON.stringify({ content: { sha: "new-200" } }), { status: 200 }));
        expect(await putFile(REF, "commands/wifi.json", "body", "msg", "old")).toEqual({
            status: "ok",
            newSha: "new-200",
        });
    });

    it("returns ok with the extracted newSha on 201", async () => {
        stubFetch(async () => new Response(JSON.stringify({ content: { sha: "new-201" } }), { status: 201 }));
        expect(await putFile(REF, "commands/wifi.json", "body", "msg")).toEqual({ status: "ok", newSha: "new-201" });
    });

    it("returns ok without newSha when the 200 response omits content.sha", async () => {
        stubFetch(async () => new Response(JSON.stringify({}), { status: 200 }));
        expect(await putFile(REF, "commands/wifi.json", "body", "msg", "old")).toEqual({ status: "ok" });
    });

    it("returns ok without newSha when the 200 response body is not JSON", async () => {
        stubFetch(async () => new Response("not json", { status: 200 }));
        expect(await putFile(REF, "commands/wifi.json", "body", "msg", "old")).toEqual({ status: "ok" });
    });

    it("maps 409 to sha_conflict", async () => {
        stubFetch(async () => new Response("conflict", { status: 409 }));
        expect(await putFile(REF, "commands/wifi.json", "body", "msg", "old")).toEqual({ status: "sha_conflict" });
    });

    it("maps a 422 with a sha-shaped body to sha_conflict", async () => {
        stubFetch(async () => new Response('{"message":"sha does not match"}', { status: 422 }));
        expect(await putFile(REF, "commands/wifi.json", "body", "msg")).toEqual({ status: "sha_conflict" });
    });

    it("maps a 422 branch-protection body to error, not sha_conflict (the reload-forever guard)", async () => {
        stubFetch(async () => new Response("protected branch update failed for refs/heads/main", { status: 422 }));
        const result = await putFile(REF, "commands/wifi.json", "body", "msg", "old");
        expect(result.status).toBe("error");
        expect((result as any).message).toContain("422");
    });

    it("maps a TimeoutError to timeout because the write may have landed", async () => {
        stubFetch(async () => {
            throw timeoutError();
        });
        expect(await putFile(REF, "commands/wifi.json", "body", "msg", "old")).toEqual({ status: "timeout" });
    });

    it("maps a non-timeout rejection to error", async () => {
        stubFetch(async () => {
            throw new Error("network down");
        });
        expect(await putFile(REF, "commands/wifi.json", "body", "msg", "old")).toEqual({
            status: "error",
            message: "network down",
        });
    });

    it("includes the sha in the payload when provided and base64-encodes the content", async () => {
        const fetchMock = stubFetch(
            async () => new Response(JSON.stringify({ content: { sha: "s" } }), { status: 200 }),
        );
        await putFile(REF, "commands/wifi.json", "file content", "commit msg", "old-sha");
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.github.com/repos/webhead/Commands/contents/commands/wifi.json");
        expect(options.method).toBe("PUT");
        expect(options.headers.Authorization).toBe(`Bearer ${PAT}`);
        const sent = JSON.parse(options.body);
        expect(sent.sha).toBe("old-sha");
        expect(sent.message).toBe("commit msg");
        expect(sent.branch).toBe("main");
        expect(sent.content).toBe(Buffer.from("file content", "utf8").toString("base64"));
    });

    it("omits sha from the payload for create-new semantics", async () => {
        const fetchMock = stubFetch(
            async () => new Response(JSON.stringify({ content: { sha: "s" } }), { status: 201 }),
        );
        await putFile(REF, "commands/wifi.json", "body", "msg");
        const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect("sha" in sent).toBe(false);
    });
});

describe("deleteFile", () => {
    it("maps 200 to ok", async () => {
        stubFetch(async () => new Response("", { status: 200 }));
        expect(await deleteFile(REF, "commands/wifi.json", "msg", "sha")).toEqual({ status: "ok" });
    });

    it("maps 404 to ok (idempotent out-of-band delete)", async () => {
        stubFetch(async () => new Response("not found", { status: 404 }));
        expect(await deleteFile(REF, "commands/wifi.json", "msg", "sha")).toEqual({ status: "ok" });
    });

    it("maps 409 to sha_conflict", async () => {
        stubFetch(async () => new Response("conflict", { status: 409 }));
        expect(await deleteFile(REF, "commands/wifi.json", "msg", "sha")).toEqual({ status: "sha_conflict" });
    });

    it("maps a 422 with a sha-shaped body to sha_conflict", async () => {
        stubFetch(async () => new Response('{"message":"sha does not match"}', { status: 422 }));
        expect(await deleteFile(REF, "commands/wifi.json", "msg", "sha")).toEqual({ status: "sha_conflict" });
    });

    it("maps a 422 without a sha-shaped body to error", async () => {
        stubFetch(async () => new Response("some other 422 failure", { status: 422 }));
        expect((await deleteFile(REF, "commands/wifi.json", "msg", "sha")).status).toBe("error");
    });

    it("maps a TimeoutError to timeout", async () => {
        stubFetch(async () => {
            throw timeoutError();
        });
        expect(await deleteFile(REF, "commands/wifi.json", "msg", "sha")).toEqual({ status: "timeout" });
    });

    it("sends a DELETE with the PAT, sha, message, and branch in the body", async () => {
        const fetchMock = stubFetch(async () => new Response("", { status: 200 }));
        await deleteFile(REF, "commands/wifi.json", "delete msg", "the-sha");
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.github.com/repos/webhead/Commands/contents/commands/wifi.json");
        expect(options.method).toBe("DELETE");
        expect(options.headers.Authorization).toBe(`Bearer ${PAT}`);
        expect(JSON.parse(options.body)).toEqual({ message: "delete msg", sha: "the-sha", branch: "main" });
    });
});

describe("sanitizeCommitAuthor", () => {
    const cases: [string, string, string][] = [
        ["strips CRLF newline injection", "line1\r\nline2", "line1 line2"],
        ["strips bare newlines", "a\nb", "a b"],
        ["strips control characters", "a bc", "abc"],
        ["collapses runs of whitespace", "a    b\t c", "a b c"],
        ["removes disallowed symbols but keeps letters, digits, and ._-", "user@name#1!.2_3-4", "username1.2_3-4"],
        ["keeps unicode letters", "café_Ω", "café_Ω"],
        ["caps output at 40 characters", "a".repeat(45), "a".repeat(40)],
        ["falls back to unknown on empty input", "", "unknown"],
        ["falls back to unknown on only-junk input", "@#$%^&*", "unknown"],
        ["falls back to unknown on whitespace-only input", "   \t  ", "unknown"],
    ];
    it.each(cases)("%s", (_label, input, expected) => {
        expect(sanitizeCommitAuthor(input)).toBe(expected);
    });
});

describe("clampCommitMessage", () => {
    it("leaves a message of 80 characters or fewer unchanged", () => {
        const eighty = "x".repeat(80);
        expect(clampCommitMessage(eighty)).toBe(eighty);
        expect(clampCommitMessage("short")).toBe("short");
    });

    it("truncates a message longer than 80 characters to 77 chars plus an ellipsis", () => {
        const clamped = clampCommitMessage("y".repeat(81));
        expect(clamped).toBe(`${"y".repeat(77)}...`);
        expect(clamped).toHaveLength(80);
    });
});
