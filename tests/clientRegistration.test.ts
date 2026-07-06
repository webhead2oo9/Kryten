import { ApplicationCommandOptionType, ApplicationCommandType } from "discord.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KrytenClient } from "../src/classes/client";

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let originalGuildId: string | undefined;

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    originalGuildId = process.env["GUILD_ID"];
});

afterEach(() => {
    if (originalGuildId === undefined) delete process.env["GUILD_ID"];
    else process.env["GUILD_ID"] = originalGuildId;
    vi.restoreAllMocks();
});

/**
 * A KrytenClient stand-in whose prototype chain is the real class (so
 * registration methods that call sibling prototype methods work) but whose
 * constructor never runs — the real ctor needs Discord internals + config.json.
 * Own properties shadow prototype methods where a test wants a spy.
 */
function fakeClient(fields: Record<string, unknown>): KrytenClient {
    return Object.assign(Object.create(KrytenClient.prototype), fields) as KrytenClient;
}

/** Minimal loaded-classes stand-in: only `.has` is exercised. */
function loadedClasses(names: string[]): Map<string, unknown> {
    return new Map(names.map(n => [n, {}]));
}

function customCmd(name: string, description: string) {
    return { format: 2, name, description, blocks: [{ type: "text", text: description }] };
}

describe("buildCustomCommandPayload", () => {
    it("maps custom commands to type:1 payloads with a hidden boolean option", () => {
        const client = fakeClient({
            custom_commands: [customCmd("wifi", "wifi help")],
            commands: { loaded_classes: loadedClasses([]) },
        });

        const payload = KrytenClient.prototype.buildCustomCommandPayload.call(client) as any[];

        expect(payload).toHaveLength(1);
        expect(payload[0]).toMatchObject({
            type: ApplicationCommandType.ChatInput,
            name: "wifi",
            description: "wifi help",
        });
        expect(payload[0].options[0]).toMatchObject({
            type: ApplicationCommandOptionType.Boolean,
            name: "hidden",
        });
    });

    it("filters out a custom command whose name collides with a loaded built-in", () => {
        const client = fakeClient({
            custom_commands: [customCmd("ping", "collides"), customCmd("wifi", "wifi help")],
            commands: { loaded_classes: loadedClasses(["ping"]) },
        });

        const payload = KrytenClient.prototype.buildCustomCommandPayload.call(client) as any[];

        expect(payload.map(p => p.name)).toEqual(["wifi"]);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("collides with a built-in"));
    });
});

describe("registerIfChanged", () => {
    function makeClient(current: ReturnType<typeof customCmd>[]) {
        const registerApplicationCommands = vi.fn(async () => undefined);
        const client = fakeClient({
            custom_commands: current,
            registerApplicationCommands,
        });
        return { client, registerApplicationCommands };
    }

    it("returns false and does not register when the (name, description) set is unchanged (any order)", async () => {
        const { client, registerApplicationCommands } = makeClient([customCmd("a", "A"), customCmd("b", "B")]);

        const changed = await client.registerIfChanged([customCmd("b", "B"), customCmd("a", "A")]);

        expect(changed).toBe(false);
        expect(registerApplicationCommands).not.toHaveBeenCalled();
    });

    it("registers and returns true on a description-only change", async () => {
        const { client, registerApplicationCommands } = makeClient([customCmd("a", "A2")]);

        const changed = await client.registerIfChanged([customCmd("a", "A1")]);

        expect(changed).toBe(true);
        expect(registerApplicationCommands).toHaveBeenCalledTimes(1);
    });

    it("registers and returns true on a rename", async () => {
        const { client, registerApplicationCommands } = makeClient([customCmd("c", "A")]);

        const changed = await client.registerIfChanged([customCmd("a", "A")]);

        expect(changed).toBe(true);
        expect(registerApplicationCommands).toHaveBeenCalledTimes(1);
    });

    it("registers and returns true on an addition", async () => {
        const { client, registerApplicationCommands } = makeClient([customCmd("a", "A"), customCmd("b", "B")]);

        const changed = await client.registerIfChanged([customCmd("a", "A")]);

        expect(changed).toBe(true);
        expect(registerApplicationCommands).toHaveBeenCalledTimes(1);
    });

    it("registers and returns true on a removal", async () => {
        const { client, registerApplicationCommands } = makeClient([customCmd("a", "A")]);

        const changed = await client.registerIfChanged([customCmd("a", "A"), customCmd("b", "B")]);

        expect(changed).toBe(true);
        expect(registerApplicationCommands).toHaveBeenCalledTimes(1);
    });
});

