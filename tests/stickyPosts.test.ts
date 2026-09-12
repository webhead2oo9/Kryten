import { afterEach, expect, it, vi } from "vitest";
import { Client, ClientUser, Guild, Message, TextChannel } from "discord.js";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateConfig } from "../src/config/validate";
import { StickyStore } from "../src/features/stickyPosts/store";
import { StickyPosts } from "../src/features/stickyPosts/handler";
import type { KrytenClient } from "../src/classes/client";

const guildId = "123456789012345678";
const channelId = "223456789012345678";
const botId = "323456789012345678";
const humanId = "423456789012345678";
const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

function setup(interval = 2) {
    vi.stubEnv("GUILD_ID", guildId);
    const dir = mkdtempSync(join(process.cwd(), ".sticky-test-"));
    dirs.push(dir);
    const path = join(dir, "state.json");
    const client = new Client({ intents: [] }) as KrytenClient;
    // @ts-expect-error Native SDK fixture construction; transport alone is mocked.
    client.user = new ClientUser(client, { id: botId, username: "bot", discriminator: "0", bot: true });
    client.config = validateConfig({
        sticky_posts: {
            enabled: true,
            channels: { [channelId]: { interval_messages: interval, embed: { description: "Synthetic information" } } },
        },
    });
    client.configLoadFailed = false;
    // @ts-expect-error Native SDK fixture construction; transport alone is mocked.
    const guild = new Guild(client, { id: guildId, name: "test", unavailable: false });
    client.guilds.cache.set(guildId, guild);
    // @ts-expect-error Native SDK fixture construction; transport alone is mocked.
    const channel = new TextChannel(guild, { id: channelId, type: 0, name: "test" }, client);
    client.channels.cache.set(channelId, channel);
    let sequence = 0n;
    const remote = new Map<string, any>();
    const data = (id: string, author = botId) => ({
        id,
        channel_id: channelId,
        guild_id: guildId,
        type: 0,
        content: "",
        author: { id: author, username: "synthetic", discriminator: "0", bot: author === botId },
        timestamp: new Date().toISOString(),
        attachments: [],
        embeds: [],
        components: [],
    });
    const post = vi.spyOn(client.rest, "post").mockImplementation(async (_route, options) => {
        const id = String(523456789012345678n + sequence++);
        const raw = { ...data(id), channel_id: String(_route).split("/")[2], embeds: (options?.body as any).embeds };
        remote.set(id, raw);
        return raw;
    });
    const get = vi.spyOn(client.rest, "get").mockImplementation(async route => {
        const id = String(route).split("/").at(-1)!;
        if (String(route) === `/channels/${channelId}`)
            return { id: channelId, guild_id: guildId, type: 0, name: "test" };
        if (!remote.has(id) || remote.get(id).channel_id !== String(route).split("/")[2])
            throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        return remote.get(id);
    });
    const del = vi.spyOn(client.rest, "delete").mockImplementation(async route => {
        remote.delete(String(route).split("/").at(-1)!);
    });
    // @ts-expect-error Native SDK fixture construction; transport alone is mocked.
    const message = () => new Message(client, data("623456789012345678", humanId));
    const handler = new StickyPosts(client, path);
    const state = () => JSON.parse(readFileSync(path, "utf8"));
    return { client, channel, handler, path, dir, remote, post, get, del, message, state };
}

it("persists the canonical and count, reposting only after N subsequent messages across restart", async () => {
    const f = setup(2);
    const humanMessage = f.message();
    humanMessage.content = "Synthetic private human content";
    await f.handler.process(humanMessage);
    const first = [...f.remote.keys()][0]!;
    await f.handler.process(f.message());
    expect(f.post).toHaveBeenCalledTimes(1);
    const restarted = new StickyPosts(f.client, f.path);
    await restarted.process(f.message());
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.remote.has(first)).toBe(false);
    expect(f.remote.size).toBe(1);
    expect(f.state().channels[channelId]).toMatchObject({ count: 0, canonical: [...f.remote.keys()][0] });
    expect(readFileSync(f.path, "utf8")).not.toContain("Synthetic information");
    expect(readFileSync(f.path, "utf8")).not.toContain(humanMessage.content);
});

