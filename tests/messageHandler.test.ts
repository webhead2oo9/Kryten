import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    handleMessage,
    handleMessageDelete,
    handleMessageDeleteBulk,
    handleMessageUpdate,
} from "../src/handlers/messageHandler";
import { KrytenClient } from "../src/classes/client";
import { Message, PartialMessage } from "discord.js";

// The module-scope feature registry is built once from real feature
// constructors. Replace those constructors/handlers with controllable spies so
// the tests exercise the REAL handleMessage/handleMessageDelete pipeline loop
// (bot short-circuit, config gate, blacklist, stop-on-true, throw isolation)
// while owning what every feature does.
const H = vi.hoisted(() => ({
    imageProcess: vi.fn(),
    crosspostCheck: vi.fn(),
    crosspostDelete: vi.fn(),
    autoProcess: vi.fn(),
    betaProcess: vi.fn(),
    betaRespond: vi.fn(),
    modPing: vi.fn(),
    twitter: vi.fn(),
    logCapture: vi.fn(),
    logEdit: vi.fn(),
    logDelete: vi.fn(),
    logBulk: vi.fn(),
}));

vi.mock("../src/features/imageFingerprint/imageFingerprintHandler", () => ({
    ImageFingerprintHandler: class {
        process = H.imageProcess;
    },
    // Faithful copy of the real gate so the registry tests can drive it via config.
    imageFingerprintEnabled: (config: KrytenClient["config"]) => config.moderation?.image_fingerprint?.enabled ?? false,
}));
vi.mock("../src/features/crosspost/crosspostHandler", () => ({
    CrosspostHandler: class {
        process = H.crosspostCheck;
        handleMessageDeletion = H.crosspostDelete;
    },
    crosspostEnabled: (config: KrytenClient["config"]) => config.moderation?.crosspost?.enabled ?? true,
}));
vi.mock("../src/features/autoresponder/autoResponder", () => ({
    AutoResponder: class {
        process = H.autoProcess;
        constructor(private readonly client: KrytenClient) {}
        isConfigured(): boolean {
            return !!this.client.config.auto_responder?.random_greeting_channel_id;
        }
    },
}));
vi.mock("../src/features/userInteractions/store", () => ({
    UserInteractionStore: class {
        reconcileClassifierCampaigns = vi.fn(async () => undefined);
    },
}));
vi.mock("../src/features/betaClassifier/betaClassifier", () => ({
    BetaClassifier: class {
        process = H.betaProcess;
    },
}));
vi.mock("../src/features/betaResponder/betaResponder", () => ({
    BetaResponder: class {
        process = H.betaRespond;
    },
}));
vi.mock("../src/features/moderation/modPing", () => ({
    handleModPing: H.modPing,
}));
vi.mock("../src/features/twitter/twitterHandler", () => ({
    handleTwitterLinks: H.twitter,
}));
vi.mock("../src/features/messageLogging/messageLogger", () => ({
    MessageLogger: class {
        capture = H.logCapture;
        captureEdit = H.logEdit;
        captureDelete = H.logDelete;
        captureBulk = H.logBulk;
        isEnabled = () => true;
    },
}));

const onMessageSpies = [
    H.logCapture,
    H.imageProcess,
    H.modPing,
    H.betaProcess,
    H.betaRespond,
    H.autoProcess,
    H.crosspostCheck,
    H.twitter,
];

function fullConfig() {
    return {
        moderation: {
            image_fingerprint: { enabled: true },
            mod_role_id: "role-1",
            crosspost: { enabled: true },
            channel_blacklist: [] as string[],
        },
        auto_responder: { random_greeting_channel_id: "greet-1" },
        llm_classifier: { enabled: true, provider: "fireworks" as const, model: "example" },
        beta_classifier: {
            enabled: true,
            response_enabled: false,
            target_greeting_enabled: true,
            announcements_channel_id: "announcements-1",
            guild_id: "guild-1",
            campaign_id: "synthetic-beta",
            campaign_started_at: new Date(Date.now() - 1_000).toISOString(),
            included_channel_ids: ["chan-1"],
            target_channel_id: "beta-1",
            announcement_url: "https://discord.com/channels/guild/channel/message",
            prompt_file: "/private/beta-prompt.json",
        },
        twitter: { enabled: true },
        logging: { enabled: true },
    };
}

