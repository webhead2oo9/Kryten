/**
 * Pure builders for the staff review card. State-free: the Approve/Reject
 * buttons encode the proposal id in their custom_id and the proposal itself
 * lives in SQLite, so cards keep working across bot restarts with no
 * re-registration step (the manual interaction router in index.ts routes
 * the "cmdprop:" prefix here).
 *
 * Cards are Components-V2: a metadata container (with the buttons inside)
 * followed by the command preview rendered through the same block renderer
 * the live commands use, so reviewers see exactly what will ship.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ContainerBuilder, TextDisplayBuilder } from "discord.js";
import { blockText, unitContainers } from "../utils/commandRender";
import { CommandBlock } from "../types";
import {
    CV2_COMPONENT_BUDGET,
    CV2_TEXT_BUDGET,
    containerComponentCount,
    containerTextChars,
    renderFields,
} from "../utils/cv2";
import { embedFieldValue } from "../utils/format";
import { getPages, summarizePatchEdits } from "./patchEngine";
import { ProposalRecord } from "./types";

export const PROPOSAL_BUTTON_PREFIX = "cmdprop:";
export const PROPOSAL_BUTTON_RE = /^cmdprop:(approve|reject):([a-f0-9]{32})$/;

export function parseProposalButtonId(customId: string): { action: "approve" | "reject"; proposalId: string } | null {
    const match = PROPOSAL_BUTTON_RE.exec(customId);
    if (!match) return null;
    return { action: match[1] as "approve" | "reject", proposalId: match[2]! };
}

const OPERATION_COLORS: Record<string, number> = {
    create: 0x57f287, // green
    patch: 0xf1c40f, // gold
    delete: 0xed4245, // red
};

const MAX_PREVIEW_UNITS = 24;
const MESSAGE_TEXT_HEADROOM = 100;
const MESSAGE_COMPONENT_HEADROOM = 2;
const PREVIEW_UNIT_TEXT_HEADROOM = 200;
const MAX_CHARS_PER_MESSAGE = CV2_TEXT_BUDGET - MESSAGE_TEXT_HEADROOM;
const MAX_COMPONENTS_PER_MESSAGE = CV2_COMPONENT_BUDGET - MESSAGE_COMPONENT_HEADROOM;
// A single preview unit must fit in a message by itself.
const MAX_PREVIEW_UNIT_CHARS = CV2_TEXT_BUDGET - PREVIEW_UNIT_TEXT_HEADROOM;

export interface ReviewMessage {
    components: ContainerBuilder[];
}

export interface ReviewMessageOptions {
    proposedBy?: string;
}

function structureSummary(command: Record<string, unknown> | undefined): string {
    if (!command) return "n/a";
    // Count via the same resolver the preview renders with, so the metadata
    // line can't disagree with what's actually shown below.
    const blocks = Array.isArray(command["blocks"]) ? command["blocks"].length : 0;
    const pages = getPages(command);
    const parts = [
        `${blocks} top-level block${blocks === 1 ? "" : "s"}`,
        `${pages.length} page${pages.length === 1 ? "" : "s"}`,
    ];
    if (pages.length) {
        const titles = pages.slice(0, 15).map(p => String(p["title"] ?? p["name"] ?? "?"));
        parts.push(`(${titles.join(", ")}${pages.length > 15 ? ", …" : ""})`);
    }
    return embedFieldValue(parts.join(" · "));
}

function buildMetadataContainer(
    record: ProposalRecord,
    previewTruncated: boolean,
    options: ReviewMessageOptions,
): ContainerBuilder {
    const fields: { name: string; value: string }[] = [
        { name: "Operation", value: record.operation },
        { name: "Proposed by", value: options.proposedBy ?? record.proposer ?? "chatbot" },
    ];
    if (record.operation !== "delete") {
        fields.push({ name: "Structure", value: structureSummary(record.proposedCommand) });
    }
    const patchSummary = summarizePatchEdits(record.proposedEdits);
    if (patchSummary) {
        fields.push({ name: "Patch edits", value: embedFieldValue(patchSummary) });
    }
    if (record.rationale) {
        fields.push({ name: "Rationale", value: embedFieldValue(record.rationale) });
    }
    if (record.operation !== "delete" && record.proposedCommand) {
        const hasTopLevel =
            Array.isArray(record.proposedCommand["blocks"]) && record.proposedCommand["blocks"].length > 0;
        const hasPages = getPages(record.proposedCommand).length > 0;
        if (!hasTopLevel && hasPages) {
            fields.push({
                name: "⚠️ Initial response",
                value: "This command has pages but no top-level blocks — the initial slash reply will be empty.",
            });
        }
    }
    if (previewTruncated) {
        fields.push({ name: "⚠️ Preview truncated", value: "Not all views are shown below." });
    }

    return new ContainerBuilder()
        .setAccentColor(OPERATION_COLORS[record.operation] ?? 0x95a5a6)
        .addTextDisplayComponents(
            new TextDisplayBuilder().setContent(`## Command Proposal · ${record.operation} \`${record.commandName}\``),
            new TextDisplayBuilder().setContent(renderFields(fields)),
            new TextDisplayBuilder().setContent(`-# proposal ${record.proposalId}`),
        );
}

function buildButtons(proposalId: string): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`${PROPOSAL_BUTTON_PREFIX}approve:${proposalId}`)
            .setLabel("Approve")
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`${PROPOSAL_BUTTON_PREFIX}reject:${proposalId}`)
            .setLabel("Reject")
            .setStyle(ButtonStyle.Danger),
    );
}

/**
 * Build the review messages: a metadata container (carrying the Approve/Reject
 * buttons) + a rendered visual preview of the command (top-level blocks first —
 * the actual initial slash response — then each page), chunked to the CV2
 * per-message budgets.
 */
