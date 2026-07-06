import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProposalService } from "../src/proposals/service";
import { ProposalStore } from "../src/proposals/store";
import { normalizeName } from "../src/utils/format";

let dir: string;
let store: ProposalStore;
let activeService: ProposalService | undefined;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kryten-proposal-service-"));
    store = new ProposalStore(join(dir, "proposals.db"));
    activeService = undefined;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    // service.stop() closes the store; if a test never built one, close it directly.
    if (activeService) activeService.stop();
    else store.close();
    activeService = undefined;
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

/** A minimal but schema-valid format-2 command body. */
function validBody(name: string, description = "Answer text goes here"): Record<string, unknown> {
    return {
        format: 2,
        name,
        description,
        blocks: [
            { type: "heading", text: name.toUpperCase() },
            { type: "text", text: description },
        ],
    };
}

/**
 * Fake CommandFilesClient. `load`/`commit`/`del` let a test script the GitHub
 * responses (including per-call sequences); every method is a vi.fn so call
 * counts and args can be asserted.
 */
function makeFiles(
    seq: { load?: (name: string) => unknown; commit?: () => unknown; del?: () => unknown } = {},
): any {
    return {
        loadCommand: vi.fn(async (name: string) => (seq.load ? seq.load(name) : "not_found")),
        commitCommand: vi.fn(async () => (seq.commit ? seq.commit() : { status: "ok", newSha: "sha-committed" })),
        deleteCommand: vi.fn(async () => (seq.del ? seq.del() : { status: "ok" })),
        commandPath: (name: string) => `commands/${name}.json`,
    };
}

/** Fake of the CommandSync slice the service actually touches. */
function makeCommandSync(opts: {
    filesClient: unknown;
    lastLoadSource?: string;
    rawBodies?: Record<string, unknown>;
}): any {
    const raw = opts.rawBodies ?? {};
    return {
        lastLoadSource: opts.lastLoadSource ?? "github",
        filesClient: () => opts.filesClient,
        getRawBody: (name: string) => raw[normalizeName(name)],
        getDigest: () => "digest-abc",
        applyCommit: vi.fn(),
        applyDelete: vi.fn(),
        refreshDigest: vi.fn(async () => undefined),
        saveSnapshot: vi.fn(),
    };
}

function setup(
    opts: {
        lastLoadSource?: string;
        filesClientNull?: boolean;
        filesSeq?: { load?: (name: string) => unknown; commit?: () => unknown; del?: () => unknown };
        rawBodies?: Record<string, unknown>;
        customCommands?: any[];
        config?: any;
        builtinNames?: string[];
        registerIfChanged?: any;
        reviewerResult?: unknown;
    } = {},
): { service: ProposalService; client: any; commandSync: any; reviewer: any; files: any } {
    const files = opts.filesClientNull ? null : makeFiles(opts.filesSeq ?? {});
    const commandSync = makeCommandSync({
        filesClient: files,
        lastLoadSource: opts.lastLoadSource,
        rawBodies: opts.rawBodies,
    });
    const reviewer = { postReviewCard: vi.fn(async () => opts.reviewerResult ?? { messageId: "msg-1" }) };
    const client: any = {
        commandSync,
        custom_commands: opts.customCommands ?? [],
        config: opts.config ?? {},
        commands: { loaded_classes: new Map((opts.builtinNames ?? []).map(n => [n, {}])) },
        registerIfChanged: opts.registerIfChanged ?? vi.fn(async () => false),
    };
    const service = new ProposalService(client, store, reviewer as any);
    activeService = service;
    return { service, client, commandSync, reviewer, files };
}