it("serializes concurrent qualifying messages without duplicate creates or lost counts", async () => {
    const f = setup(10);
    await Promise.all(Array.from({ length: 21 }, () => f.handler.process(f.message())));
    expect(f.post).toHaveBeenCalledTimes(3);
    expect(f.remote.size).toBe(1);
    expect(f.state().channels[channelId].count).toBe(0);
});

it("recreates a manually deleted canonical despite a primed SDK cache and missed restart events", async () => {
    const f = setup(10);
    await f.handler.process(f.message());
    const id = [...f.remote.keys()][0]!;
    expect(f.channel.messages.cache.has(id)).toBe(true);
    f.remote.delete(id);
    await new StickyPosts(f.client, f.path).process(f.message());
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.get).toHaveBeenCalledWith(`/channels/${channelId}/messages/${id}`);
});

it("refuses to replace or delete a canonical not owned by this bot", async () => {
    const f = setup(1);
    await f.handler.process(f.message());
    const id = [...f.remote.keys()][0]!;
    f.remote.get(id).author = { id: humanId, username: "human", discriminator: "0", bot: false };
    await expect(f.handler.process(f.message())).rejects.toThrow(/ownership/i);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.del).not.toHaveBeenCalled();
});

it.each([
    "bot",
    "webhook",
    "system",
    "dm",
    "otherGuild",
    "unsetGuild",
    "disabled",
    "removed",
    "loadFailed",
    "blacklist",
    "child",
])("ignores %s messages without opening state", async kind => {
    const f = setup();
    const message = f.message();
    if (kind === "bot") message.author.bot = true;
    if (kind === "webhook") message.webhookId = botId;
    if (kind === "system") message.type = 7;
    if (kind === "dm") message.guildId = null;
    if (kind === "otherGuild") message.guildId = "723456789012345678";
    if (kind === "unsetGuild") vi.stubEnv("GUILD_ID", "");
    if (kind === "disabled") f.client.config.sticky_posts!.enabled = false;
    if (kind === "removed") delete f.client.config.sticky_posts!.channels[channelId];
    if (kind === "loadFailed") f.client.configLoadFailed = true;
    if (kind === "blacklist") f.client.config.moderation = { channel_blacklist: [channelId] };
    if (kind === "child") message.channelId = "823456789012345678";
    await f.handler.process(message);
    expect(f.post).not.toHaveBeenCalled();
});

it("retains a due count after definite send rejection, retrying on the next human message", async () => {
    const f = setup(2);
    await f.handler.process(f.message());
    await f.handler.process(f.message());
    f.post.mockRejectedValueOnce(Object.assign(new Error("Forbidden"), { status: 403 }));
    await expect(f.handler.process(f.message())).rejects.toThrow("Forbidden");
    expect(f.remote.size).toBe(1);
    expect(f.state().channels[channelId].count).toBe(2);
    await new StickyPosts(f.client, f.path).process(f.message());
    expect(f.post).toHaveBeenCalledTimes(3);
    expect(f.remote.size).toBe(1);
});

it("durably blocks unknown delivery instead of producing duplicates on retries or restart", async () => {
    const f = setup(1);
    await f.handler.process(f.message());
    const send = f.post.getMockImplementation()!;
    f.post.mockImplementationOnce(async (...args) => {
        await send(...args);
        throw new Error("Connection lost after delivery");
    });
    await expect(f.handler.process(f.message())).rejects.toThrow("Connection lost");
    expect(f.remote.size).toBe(2);
    expect(f.state().channels[channelId].intent).toEqual(expect.any(String));
    await expect(f.handler.process(f.message())).rejects.toThrow(/delivery/i);
    await expect(new StickyPosts(f.client, f.path).process(f.message())).rejects.toThrow(/delivery/i);
    expect(f.post).toHaveBeenCalledTimes(2);
});

