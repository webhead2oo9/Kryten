/**
 * Discord-coupled side of the proposals subsystem: posts review cards to the
 * staff channel and handles the Approve/Reject buttons routed from index.ts
 * by the "cmdprop:" custom-id prefix. Never throws — every failure lands as
 * an ephemeral reply and/or logError.
 */
import { ButtonInteraction, DiscordAPIError, Guild, Message, MessageFlags, TextChannel } from "discord.js";
import { KrytenClient } from "../classes/client";
import { outcomeNote, parseProposalButtonId, buildReviewMessages } from "../proposals/reviewCard";
import { resolveCard } from "../utils/cv2";
import { ProposalService } from "../proposals/service";
import { DEFAULT_PROPOSAL_TTL_HOURS, ProposalStore } from "../proposals/store";
import { ProposalRecord, ResolutionResult } from "../proposals/types";
import { memberHasStaffRole } from "../utils/staff";

const DISCORD_INVALID_FORM_BODY = 50035;
const DISCORD_USER_PROPOSER_RE = /^discord_user:(\d{17,20})$/;

function cleanDisplayName(value: string | undefined): string {
    const cleaned = (value ?? "").replace(/\s+/g, " ").trim();
    return cleaned.length ? cleaned.slice(0, 80) : "Discord user";
}

export async function resolveProposalProposerLabel(
    client: KrytenClient,
    proposer: string | undefined,
    reviewGuild?: Guild,
): Promise<string> {
    const raw = proposer ?? "chatbot";
    const match = DISCORD_USER_PROPOSER_RE.exec(raw.trim());
    if (!match) return raw;

    const userId = match[1]!;
    const guild =
        reviewGuild ?? (process.env["GUILD_ID"] ? client.guilds.cache.get(process.env["GUILD_ID"]) : undefined);
    const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
    if (member) return `${cleanDisplayName(member.displayName)}\n-# ID: ${userId}`;

    const user = await client.users.fetch(userId).catch(() => null);
    return `${cleanDisplayName(user?.globalName ?? user?.username)}\n-# ID: ${userId}`;
}

/**
 * Bring the proposal service in line with the current config: start it when
 * enabled, stop it when disabled. Idempotent — called from the ready handler
 * and from /reload_config so flipping proposals.enabled doesn't need a restart.
 */
export function ensureProposalService(client: KrytenClient): void {
    const config = client.config.proposals;
    if (!config?.enabled) {
        if (client.proposalService) {
            // Don't close the store under an in-flight resolution click — defer
            // the stop until it finishes, then reconcile again and disable cleanly.
            if (client.proposalService.busy) {
                client.proposalService.runWhenIdle(() => ensureProposalService(client));
                console.log("Proposals disabled; deferring service stop until the in-flight resolution finishes.");
                return;
            }
            client.proposalService.stop();
            delete client.proposalService;
            console.log("Command proposal service stopped (disabled in config).");
        }
        return;
    }
    if (client.proposalService) {
        // Already running. ttl_hours and db_path are baked into the store at
        // construction, so a live change needs a rebuild — otherwise /reload_config
        // silently keeps the old values with no signal. (max_pending is read fresh
        // on each call, so it needs no rebuild.) Persisted rows survive the reopen.
        const runningStore = client.proposalService.store;
        const desiredTtlMs = (config.ttl_hours ?? DEFAULT_PROPOSAL_TTL_HOURS) * 3600 * 1000;
        const desiredDbPath = config.db_path ?? "./data/proposals.db";
        if (runningStore.ttlMs === desiredTtlMs && runningStore.dbPath === desiredDbPath) return;
        // Don't rebuild (which closes the old store) under an in-flight resolution
        // click; the deferred reconcile re-reads config and rebuilds when it finishes.
        if (client.proposalService.busy) {
            client.proposalService.runWhenIdle(() => ensureProposalService(client));
            console.log(
                "Proposal ttl_hours/db_path changed; deferring rebuild until the in-flight resolution finishes.",
            );
            return;
        }
        console.log("Proposal ttl_hours/db_path changed in config; rebuilding the proposal service.");
        client.proposalService.stop();
        delete client.proposalService;
        // fall through to reconstruct with the new settings
    }

    if (!process.env["PROPOSAL_API_KEY"]) {
        console.warn("proposals.enabled is set but PROPOSAL_API_KEY is missing; the intake API stays disabled.");
    }
    try {
        const store = new ProposalStore(
            config.db_path ?? "./data/proposals.db",
            (config.ttl_hours ?? DEFAULT_PROPOSAL_TTL_HOURS) * 3600 * 1000,
        );
        client.proposalService = new ProposalService(client, store, {
            postReviewCard: record => postReviewCard(client, record),
        });
        console.log("Command proposal service started.");
    } catch (error) {
        console.error("Failed to start the proposal service:", error);
        void client
            .logError("Proposal Service Startup Failed", error instanceof Error ? error : String(error))
            .catch(() => undefined);
    }
}