describe("ProposalService.submitProposal gates", () => {
    it("reports unavailable when the corpus never loaded (lastLoadSource 'none')", async () => {
        const { service } = setup({ lastLoadSource: "none" });
        const res = await service.submitProposal({ operation: "delete", commandName: "faq" });
        expect(res.status).toBe("unavailable");
        expect(res.message).toContain("empty");
    });

    it("reports unavailable when GitHub is not configured (no files client)", async () => {
        const { service } = setup({ filesClientNull: true });
        const res = await service.submitProposal({ operation: "delete", commandName: "faq" });
        expect(res.status).toBe("unavailable");
        expect(res.message).toContain("not configured");
    });

    it("refuses a patch when running from a fallback (lastLoadSource != github, retryable)", async () => {
        const { service } = setup({
            lastLoadSource: "cache",
            customCommands: [validBody("faq", "old desc")],
            rawBodies: { faq: validBody("faq", "old desc") },
        });
        const res = await service.submitProposal({
            operation: "patch",
            commandName: "faq",
            edits: [{ type: "set_property", property: "description", old: "old desc", new: "new desc" }],
        });
        expect(res.status).toBe("unavailable");
        expect(res.message).toContain("fallback");
    });

    it("rejects an unknown operation", async () => {
        const { service } = setup();
        const res = await service.submitProposal({ operation: "frobnicate", commandName: "faq" });
        expect(res.status).toBe("invalid");
    });

    it("rejects a command_name that violates the name pattern", async () => {
        const { service } = setup();
        const res = await service.submitProposal({ operation: "delete", commandName: "Not Valid!" });
        expect(res.status).toBe("invalid");
    });

    it("normalizes operation 'edit' into a staged patch proposal", async () => {
        const { service } = setup({
            customCommands: [validBody("faq", "old desc")],
            rawBodies: { faq: validBody("faq", "old desc") },
        });
        const res = await service.submitProposal({
            operation: "edit",
            commandName: "faq",
            edits: [{ type: "set_property", property: "description", old: "old desc", new: "new desc" }],
        });
        expect(res.status).toBe("staged");
        const row = store.get(res.proposalId!);
        expect(row?.operation).toBe("patch");
        expect(row?.proposedEdits).toBeTruthy();
        // The pre-applied preview body carries the edit result.
        expect((row?.proposedCommand as any)?.description).toBe("new desc");
    });

    it("rejects an 'edit' with no edits", async () => {
        const { service } = setup({ customCommands: [validBody("faq")] });
        const res = await service.submitProposal({ operation: "edit", commandName: "faq", edits: [] });
        expect(res.status).toBe("invalid");
        expect(res.message).toContain("non-empty");
    });

    it("rejects an 'edit' that also carries a full command body", async () => {
        const { service } = setup({ customCommands: [validBody("faq")] });
        const res = await service.submitProposal({
            operation: "edit",
            commandName: "faq",
            command: validBody("faq"),
            edits: [{ type: "set_property", property: "description", old: "x", new: "y" }],
        });
        expect(res.status).toBe("invalid");
        expect(res.message).toContain("Full-body");
    });

    it("rejects a create whose body name differs from command_name", async () => {
        const { service } = setup();
        const res = await service.submitProposal({
            operation: "create",
            commandName: "faq",
            command: validBody("other"),
        });
        expect(res.status).toBe("invalid");
        expect(res.message).toContain("does not match");
    });

    it("rejects a create for a command that already exists (conflict)", async () => {
        const { service } = setup({ customCommands: [validBody("faq")] });
        const res = await service.submitProposal({
            operation: "create",
            commandName: "faq",
            command: validBody("faq"),
        });
        expect(res.status).toBe("conflict");
        expect(res.message).toContain("already exists");
    });

    it("rejects a create colliding with a built-in command name", async () => {
        const { service } = setup({ builtinNames: ["faq"] });
        const res = await service.submitProposal({
            operation: "create",
            commandName: "faq",
            command: validBody("faq"),
        });
        expect(res.status).toBe("invalid");
        expect(res.message).toContain("collides with a built-in");
    });

    it("rejects a delete of a command that does not exist (conflict)", async () => {
        const { service } = setup();
        const res = await service.submitProposal({ operation: "delete", commandName: "faq" });
        expect(res.status).toBe("conflict");
        expect(res.message).toContain("does not exist");
    });

    it("stages a valid create and records the review message id", async () => {
        const { service, reviewer } = setup();
        const res = await service.submitProposal({
            operation: "create",
            commandName: "faq",
            command: validBody("faq"),
        });
        expect(res.status).toBe("staged");
        expect(reviewer.postReviewCard).toHaveBeenCalledTimes(1);
        expect(store.get(res.proposalId!)?.reviewMessageId).toBe("msg-1");
    });
});

