import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandFilesClient, computeDirectoryDigest } from "../src/github/commandFiles";
import { CommandSync, CommandSyncHost } from "../src/github/commandSync";
import { Commands, Config, CustomCommand } from "../src/types";

let dir: string;
let cachePath: string;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "command-sync-test-"));
    cachePath = join(dir, ".commands-cache.json");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

function cmd(name: string): CustomCommand {
    return {
        format: 2,
        name,
        description: `${name} help`,
        blocks: [
            { type: "heading", text: name },
            { type: "text", text: "body" },
        ],
    };
}

type Host = CommandSyncHost & { errors: [string, string][] };

function makeHost(): Host {
    const errors: [string, string][] = [];
    return {
        config: {} as Config,
        custom_commands: [] as Commands,
        errors,
        logError: async (title: string, error: string | Error) => {
            errors.push([title, String(error)]);
        },
    };
}

function entriesFor(commands: CustomCommand[]) {
    return commands.map(c => ({
        type: "file",
        name: `${c.name}.json`,
        path: `commands/${c.name}.json`,
        sha: `sha-${c.name}`,
    }));
}

/** Happy-path GitHub stub serving the given commands as one file each. */
function githubWith(commands: CustomCommand[]): CommandFilesClient {
    const entries = entriesFor(commands);
    return {
        listCommandDir: async () => ({ entries }),
        fetchCommandFile: async (path: string) => {
            const command = commands.find(c => `commands/${c.name}.json` === path);
            if (!command) return "not_found";
            return {
                raw: JSON.parse(JSON.stringify(command)) as Record<string, unknown>,
                sha: `sha-${command.name}`,
                path,
            };
        },
        commandPath: (name: string) => `commands/${name}.json`,
    } as unknown as CommandFilesClient;
}

const githubDown = {
    listCommandDir: async () => ({ error: "boom", status: 500 }),
} as unknown as CommandFilesClient;

class TestSync extends CommandSync {
    constructor(
        host: CommandSyncHost,
        path: string,
        private readonly stub: CommandFilesClient | null,
    ) {
        super(host, { cachePath: path });
    }

    override filesClient(): CommandFilesClient | null {
        return this.stub;
    }
}

function readSnapshot(): any {
    return JSON.parse(readFileSync(cachePath, "utf-8"));
}

function writeSnapshot(body: object): void {
    writeFileSync(cachePath, JSON.stringify(body));
}

function v2Snapshot(commands: CustomCommand[], digest?: string) {
    const files: Record<string, { path: string; sha: string }> = {};
    for (const c of commands) files[c.name] = { path: `commands/${c.name}.json`, sha: `sha-${c.name}` };
    return { version: 2, timestamp: "2026-01-01T00:00:00.000Z", digest, files, commands };
}