function makeClient(overrides: Record<string, unknown> = {}): KrytenClient {
    return {
        config: fullConfig(),
        configLoadFailed: false,
        logError: vi.fn(async () => undefined),
        ...overrides,
    } as unknown as KrytenClient;
}

function makeMessage(overrides: Record<string, unknown> = {}): Message {
    return {
        author: { bot: false },
        channelId: "chan-1",
        channel: { isThread: () => false },
        ...overrides,
    } as unknown as Message;
}

beforeEach(() => {
    for (const spy of Object.values(H)) spy.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe("handleMessage short-circuits", () => {
    it("returns before any feature hook when the author is a bot", async () => {
        const client = makeClient();
        await handleMessage(makeMessage({ author: { bot: true } }), client);

        for (const spy of onMessageSpies) expect(spy).not.toHaveBeenCalled();
        expect(client.logError).not.toHaveBeenCalled();
    });

    it("returns before any feature hook when config failed to load", async () => {
        const client = makeClient({ configLoadFailed: true });
        await handleMessage(makeMessage(), client);

        for (const spy of onMessageSpies) expect(spy).not.toHaveBeenCalled();
    });

    it("returns before any feature hook when the channel is blacklisted", async () => {
        const config = fullConfig();
        config.moderation.channel_blacklist = ["chan-1"];
        const client = makeClient({ config });
        await handleMessage(makeMessage({ channelId: "chan-1" }), client);

        for (const spy of onMessageSpies) expect(spy).not.toHaveBeenCalled();
    });

    it("returns when the message's thread lives under a blacklisted parent channel", async () => {
        const config = fullConfig();
        config.moderation.channel_blacklist = ["parent-1"];
        const client = makeClient({ config });
        const message = makeMessage({
            channelId: "thread-1",
            channel: { isThread: () => true, parentId: "parent-1" },
        });
        await handleMessage(message, client);

        for (const spy of onMessageSpies) expect(spy).not.toHaveBeenCalled();
    });
});

describe("handleMessage pipeline semantics", () => {
    it("runs every enabled feature in registry order when none short-circuit", async () => {
        const client = makeClient();
        await handleMessage(makeMessage(), client);

        for (const spy of onMessageSpies) expect(spy).toHaveBeenCalledTimes(1);
        const callOrder = onMessageSpies.map(spy => spy.mock.invocationCallOrder[0]!);
        for (let i = 1; i < callOrder.length; i++) {
            expect(callOrder[i]!).toBeGreaterThan(callOrder[i - 1]!);
        }
        expect(client.logError).not.toHaveBeenCalled();
    });

    it("stops the pipeline when a feature's onMessage resolves true", async () => {
        H.imageProcess.mockResolvedValue(true);
        const client = makeClient();
        await handleMessage(makeMessage(), client);

        expect(H.imageProcess).toHaveBeenCalledTimes(1);
        expect(H.modPing).not.toHaveBeenCalled();
        expect(H.betaProcess).not.toHaveBeenCalled();
        expect(H.betaRespond).not.toHaveBeenCalled();
        expect(H.autoProcess).not.toHaveBeenCalled();
        expect(H.crosspostCheck).not.toHaveBeenCalled();
        expect(H.twitter).not.toHaveBeenCalled();
    });

    it("does not stop the pipeline when onMessage resolves a falsy value", async () => {
        H.imageProcess.mockResolvedValue(false);
        H.modPing.mockResolvedValue(undefined);
        const client = makeClient();
        await handleMessage(makeMessage(), client);

        for (const spy of onMessageSpies) expect(spy).toHaveBeenCalledTimes(1);
    });

    it("isolates a throwing feature: error routed to logError, later features still run", async () => {
        H.modPing.mockRejectedValue(new Error("mod boom"));
        const client = makeClient();
        await handleMessage(makeMessage(), client);

        // The earlier feature ran, the thrower was caught, and every later
        // feature still executed — one feature can't take down the pipeline.
        for (const spy of onMessageSpies) expect(spy).toHaveBeenCalledTimes(1);
        expect(client.logError).toHaveBeenCalledTimes(1);
        expect(client.logError).toHaveBeenCalledWith(expect.stringContaining("mod-ping"), expect.any(Error));
    });

    it("skips a feature whose enabled() gate returns false", async () => {
        const config = fullConfig();
        config.moderation.image_fingerprint.enabled = false;
        const client = makeClient({ config });
        await handleMessage(makeMessage(), client);

        expect(H.imageProcess).not.toHaveBeenCalled();
        expect(H.modPing).toHaveBeenCalledTimes(1);
        expect(H.betaProcess).toHaveBeenCalledTimes(1);
        expect(H.betaRespond).toHaveBeenCalledTimes(1);
        expect(H.autoProcess).toHaveBeenCalledTimes(1);
        expect(H.crosspostCheck).toHaveBeenCalledTimes(1);
        expect(H.twitter).toHaveBeenCalledTimes(1);
    });
});

describe("handleMessageDelete pipeline semantics", () => {
    function deletedMessage(): Message | PartialMessage {
        return { id: "gone-1" } as unknown as PartialMessage;
    }

    it("dispatches only to features exposing onMessageDelete", async () => {
        const client = makeClient();
        await handleMessageDelete(deletedMessage(), client);

        expect(H.logDelete).toHaveBeenCalledTimes(1);
        expect(H.crosspostDelete).toHaveBeenCalledTimes(1);
        for (const spy of onMessageSpies) expect(spy).not.toHaveBeenCalled();
    });

    it("returns before any hook when config failed to load", async () => {
        const client = makeClient({ configLoadFailed: true });
        await handleMessageDelete(deletedMessage(), client);

        expect(H.crosspostDelete).not.toHaveBeenCalled();
        expect(H.logDelete).not.toHaveBeenCalled();
    });

    it("skips an onMessageDelete feature whose enabled() gate returns false", async () => {
        const config = fullConfig();
        config.moderation.crosspost.enabled = false;
        const client = makeClient({ config });
        await handleMessageDelete(deletedMessage(), client);

        expect(H.crosspostDelete).not.toHaveBeenCalled();
    });

    it("isolates a throwing onMessageDelete hook and routes the error to logError", async () => {
        H.crosspostDelete.mockRejectedValue(new Error("delete boom"));
        const client = makeClient();
        await handleMessageDelete(deletedMessage(), client);

        expect(client.logError).toHaveBeenCalledTimes(1);
        expect(client.logError).toHaveBeenCalledWith(expect.stringContaining("crosspost"), expect.any(Error));
    });
});

describe("message lifecycle pipeline hooks", () => {
    it("dispatches message updates to the logging feature", async () => {
        const client = makeClient();
        const before = makeMessage({ content: "before" });
        const after = makeMessage({ content: "after" });

        await handleMessageUpdate(before, after, client);

        expect(H.logEdit).toHaveBeenCalledWith(before, after);
    });

    it("groups logging for bulk deletes while preserving per-message legacy delete hooks", async () => {
        const client = makeClient();
        const first = deletedMessage("gone-1");
        const second = deletedMessage("gone-2");
        const messages = new Map([
            [first.id, first],
            [second.id, second],
        ]) as never;

        await handleMessageDeleteBulk(messages, client);

        expect(H.logBulk).toHaveBeenCalledTimes(1);
        expect(H.crosspostDelete).toHaveBeenCalledTimes(2);
    });

    it("keeps processing a bulk delete after one message throws in the legacy fallback", async () => {
        H.crosspostDelete.mockRejectedValueOnce(new Error("bad partial"));
        const client = makeClient();
        const messages = new Map([
            ["gone-1", deletedMessage("gone-1")],
            ["gone-2", deletedMessage("gone-2")],
            ["gone-3", deletedMessage("gone-3")],
        ]) as never;

        await handleMessageDeleteBulk(messages, client);

        expect(H.crosspostDelete).toHaveBeenCalledTimes(3);
        expect(client.logError).toHaveBeenCalledTimes(1);
    });
});

function deletedMessage(id: string): PartialMessage {
    return { id } as unknown as PartialMessage;
}