describe("ProposalService.submitProposal prove-apply", () => {
    it("returns conflict when a patch old-guard no longer matches the live body", async () => {
        const { service } = setup({
            customCommands: [validBody("faq", "old desc")],
            rawBodies: { faq: validBody("faq", "old desc") },
        });
        const res = await service.submitProposal({
            operation: "edit",
            commandName: "faq",
            edits: [{ type: "set_property", property: "description", old: "WRONG", new: "new desc" }],
        });
        expect(res.status).toBe("conflict");
    });

    it("returns invalid for a structurally invalid patch edit", async () => {
        const { service } = setup({
            customCommands: [validBody("faq", "old desc")],
            rawBodies: { faq: validBody("faq", "old desc") },
        });
        const res = await service.submitProposal({
            operation: "edit",
            commandName: "faq",
            edits: [{ type: "set_property", property: "description", new: "no old guard" }],
        });
        expect(res.status).toBe("invalid");
    });
});

describe("ProposalService.submitProposal dedupe + rate limit", () => {
    it("dedupes an identical pending (operation, name)", async () => {
        const { service } = setup();
        const first = await service.submitProposal({
            operation: "create",
            commandName: "aaa",
            command: validBody("aaa"),
        });
        expect(first.status).toBe("staged");
        const second = await service.submitProposal({
            operation: "create",
            commandName: "aaa",
            command: validBody("aaa"),
        });
        expect(second.status).toBe("duplicate");
        expect(second.proposalId).toBe(first.proposalId);
    });

    it("rejects submissions past max_pending and reads the ceiling fresh from config", async () => {
        const config = { proposals: { max_pending: 1 } };
        const { service, client } = setup({ config });
        const first = await service.submitProposal({
            operation: "create",
            commandName: "aaa",
            command: validBody("aaa"),
        });
        expect(first.status).toBe("staged");
        const blocked = await service.submitProposal({
            operation: "create",
            commandName: "bbb",
            command: validBody("bbb"),
        });
        expect(blocked.status).toBe("too_many_pending");

        // /reload_config raised the limit — no rebuild, read fresh on the next call.
        client.config.proposals.max_pending = 5;
        const allowed = await service.submitProposal({
            operation: "create",
            commandName: "bbb",
            command: validBody("bbb"),
        });
        expect(allowed.status).toBe("staged");
    });
});