describe("CommandSync loadAll", () => {
    it("GitHub success writes a v2 snapshot and nothing else", async () => {
        const host = makeHost();
        const commands = [cmd("airlink"), cmd("wifi")];
        const sync = new TestSync(host, cachePath, githubWith(commands));

        const loaded = await sync.loadAll();

        expect(loaded).toHaveLength(2);
        expect(sync.lastLoadSource).toBe("github");
        expect(host.custom_commands).toHaveLength(2);
        expect(sync.getFileSha("wifi")).toBe("sha-wifi");

        const snapshot = readSnapshot();
        expect(snapshot.version).toBe(2);
        expect(snapshot.digest).toBe(computeDirectoryDigest(entriesFor(commands)));
        expect(snapshot.files.wifi).toEqual({ path: "commands/wifi.json", sha: "sha-wifi" });
        expect(Date.parse(snapshot.timestamp)).not.toBeNaN();
        // The snapshot is the ONLY artifact — no commands.json aggregate.
        expect(readdirSync(dir)).toEqual([".commands-cache.json"]);
    });

    it("does not wipe the snapshot on the first empty GitHub listing", async () => {
        const host = makeHost();
        writeSnapshot(v2Snapshot([cmd("wifi")], "d1"));
        const sync = new TestSync(host, cachePath, githubWith([]));

        const loaded = await sync.loadAll();

        expect(loaded).toHaveLength(1);
        expect(sync.lastLoadSource).toBe("cache");
        expect(host.custom_commands.map(c => c.name)).toEqual(["wifi"]);
        expect(readSnapshot().commands.map((c: CustomCommand) => c.name)).toEqual(["wifi"]);
        expect(host.errors.some(([title]) => title === "GitHub Commands Empty Listing Deferred")).toBe(true);
    });

    it("adopts an empty GitHub directory after a second consecutive empty listing", async () => {
        const host = makeHost();
        writeSnapshot(v2Snapshot([cmd("wifi")], "d1")); // a stale snapshot must NOT come back after confirmation
        const sync = new TestSync(host, cachePath, githubWith([]));

        await sync.loadAll();
        const loaded = await sync.loadAll();

        expect(loaded).toEqual([]);
        expect(sync.lastLoadSource).toBe("github");
        expect(host.custom_commands).toEqual([]);
        expect(readSnapshot().commands).toEqual([]);
        expect(sync.getDigest()).toBe(computeDirectoryDigest([]));
    });

    it("skips a command file whose name collides with a built-in", async () => {
        const host = { ...makeHost(), isBuiltinCommandName: (name: string) => name === "reload_config" };
        const sync = new TestSync(host, cachePath, githubWith([cmd("reload_config"), cmd("wifi")]));

        const loaded = await sync.loadAll();

        expect(loaded.map(c => c.name)).toEqual(["wifi"]);
        expect(sync.lastLoadSource).toBe("github");
        expect(host.errors.some(([title]) => title === "Invalid Command Files")).toBe(true);
    });

    it("preserves raw GitHub command bodies when validation repairs blocks", async () => {
        const raw = {
            format: 2,
            name: "testcmd",
            description: "  A test command  ",
            blocks: [{ type: "heading", text: "Hello", url: "not a url" }],
        };
        const filesClient = {
            listCommandDir: async () => ({
                entries: [{ name: "testcmd.json", path: "commands/testcmd.json", sha: "abc123", type: "file" }],
            }),
            fetchCommandFile: async () => ({ raw, sha: "abc123", path: "commands/testcmd.json" }),
        } as unknown as CommandFilesClient;
        const host = makeHost();
        const sync = new TestSync(host, cachePath, filesClient);

        const commands = await sync.loadAll();

        // The live corpus gets the normalized copy…
        expect(commands[0]!.description).toBe("A test command");
        expect(commands[0]!.blocks![0]).toEqual({ type: "heading", text: "Hello" });
        // …while the raw body (patch-engine input) stays byte-faithful.
        expect(sync.getRawBody("testcmd")).toEqual(raw);
        expect((raw.blocks[0] as Record<string, unknown>)["url"]).toBe("not a url");
    });

    it("listing failure boots from the snapshot and restores revision state", async () => {
        const host = makeHost();
        writeSnapshot(v2Snapshot([cmd("wifi")], "d1"));
        const sync = new TestSync(host, cachePath, githubDown);

        const loaded = await sync.loadAll();

        expect(loaded).toHaveLength(1);
        expect(sync.lastLoadSource).toBe("cache");
        expect(sync.getDigest()).toBe("d1");
        expect(sync.getFileSha("wifi")).toBe("sha-wifi");
        expect(sync.getRawBody("wifi")).toEqual(cmd("wifi"));
        expect(sync.snapshotShas()).toEqual({ wifi: "sha-wifi" });
        expect(host.errors.some(([title]) => title === "GitHub Commands Load Failed")).toBe(true);

        // Round-trip: a save from the snapshot boot keeps files+digest intact.
        sync.saveSnapshot();
        const snapshot = readSnapshot();
        expect(snapshot.files.wifi).toEqual({ path: "commands/wifi.json", sha: "sha-wifi" });
        expect(snapshot.digest).toBe("d1");
    });

    it("no snapshot + GitHub failure yields an empty corpus with unknown revision", async () => {
        const host = makeHost();
        const sync = new TestSync(host, cachePath, githubDown);

        const loaded = await sync.loadAll();

        expect(loaded).toEqual([]);
        expect(sync.lastLoadSource).toBe("none");
        expect(sync.getDigest()).toBeUndefined();
        expect(sync.snapshotShas()).toBeUndefined();
        expect(host.custom_commands).toEqual([]);
        expect(existsSync(cachePath)).toBe(false);
    });

    it("no snapshot + GitHub failure preserves the live in-memory corpus", async () => {
        const host = makeHost();
        const live = [cmd("wifi")];
        const files = {
            listCommandDir: vi
                .fn()
                .mockResolvedValueOnce({ entries: entriesFor(live) })
                .mockResolvedValueOnce({ error: "boom", status: 500 }),
            fetchCommandFile: async () => ({
                raw: JSON.parse(JSON.stringify(live[0])) as Record<string, unknown>,
                sha: "sha-wifi",
                path: "commands/wifi.json",
            }),
            commandPath: (name: string) => `commands/${name}.json`,
        } as unknown as CommandFilesClient;
        const sync = new TestSync(host, cachePath, files);
        await sync.loadAll();
        rmSync(cachePath);

        const loaded = await sync.loadAll();

        expect(loaded.map(c => c.name)).toEqual(["wifi"]);
        expect(sync.lastLoadSource).toBe("memory");
        expect(host.custom_commands.map(c => c.name)).toEqual(["wifi"]);
        expect(sync.getFileSha("wifi")).toBe("sha-wifi");
        expect(sync.getRawBody("wifi")).toEqual(cmd("wifi"));
    });

    it("no GitHub config boots from the snapshot, else empty", async () => {
        const host = makeHost();
        writeSnapshot(v2Snapshot([cmd("wifi")]));
        const withSnapshot = new TestSync(host, cachePath, null);
        expect(await withSnapshot.loadAll()).toHaveLength(1);
        expect(withSnapshot.lastLoadSource).toBe("cache");

        const emptyDirHost = makeHost();
        const emptyPath = join(dir, "missing-snapshot.json");
        const withoutSnapshot = new TestSync(emptyDirHost, emptyPath, null);
        expect(await withoutSnapshot.loadAll()).toEqual([]);
        expect(withoutSnapshot.lastLoadSource).toBe("none");
    });

    it("a single failed file fetch falls back whole — never a partial corpus", async () => {
        const host = makeHost();
        writeSnapshot(v2Snapshot([cmd("old-a"), cmd("old-b")], "d0"));
        const commands = [cmd("new-a"), cmd("new-b")];
        const partial = {
            listCommandDir: async () => ({ entries: entriesFor(commands) }),
            fetchCommandFile: async (path: string) => {
                if (path === "commands/new-b.json") return "error";
                const command = commands.find(c => `commands/${c.name}.json` === path)!;
                return {
                    raw: JSON.parse(JSON.stringify(command)) as Record<string, unknown>,
                    sha: `sha-${command.name}`,
                    path,
                };
            },
        } as unknown as CommandFilesClient;
        const sync = new TestSync(host, cachePath, partial);

        const loaded = await sync.loadAll();

        // The whole load fell back to the snapshot corpus, not the one fetchable file.
        expect(loaded.map(c => c.name).sort()).toEqual(["old-a", "old-b"]);
        expect(sync.lastLoadSource).toBe("cache");
    });

    it("filters invalid snapshot entries", async () => {
        const host = makeHost();
        writeSnapshot({
            version: 2,
            timestamp: "2026-01-01T00:00:00.000Z",
            commands: [cmd("good"), { name: "bad" }, 42],
        });
        const sync = new TestSync(host, cachePath, githubDown);

        const loaded = await sync.loadAll();
        expect(loaded.map(c => c.name)).toEqual(["good"]);
    });

    it("rejects a snapshot without version 2", async () => {
        const host = makeHost();
        writeSnapshot({ timestamp: "2026-01-01T00:00:00.000Z", commands: [cmd("wifi")] });
        const sync = new TestSync(host, cachePath, githubDown);

        const loaded = await sync.loadAll();
        expect(loaded).toEqual([]);
        expect(sync.lastLoadSource).toBe("none");
    });
});

