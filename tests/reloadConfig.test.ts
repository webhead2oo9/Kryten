import { describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../src/classes/commandContext";
import type { Config } from "../src/types";

const H = vi.hoisted(() => ({
    reconcile: vi.fn(async () => undefined),
    ensureProposalService: vi.fn(),
    reconfigureLogging: vi.fn(async () => undefined),
}));

vi.mock("../src/handlers/messageHandler", () => ({
    getUserInteractionStore: () => ({ reconcileClassifierCampaigns: H.reconcile }),
    getMessageLogger: () => ({ reconfigure: H.reconfigureLogging }),
}));
vi.mock("../src/handlers/proposalHandler", () => ({ ensureProposalService: H.ensureProposalService }));

import ReloadConfigCommand from "../src/commands/reloadConfig";

describe("/reload_config interaction retention", () => {
    it("reconciles campaigns before reapplying other live configuration", async () => {
        H.reconcile.mockReset();
        H.reconcile.mockResolvedValue(undefined);
        H.ensureProposalService.mockReset();
        H.reconfigureLogging.mockReset();
        H.reconfigureLogging.mockResolvedValue(undefined);
        const previous = { githubPollMinutes: 60 } satisfies Config;
        const next = { githubPollMinutes: 30 } satisfies Config;
        const context = commandContext(previous, next);

        await new ReloadConfigCommand().run(context);

        expect(H.reconcile).toHaveBeenCalledTimes(1);
        expect(H.reconfigureLogging).toHaveBeenCalledWith(previous.logging);
        expect(H.reconcile.mock.invocationCallOrder[0]).toBeLessThan(H.reconfigureLogging.mock.invocationCallOrder[0]!);
        expect(context.client.poller.start).toHaveBeenCalledTimes(1);
        expect(H.ensureProposalService).toHaveBeenCalledWith(context.client);
        expect(context.interaction.reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining("interaction retention") }),
        );
    });

    it("rolls back the config when campaign reconciliation cannot be persisted", async () => {
        H.reconcile.mockReset();
        H.reconcile.mockRejectedValue(new Error("synthetic disk failure"));
        H.ensureProposalService.mockReset();
        H.reconfigureLogging.mockReset();
        const previous = { githubPollMinutes: 60 } satisfies Config;
        const next = { githubPollMinutes: 30 } satisfies Config;
        const context = commandContext(previous, next);

        await new ReloadConfigCommand().run(context);

        expect(context.client.config).toBe(previous);
        expect(H.reconfigureLogging).not.toHaveBeenCalled();
        expect(context.client.poller.start).not.toHaveBeenCalled();
        expect(H.ensureProposalService).not.toHaveBeenCalled();
        expect(context.interaction.reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining("synthetic disk failure") }),
        );
    });

    it("rolls back the config and logger when logging reconfiguration fails", async () => {
        H.reconcile.mockReset();
        H.ensureProposalService.mockReset();
        H.reconfigureLogging.mockReset();
        H.reconfigureLogging.mockRejectedValueOnce(new Error("wrong logging key")).mockResolvedValueOnce(undefined);
        const previous = { githubPollMinutes: 60 } satisfies Config;
        const next = { githubPollMinutes: 30, logging: { enabled: true } } satisfies Config;
        const context = commandContext(previous, next);

        await new ReloadConfigCommand().run(context);

        expect(context.client.config).toBe(previous);
        expect(H.reconfigureLogging).toHaveBeenCalledTimes(2);
        expect(H.reconcile).toHaveBeenCalledTimes(1);
        expect(context.client.poller.start).not.toHaveBeenCalled();
        expect(context.interaction.reply).toHaveBeenCalledWith(
            expect.objectContaining({ content: expect.stringContaining("wrong logging key") }),
        );
    });
});

function commandContext(previous: Config, next: Config): CommandContext {
    const client = {
        config: previous,
        configLoadFailed: false,
        loadConfig: vi.fn(function (this: { config: Config }) {
            this.config = next;
        }),
        poller: { start: vi.fn() },
    };
    return {
        client,
        interaction: { reply: vi.fn(async () => undefined) },
    } as unknown as CommandContext;
}