describe("ProposalService.approveProposal", () => {
    it("claims, commits, syncs the bot, and marks approved with the committed sha", async () => {
        const { service, client, commandSync } = setup();
        const rec = store.createProposal({
            operation: "create",
            commandName: "faq",
            proposedCommand: validBody("faq"),
        });

        const res = await service.approveProposal(rec.proposalId, "alice");

        expect(res.ok).toBe(true);
        expect(res.status).toBe("approved");
        expect(res.committedSha).toBe("sha-committed");
        expect(commandSync.applyCommit).toHaveBeenCalledWith(
            "faq",
            "sha-committed",
            expect.objectContaining({ name: "faq" }),
        );
        expect(commandSync.refreshDigest).toHaveBeenCalledTimes(1);
        expect(commandSync.saveSnapshot).toHaveBeenCalledTimes(1);
        expect(client.registerIfChanged).toHaveBeenCalledTimes(1);
        expect(client.custom_commands.some((c: any) => c.name === "faq")).toBe(true);

        const row = store.get(rec.proposalId);
        expect(row?.status).toBe("approved");
        expect(row?.committedSha).toBe("sha-committed");
        expect(row?.resolvedBy).toBe("alice");
    });

    it("approves a delete, applying the delete locally and dropping the command", async () => {
        const { service, client, commandSync, files } = setup({
            customCommands: [validBody("faq")],
            filesSeq: { load: () => ({ raw: validBody("faq"), sha: "livesha", path: "commands/faq.json" }) },
        });
        const rec = store.createProposal({ operation: "delete", commandName: "faq" });

        const res = await service.approveProposal(rec.proposalId, "alice");

        expect(res.status).toBe("approved");
        expect(commandSync.applyDelete).toHaveBeenCalledWith("faq");
        // deleteCommand carries the live blob sha as its precondition.
        expect(files.deleteCommand.mock.calls[0][2]).toBe("livesha");
        expect(client.custom_commands.some((c: any) => c.name === "faq")).toBe(false);
        expect(store.get(rec.proposalId)?.status).toBe("approved");
    });

    it("returns the actual terminal state on a lost double-approve race and commits only once", async () => {
        const { service, files } = setup();
        const rec = store.createProposal({
            operation: "create",
            commandName: "faq",
            proposedCommand: validBody("faq"),
        });

        const first = await service.approveProposal(rec.proposalId, "alice");
        expect(first.status).toBe("approved");

        const second = await service.approveProposal(rec.proposalId, "bob");
        expect(second.ok).toBe(false);
        expect(second.status).toBe("already_resolved");
        expect(second.resolved?.status).toBe("approved");
        expect(second.resolved?.resolvedBy).toBe("alice");
        expect(second.resolved?.committedSha).toBe("sha-committed");

        // The loser never re-committed and never clobbered the winner's record.
        expect(files.commitCommand.mock.calls.length).toBe(1);
        expect(store.get(rec.proposalId)?.resolvedBy).toBe("alice");
    });

    it("retries a commit exactly once on a GitHub sha race, then succeeds", async () => {
        let n = 0;
        const commit = () => {
            n += 1;
            return n === 1 ? { status: "sha_conflict" } : { status: "ok", newSha: "sha-ok" };
        };
        const { service, commandSync, files } = setup({ filesSeq: { load: () => "not_found", commit } });
        const rec = store.createProposal({
            operation: "create",
            commandName: "faq",
            proposedCommand: validBody("faq"),
        });

        const res = await service.approveProposal(rec.proposalId, "alice");

        expect(res.status).toBe("approved");
        expect(files.commitCommand.mock.calls.length).toBe(2);
        expect(files.loadCommand.mock.calls.length).toBe(2);
        expect(commandSync.applyCommit).toHaveBeenCalledWith("faq", "sha-ok", expect.anything());
    });

    it("fails terminally after a sha race twice (no third attempt)", async () => {
        const { service, commandSync, files } = setup({
            filesSeq: { load: () => "not_found", commit: () => ({ status: "sha_conflict" }) },
        });
        const rec = store.createProposal({
            operation: "create",
            commandName: "faq",
            proposedCommand: validBody("faq"),
        });

        const res = await service.approveProposal(rec.proposalId, "alice");

        expect(res.ok).toBe(false);
        expect(res.status).toBe("failed");
        expect(res.message).toContain("kept conflicting");
        expect(files.commitCommand.mock.calls.length).toBe(2);
        expect(commandSync.applyCommit).not.toHaveBeenCalled();
        expect(store.get(rec.proposalId)?.status).toBe("failed");
    });

    it("does NOT retry a non-sha commit error", async () => {
        const { service, files } = setup({
            filesSeq: { load: () => "not_found", commit: () => ({ status: "error", message: "boom" }) },
        });
        const rec = store.createProposal({
            operation: "create",
            commandName: "faq",
            proposedCommand: validBody("faq"),
        });

        const res = await service.approveProposal(rec.proposalId, "alice");

        expect(res.status).toBe("failed");
        expect(res.message).toContain("GitHub commit failed: boom");
        expect(files.commitCommand.mock.calls.length).toBe(1);
    });

    it("maps a timeout WriteResult to failed with 'may have landed' guidance (no retry)", async () => {
        const { service, files } = setup({
            filesSeq: { load: () => "not_found", commit: () => ({ status: "timeout" }) },
        });
        const rec = store.createProposal({
            operation: "create",
            commandName: "faq",
            proposedCommand: validBody("faq"),
        });

        const res = await service.approveProposal(rec.proposalId, "alice");

        expect(res.status).toBe("failed");
        expect(res.message).toContain("may have landed");
        expect(files.commitCommand.mock.calls.length).toBe(1);
    });

    it("surfaces a committed-but-sync-failed outcome carrying the committed sha", async () => {
        const registerIfChanged = vi.fn(async () => {
            throw new Error("discord down");
        });
        const { service, commandSync } = setup({ registerIfChanged });
        const rec = store.createProposal({
            operation: "create",
            commandName: "faq",
            proposedCommand: validBody("faq"),
        });

        const res = await service.approveProposal(rec.proposalId, "alice");

        expect(res.ok).toBe(false);
        expect(res.status).toBe("failed");
        expect(res.committedSha).toBe("sha-committed");
        expect(res.message).toContain("/reload_commands");
        // The commit had already landed — the in-memory apply ran before the throw.
        expect(commandSync.applyCommit).toHaveBeenCalledTimes(1);

        const row = store.get(rec.proposalId);
        expect(row?.status).toBe("failed");
        expect(row?.committedSha).toBe("sha-committed");
        expect(row?.resolutionNote).toContain("post-commit sync failed");
    });

    it("marks conflict (no retry) when the target no longer applies on GitHub", async () => {
        // A create whose file already exists on GitHub is a semantic conflict.
        const { service, files } = setup({
            filesSeq: { load: () => ({ raw: validBody("faq"), sha: "s", path: "commands/faq.json" }) },
        });
        const rec = store.createProposal({
            operation: "create",
            commandName: "faq",
            proposedCommand: validBody("faq"),
        });

        const res = await service.approveProposal(rec.proposalId, "alice");

        expect(res.status).toBe("conflict");
        expect(res.message).toContain("No longer applies");
        expect(files.commitCommand.mock.calls.length).toBe(0);
        expect(store.get(rec.proposalId)?.status).toBe("conflict");
    });

    it("returns already_resolved for an unknown / already-terminal id without touching GitHub", async () => {
        const { service, files } = setup();
        const res = await service.approveProposal("deadbeefdeadbeefdeadbeefdeadbeef", "alice");
        expect(res.status).toBe("already_resolved");
        expect(files.loadCommand.mock.calls.length).toBe(0);
    });
});