it("persists bounded old-message deletion with backoff across restart, blocking further replacements", async () => {
    const f = setup(1);
    await f.handler.process(f.message());
    const old = [...f.remote.keys()][0]!;
    f.del.mockRejectedValueOnce(new Error("delete network failure"));
    await expect(f.handler.process(f.message())).rejects.toThrow("delete network failure");
    expect(f.remote.size).toBe(2);
    expect(f.state().channels[channelId].pending.id).toBe(old);
    const restarted = new StickyPosts(f.client, f.path);
    await restarted.process(f.message());
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.del).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await restarted.process(f.message());
    expect(f.remote.has(old)).toBe(false);
    expect(f.remote.size).toBe(1);
});

it("cleans up an untracked send and latches closed after persistence fails", async () => {
    const f = setup(1);
    await f.handler.process(f.message());
    const old = [...f.remote.keys()][0]!;
    const send = f.post.getMockImplementation()!;
    f.post.mockImplementationOnce(async (...args) => {
        const result = await send(...args);
        renameSync(f.path, f.path + ".backup");
        mkdirSync(f.path);
        return result;
    });
    await expect(f.handler.process(f.message())).rejects.toThrow();
    expect([...f.remote.keys()]).toEqual([old]);
    rmSync(f.path, { recursive: true });
    renameSync(f.path + ".backup", f.path);
    await expect(f.handler.process(f.message())).rejects.toThrow(/closed/i);
    await expect(new StickyPosts(f.client, f.path).process(f.message())).rejects.toThrow(/delivery/i);
    expect(f.post).toHaveBeenCalledTimes(2);
});

it("writes state atomically and refuses to refresh if the durable write cannot be staged", async () => {
    const f = setup(1);
    await f.handler.process(f.message());
    const before = readFileSync(f.path, "utf8");
    mkdirSync(f.path + ".tmp");
    await expect(f.handler.process(f.message())).rejects.toThrow();
    expect(readFileSync(f.path, "utf8")).toBe(before);
    expect(f.post).toHaveBeenCalledTimes(1);
});

it.each([
    "{",
    JSON.stringify({ version: 99, channels: {} }),
    JSON.stringify({ version: 1, channels: { [channelId]: { count: -1, hash: "" } } }),
    JSON.stringify({ version: 1, channels: { [channelId]: { count: 0, hash: "", canonical: "not-an-id" } } }),
    JSON.stringify({ version: 1, channels: { [channelId]: { count: 0, hash: "", content: "must not persist" } } }),
])("fails closed for invalid state %#", async raw => {
    const f = setup();
    writeFileSync(f.path, raw);
    await expect(f.handler.process(f.message())).rejects.toThrow();
    expect(f.post).not.toHaveBeenCalled();
    expect(readFileSync(f.path, "utf8")).toBe(raw);
});

it("refreshes changed content on reload immediately but not disabled/removed entries", async () => {
    const f = setup(10);
    await f.handler.process(f.message());
    f.client.config.sticky_posts!.channels[channelId]!.embed.description = "Updated synthetic information";
    await f.handler.reload();
    expect(f.post).toHaveBeenCalledTimes(2);
    expect([...f.remote.values()][0].embeds).toEqual([{ description: "Updated synthetic information" }]);
    const retained = f.state().channels[channelId].canonical;
    f.client.config.sticky_posts!.enabled = false;
    f.client.config.sticky_posts!.channels[channelId]!.embed.description = "Disabled update";
    await f.handler.reload();
    await f.handler.process(f.message());
    expect(f.post).toHaveBeenCalledTimes(2);
    const entry = f.client.config.sticky_posts!.channels[channelId]!;
    f.client.config.sticky_posts!.enabled = true;
    delete f.client.config.sticky_posts!.channels[channelId];
    await f.handler.reload();
    expect(f.state().channels[channelId].canonical).toBe(retained);
    f.client.config.sticky_posts!.channels[channelId] = entry;
    await new StickyPosts(f.client, f.path).reload();
    expect(f.post).toHaveBeenCalledTimes(3);
    expect(f.remote.size).toBe(1);
});

