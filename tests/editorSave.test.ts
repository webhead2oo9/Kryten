import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorSession } from "../src/classes/customCommandEditor";
import { KrytenClient } from "../src/classes/client";
import { commitSessionChanges, drainPendingSync } from "../src/handlers/editorHandler";
import { CommandFilesClient } from "../src/github/commandFiles";
import { CommandSync } from "../src/github/commandSync";
import { CustomCommand } from "../src/types";

let dir: string;
let cachePath: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "editor-save-test-"));
    cachePath = join(dir, ".commands-cache.json");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function cmd(name: string, description: string): CustomCommand {
    return {
        format: 2,
        name,
        description,
        blocks: [
            { type: "heading", text: name },
            { type: "text", text: description },
        ],
    };
}

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function registrationSignature(commands: CustomCommand[]): string {
    return JSON.stringify(commands.map(c => [c.name, c.description] as const).sort((a, b) => a[0].localeCompare(b[0])));
}

/**
 * GitHub stub whose commitCommand fails (sha_conflict) for names in
 * `failing` — remove a name from the set to let a retry succeed.
 */
function makeFilesClient(failing: Set<string>) {
    let counter = 0;
    return {
        commitCommand: async (name: string) => {
            if (failing.has(name)) return { status: "sha_conflict" as const };
            counter++;
            return { status: "ok" as const, newSha: `sha-${name}-${counter}` };
        },
        deleteCommand: async (name: string) => {
            if (failing.has(name)) return { status: "sha_conflict" as const };
            return { status: "ok" as const };
        },
        commandPath: (name: string) => `commands/${name}.json`,
    } as unknown as CommandFilesClient;
}

class TestSync extends CommandSync {
    constructor(
        host: ConstructorParameters<typeof CommandSync>[0],
        path: string,
        private readonly stub: CommandFilesClient,
    ) {
        super(host, { cachePath: path });
    }

    override filesClient(): CommandFilesClient {
        return this.stub;
    }

    override async refreshDigest(): Promise<void> {
        // Listing-digest reconciliation is out of scope for these tests.
    }
}

/** Minimal KrytenClient stand-in for the save path. */
function makeClient(live: CustomCommand[], files: CommandFilesClient) {
    const client = {
        custom_commands: clone(live),
        config: {},
        logError: async () => undefined,
        registerIfChanged: async () => false,
    } as unknown as KrytenClient;
    (client as { commandSync: CommandSync }).commandSync = new TestSync(
        client as unknown as ConstructorParameters<typeof CommandSync>[0],
        cachePath,
        files,
    );
    return client;
}

function makeSession(live: CustomCommand[], working: CustomCommand[], fileShas: Record<string, string>): EditorSession {
    return {
        userId: "user",
        commands: clone(working),
        originalCommands: clone(live),
        hasUnsavedChanges: true,
        lastTouched: Date.now(),
        fileShas,
    };
}