describe("ProposalService.rejectProposal", () => {
    it("rejects a pending proposal", () => {
        const { service } = setup();
        const rec = store.createProposal({ operation: "delete", commandName: "faq" });
        const res = service.rejectProposal(rec.proposalId, "alice");
        expect(res.ok).toBe(true);
        expect(res.status).toBe("rejected");
        expect(store.get(rec.proposalId)?.status).toBe("rejected");
    });

    it("cannot reject a proposal already claimed for approval (mid-applying)", () => {
        const { service } = setup();
        const rec = store.createProposal({ operation: "delete", commandName: "faq" });
        store.claimForResolution(rec.proposalId); // pending → applying
        const res = service.rejectProposal(rec.proposalId, "alice");
        expect(res.ok).toBe(false);
        expect(res.status).toBe("already_resolved");
        expect(res.resolved?.status).toBe("applying");
        expect(store.get(rec.proposalId)?.status).toBe("applying");
    });
});

describe("ProposalService crash recovery", () => {
    it("fails proposals stuck in 'applying' when a new service constructs", () => {
        const rec = store.createProposal({ operation: "delete", commandName: "faq" });
        store.claimForResolution(rec.proposalId); // simulate an approve interrupted by a crash

        setup(); // constructs a new ProposalService → failStaleApplying runs

        const row = store.get(rec.proposalId);
        expect(row?.status).toBe("failed");
        expect(row?.resolutionNote).toContain("interrupted while applying");
    });
});