it("stops accepting work and drains an in-flight send before resolving shutdown", async () => {
    const f = setup();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    const send = f.post.getMockImplementation()!;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
        entered = resolve;
    });
    f.post.mockImplementationOnce(async (...args) => {
        entered();
        await gate;
        return send(...args);
    });
    const work = f.handler.process(f.message());
    await started;
    let stopped = false;
    const shutdown = f.handler.stop(1000).then(() => {
        stopped = true;
    });
    await f.handler.process(f.message());
    await f.handler.reload();
    expect(stopped).toBe(false);
    release();
    await shutdown;
    await work;
    expect(stopped).toBe(true);
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.state().channels[channelId].canonical).toBe([...f.remote.keys()][0]);
});

it("bounds shutdown and prevents a late fetch from starting a new send", async () => {
    const f = setup(1);
    await f.handler.process(f.message());
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    const fetch = f.get.getMockImplementation()!;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
        entered = resolve;
    });
    f.get.mockImplementationOnce(async (...args) => {
        entered();
        await gate;
        return fetch(...args);
    });
    const work = f.handler.process(f.message());
    await started;
    await f.handler.stop(5);
    release();
    await work;
    expect(f.post).toHaveBeenCalledTimes(1);
});

it("bounds per-channel backlog without persisting or retaining human content", async () => {
    const f = setup(1000);
    const work = Array.from({ length: 101 }, () => f.handler.process(f.message()));
    const results = await Promise.allSettled(work);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(f.state().channels[channelId].count).toBe(99);
});

it("rechecks disabled config after a network await before sending", async () => {
    const f = setup(1);
    await f.handler.process(f.message());
    const fetch = f.get.getMockImplementation()!;
    f.get.mockImplementationOnce(async (...args) => {
        f.client.config.sticky_posts!.enabled = false;
        return fetch(...args);
    });
    await f.handler.process(f.message());
    expect(f.post).toHaveBeenCalledTimes(1);
});

it("runs through the real Feature pipeline and successful reload_config command", async () => {
    const f = setup(10);
    const cwd = process.cwd();
    process.chdir(f.dir);
    try {
        f.client.config.moderation = {
            crosspost: { enabled: false },
            image_fingerprint: { enabled: false, db_path: join(f.dir, "fingerprints.db") },
        };
        f.client.config.auto_responder = {
            store_path: join(f.dir, "interactions.json"),
            encryption_key_env: "STICKY_TEST_UNUSED_KEY",
        };
        f.client.logError = vi.fn(async () => undefined);
        f.client.poller = { start: vi.fn() } as any;
        const { handleMessage } = await import("../src/handlers/messageHandler");
        await handleMessage(f.message(), f.client);
        expect(f.post).toHaveBeenCalledTimes(1);
        f.client.loadConfig = () => {
            f.client.config = validateConfig({
                ...f.client.config,
                sticky_posts: { enabled: true, channels: { [channelId]: { embed: { title: "Reloaded" } } } },
            });
        };
        const Reload = (await import("../src/commands/reloadConfig")).default;
        const reply = vi.fn(async () => undefined);
        const deferReply = vi.fn(async () => undefined);
        await new Reload().run({ client: f.client, interaction: { reply, editReply: reply, deferReply } } as any);
        expect(deferReply).toHaveBeenCalledWith({ ephemeral: true });
        expect(deferReply.mock.invocationCallOrder[0]).toBeLessThan(f.post.mock.invocationCallOrder[1]!);
        expect(f.post).toHaveBeenCalledTimes(2);
        expect([...f.remote.values()][0].embeds).toEqual([{ title: "Reloaded" }]);
        expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining("Reloaded") }));
        expect(f.client.logError).not.toHaveBeenCalled();
    } finally {
        process.chdir(cwd);
    }
});

it.each([50013, 50001, "ETIMEDOUT"])(
    "does not treat fetch error %s as absence and still persists the human count",
    async code => {
        const f = setup(2);
        await f.handler.process(f.message());
        f.get.mockRejectedValueOnce(Object.assign(new Error("fetch failure"), { code }));
        await expect(f.handler.process(f.message())).rejects.toThrow("fetch failure");
        expect(f.post).toHaveBeenCalledTimes(1);
        expect(f.state().channels[channelId].count).toBe(1);
        await f.handler.process(f.message());
        expect(f.post).toHaveBeenCalledTimes(2);
    },
);