describe("commitSessionChanges retry after mid-batch failure", () => {
    it("preserves disjoint live updates that land while the save awaits GitHub", async () => {
        const live = [cmd("alpha", "old alpha")];
        const working = [cmd("alpha", "new alpha")];
        const holder: { client?: KrytenClient } = {};
        const files = {
            commitCommand: async () => {
                const client = holder.client!;
                client.custom_commands = [...client.custom_commands, cmd("concurrent", "live update")];
                return { status: "ok" as const, newSha: "sha-alpha-1" };
            },
            deleteCommand: async () => ({ status: "ok" as const }),
            commandPath: (name: string) => `commands/${name}.json`,
        } as unknown as CommandFilesClient;
        const client = makeClient(live, files);
        holder.client = client;
        const session = makeSession(live, working, { alpha: "sha-alpha-0" });

        await commitSessionChanges(client, session, "tester");

        expect(client.custom_commands.find(c => c.name === "alpha")!.description).toBe("new alpha");
        expect(client.custom_commands.find(c => c.name === "concurrent")!.description).toBe("live update");
    });

    it("applies earlier-committed files to live corpus and snapshot on a retry", async () => {
        const live = [cmd("alpha", "old alpha"), cmd("beta", "old beta")];
        const working = [cmd("alpha", "new alpha"), cmd("beta", "new beta")];
        const failing = new Set(["beta"]);
        const client = makeClient(live, makeFilesClient(failing));
        const session = makeSession(live, working, { alpha: "sha-alpha-0", beta: "sha-beta-0" });

        // Attempt 1: alpha commits, beta conflicts. alpha's committed body lands
        // in the live corpus immediately (in lockstep with its fresh blob SHA) so
        // a concurrent session can't seed a stale alpha and clobber it.
        await commitSessionChanges(client, session, "tester");
        expect(session.hasUnsavedChanges).toBe(true);
        expect(client.custom_commands.find(c => c.name === "alpha")!.description).toBe("new alpha");
        expect(client.custom_commands.find(c => c.name === "beta")!.description).toBe("old beta");
        expect(session.pendingSync!.upserts["alpha"]!.description).toBe("new alpha");

        // Attempt 2: conflict resolved — retry commits beta only (baseline
        // advanced past alpha), but alpha's earlier commit must land locally.
        failing.delete("beta");
        await commitSessionChanges(client, session, "tester");

        expect(session.hasUnsavedChanges).toBe(false);
        expect(session.pendingSync).toBeUndefined();
        expect(client.custom_commands.find(c => c.name === "alpha")!.description).toBe("new alpha");
        expect(client.custom_commands.find(c => c.name === "beta")!.description).toBe("new beta");

        const snapshot = JSON.parse(readFileSync(cachePath, "utf-8"));
        const names = Object.fromEntries(
            snapshot.commands.map((c: CustomCommand) => [c.name, c.description]),
        ) as Record<string, string>;
        expect(names["alpha"]).toBe("new alpha");
        expect(names["beta"]).toBe("new beta");
    });

    it("drains pending commits on a zero-diff save after a discard", async () => {
        const live = [cmd("alpha", "old alpha"), cmd("beta", "old beta")];
        const working = [cmd("alpha", "new alpha"), cmd("beta", "new beta")];
        const failing = new Set(["beta"]);
        const client = makeClient(live, makeFilesClient(failing));
        const session = makeSession(live, working, { alpha: "sha-alpha-0", beta: "sha-beta-0" });

        await commitSessionChanges(client, session, "tester"); // alpha lands on GitHub, beta conflicts

        // Discard: working copy resets to the advanced baseline → zero diff,
        // but alpha is already committed remotely and must still sync locally.
        session.commands = clone(session.originalCommands);
        session.hasUnsavedChanges = false;
        await commitSessionChanges(client, session, "tester");

        expect(session.pendingSync).toBeUndefined();
        expect(client.custom_commands.find(c => c.name === "alpha")!.description).toBe("new alpha");
        expect(client.custom_commands.find(c => c.name === "beta")!.description).toBe("old beta");
    });

    it("handles a committed create followed by retry (committed file lands in live immediately)", async () => {
        const live = [cmd("alpha", "old alpha")];
        const working = [cmd("alpha", "new alpha"), cmd("created", "brand new")];
        // Creates commit before edits — let the create succeed, fail the edit.
        const failing = new Set(["alpha"]);
        const client = makeClient(live, makeFilesClient(failing));
        const session = makeSession(live, working, { alpha: "sha-alpha-0" });

        await commitSessionChanges(client, session, "tester"); // 'created' lands, 'alpha' conflicts
        // 'created' committed to GitHub, so it's live at once (was previously
        // withheld until the whole batch succeeded — the stale-overwrite window).
        expect(client.custom_commands.some(c => c.name === "created")).toBe(true);
        // 'alpha' never committed, so its live body is unchanged.
        expect(client.custom_commands.find(c => c.name === "alpha")!.description).toBe("old alpha");

        failing.delete("alpha");
        await commitSessionChanges(client, session, "tester");

        expect(client.custom_commands.some(c => c.name === "created")).toBe(true);
        expect(client.custom_commands.find(c => c.name === "alpha")!.description).toBe("new alpha");
    });

    it("keeps a committed file's live body consistent with its advanced SHA (no stale-overwrite window)", async () => {
        const live = [cmd("alpha", "old alpha"), cmd("beta", "old beta")];
        const working = [cmd("alpha", "new alpha"), cmd("beta", "new beta")];
        const failing = new Set(["beta"]);
        const client = makeClient(live, makeFilesClient(failing));
        const session = makeSession(live, working, { alpha: "sha-alpha-0", beta: "sha-beta-0" });

        await commitSessionChanges(client, session, "tester"); // alpha commits, beta conflicts

        // A second session would seed its working copy from client.custom_commands
        // and anchor SHAs from commandSync. After alpha's commit both advanced
        // together — the new body pairs with the new blob SHA — so that session
        // can't commit a stale alpha body over the fresh SHA (the finding's bug).
        expect(client.custom_commands.find(c => c.name === "alpha")!.description).toBe("new alpha");
        expect(client.commandSync.getFileSha("alpha")).toBe("sha-alpha-1");
    });

    it("drains pending commits on Close so a committed create can't stay live-but-unregistered", async () => {
        const live = [cmd("alpha", "old alpha")];
        const working = [cmd("alpha", "new alpha"), cmd("created", "brand new")];
        // Creates commit before edits — the create lands, then alpha conflicts.
        const failing = new Set(["alpha"]);
        const client = makeClient(live, makeFilesClient(failing));
        const session = makeSession(live, working, { alpha: "sha-alpha-0" });
        const registrationChanges: boolean[] = [];
        client.registerIfChanged = async previous => {
            const changed = registrationSignature(previous) !== registrationSignature(client.custom_commands);
            registrationChanges.push(changed);
            return changed;
        };

        await commitSessionChanges(client, session, "tester"); // 'created' lands, 'alpha' conflicts
        expect(session.pendingSync).toBeDefined();
        expect(registrationChanges).toEqual([]);

        // Close abandons the session — the poller can't register 'created'
        // (corpus-before and corpus-after both already contain it), so the
        // drain must catch up the snapshot and slash registration itself.
        await drainPendingSync(client, session);

        expect(session.pendingSync).toBeUndefined();
        expect(registrationChanges).toEqual([true]);
        expect(client.custom_commands.some(c => c.name === "created")).toBe(true);
        const snapshot = JSON.parse(readFileSync(cachePath, "utf-8"));
        expect(snapshot.commands.some((c: CustomCommand) => c.name === "created")).toBe(true);
    });

    it("preserves the pre-partial registration baseline across a content-only retry", async () => {
        const live = [cmd("beta", "unchanged registration")];
        const betaContentOnlyEdit = cmd("beta", "unchanged registration");
        betaContentOnlyEdit.blocks = [{ type: "text", text: "content-only change" }];
        const working = [cmd("created", "new registration"), betaContentOnlyEdit];
        const failing = new Set(["beta"]);
        const client = makeClient(live, makeFilesClient(failing));
        const session = makeSession(live, working, { beta: "sha-beta-0" });
        const registrationChanges: boolean[] = [];
        client.registerIfChanged = async previous => {
            const changed = registrationSignature(previous) !== registrationSignature(client.custom_commands);
            registrationChanges.push(changed);
            return changed;
        };

        await commitSessionChanges(client, session, "tester"); // created lands, beta conflicts; no registration yet
        expect(registrationChanges).toEqual([]);

        failing.delete("beta");
        await commitSessionChanges(client, session, "tester");

        expect(registrationChanges).toEqual([true]);
        expect(client.custom_commands.some(c => c.name === "created")).toBe(true);
        expect(session.pendingSync).toBeUndefined();
    });
});
