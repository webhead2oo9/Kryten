import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    ensureProposalService,
    handleProposalButton,
    resolveProposalProposerLabel,
} from "../src/handlers/proposalHandler";

describe("resolveProposalProposerLabel", () => {
    it("resolves discord_user proposers to guild display names with the id below", async () => {
        const memberFetch = vi.fn(async () => ({ displayName: " Alice\nExample " }));
        const userFetch = vi.fn();
        const label = await resolveProposalProposerLabel(
            {
                guilds: { cache: new Map() },
                users: { fetch: userFetch },
            } as any,
            "discord_user:134295609287901184",
            { members: { fetch: memberFetch } } as any,
        );

        expect(label).toBe("Alice Example\n-# ID: 134295609287901184");
        expect(memberFetch).toHaveBeenCalledWith("134295609287901184");
        expect(userFetch).not.toHaveBeenCalled();
    });

    it("falls back to the user profile when the guild member cannot be fetched", async () => {
        const label = await resolveProposalProposerLabel(
            {
                guilds: { cache: new Map() },
                users: { fetch: vi.fn(async () => ({ globalName: "Global Name", username: "username" })) },
            } as any,
            "discord_user:134295609287901184",
            { members: { fetch: vi.fn(async () => null) } } as any,
        );

        expect(label).toBe("Global Name\n-# ID: 134295609287901184");
    });

    it("leaves non-discord proposer labels unchanged", async () => {
        await expect(
            resolveProposalProposerLabel({ guilds: { cache: new Map() }, users: { fetch: vi.fn() } } as any, "llm-bot"),
        ).resolves.toBe("llm-bot");
    });
});

describe("ensureProposalService teardown gating", () => {
    beforeEach(() => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("stops and clears the service immediately when disabled and idle", () => {
        const stop = vi.fn();
        const client: any = {
            config: { proposals: { enabled: false } },
            proposalService: { busy: false, stop, runWhenIdle: vi.fn(), store: { ttlMs: 1, dbPath: "x" } },
        };
        ensureProposalService(client);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(client.proposalService).toBeUndefined();
    });

    it("defers the stop while an approve is in flight (no close under the running approve)", () => {
        const stop = vi.fn();
        const runWhenIdle = vi.fn();
        const client: any = {
            config: { proposals: { enabled: false } },
            proposalService: { busy: true, stop, runWhenIdle, store: { ttlMs: 1, dbPath: "x" } },
        };
        ensureProposalService(client);
        expect(stop).not.toHaveBeenCalled();
        expect(runWhenIdle).toHaveBeenCalledTimes(1);
        expect(typeof runWhenIdle.mock.calls[0]![0]).toBe("function");
        // Service is left in place; the deferred reconcile tears it down later.
        expect(client.proposalService).toBeDefined();
    });

    it("acquires the gate before acknowledging a resolution click", async () => {
        let releaseAck: (() => void) | undefined;
        const ackGate = new Promise<void>(resolve => {
            releaseAck = resolve;
        });
        let busy = false;
        let onIdle: (() => void) | undefined;
        const stop = vi.fn();
        const approveProposal = vi.fn(async () => ({
            ok: false,
            status: "already_resolved",
            message: "Resolution is already applying.",
            resolved: { status: "applying" },
        }));
        const service = {
            get busy() {
                return busy;
            },
            store: { ttlMs: 1, dbPath: "x" },
            stop,
            runWhenIdle: vi.fn((fn: () => void) => {
                if (busy) onIdle = fn;
                else fn();
            }),
            acquireResolutionGate: vi.fn(() => {
                busy = true;
                return () => {
                    busy = false;
                    const fn = onIdle;
                    onIdle = undefined;
                    fn?.();
                };
            }),
            approveProposal,
            rejectProposal: vi.fn(),
        };
        const interaction: any = {
            customId: `cmdprop:approve:${"a".repeat(32)}`,
            member: { roles: ["staff"] },
            user: { username: "alice", globalName: "Alice" },
            inCachedGuild: () => false,
            deferUpdate: vi.fn(() => ackGate),
            followUp: vi.fn(async () => undefined),
            reply: vi.fn(async () => undefined),
        };
        const client: any = {
            config: { staff_roles: ["staff"], proposals: { enabled: true } },
            proposalService: service,
            logError: vi.fn(async () => undefined),
        };

        const handling = handleProposalButton(interaction, client);
        expect(service.acquireResolutionGate).toHaveBeenCalledTimes(1);
        expect(service.busy).toBe(true);
        expect(approveProposal).not.toHaveBeenCalled();

        client.config.proposals.enabled = false;
        ensureProposalService(client);
        expect(stop).not.toHaveBeenCalled();

        releaseAck?.();
        await handling;

        expect(approveProposal).toHaveBeenCalledTimes(1);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(client.proposalService).toBeUndefined();
    });
});
