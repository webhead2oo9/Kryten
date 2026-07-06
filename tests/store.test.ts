import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProposalStore } from "../src/proposals/store";

let dir: string;
let store: ProposalStore;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "proposals-test-"));
    store = new ProposalStore(join(dir, "proposals.db"));
});

afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
});

function stage(name = "wifi") {
    return store.createProposal({
        operation: "patch",
        commandName: name,
        proposedEdits: [{ type: "set_property", property: "description", old: "a", new: "b" }],
        proposer: "chatbot",
    });
}

describe("ProposalStore", () => {
    it("creates pending proposals with 32-hex ids and TTL", () => {
        const record = stage();
        expect(record.proposalId).toMatch(/^[a-f0-9]{32}$/);
        expect(record.status).toBe("pending");
        expect(record.expiresAtMs).toBeGreaterThan(record.createdAtMs);
    });

    it("claims exactly once (double-click gate)", () => {
        const record = stage();
        const first = store.claimForResolution(record.proposalId);
        expect(first?.status).toBe("applying");
        const second = store.claimForResolution(record.proposalId);
        expect(second).toBeNull();
    });

    it("resolution transitions require the claiming state", () => {
        const record = stage();
        // Not yet claimed: approve must not apply.
        expect(store.markApproved(record.proposalId, "staff")).toBeNull();
        store.claimForResolution(record.proposalId);
        const approved = store.markApproved(record.proposalId, "staff", "sha123");
        expect(approved?.status).toBe("approved");
        expect(approved?.committedSha).toBe("sha123");
        // Terminal: nothing else applies.
        expect(store.markFailed(record.proposalId, "staff", "x")).toBeNull();
    });

    it("reject requires pending (not mid-approve)", () => {
        const record = stage();
        store.claimForResolution(record.proposalId);
        expect(store.markRejected(record.proposalId, "staff")).toBeNull();

        const other = stage("airlink");
        const rejected = store.markRejected(other.proposalId, "staff");
        expect(rejected?.status).toBe("rejected");
    });

    it("expired proposals cannot be claimed or rejected", () => {
        const shortStore = new ProposalStore(join(dir, "short.db"), 1); // 1ms TTL
        const record = shortStore.createProposal({ operation: "delete", commandName: "wifi" });
        const start = Date.now();
        while (Date.now() - start < 5) {
            // spin past the TTL
        }
        expect(shortStore.claimForResolution(record.proposalId)).toBeNull();
        expect(shortStore.get(record.proposalId)?.status).toBe("expired");
        shortStore.close();
    });

    it("dedupes by pending + operation + name and counts pending", () => {
        const record = stage();
        expect(store.findPendingDuplicate("patch", "wifi")?.proposalId).toBe(record.proposalId);
        expect(store.findPendingDuplicate("delete", "wifi")).toBeNull();
        expect(store.findPendingDuplicate("patch", "other")).toBeNull();
        expect(store.countPending()).toBe(1);

        store.claimForResolution(record.proposalId);
        expect(store.findPendingDuplicate("patch", "wifi")).toBeNull();
        expect(store.countPending()).toBe(0);
    });

    it("round-trips JSON payloads", () => {
        const record = store.createProposal({
            operation: "create",
            commandName: "newcmd",
            proposedCommand: { name: "newcmd", description: "d", embed: { title: "T" } },
            rationale: "user asked",
        });
        const loaded = store.get(record.proposalId)!;
        expect(loaded.proposedCommand).toEqual({ name: "newcmd", description: "d", embed: { title: "T" } });
        expect(loaded.rationale).toBe("user asked");
    });
});