export async function postReviewCard(
    client: KrytenClient,
    record: ProposalRecord,
): Promise<{ messageId: string } | { error: { message: string; contentRejected: boolean } }> {
    const channelId = client.config.proposals?.review_channel_id;
    if (!channelId) {
        return { error: { message: "proposals.review_channel_id is not configured", contentRejected: false } };
    }
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased()) {
        return { error: { message: "review channel not found or not text-based", contentRejected: false } };
    }

    try {
        const reviewGuild = "guild" in channel ? (channel as { guild?: Guild }).guild : undefined;
        const proposedBy = await resolveProposalProposerLabel(client, record.proposer, reviewGuild);
        const messages = buildReviewMessages(record, { proposedBy });
        const sent: Message[] = [];
        try {
            for (const message of messages) {
                sent.push(
                    await (channel as TextChannel).send({
                        components: message.components,
                        flags: MessageFlags.IsComponentsV2,
                        allowedMentions: { parse: [] },
                    }),
                );
            }
        } catch (sendError) {
            // A later chunk failed: tear down the chunks already posted. The first
            // message carries the Approve/Reject buttons, so leaving it would strand
            // a live-but-dead card (the proposal is about to be marked failed, so
            // clicks would only ever say "already resolved").
            for (const m of sent) await m.delete().catch(() => undefined);
            throw sendError;
        }
        return { messageId: sent[0]!.id };
    } catch (error) {
        if (error instanceof DiscordAPIError && error.code === DISCORD_INVALID_FORM_BODY) {
            // The card content itself is unrenderable (component limits) — the
            // proposal author must fix the body; not an environment problem.
            return { error: { message: "component limits exceeded (Discord 50035)", contentRejected: true } };
        }
        const message =
            error instanceof DiscordAPIError && error.status === 403
                ? "missing permissions to post in the review channel"
                : error instanceof Error
                  ? error.message
                  : String(error);
        return { error: { message, contentRejected: false } };
    }
}

export async function handleProposalButton(interaction: ButtonInteraction, client: KrytenClient): Promise<void> {
    try {
        const parsed = parseProposalButtonId(interaction.customId);
        if (!parsed) {
            // A "cmdprop:"-prefixed id from an older build/format: this is the
            // only handler that will see it, so ack it or the user gets
            // "This interaction failed".
            await interaction.deferUpdate().catch(() => undefined);
            return;
        }

        const service = client.proposalService;
        if (!service) {
            await interaction
                .reply({ content: "Command proposals are not enabled.", flags: MessageFlags.Ephemeral })
                .catch(() => undefined);
            return;
        }

        if (!memberHasStaffRole(interaction.member, client.config)) {
            await interaction
                .reply({ content: "Only staff members can resolve command proposals.", flags: MessageFlags.Ephemeral })
                .catch(() => undefined);
            return;
        }

        // Enter the service's teardown gate before the first network await. A
        // concurrent /reload_config can then defer disabling/rebuilding instead
        // of closing this captured service's SQLite handle mid-click.
        const releaseResolutionGate = service.acquireResolutionGate();
        let reviewerName: string;
        let result: ResolutionResult;
        try {
            await interaction.deferUpdate().catch(() => undefined);

            reviewerName =
                interaction.inCachedGuild() && interaction.member.displayName
                    ? interaction.member.displayName
                    : (interaction.user.globalName ?? interaction.user.username);

            result =
                parsed.action === "approve"
                    ? await service.approveProposal(parsed.proposalId, reviewerName)
                    : service.rejectProposal(parsed.proposalId, reviewerName);
        } finally {
            releaseResolutionGate();
        }

        // A lost double-click that lands while the WINNER is still committing:
        // the proposal's recorded status ("applying") isn't terminal yet, so
        // there is no real outcome to render. Leave the card alone — the
        // winner annotates it when its commit finishes — and answer this
        // click ephemerally instead of clobbering that annotation.
        if (result.status === "already_resolved" && result.resolved?.status === "applying") {
            await interaction
                .followUp({ content: result.message, flags: MessageFlags.Ephemeral })
                .catch(() => undefined);
            return;
        }

        // Annotate the card and always drop the buttons: every resolution
        // attempt is terminal in the store (the pending→applying claim is
        // one-shot), so leaving buttons would only produce "already resolved"
        // on the next click. A failed proposal must be re-submitted.
        //
        // For a lost double-click race (already_resolved), render the proposal's
        // REAL terminal outcome (approved by the winner, rejected, …) rather than
        // a generic note — otherwise the loser's late edit could overwrite the
        // winner's annotation with a misleading "already resolved".
        const cardOutcome =
            result.status === "already_resolved" && result.resolved
                ? {
                      status: result.resolved.status,
                      message: result.message,
                      actor: result.resolved.resolvedBy ? `@${result.resolved.resolvedBy}` : "another reviewer",
                      ...(result.resolved.committedSha !== undefined
                          ? { committedSha: result.resolved.committedSha }
                          : {}),
                  }
                : {
                      status: result.status,
                      message: result.message,
                      actor: `@${reviewerName}`,
                      ...(result.committedSha !== undefined ? { committedSha: result.committedSha } : {}),
                  };
        const { note, color } = outcomeNote(cardOutcome);
        await resolveCard(interaction, note, color);

        await interaction.followUp({ content: result.message, flags: MessageFlags.Ephemeral }).catch(() => undefined);
    } catch (error) {
        await client
            .logError("Proposal button failed", error instanceof Error ? error : String(error))
            .catch(() => undefined);
        await interaction
            .followUp({ content: "An error occurred while resolving the proposal.", flags: MessageFlags.Ephemeral })
            .catch(() => undefined);
    }
}