it("recreates a missing canonical on the same message that clears a pending deletion", async () => {
    const f = setup(10);
    await f.handler.process(f.message());
    f.client.config.sticky_posts!.channels[channelId]!.embed.title = "Updated";
    f.del.mockRejectedValueOnce(new Error("temporary delete failure"));
    await expect(f.handler.reload()).rejects.toThrow();
    f.remote.clear();
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    await new StickyPosts(f.client, f.path).process(f.message());
    expect(f.remote.size).toBe(1);
});

it("caps retained state rather than growing indefinitely", async () => {
    const f = setup();
    const channels = Object.fromEntries(
        Array.from({ length: 1000 }, (_, i) => [String(723456789012345678n + BigInt(i)), { count: 0, hash: "" }]),
    );
    writeFileSync(f.path, JSON.stringify({ version: 1, channels }));
    await expect(f.handler.process(f.message())).rejects.toThrow(/capacity/i);
    expect(f.post).not.toHaveBeenCalled();
    expect(Object.keys(f.state().channels)).toHaveLength(1000);
});

it("latches closed after an unreadable store rather than treating its later removal as an empty store", async () => {
    const f = setup();
    mkdirSync(f.path);
    await expect(f.handler.process(f.message())).rejects.toThrow();
    rmSync(f.path, { recursive: true });
    await expect(f.handler.process(f.message())).rejects.toThrow(/closed/i);
    expect(f.post).not.toHaveBeenCalled();
});

it("bounds total queued work across channels", async () => {
    const f = setup(1000);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });
    f.post.mockImplementation(async () => {
        await gate;
        throw Object.assign(new Error("synthetic rejected send"), { status: 403 });
    });
    const work: Promise<void>[] = [];
    for (let i = 0; i < 11; i++) {
        const id = String(823456789012345678n + BigInt(i));
        // @ts-expect-error Native SDK fixture construction; transport alone is mocked.
        const channel = new TextChannel(f.channel.guild, { id, type: 0, name: "test" }, f.client);
        f.client.channels.cache.set(id, channel);
        f.client.config.sticky_posts!.channels[id] = f.client.config.sticky_posts!.channels[channelId]!;
        for (let j = 0; j < 100; j++) {
            const message = f.message();
            message.channelId = id;
            work.push(f.handler.process(message));
        }
    }
    const completed = Promise.allSettled(work);
    await f.handler.stop(5);
    release();
    const results = await completed;
    expect(
        results.filter(result => result.status === "rejected" && /capacity/.test(String(result.reason))),
    ).toHaveLength(100);
});

it("wires bounded sticky draining before index destroys Discord", () => {
    const index = readFileSync(join(process.cwd(), "src/index.ts"), "utf8");
    const shutdown = index.slice(index.indexOf("async function shutdown"));
    expect(shutdown).toContain("await getStickyPosts(client).stop(5_000)");
    expect(shutdown.indexOf("await getStickyPosts(client).stop(5_000)")).toBeLessThan(
        shutdown.indexOf("await stopBetaFeatures("),
    );
});

it("refuses oversized state before parsing it", async () => {
    const f = setup();
    writeFileSync(f.path, " ".repeat(1_048_576) + JSON.stringify({ version: 1, channels: {} }));
    await expect(f.handler.process(f.message())).rejects.toThrow(/closed/i);
    expect(f.post).not.toHaveBeenCalled();
});

it("reports an uncertain initial delivery during reload instead of claiming success", async () => {
    const f = setup();
    f.post.mockRejectedValueOnce(new Error("network disconnected"));
    await expect(f.handler.process(f.message())).rejects.toThrow();
    await expect(f.handler.reload()).rejects.toThrow(/delivery/i);
    expect(f.post).toHaveBeenCalledTimes(1);
});

