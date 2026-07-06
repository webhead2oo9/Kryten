import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPoller } from "../src/github/poller";

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/**
 * Build a CommandPoller wired to a fake KrytenClient. Everything the poller
 * touches flows through this: the commandSync surface (filesClient /
 * fetchRemoteDigest / getDigest / lastLoadSource / loadAll), registration
 * hooks, and logError. `state` is mutated by tests (and by loadAll overrides)
 * so a single tick can move lastLoadSource the way a real reload would.
 */
function setup(
    opts: {
        githubPollMinutes?: number;
        currentDigest?: string;
        remoteDigest?: string | null;
        lastLoadSource?: string;
        hasFiles?: boolean;
    } = {},
) {
    const state = {
        currentDigest: opts.currentDigest,
        remoteDigest: opts.remoteDigest ?? null,
        lastLoadSource: opts.lastLoadSource ?? "github",
        hasFiles: opts.hasFiles ?? true,
    };
    const order: string[] = [];

    const fetchRemoteDigest = vi.fn(async () => {
        order.push("fetch");
        return state.remoteDigest;
    });
    const files = { fetchRemoteDigest };

    const loadAll = vi.fn(async () => client.custom_commands);
    const commandSync = {
        filesClient: () => (state.hasFiles ? files : null),
        getDigest: () => state.currentDigest,
        get lastLoadSource() {
            return state.lastLoadSource;
        },
        loadAll,
    };

    const registerApplicationCommands = vi.fn(async () => {
        order.push("register");
    });
    const registerIfChanged = vi.fn(async () => false);
    const logError = vi.fn(async () => undefined);

    const client = {
        config: { githubPollMinutes: opts.githubPollMinutes },
        commandSync,
        custom_commands: [] as unknown[],
        registerApplicationCommands,
        registerIfChanged,
        logError,
    };

    const poller = new CommandPoller(client as never);
    return {
        poller,
        client,
        state,
        order,
        fetchRemoteDigest,
        loadAll,
        registerApplicationCommands,
        registerIfChanged,
        logError,
    };
}

function pending(poller: CommandPoller): boolean {
    return (poller as unknown as { registrationPending: boolean }).registrationPending;
}

describe("CommandPoller intervalMs / start", () => {
    it("disables when githubPollMinutes <= 0", () => {
        expect((setup({ githubPollMinutes: 0 }).poller as never as { intervalMs(): number }).intervalMs()).toBe(0);
        expect((setup({ githubPollMinutes: -5 }).poller as never as { intervalMs(): number }).intervalMs()).toBe(0);
    });

    it("defaults to 60 minutes when githubPollMinutes is unset", () => {
        expect((setup({}).poller as never as { intervalMs(): number }).intervalMs()).toBe(3_600_000);
    });

    it("caps an absurd interval at the setInterval busy-loop guard (2^31-1 ms)", () => {
        expect((setup({ githubPollMinutes: 1e9 }).poller as never as { intervalMs(): number }).intervalMs()).toBe(
            2_147_483_647,
        );
    });

    it("start schedules no timer when the interval is disabled", () => {
        const t = setup({ githubPollMinutes: 0 });
        t.poller.start();
        expect((t.poller as unknown as { timer?: unknown }).timer).toBeUndefined();
    });

    it("start schedules no timer when GitHub is not configured", () => {
        const t = setup({ githubPollMinutes: 1, hasFiles: false });
        t.poller.start();
        expect((t.poller as unknown as { timer?: unknown }).timer).toBeUndefined();
    });

    it("start runs a checkNow tick on each configured interval", async () => {
        vi.useFakeTimers();
        const t = setup({ githubPollMinutes: 1, currentDigest: "D", remoteDigest: "D", lastLoadSource: "github" });
        t.poller.start();
        expect(t.fetchRemoteDigest).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(t.fetchRemoteDigest).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(t.fetchRemoteDigest).toHaveBeenCalledTimes(2);
        t.poller.stop();
    });
});

describe("CommandPoller checkNow digest handling", () => {
    it("does not reload when the remote digest equals the current and the corpus is on GitHub", async () => {
        const t = setup({ currentDigest: "D", remoteDigest: "D", lastLoadSource: "github" });
        await t.poller.checkNow();
        expect(t.loadAll).not.toHaveBeenCalled();
        expect(t.registerIfChanged).not.toHaveBeenCalled();
    });

    it("reloads and re-registers on a changed digest when the reload lands on GitHub", async () => {
        const t = setup({ currentDigest: "D1", remoteDigest: "D2", lastLoadSource: "github" });
        t.loadAll.mockImplementation(async () => {
            t.state.lastLoadSource = "github";
            return [];
        });
        await t.poller.checkNow();
        expect(t.loadAll).toHaveBeenCalledTimes(1);
        expect(t.registerIfChanged).toHaveBeenCalledTimes(1);
    });

    it("does not consume a changed digest when the reload falls back to cache, and warns", async () => {
        const t = setup({ currentDigest: "D1", remoteDigest: "D2", lastLoadSource: "github" });
        t.loadAll.mockImplementation(async () => {
            t.state.lastLoadSource = "cache";
            return [];
        });
        await t.poller.checkNow();
        expect(t.loadAll).toHaveBeenCalledTimes(1);
        expect(t.registerIfChanged).not.toHaveBeenCalled();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("fell back to the local snapshot"));
    });

    it("forces a reload to escape the cache fallback even when digests are equal, then stops forcing", async () => {
        const t = setup({ currentDigest: "D", remoteDigest: "D", lastLoadSource: "cache" });
        t.loadAll.mockImplementation(async () => {
            t.state.lastLoadSource = "github";
            return [];
        });
        await t.poller.checkNow();
        expect(t.loadAll).toHaveBeenCalledTimes(1);

        // Now on GitHub with the same digest — the next tick is a plain no-op.
        await t.poller.checkNow();
        expect(t.loadAll).toHaveBeenCalledTimes(1);
    });
});