describe("registerApplicationCommands guards", () => {
    it("warns and does not register when client.application is missing", async () => {
        process.env["GUILD_ID"] = "guild-1";
        const client = fakeClient({
            application: undefined,
            commands: { loaded_classes: loadedClasses([]), createPostBody: () => [] },
            contexts: { createPostBody: () => [] },
            custom_commands: [],
        });

        await client.registerApplicationCommands();

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping command registration"));
    });

    it("warns and does not register (never globally) when GUILD_ID is missing", async () => {
        delete process.env["GUILD_ID"];
        const set = vi.fn(async () => undefined);
        const client = fakeClient({
            application: { commands: { set } },
            commands: { loaded_classes: loadedClasses([]), createPostBody: () => [] },
            contexts: { createPostBody: () => [] },
            custom_commands: [],
        });

        await client.registerApplicationCommands();

        expect(set).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping command registration"));
    });

    it("registers built-ins + contexts + custom (collision filtered) as guild commands", async () => {
        process.env["GUILD_ID"] = "guild-1";
        const set = vi.fn(async () => undefined);
        const client = fakeClient({
            application: { commands: { set } },
            commands: {
                loaded_classes: loadedClasses(["ping"]),
                createPostBody: () => [{ type: ApplicationCommandType.ChatInput, name: "ping", description: "builtin" }],
            },
            contexts: { createPostBody: () => [{ type: ApplicationCommandType.Message, name: "ctx" }] },
            custom_commands: [customCmd("ping", "collides"), customCmd("wifi", "wifi help")],
        });

        await client.registerApplicationCommands();

        expect(set).toHaveBeenCalledTimes(1);
        const [payload, guildId] = set.mock.calls[0] as [any[], string];
        expect(guildId).toBe("guild-1");
        // builtins, contexts, then only the non-colliding custom command.
        expect(payload.map(p => p.name)).toEqual(["ping", "ctx", "wifi"]);
    });
});

describe("registerBuiltinsPreservingCustom", () => {
    function makeClient(existing: unknown[], builtinNames: string[]) {
        const set = vi.fn(async () => undefined);
        const fetch = vi.fn(async () => existing);
        const client = fakeClient({
            application: { commands: { fetch, set } },
            commands: {
                loaded_classes: loadedClasses(builtinNames),
                createPostBody: () =>
                    builtinNames.map(n => ({ type: ApplicationCommandType.ChatInput, name: n, description: n })),
            },
            contexts: { createPostBody: () => [{ type: ApplicationCommandType.Message, name: "ctx" }] },
        });
        return { client, set, fetch };
    }

    it("re-registers preserved custom commands alongside built-ins and contexts", async () => {
        process.env["GUILD_ID"] = "guild-1";
        const existing = [
            { type: ApplicationCommandType.ChatInput, name: "wifi", description: "wifi help" },
            { type: ApplicationCommandType.ChatInput, name: "ping", description: "builtin dup" },
            { type: ApplicationCommandType.User, name: "Report User", description: "" },
        ];
        const { client, set, fetch } = makeClient(existing, ["ping"]);

        await client.registerBuiltinsPreservingCustom();

        expect(fetch).toHaveBeenCalledWith({ guildId: "guild-1" });
        expect(set).toHaveBeenCalledTimes(1);
        const [payload, guildId] = set.mock.calls[0] as [any[], string];
        expect(guildId).toBe("guild-1");

        const names = payload.map(p => p.name);
        expect(names).toContain("wifi"); // preserved (custom, not built-in-backed)
        expect(names).toContain("ctx"); // context
        // 'ping' is built-in-backed and the User-type entry is not ChatInput —
        // neither is preserved; 'ping' appears exactly once (the built-in).
        expect(names.filter(n => n === "ping")).toHaveLength(1);
        expect(names).not.toContain("Report User");

        const wifi = payload.find(p => p.name === "wifi")!;
        expect(wifi).toMatchObject({ type: ApplicationCommandType.ChatInput });
        expect(wifi.options[0]).toMatchObject({ name: "hidden" });
    });

    it("leaves registration untouched when the existing-commands fetch rejects", async () => {
        process.env["GUILD_ID"] = "guild-1";
        const set = vi.fn(async () => undefined);
        const fetch = vi.fn(async () => {
            throw new Error("fetch failed");
        });
        const client = fakeClient({
            application: { commands: { fetch, set } },
            commands: { loaded_classes: loadedClasses([]), createPostBody: () => [] },
            contexts: { createPostBody: () => [] },
        });

        await client.registerBuiltinsPreservingCustom();

        expect(set).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(
            expect.stringContaining("leaving registration unchanged"),
            expect.anything(),
        );
    });

    it("warns and does not register when GUILD_ID is missing", async () => {
        delete process.env["GUILD_ID"];
        const set = vi.fn(async () => undefined);
        const fetch = vi.fn(async () => []);
        const client = fakeClient({
            application: { commands: { fetch, set } },
            commands: { loaded_classes: loadedClasses([]), createPostBody: () => [] },
            contexts: { createPostBody: () => [] },
        });

        await client.registerBuiltinsPreservingCustom();

        expect(fetch).not.toHaveBeenCalled();
        expect(set).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping command registration"));
    });
});