it("stops deletion retries at a durable finite limit without creating more duplicates", async () => {
    const f = setup(1);
    await f.handler.process(f.message());
    f.del.mockRejectedValue(new Error("delete unavailable"));
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    for (let i = 0; i < 10; i++) {
        await expect(f.handler.process(f.message())).rejects.toThrow("delete unavailable");
        now += 3_600_001;
    }
    await expect(new StickyPosts(f.client, f.path).process(f.message())).rejects.toThrow(/retry limit/i);
    expect(f.del).toHaveBeenCalledTimes(10);
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.remote.size).toBe(2);
});

it("reports hot-reload refresh blocked by pending deletion backoff", async () => {
    const f = setup(1);
    await f.handler.process(f.message());
    f.del.mockRejectedValueOnce(new Error("delete failure"));
    await expect(f.handler.process(f.message())).rejects.toThrow();
    f.client.config.sticky_posts!.channels[channelId]!.embed.title = "Changed during backoff";
    await expect(f.handler.reload()).rejects.toThrow(/pending deletion/i);
    expect(f.post).toHaveBeenCalledTimes(2);
});

it("ignores unconfigured threads but counts an explicitly configured thread including staff replies", async () => {
    const f = setup(1);
    const { ThreadChannel, GuildMember, Role } = await import("discord.js");
    const threadId = "923456789012345678";
    // @ts-expect-error Native SDK fixture construction; transport alone is mocked.
    const thread = new ThreadChannel(
        f.channel.guild,
        {
            id: threadId,
            type: 11,
            name: "thread",
            parent_id: channelId,
            thread_metadata: {
                archived: false,
                auto_archive_duration: 1440,
                archive_timestamp: new Date().toISOString(),
                locked: false,
            },
        },
        f.client,
    );
    f.client.channels.cache.set(threadId, thread);
    const message = f.message();
    message.channelId = threadId;
    message.type = 19;
    await f.handler.process(message);
    expect(f.post).not.toHaveBeenCalled();
    f.client.config.sticky_posts!.channels[threadId] = f.client.config.sticky_posts!.channels[channelId]!;
    f.client.config.staff_roles = ["111456789012345678"];
    // @ts-expect-error Native SDK fixture construction; transport alone is mocked.
    const role = new Role(f.client, { id: "111456789012345678", name: "staff", permissions: "0" }, f.channel.guild);
    f.channel.guild.roles.cache.set(role.id, role);
    // @ts-expect-error Native SDK fixture construction; transport alone is mocked.
    const member = new GuildMember(
        f.client,
        { user: { id: humanId, username: "staff", discriminator: "0" }, roles: [role.id] },
        f.channel.guild,
    );
    f.channel.guild.members.cache.set(humanId, member);
    expect(message.member?.roles.cache.has(role.id)).toBe(true);
    await f.handler.process(message);
    expect(f.post).toHaveBeenCalledTimes(1);
    f.client.config.moderation = { channel_blacklist: [channelId] };
    await f.handler.process(message);
    expect(f.post).toHaveBeenCalledTimes(1);
});

it("persists the replacement before an ownership-verified old deletion", async () => {
    const f = setup(1);
    await f.handler.process(f.message());
    const old = [...f.remote.keys()][0]!;
    const remove = f.del.getMockImplementation()!;
    f.del.mockImplementationOnce(async (...args) => {
        const state = f.state().channels[channelId];
        expect(state.canonical).not.toBe(old);
        expect(state.pending.id).toBe(old);
        expect(f.get.mock.calls.at(-1)![0]).toBe(`/channels/${channelId}/messages/${old}`);
        return remove(...args);
    });
    await f.handler.process(f.message());
    expect(f.del).toHaveBeenCalledTimes(1);
});

it("keeps the durable intent if persistence rollback cleanup also fails", async () => {
    const f = setup(1);
    await f.handler.process(f.message());
    const send = f.post.getMockImplementation()!;
    f.post.mockImplementationOnce(async (...args) => {
        const result = await send(...args);
        renameSync(f.path, f.path + ".backup");
        mkdirSync(f.path);
        return result;
    });
    f.del.mockRejectedValueOnce(new Error("cleanup failed"));
    await expect(f.handler.process(f.message())).rejects.toThrow(/cleanup failed/);
    expect(f.remote.size).toBe(2);
    rmSync(f.path, { recursive: true });
    renameSync(f.path + ".backup", f.path);
    await expect(new StickyPosts(f.client, f.path).process(f.message())).rejects.toThrow(/delivery/i);
    expect(f.post).toHaveBeenCalledTimes(2);
});

