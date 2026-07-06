import { describe, expect, it, vi } from "vitest";
import { resolveProposalProposerLabel } from "../src/handlers/proposalHandler";

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