export function buildReviewMessages(record: ProposalRecord, options: ReviewMessageOptions = {}): ReviewMessage[] {
    // Budget each preview unit by its TRANSLATED size so content that is valid
    // under stored-format limits can never produce an unrenderable card.
    const previewContainers: ContainerBuilder[] = [];
    let truncated = false;

    /** Render one view's blocks; returns false when the preview cap is hit. */
    const pushUnit = (holder: Record<string, unknown>, label: string | undefined, fallbackAccent: unknown): boolean => {
        const blocks = holder["blocks"];
        if (!Array.isArray(blocks) || !blocks.length) return true;
        if (previewContainers.length >= MAX_PREVIEW_UNITS) {
            truncated = true;
            return false;
        }
        const labeled = label
            ? ([{ type: "small", text: label }, ...(blocks as CommandBlock[])] as CommandBlock[])
            : (blocks as CommandBlock[]);
        // The synthetic label counts against the per-unit budget, so a near-max
        // page's content can be silently clamped by the renderer. Flag it (staff
        // see the ⚠️ note) rather than approving against a preview that doesn't
        // match what ships. blockText mirrors the renderer's own length accounting.
        const renderedChars = labeled.reduce((sum, b) => sum + (blockText(b)?.length ?? 0), 0);
        if (renderedChars > MAX_PREVIEW_UNIT_CHARS) truncated = true;
        const containers = unitContainers(
            {
                blocks: labeled,
                accent_color: typeof holder["accent_color"] === "number" ? holder["accent_color"] : undefined,
                thumbnail_url: typeof holder["thumbnail_url"] === "string" ? holder["thumbnail_url"] : undefined,
            },
            typeof fallbackAccent === "number" ? fallbackAccent : undefined,
            MAX_PREVIEW_UNIT_CHARS,
        );
        previewContainers.push(...containers);
        return true;
    };

    if (record.operation !== "delete" && record.proposedCommand) {
        const command = record.proposedCommand;
        if (pushUnit(command, undefined, command["accent_color"])) {
            for (const page of getPages(command)) {
                const pageTitle = String(page["title"] ?? page["name"] ?? "?");
                if (!pushUnit(page, `📑 Page preview: ${pageTitle.slice(0, 120)}`, command["accent_color"])) {
                    break;
                }
            }
        }
    }

    const metadata = buildMetadataContainer(record, truncated, options).addActionRowComponents(
        buildButtons(record.proposalId),
    );
    const allContainers = [metadata, ...previewContainers];

    // Chunk greedily under both CV2 budgets; a container never splits.
    const messages: ReviewMessage[] = [];
    let current: ContainerBuilder[] = [];
    let currentChars = 0;
    let currentComponents = 0;
    for (const container of allContainers) {
        const json = container.toJSON();
        const chars = containerTextChars(json);
        const components = containerComponentCount(json);
        if (
            current.length > 0 &&
            (currentComponents + components > MAX_COMPONENTS_PER_MESSAGE ||
                currentChars + chars > MAX_CHARS_PER_MESSAGE)
        ) {
            messages.push({ components: current });
            current = [];
            currentChars = 0;
            currentComponents = 0;
        }
        current.push(container);
        currentChars += chars;
        currentComponents += components;
    }
    if (current.length) messages.push({ components: current });

    return messages;
}

/** Terminal-outcome annotation for the card (rendered by the shared resolveCard). */
export function outcomeNote(outcome: { status: string; message: string; committedSha?: string; actor: string }): {
    note: string;
    color: number;
} {
    if (outcome.status === "approved") {
        return {
            note: `**Outcome**\n✅ Approved & committed by ${outcome.actor}${outcome.committedSha ? ` · \`${outcome.committedSha.slice(0, 8)}\`` : ""}`,
            color: 0x57f287,
        };
    }
    if (outcome.status === "rejected") {
        return { note: `**Outcome**\n🚫 Rejected by ${outcome.actor}`, color: 0x4f545c };
    }
    return {
        note: `**Outcome**\n${embedFieldValue(`⚠️ ${outcome.status}: ${outcome.message}`)}`,
        color: 0xe67e22,
    };
}