describe("CommandSync saveSnapshot", () => {
    it("never overwrites the snapshot with an empty corpus", async () => {
        const host = makeHost();
        writeSnapshot(v2Snapshot([cmd("wifi")], "d1"));
        const sync = new TestSync(host, cachePath, githubDown);
        await sync.loadAll();

        host.custom_commands = [];
        sync.saveSnapshot();

        const snapshot = readSnapshot();
        expect(snapshot.commands).toHaveLength(1);
        expect(snapshot.commands[0].name).toBe("wifi");
    });

    it("persists an empty snapshot after a cache-backed final delete is verified remotely", async () => {
        const host = makeHost();
        writeSnapshot(v2Snapshot([cmd("wifi")], "d1"));
        const files = {
            listCommandDir: vi
                .fn()
                .mockResolvedValueOnce({ error: "boom", status: 500 })
                .mockResolvedValueOnce({ entries: [] }),
            commandPath: (name: string) => `commands/${name}.json`,
        } as unknown as CommandFilesClient;
        const sync = new TestSync(host, cachePath, files);
        await sync.loadAll();

        sync.applyDelete("wifi");
        host.custom_commands = [];
        await sync.refreshDigest();
        sync.saveSnapshot();

        expect(sync.lastLoadSource).toBe("cache");
        expect(sync.getDigest()).toBe(computeDirectoryDigest([]));
        expect(readSnapshot().commands).toEqual([]);
    });
});