it("does not refresh semantically identical embeds with reordered JSON keys", async () => {
    const f = setup();
    f.client.config.sticky_posts!.channels[channelId]!.embed = {
        title: "x",
        description: "y",
        footer: { text: "z", icon_url: "https://example.com/icon.png" },
    };
    await f.handler.process(f.message());
    f.client.config.sticky_posts!.channels[channelId]!.embed = {
        footer: { icon_url: "https://example.com/icon.png", text: "z" },
        description: "y",
        title: "x",
    };
    await f.handler.reload();
    expect(f.post).toHaveBeenCalledTimes(1);
});

it("recreates a missing canonical during pending-deletion backoff without exceeding two posts", async () => {
    const f = setup(1);
    await f.handler.process(f.message());
    f.del.mockRejectedValueOnce(new Error("delete failed"));
    await expect(f.handler.process(f.message())).rejects.toThrow();
    const state = f.state().channels[channelId];
    f.remote.delete(state.canonical);
    await new StickyPosts(f.client, f.path).process(f.message());
    expect(f.post).toHaveBeenCalledTimes(3);
    expect(f.remote.size).toBe(2);
    expect(f.state().channels[channelId].pending.id).toBe(state.pending.id);
    expect(f.remote.has(f.state().channels[channelId].canonical)).toBe(true);
});

it("creates one mention-suppressed embed on the first human message", async () => {
    const f = setup();
    await f.handler.process(f.message());
    expect(f.post).toHaveBeenCalledTimes(1);
    const body = f.post.mock.calls[0]![1]!.body as any;
    expect(body.embeds).toEqual([{ description: "Synthetic information" }]);
    expect(body.enforce_nonce).toBe(true);
    expect(body.nonce).toMatch(/^[a-f0-9]{24}$/);
    expect(body.content).toBeUndefined();
    expect(body.components ?? []).toEqual([]);
    expect(body.allowed_mentions).toEqual({ parse: [], users: [], roles: [], replied_user: false });
});

const inactiveModes = ["disable", "remove", "blacklist", "loadFailed"] as const;
function deactivate(client: KrytenClient, mode: (typeof inactiveModes)[number]) {
    if (mode === "disable") client.config.sticky_posts!.enabled = false;
    if (mode === "remove") delete client.config.sticky_posts!.channels[channelId];
    if (mode === "blacklist") client.config.moderation = { channel_blacklist: [channelId] };
    if (mode === "loadFailed") client.configLoadFailed = true;
}

it.each(
    inactiveModes.flatMap(mode =>
        ["canonical", "ownership", "missing", "failure"].map(phase => [mode, phase] as const),
    ),
)("retains pending cleanup when %s occurs during %s fetch", async (mode, phase) => {
    const f = setup(1);
    await f.handler.process(f.message());
    f.del.mockRejectedValueOnce(new Error("temporary failure"));
    await expect(f.handler.process(f.message())).rejects.toThrow("temporary failure");
    const before = f.state().channels[channelId];
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000);
    f.del.mockClear();
    f.get.mockClear();
    const get = f.get.getMockImplementation()!;
    const save = vi.spyOn(StickyStore.prototype, "save");
    save.mockClear();
    f.get.mockImplementation(async (...args) => {
        const result = await get(...args);
        const target = phase === "canonical" ? before.canonical : before.pending.id;
        if (String(args[0]).endsWith(`/messages/${target}`)) {
            deactivate(f.client, mode);
            if (phase === "missing") throw Object.assign(new Error("Unknown Message"), { code: 10008 });
            if (phase === "failure") throw new Error("fetch failed after disable");
        }
        return result;
    });
    await f.handler.process(f.message());
    expect(f.del).not.toHaveBeenCalled();
    expect(f.post).toHaveBeenCalledTimes(2);
    expect(f.state().channels[channelId]).toEqual({ ...before, count: 1 });
    expect(save).toHaveBeenCalledTimes(1);
    if (phase === "canonical") expect(f.get).toHaveBeenCalledTimes(1);
    save.mockRestore();
});