describe("CommandPoller registrationPending retry", () => {
    it("retries the pending registration before the digest check and clears it on success", async () => {
        const t = setup({ currentDigest: "D", remoteDigest: "D", lastLoadSource: "github" });
        t.poller.markRegistrationPending();
        await t.poller.checkNow();
        expect(t.registerApplicationCommands).toHaveBeenCalledTimes(1);
        expect(pending(t.poller)).toBe(false);
        // Registration is retried BEFORE the digest listing is fetched.
        expect(t.order).toEqual(["register", "fetch"]);
    });

    it("keeps the flag set when the retry throws, then clears it on the next successful retry", async () => {
        const t = setup({ currentDigest: "D", remoteDigest: "D", lastLoadSource: "github" });
        t.registerApplicationCommands.mockRejectedValueOnce(new Error("discord 5xx"));
        t.poller.markRegistrationPending();
        await t.poller.checkNow();
        expect(pending(t.poller)).toBe(true);

        await t.poller.checkNow();
        expect(pending(t.poller)).toBe(false);
    });

    it("does not clear the flag on a content-only reload where registerIfChanged returns false", async () => {
        const t = setup({ currentDigest: "D1", remoteDigest: "D2", lastLoadSource: "github" });
        // The top-of-tick retry fails, so the flag survives into the reload path.
        t.registerApplicationCommands.mockRejectedValue(new Error("still down"));
        t.loadAll.mockImplementation(async () => {
            t.state.lastLoadSource = "github";
            return [];
        });
        t.registerIfChanged.mockResolvedValue(false);
        t.poller.markRegistrationPending();

        await t.poller.checkNow();

        expect(t.registerIfChanged).toHaveBeenCalledTimes(1);
        expect(pending(t.poller)).toBe(true);
    });

    it("clears the flag when a reload's registerIfChanged actually re-registers", async () => {
        const t = setup({ currentDigest: "D1", remoteDigest: "D2", lastLoadSource: "github" });
        t.registerApplicationCommands.mockRejectedValue(new Error("down"));
        t.loadAll.mockImplementation(async () => {
            t.state.lastLoadSource = "github";
            return [];
        });
        t.registerIfChanged.mockResolvedValue(true);
        t.poller.markRegistrationPending();

        await t.poller.checkNow();

        expect(t.registerIfChanged).toHaveBeenCalledTimes(1);
        expect(pending(t.poller)).toBe(false);
    });

    it("marks registration pending when a reload's slash registration throws", async () => {
        const t = setup({ currentDigest: "D1", remoteDigest: "D2", lastLoadSource: "github" });
        t.loadAll.mockImplementation(async () => {
            t.state.lastLoadSource = "github";
            return [];
        });
        t.registerIfChanged.mockRejectedValue(new Error("discord fail"));

        await t.poller.checkNow();

        expect(pending(t.poller)).toBe(true);
        expect(t.logError).toHaveBeenCalledWith("Command Registration Retry Pending", expect.anything());
    });
});

describe("CommandPoller unreachable-repo alerting", () => {
    it("alerts exactly once across consecutive failing ticks, then again after a recovery", async () => {
        const t = setup({ currentDigest: "D", remoteDigest: null, lastLoadSource: "github" });

        await t.poller.checkNow(); // fail 1 → alert
        await t.poller.checkNow(); // fail 2 → suppressed (edge-triggered)
        const firstOutage = t.logError.mock.calls.filter(c => c[0] === "Command Poller Cannot Reach Repo");
        expect(firstOutage).toHaveLength(1);

        // Recover, then fail again — a fresh edge fires a second alert.
        t.state.remoteDigest = "D";
        await t.poller.checkNow();
        t.state.remoteDigest = null;
        await t.poller.checkNow();
        const bothOutages = t.logError.mock.calls.filter(c => c[0] === "Command Poller Cannot Reach Repo");
        expect(bothOutages).toHaveLength(2);
    });
});

describe("CommandPoller reentrancy", () => {
    it("ignores a checkNow entered while another tick is still in flight", async () => {
        const t = setup({ currentDigest: "D1", remoteDigest: "D2", lastLoadSource: "github" });
        let release!: () => void;
        const gate = new Promise<void>(r => {
            release = r;
        });
        t.loadAll.mockImplementation(async () => {
            await gate;
            t.state.lastLoadSource = "github";
            return [];
        });

        const first = t.poller.checkNow();
        await t.poller.checkNow(); // guarded: returns immediately, does no work

        // The second call never reached the listing fetch.
        expect(t.fetchRemoteDigest).toHaveBeenCalledTimes(1);

        release();
        await first;
        expect(t.loadAll).toHaveBeenCalledTimes(1);
        expect(t.fetchRemoteDigest).toHaveBeenCalledTimes(1);
    });
});