it.each(inactiveModes)("skips nonessential saves when %s occurs during canonical fetch", async mode => {
    const f = setup(10);
    await f.handler.process(f.message());
    const get = f.get.getMockImplementation()!;
    f.get.mockImplementationOnce(async (...args) => {
        const result = await get(...args);
        deactivate(f.client, mode);
        return result;
    });
    const save = vi.spyOn(StickyStore.prototype, "save");
    await f.handler.process(f.message());
    expect(save).toHaveBeenCalledTimes(1);
    expect(f.state().channels[channelId].count).toBe(1);
});

it.each(inactiveModes)("persists a submitted send after %s without starting cleanup", async mode => {
    const f = setup(1);
    await f.handler.process(f.message());
    const old = f.state().channels[channelId].canonical;
    const send = f.post.getMockImplementation()!;
    f.post.mockImplementationOnce(async (...args) => {
        const result = await send(...args);
        deactivate(f.client, mode);
        return result;
    });
    f.get.mockClear();
    await f.handler.process(f.message());
    const state = f.state().channels[channelId];
    expect(state.canonical).not.toBe(old);
    expect(f.remote.has(state.canonical)).toBe(true);
    expect(state.intent).toBeUndefined();
    expect(state.pending).toEqual({ id: old, attempts: 0, retryAt: 0 });
    expect(f.del).not.toHaveBeenCalled();
    expect(f.get).toHaveBeenCalledTimes(1);
});

it.each(inactiveModes)("persists submitted deletion outcomes after %s", async mode => {
    for (const outcome of ["success", "missing", "failure"]) {
        const f = setup(1);
        await f.handler.process(f.message());
        const remove = f.del.getMockImplementation()!;
        f.del.mockImplementationOnce(async (...args) => {
            deactivate(f.client, mode);
            if (outcome === "failure") throw new Error("delete failed");
            await remove(...args);
            if (outcome === "missing") throw Object.assign(new Error("Unknown Message"), { code: 10008 });
        });
        const work = f.handler.process(f.message());
        if (outcome === "failure") await expect(work).rejects.toThrow("delete failed");
        else await work;
        const state = f.state().channels[channelId];
        expect(f.remote.has(state.canonical)).toBe(true);
        if (outcome === "failure") expect(state.pending.attempts).toBe(1);
        else expect(state.pending).toBeUndefined();
    }
});

it("reload still refreshes a healthy channel after another channel has uncertain delivery", async () => {
    const f = setup(1);
    const secondId = "723456789012345678";
    // @ts-expect-error Native SDK fixture; REST transport is mocked.
    const second = new TextChannel(f.channel.guild, { id: secondId, type: 0, name: "second" }, f.client);
    f.client.channels.cache.set(secondId, second);
    f.client.config.sticky_posts!.channels[secondId] = structuredClone(
        f.client.config.sticky_posts!.channels[channelId]!,
    );
    await f.handler.process(f.message());
    const message = f.message();
    message.channelId = secondId;
    await f.handler.process(message);
    const secondCanonical = f.state().channels[secondId].canonical;
    f.post.mockRejectedValueOnce(new Error("uncertain transport"));
    await expect(f.handler.process(f.message())).rejects.toThrow("uncertain transport");
    const blocked = f.state().channels[channelId];
    f.client.config.sticky_posts!.channels[secondId]!.embed.description = "Updated healthy channel";
    const error = await f.handler.reload().catch(error => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.message).toContain(channelId);
    expect(error.errors[0].message).toContain("delivery");
    expect(f.state().channels[channelId]).toEqual(blocked);
    expect(f.remote.has(secondCanonical)).toBe(false);
    expect(
        [...f.remote.values()].some(
            value => value.channel_id === secondId && value.embeds[0].description === "Updated healthy channel",
        ),
    ).toBe(true);
});
