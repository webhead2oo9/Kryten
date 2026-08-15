import {
    ActionRowBuilder,
    APIButtonComponent,
    ContainerBuilder,
    APISelectMenuOption,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    InteractionEditReplyOptions,
    InteractionReplyOptions,
    InteractionUpdateOptions,
    MessageFlags,
    ModalBuilder,
    ModalSubmitInteraction,
    Routes,
    StringSelectMenuBuilder,
    StringSelectMenuInteraction,
    TextDisplayBuilder,
    TextInputBuilder,
    TextInputStyle,
} from "discord.js";
import { CustomCommand, CommandBlock, CommandPage } from "../types";
import { EditorSection, EditorSession } from "../classes/customCommandEditor";
import { KrytenClient } from "../classes/client";
import { RenderUnit, blockText, blocksToContainer, unitContainers } from "../utils/commandRender";
import {
    CV2_COMPONENT_BUDGET,
    CV2_MEDIA_GALLERY_ITEM_BUDGET,
    CV2_TEXT_BUDGET,
    messageComponentCount,
} from "../utils/cv2";
import { clampCommitMessage, sanitizeCommitAuthor } from "../github/commandFiles";
import { deepEqual } from "../utils/deepEqual";
import { jsonClone } from "../utils/jsonClone";
import {
    NAME_PATTERN,
    clampText,
    embedFieldValue,
    sanitizeSelectDescription,
    sanitizeSelectLabel,
    sanitizeSelectValue,
} from "../utils/format";
import {
    MAX_BLOCKS_PER_UNIT,
    MAX_BLOCK_FIELD_NAME,
    MAX_BLOCK_FIELD_VALUE,
    MAX_BLOCK_HEADING,
    MAX_BLOCK_SMALL,
    MAX_BLOCK_TEXT,
    MAX_THUMBNAIL_URL,
    isValidEmbedUrl,
    validateBlocksDetailed,
    validateCustomCommandDetailed,
} from "../utils/validateCommand";

// All editor component ids share the "cmd-editor-" prefix. Keep it that way:
// validateCommand.ts reserves the prefix for command names, because a custom
// command's page select uses the command name as its custom-id and the router
// matches these editor ids first.
export const SECTION_SELECT_ID = "cmd-editor-section-select";
export const BLOCK_SELECT_ID = "cmd-editor-block-select";
export const BUTTON_EDIT_GENERAL_ID = "cmd-editor-edit-general";
export const BUTTON_EDIT_BLOCKS_ID = "cmd-editor-edit-blocks";
export const BUTTON_EDIT_PAGE_BLOCKS_ID = "cmd-editor-edit-page-blocks";
export const BUTTON_EDIT_PAGE_INFO_ID = "cmd-editor-edit-page-info";
export const BUTTON_EDIT_BLOCK_ID = "cmd-editor-edit-block";
export const BUTTON_DELETE_BLOCK_ID = "cmd-editor-delete-block";
export const BUTTON_ADD_PAGE_ID = "cmd-editor-add-page";
export const BUTTON_DUPLICATE_PAGE_ID = "cmd-editor-duplicate-page";
export const BUTTON_DELETE_PAGE_ID = "cmd-editor-delete-page";
export const BUTTON_SAVE_ID = "cmd-editor-save";
export const BUTTON_DISCARD_ID = "cmd-editor-discard";
export const BUTTON_CLOSE_ID = "cmd-editor-close";

export const MODAL_GENERAL_ID = "cmd-editor-modal-general";
export const MODAL_BLOCKS_ID = "cmd-editor-modal-blocks";
export const MODAL_PAGE_BLOCKS_ID = "cmd-editor-modal-page-blocks";
export const MODAL_PAGE_INFO_ID = "cmd-editor-modal-page-info";
export const MODAL_ADD_PAGE_ID = "cmd-editor-modal-add-page";
// Kept short: the scoped id (":<command>:<unit>:<index|new>:<type>") must stay
// inside Discord's 100-char custom_id cap at maximum name lengths.
export const MODAL_BLOCK_ID = "cmd-editor-modal-blk";

const PAGE_VALUE_PREFIX = "page:";
const ADD_PAGE_VALUE = "add_page";
const BLOCK_VALUE_PREFIX = "blk:";
const ADD_BLOCK_VALUE_PREFIX = "addblk:";

const BLOCK_TYPES = ["heading", "text", "field", "divider", "images", "small"] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

const ADD_BLOCK_DESCRIPTIONS: Record<BlockType, string> = {
    heading: "Large title line",
    text: "Markdown paragraph",
    field: "Bold name over a value",
    divider: "Horizontal spacer",
    images: "Image gallery (up to 10 URLs)",
    small: "Muted footnote line",
};
// The editor's section select holds at most 25 options and always spends up to
// three on "General", "Content", and "➕ Add Page" — pages beyond 22 would
// be unreachable in the editor even though Discord allows 25 in the reply
// select. Cap authoring at 22.
const MAX_PAGES = 22;
const MAX_MODAL_TITLE_LENGTH = 45;
const MAX_COMMAND_DESCRIPTION_LENGTH = 100;
const EDITOR_PREVIEW_TRUNCATED_TEXT = "-# Preview truncated to fit editor controls.";
const PENDING_SYNC_TEXT = "Earlier changes already committed to GitHub — press Save to finish syncing them.";

function clampModalTitle(title: string): string {
    return title.length > MAX_MODAL_TITLE_LENGTH ? `${title.slice(0, MAX_MODAL_TITLE_LENGTH - 3)}...` : title;
}

// Block editing uses a raw-JSON modal: one block object per line keeps the
// payload readable while staying inside Discord's 4000-char modal input cap
// for every unit under the rendered-text budget.
const MAX_BLOCKS_INPUT_CHARS = 4000;

function serializeBlocksForInput(blocks?: CommandBlock[]): string {
    if (!blocks || !blocks.length) return "";
    try {
        return `[\n${blocks.map(block => JSON.stringify(block)).join(",\n")}\n]`;
    } catch (error) {
        console.error("Failed to serialize blocks:", error);
        return "";
    }
}

function parseBlocksInput(raw: string): CommandBlock[] | undefined {
    const trimmed = raw.trim();
    if (!trimmed.length) return undefined;
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        throw new Error("Blocks must be valid JSON.");
    }
    if (!Array.isArray(parsed)) throw new Error("Blocks JSON must be an array.");
    return parsed.length ? (parsed as CommandBlock[]) : undefined;
}

/** One-line gist of a block for select-option descriptions; empty for dividers. */
function blockSummary(block: CommandBlock): string {
    switch (block.type) {
        case "heading":
        case "text":
        case "small":
            return block.text;
        case "field":
            return block.name;
        case "images":
            return `${block.urls.length} image URL${block.urls.length === 1 ? "" : "s"}`;
        case "divider":
            return "";
    }
}

export interface BlockSelectOptions {
    options: APISelectMenuOption[];
    /** Blocks outside the select's window (it follows the cursor) — reachable via Edit JSON. */
    hiddenBlockCount: number;
}

/**
 * Options for the block select: one entry per block, then one "➕ Add <type>"
 * entry per block type while the unit is under the per-view block cap. The
 * add entries always fit, so block entries get whatever the 25-option select
 * cap leaves — windowed around the cursor, since an edit/move can land the
 * selection past the cap and the block must stay visible and re-selectable.
 * Labels and values carry real indices, so the window shift is transparent.
 * Exported for tests.
 */
export function buildBlockSelectOptions(blocks: CommandBlock[], selectedIndex?: number): BlockSelectOptions {
    const addOptions: APISelectMenuOption[] =
        blocks.length >= MAX_BLOCKS_PER_UNIT
            ? []
            : BLOCK_TYPES.map(type => ({
                  label: `➕ Add ${type}`,
                  value: `${ADD_BLOCK_VALUE_PREFIX}${type}`,
                  description: ADD_BLOCK_DESCRIPTIONS[type],
                  default: false,
              }));
    const maxShown = 25 - addOptions.length;
    const start =
        selectedIndex !== undefined && selectedIndex >= maxShown
            ? Math.min(selectedIndex - maxShown + 1, Math.max(0, blocks.length - maxShown))
            : 0;
    const shown = blocks.slice(start, start + maxShown);
    const options: APISelectMenuOption[] = shown.map((block, offset) => {
        const index = start + offset;
        return {
            label: sanitizeSelectLabel(`${index + 1} · ${block.type}`, `Block ${index + 1}`),
            value: `${BLOCK_VALUE_PREFIX}${index}`,
            description: sanitizeSelectDescription(blockSummary(block)),
            default: index === selectedIndex,
        };
    });
    return { options: [...options, ...addOptions], hiddenBlockCount: blocks.length - shown.length };
}

/** The unit whose blocks the current section views: the command itself ("embed") or the selected page. */
function viewedUnit(
    session: EditorSession,
    command: CustomCommand | undefined,
    page: CommandPage | undefined,
): CustomCommand | CommandPage | undefined {
    if (!command) return undefined;
    if (session.selectedSection === "embed") return command;
    if (session.selectedSection === "page") return page;
    return undefined;
}

/** Validation-context label matching the shared validator's conventions. */
function unitContext(unitTag: string): string {
    return unitTag === "" ? "content" : `page '${unitTag}'`;
}

/**
 * Tag of the unit whose blocks the current view edits: "" for the command's
 * own blocks (Content section), the page name on a page section, undefined
 * when no block-bearing unit is viewed. Rides in block-modal custom-id scopes
 * at open time and gates them again at submit time (modalScopeMismatch), so
 * both sides must derive it through this one helper.
 */
function viewedUnitTag(session: EditorSession): string | undefined {
    if (session.selectedSection === "embed") return "";
    if (session.selectedSection === "page") return session.selectedPageName;
    return undefined;
}

/** Resolve the session's block cursor against the viewed unit; undefined unless every link holds. */
function resolveSelectedBlock(
    session: EditorSession,
    command: CustomCommand | undefined,
    page: CommandPage | undefined,
):
    | { unit: CustomCommand | CommandPage; unitTag: string; blocks: CommandBlock[]; index: number; block: CommandBlock }
    | undefined {
    const unit = viewedUnit(session, command, page);
    const unitTag = viewedUnitTag(session);
    if (!unit || unitTag === undefined) return undefined;
    const blocks = unit.blocks ?? [];
    const index = session.selectedBlockIndex;
    const block = index !== undefined ? blocks[index] : undefined;
    if (index === undefined || !block) return undefined;
    return { unit, unitTag, blocks, index, block };
}

/**
 * Build a block from typed-modal inputs. Returns the block or a user-facing
 * problem. Exported for tests.
 */
export function buildBlockFromInputs(
    type: BlockType,
    fields: Record<string, string>,
): { block: CommandBlock } | { error: string } {
    const text = (fields["text"] ?? "").trim();
    switch (type) {
        case "heading": {
            if (!text) return { error: "Heading text is required." };
            const url = (fields["url"] ?? "").trim();
            if (url && !isValidEmbedUrl(url)) return { error: "Link URL must be a http:// or https:// URL." };
            return { block: url ? { type, text, url } : { type, text } };
        }
        case "text": {
            if (!text) return { error: "Text is required." };
            return { block: { type, text } };
        }
        case "small": {
            if (!text) return { error: "Text is required." };
            return { block: { type, text } };
        }
        case "field": {
            const name = (fields["name"] ?? "").trim();
            const value = (fields["value"] ?? "").trim();
            if (!name) return { error: "Field name is required." };
            if (!value) return { error: "Field value is required." };
            return { block: { type, name, value } };
        }
        case "images": {
            const urls = (fields["urls"] ?? "")
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line.length > 0);
            if (!urls.length) return { error: "Enter at least one image URL (one per line)." };
            if (urls.length > CV2_MEDIA_GALLERY_ITEM_BUDGET) {
                return { error: `A gallery holds at most ${CV2_MEDIA_GALLERY_ITEM_BUDGET} images.` };
            }
            const bad = urls.findIndex(url => !isValidEmbedUrl(url));
            if (bad !== -1) return { error: `Line ${bad + 1} is not a valid http(s) image URL.` };
            return { block: { type, urls } };
        }
        case "divider":
            return { block: { type } };
    }
}

export type BlockEditAction =
    | { kind: "edit"; index: number; block: CommandBlock; position: number }
    | { kind: "insert"; block: CommandBlock; position: number };

/**
 * Apply one typed block edit/insert (1-based position, so a move is an edit
 * with a new position) and re-validate the WHOLE resulting view — a submit
 * can never store a list that is over the block cap, over the rendered-text
 * budget, or divider-only. Returns the new normalized list or the problem.
 * Exported for tests.
 */
export function applyBlockEdit(
    blocks: CommandBlock[] | undefined,
    action: BlockEditAction,
    ctx: string,
): { blocks: CommandBlock[] } | { error: string } {
    const next = jsonClone(blocks ?? []);
    if (action.kind === "edit") {
        if (action.index < 0 || action.index >= next.length) return { error: "That block no longer exists." };
        next.splice(action.index, 1);
    }
    if (action.position < 1 || action.position > next.length + 1) {
        return { error: `Position must be between 1 and ${next.length + 1}.` };
    }
    next.splice(action.position - 1, 0, action.block);
    const error = validateBlocksDetailed(next, ctx);
    return error ? { error } : { blocks: next };
}

/**
 * Apply a block action to the viewed unit and advance the session cursor to
 * the block's new position. Returns the user-facing problem, if any; the
 * caller owns surfacing it (status line vs ephemeral reply) and the success
 * status message.
 */
function commitBlockEdit(
    client: KrytenClient,
    session: EditorSession,
    unit: CustomCommand | CommandPage,
    unitTag: string,
    action: BlockEditAction,
): string | undefined {
    const result = applyBlockEdit(unit.blocks, action, unitContext(unitTag));
    if ("error" in result) return result.error;
    unit.blocks = result.blocks;
    session.selectedBlockIndex = action.position - 1;
    client.commandEditor.markDirty(session);
    return undefined;
}

const POSITION_INPUT_ID = "position";

/**
 * Typed edit/add modal for one block. `indexTag` is the 0-based index being
 * edited or "new"; `unitTag` is "" for the command's own blocks or the page
 * name. Both ride in the scoped custom-id and are re-validated on submit.
 * Returns a user-facing problem instead when the block can't be prefilled.
 */
function buildBlockModal(
    commandName: string,
    unitTag: string,
    type: BlockType,
    indexTag: string,
    existing: CommandBlock | undefined,
    defaultPosition: number,
    maxPosition: number,
): ModalBuilder | { error: string } {
    // Gallery URLs don't count toward the unit text budget, so unlike every
    // other prefill they can exceed the input cap — Discord would reject the
    // whole showModal call.
    if (existing?.type === "images" && existing.urls.join("\n").length > MAX_BLOCKS_INPUT_CHARS) {
        return { error: "This gallery's URLs are too long to edit here — use Edit JSON instead." };
    }
    const modal = new ModalBuilder()
        .setCustomId(scopedModalId(MODAL_BLOCK_ID, commandName, unitTag, indexTag, type))
        .setTitle(
            clampModalTitle(indexTag === "new" ? `Add ${type} block` : `Edit block ${Number(indexTag) + 1} — ${type}`),
        );
    const inputs: TextInputBuilder[] = [];

    switch (type) {
        case "heading": {
            const text = new TextInputBuilder()
                .setCustomId("text")
                .setLabel("Heading text")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(MAX_BLOCK_HEADING);
            if (existing?.type === "heading") text.setValue(existing.text);
            inputs.push(text);
            // No prefill clamp needed: the unit text budget bounds stored URL
            // length well under the input cap (heading URLs count toward it).
            const url = new TextInputBuilder()
                .setCustomId("url")
                .setLabel("Link URL (optional, http/https)")
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(MAX_BLOCKS_INPUT_CHARS);
            if (existing?.type === "heading" && existing.url) url.setValue(existing.url);
            inputs.push(url);
            break;
        }
        case "text": {
            const text = new TextInputBuilder()
                .setCustomId("text")
                .setLabel("Text (markdown)")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(MAX_BLOCK_TEXT);
            if (existing?.type === "text") text.setValue(existing.text);
            inputs.push(text);
            break;
        }
        case "field": {
            const name = new TextInputBuilder()
                .setCustomId("name")
                .setLabel("Field name")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(MAX_BLOCK_FIELD_NAME);
            if (existing?.type === "field") name.setValue(existing.name);
            inputs.push(name);
            const value = new TextInputBuilder()
                .setCustomId("value")
                .setLabel("Field value")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(MAX_BLOCK_FIELD_VALUE);
            if (existing?.type === "field") value.setValue(existing.value);
            inputs.push(value);
            break;
        }
        case "small": {
            const text = new TextInputBuilder()
                .setCustomId("text")
                .setLabel("Small text (muted footnote)")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(MAX_BLOCK_SMALL);
            if (existing?.type === "small") text.setValue(existing.text);
            inputs.push(text);
            break;
        }
        case "images": {
            const urls = new TextInputBuilder()
                .setCustomId("urls")
                .setLabel("Image URLs (one per line, max 10)")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(MAX_BLOCKS_INPUT_CHARS);
            if (existing?.type === "images" && existing.urls.length) urls.setValue(existing.urls.join("\n"));
            inputs.push(urls);
            break;
        }
        case "divider":
            break; // nothing to collect — the modal only carries position
    }

    inputs.push(
        new TextInputBuilder()
            .setCustomId(POSITION_INPUT_ID)
            .setLabel(`Position (1-${maxPosition})`)
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(2)
            .setValue(String(defaultPosition)),
    );
    modal.addComponents(inputs.map(input => new ActionRowBuilder<TextInputBuilder>().addComponents(input)));
    return modal;
}

export const EDITOR_BUTTON_IDS = [
    BUTTON_EDIT_GENERAL_ID,
    BUTTON_EDIT_BLOCKS_ID,
    BUTTON_EDIT_PAGE_BLOCKS_ID,
    BUTTON_EDIT_PAGE_INFO_ID,
    BUTTON_EDIT_BLOCK_ID,
    BUTTON_DELETE_BLOCK_ID,
    BUTTON_ADD_PAGE_ID,
    BUTTON_DUPLICATE_PAGE_ID,
    BUTTON_DELETE_PAGE_ID,
    BUTTON_SAVE_ID,
    BUTTON_DISCARD_ID,
    BUTTON_CLOSE_ID,
];

/** Shared prefix of every editor modal id — the router matches submits by it. */
export const EDITOR_MODAL_PREFIX = "cmd-editor-modal-";

/**
 * Discord's client restores a dismissed modal's draft whenever a modal with
 * the SAME custom_id is shown again — with a static id, an abandoned draft
 * from one command resurfaced prefilled inside another command's modal. Scope
 * every modal id to its edit target (command/page names can't contain ":"),
 * and validate the scope on submit so a modal opened from a stale editor
 * message can't write to the wrong target either.
 */
function scopedModalId(base: string, ...scope: string[]): string {
    return [base, ...scope].join(":");
}

function parseEditorModalId(customId: string): { baseId: string; scope: string[] } {
    const [baseId, ...scope] = customId.split(":");
    return { baseId: baseId!, scope };
}

function modalScopeMismatch(baseId: string, scope: string[], session: EditorSession, command?: CustomCommand): boolean {
    if (scope.length > 0 && scope[0] !== command?.name) return true;

    switch (baseId) {
        case MODAL_BLOCK_ID: {
            const unitTag = viewedUnitTag(session);
            return !command || scope.length !== 4 || unitTag === undefined || scope[1] !== unitTag;
        }
        case MODAL_BLOCKS_ID:
            return !command || session.selectedSection !== "embed";
        case MODAL_PAGE_BLOCKS_ID:
        case MODAL_PAGE_INFO_ID:
            return !command || session.selectedSection !== "page" || scope[1] !== session.selectedPageName;
        default:
            return false;
    }
}

async function updateOriginalEditorMessage(
    client: KrytenClient,
    session: EditorSession,
    response: InteractionReplyOptions,
) {
    if (!session.responseToken || !session.applicationId) {
        throw new Error("Session missing response token or application id");
    }

    await client.rest.patch(Routes.webhookMessage(session.applicationId, session.responseToken, "@original"), {
        body: {
            components: response.components ?? [],
            flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
            allowed_mentions: { parse: [] },
        },
    });
}

/** Synthesized "general" section preview, rendered as blocks like everything else. */
function buildGeneralPreview(command: CustomCommand, textBudget: number, componentBudget: number) {
    const heading = command.blocks?.find(block => block.type === "heading");
    const blocks: CommandBlock[] = [
        { type: "heading", text: heading?.type === "heading" ? heading.text : command.name },
        { type: "text", text: command.description || "No description provided." },
        {
            type: "field",
            name: "Pages",
            // Many pages with long titles can exceed the field limit, which
            // would fail the whole editor view for this command.
            value: command.pages?.length
                ? embedFieldValue(command.pages.map(p => p.title ?? p.name).join(", "))
                : "None",
        },
    ];
    return buildPreviewContainer(blocks, command.accent_color, textBudget, componentBudget, command.thumbnail_url);
}

function buildPreviewContainer(
    blocks: CommandBlock[],
    accentColor: number | undefined,
    textBudget: number,
    componentBudget: number,
    thumbnailUrl?: string,
): ContainerBuilder {
    return blocksToContainer(
        blocks,
        accentColor,
        textBudget,
        componentBudget,
        EDITOR_PREVIEW_TRUNCATED_TEXT,
        thumbnailUrl,
    );
}

function buildUnitPreview(
    unit: RenderUnit,
    fallbackAccent: number | undefined,
    textBudget: number,
    componentBudget: number,
): ContainerBuilder[] {
    if (!unit.blocks?.length || componentBudget <= 1) return [];
    return unitContainers(unit, fallbackAccent, {
        textBudget,
        componentBudget,
        truncationText: EDITOR_PREVIEW_TRUNCATED_TEXT,
    });
}

function buildEditorComponents(
    session: EditorSession,
    command?: CustomCommand,
    page?: CommandPage,
    blockSelectOptions?: APISelectMenuOption[],
    selectedBlock?: CommandBlock,
) {
    const rows: ActionRowBuilder<any>[] = [];

    if (command) {
        const sectionOptions: APISelectMenuOption[] = [
            {
                label: "General",
                value: "general",
                description: "Command name, description, visibility",
                default: session.selectedSection === "general" || !session.selectedSection,
            },
        ];

        // The content section is always available, so top-level blocks can be
        // added to a pages-only command.
        sectionOptions.push({
            label: "Content",
            value: "embed",
            description: "Edit content blocks",
            default: session.selectedSection === "embed",
        });

        if (command.pages?.length) {
            for (const p of command.pages) {
                sectionOptions.push({
                    label: sanitizeSelectLabel(p.title ?? p.name, p.name),
                    value: `${PAGE_VALUE_PREFIX}${sanitizeSelectValue(p.name)}`,
                    description: sanitizeSelectDescription(p.description),
                    default: session.selectedSection === "page" && session.selectedPageName === p.name,
                });
            }
        }

        sectionOptions.push({
            label: "➕ Add Page",
            value: ADD_PAGE_VALUE,
            description: "Create a new page",
            default: false,
        });

        const sectionSelect = new StringSelectMenuBuilder()
            .setCustomId(SECTION_SELECT_ID)
            .setPlaceholder("Select a section to edit")
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(sectionOptions.slice(0, 25));

        rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(sectionSelect));

        if (blockSelectOptions?.length) {
            const blockSelect = new StringSelectMenuBuilder()
                .setCustomId(BLOCK_SELECT_ID)
                .setPlaceholder("Edit or add a content block")
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(blockSelectOptions.slice(0, 25));
            rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(blockSelect));
        }
    }

    const editButtons: APIButtonComponent[] = [];

    if (command) {
        // A selected block always leads its row; selectedBlock is only set
        // when the section views a block-bearing unit (embed or page).
        if (selectedBlock) {
            editButtons.push({
                type: 2,
                style: ButtonStyle.Primary,
                custom_id: BUTTON_EDIT_BLOCK_ID,
                label: "Edit Block",
            });
            editButtons.push({
                type: 2,
                style: ButtonStyle.Danger,
                custom_id: BUTTON_DELETE_BLOCK_ID,
                label: "Delete Block",
            });
        }
        if (session.selectedSection === "general") {
            editButtons.push({
                type: 2,
                style: ButtonStyle.Primary,
                custom_id: BUTTON_EDIT_GENERAL_ID,
                label: "Edit General Info",
            });
        } else if (session.selectedSection === "embed") {
            editButtons.push({
                type: 2,
                style: selectedBlock ? ButtonStyle.Secondary : ButtonStyle.Primary,
                custom_id: BUTTON_EDIT_BLOCKS_ID,
                label: "Edit JSON",
            });
        } else if (session.selectedSection === "page" && page) {
            editButtons.push({
                type: 2,
                style: selectedBlock ? ButtonStyle.Secondary : ButtonStyle.Primary,
                custom_id: `${BUTTON_EDIT_PAGE_INFO_ID}:${command.name}:${page.name}`,
                label: "Edit Page Info",
            });
            editButtons.push({
                type: 2,
                style: ButtonStyle.Secondary,
                custom_id: BUTTON_EDIT_PAGE_BLOCKS_ID,
                label: "Edit JSON",
            });
        }
    }

    const pageButtons: APIButtonComponent[] = [];

    if (command) {
        pageButtons.push({
            type: 2,
            style: ButtonStyle.Secondary,
            custom_id: BUTTON_ADD_PAGE_ID,
            label: "Add Page",
            disabled: (command.pages?.length ?? 0) >= MAX_PAGES,
        });

        if (session.selectedSection === "page" && page) {
            pageButtons.push({
                type: 2,
                style: ButtonStyle.Secondary,
                custom_id: `${BUTTON_DUPLICATE_PAGE_ID}:${command.name}:${page.name}`,
                label: "Duplicate Page",
            });
            pageButtons.push({
                type: 2,
                style: ButtonStyle.Danger,
                custom_id: `${BUTTON_DELETE_PAGE_ID}:${command.name}:${page.name}`,
                label: "Delete Page",
            });
        }
    }

    // Edit-action buttons and page-management buttons get their own rows.
    // Combined they can total 7 (4 edit + Add/Duplicate/Delete Page) and a single
    // row caps at 5 buttons, so putting them in one row would silently drop a
    // button. Worst case is 5 action rows (section select, block select, edit,
    // page management, save) — within even the legacy per-message row cap.
    if (editButtons.length) {
        rows.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                editButtons.map(component => new ButtonBuilder(component)),
            ),
        );
    }
    if (pageButtons.length) {
        rows.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                pageButtons.map(component => new ButtonBuilder(component)),
            ),
        );
    }

    const saveRow: APIButtonComponent[] = [
        {
            type: 2,
            style: ButtonStyle.Primary,
            custom_id: BUTTON_SAVE_ID,
            label: "Save",
            // pendingSync: an earlier partial save committed files to GitHub
            // that still need the snapshot/registration catch-up — a zero-diff
            // Save drains them, so the button must stay clickable even after
            // a Discard clears the dirty flag.
            disabled: !session.hasUnsavedChanges && !session.pendingSync,
        },
        {
            type: 2,
            style: ButtonStyle.Secondary,
            custom_id: BUTTON_DISCARD_ID,
            label: "Discard",
            disabled: !session.hasUnsavedChanges,
        },
        {
            type: 2,
            style: ButtonStyle.Secondary,
            custom_id: BUTTON_CLOSE_ID,
            label: "Close",
        },
    ];

    const saveRowBuilder = new ActionRowBuilder<ButtonBuilder>().addComponents(
        saveRow.map(component => new ButtonBuilder(component)),
    );
    rows.push(saveRowBuilder);

    return rows;
}

export function buildEditorResponse(session: EditorSession): InteractionReplyOptions {
    const command = session.selectedCommandName
        ? session.commands.find(c => c.name === session.selectedCommandName)
        : undefined;
    const page =
        session.selectedSection === "page" ? command?.pages?.find(p => p.name === session.selectedPageName) : undefined;
    const unit = viewedUnit(session, command, page);
    const unitBlocks = unit?.blocks ?? [];
    const blockIndex = session.selectedBlockIndex;
    const selectedBlock = blockIndex !== undefined ? unitBlocks[blockIndex] : undefined;
    const blockSelect = unit ? buildBlockSelectOptions(unitBlocks, blockIndex) : undefined;

    const summary: string[] = [];
    if (session.statusMessage) {
        summary.push(session.statusMessage);
    }
    if (session.pendingSync && !summary.some(text => text.includes(PENDING_SYNC_TEXT))) {
        summary.push(PENDING_SYNC_TEXT);
    }

    if (!command) {
        summary.push("Command not found. Use /edit_command to select one.");
    } else {
        summary.push(`Editing: **${command.name}**`);
        summary.push(`Section: **${session.selectedSection ?? "general"}**`);
        if (session.selectedSection === "page" && page) {
            summary.push(`Page: **${page.title ?? page.name}**`);
        }
        if (selectedBlock && blockIndex !== undefined) {
            summary.push(`Block: **${blockIndex + 1} · ${selectedBlock.type}**`);
        }
        if (blockSelect && blockSelect.hiddenBlockCount > 0) {
            summary.push(
                `-# ${blockSelect.hiddenBlockCount} block(s) outside the select window — use Edit JSON to reach them.`,
            );
        }
    }

    const rows = buildEditorComponents(session, command, page, blockSelect?.options, selectedBlock);

    // CV2 layout: the summary rides as a top-level text display, the preview
    // renders through the same block renderer the live commands use, and the
    // editor's action rows follow. Everything serializes to API data so the raw
    // webhook-PATCH path can send it verbatim.
    // The preview gets whatever text budget the summary leaves: content that is
    // valid under stored-format limits can exceed CV2's 4000-char message cap,
    // and an unbudgeted render would fail the whole repaint.
    const summaryText = clampText(summary.length ? summary.join("\n") : "Select a command to get started.", 1500);
    const previewBudget = CV2_TEXT_BUDGET - 100 - summaryText.length;
    const reservedComponents = messageComponentCount([
        new TextDisplayBuilder().setContent(summaryText).toJSON(),
        ...rows.map(row => row.toJSON()),
    ]);
    const previewComponentBudget = Math.max(0, CV2_COMPONENT_BUDGET - reservedComponents);
    let preview: ContainerBuilder[] = [];
    if (command) {
        if (session.selectedSection === "general" || !session.selectedSection) {
            const generalPreview = buildGeneralPreview(command, previewBudget, previewComponentBudget);
            preview = generalPreview.components.length ? [generalPreview] : [];
        } else if (session.selectedSection === "embed") {
            preview = buildUnitPreview(command, undefined, previewBudget, previewComponentBudget);
        } else if (session.selectedSection === "page" && page) {
            preview = buildUnitPreview(page, command.accent_color, previewBudget, previewComponentBudget);
        }
    }

    const components = [
        new TextDisplayBuilder().setContent(summaryText).toJSON(),
        ...preview.map(container => container.toJSON()),
        ...rows.map(row => row.toJSON()),
    ];

    if (messageComponentCount(components) > CV2_COMPONENT_BUDGET) {
        throw new Error("Editor response exceeded Discord's CV2 component budget");
    }

    // The preview renders staff-authored block text, and CV2 TextDisplays ping
    // through allowedMentions (see cv2.ts) — a repaint must never notify.
    return { components, allowedMentions: { parse: [] } };
}

function showModal(interaction: ButtonInteraction | StringSelectMenuInteraction, modal: ModalBuilder) {
    return interaction.showModal(modal);
}

export interface SessionDiff {
    created: CustomCommand[];
    changed: CustomCommand[];
    deleted: string[];
}

/** Exported for tests. */
export function diffSessionCommands(session: Pick<EditorSession, "commands" | "originalCommands">): SessionDiff {
    const originals = new Map(session.originalCommands.map(c => [c.name, c]));
    const current = new Map(session.commands.map(c => [c.name, c]));
    const created: CustomCommand[] = [];
    const changed: CustomCommand[] = [];
    for (const command of session.commands) {
        const original = originals.get(command.name);
        if (!original) created.push(command);
        else if (!deepEqual(original, command)) changed.push(command);
    }
    const deleted = [...originals.keys()].filter(name => !current.has(name));
    return { created, changed, deleted };
}

/** Exported for tests. Apply only touched files to the current live corpus. */
export function mergeSessionDiffIntoCommands(current: CustomCommand[], diff: SessionDiff): CustomCommand[] {
    const merged = new Map(current.map(command => [command.name, jsonClone(command)]));
    for (const command of diff.created) merged.set(command.name, jsonClone(command));
    for (const command of diff.changed) merged.set(command.name, jsonClone(command));
    for (const name of diff.deleted) merged.delete(name);
    return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function markSessionSaved(session: EditorSession, commands: CustomCommand[], statusMessage: string): void {
    session.commands = jsonClone(commands);
    session.originalCommands = jsonClone(commands);
    session.hasUnsavedChanges = false;
    session.lastTouched = Date.now();
    session.statusMessage = statusMessage;
}

/** Exported for tests. Return a valid, unique page name for Duplicate Page. */
export function nextDuplicatePageName(baseName: string, pages: CommandPage[]): string | null {
    for (let suffix = 1; suffix < 10_000; suffix++) {
        const suffixText = `_copy${suffix}`;
        const rootLength = 32 - suffixText.length;
        if (rootLength <= 0) return null;
        const candidate = `${baseName.slice(0, rootLength)}${suffixText}`;
        if (!NAME_PATTERN.test(candidate)) continue;
        if (!pages.some(p => p.name === candidate)) return candidate;
    }
    return null;
}

/**
 * Save an editor session: commit each created/changed/deleted command as its
 * own file to GitHub FIRST (per-file blob-SHA conflict detection), and only
 * then update disk + the live command set + slash registration. A conflict
 * stops the batch with the session still dirty; files committed earlier in
 * the same batch stay committed, advance the live corpus in lockstep with
 * their blob SHAs, and are recorded on `session.pendingSync`, so the next
 * successful save (even a zero-diff one) catches up the snapshot and slash
 * registration. Sets
 * session.statusMessage. Exported for tests.
 */
export async function commitSessionChanges(
    client: KrytenClient,
    session: EditorSession,
    authorLabel: string,
): Promise<void> {
    const diff = diffSessionCommands(session);
    const totalChanges = diff.created.length + diff.changed.length + diff.deleted.length;

    // Validate (and normalize in place) every created/changed command against
    // Discord's embed limits BEFORE anything is committed. The GitHub *load*
    // path gates on this, but the editor commits via the Contents API — not a
    // PR through CI — so without this a Save could push a command that 400s on
    // every invocation (an empty embed, a >6000-char message, 25 over-long
    // fields). Abort the whole save atomically on the first failure so nothing
    // reaches GitHub or the live corpus.
    for (const command of [...diff.created, ...diff.changed]) {
        const validationError = validateCustomCommandDetailed(command);
        if (validationError) {
            session.statusMessage = `Cannot save '${command.name}': ${validationError}. Fix it and try again.`;
            return;
        }
    }

    // Slash-command registration only happens after a fully successful save.
    // Capture that baseline separately from the live corpus: while GitHub calls
    // are in flight, other save/reload paths can legitimately update
    // client.custom_commands, and applyLocal must merge into that current live
    // corpus rather than this snapshot.
    const registrationBaseline = session.pendingSync?.registrationBaseline ?? jsonClone(client.custom_commands);

    const applyLocal = async (syncMessage: string): Promise<void> => {
        const baselineForRegistration = session.pendingSync?.registrationBaseline ?? registrationBaseline;
        let merged = mergeSessionDiffIntoCommands(client.custom_commands, diff);
        // Also apply files committed by earlier PARTIAL attempts of this
        // session: advanceBaseline consumed their diff entries, but the
        // snapshot/registration step never ran after the mid-batch failure.
        if (session.pendingSync) {
            merged = mergeSessionDiffIntoCommands(merged, {
                created: [],
                changed: Object.values(session.pendingSync.upserts),
                deleted: session.pendingSync.deletes,
            });
            delete session.pendingSync;
        }
        client.custom_commands = merged;
        client.commandSync.saveSnapshot();
        markSessionSaved(session, merged, "Changes saved locally.");
        session.fileShas = client.commandSync.snapshotShas();
        try {
            await client.registerIfChanged(baselineForRegistration);
            session.statusMessage = `Commands saved. ${syncMessage}`;
        } catch (registerError) {
            // Data is already consistent (GitHub/disk/live) — only the slash
            // registration failed, and /reload_commands retries it.
            console.error("Failed to re-register slash commands after save:", registerError);
            session.statusMessage = `${syncMessage} Slash-command registration failed — run /reload_commands to retry.`;
        }
    };

    if (totalChanges === 0) {
        // A discarded-then-saved session can still carry commits from an
        // earlier partial attempt — drain them so live/snapshot converge
        // with GitHub instead of silently dropping them.
        if (session.pendingSync) {
            await applyLocal("Earlier committed changes synced.");
            return;
        }
        markSessionSaved(session, client.custom_commands, "No changes to save.");
        session.fileShas = client.commandSync.snapshotShas();
        return;
    }

    const files = client.commandSync.filesClient();
    if (!files) {
        await applyLocal("Changes saved locally (GitHub sync disabled).");
        return;
    }

    // Blind-write protection: edits/deletes need the blob SHAs snapshotted
    // when this session's working copy was refreshed. Pure creates are safe
    // without them (GitHub itself rejects a create over an existing file).
    if ((diff.changed.length > 0 || diff.deleted.length > 0) && session.fileShas === undefined) {
        session.statusMessage =
            "The editor was opened without a known GitHub revision. Run /reload_commands and reopen the editor before saving.";
        return;
    }

    const safeAuthor = sanitizeCommitAuthor(authorLabel);
    let committed = 0;
    const failWith = (name: string, detail: string): void => {
        const earlier =
            committed > 0 ? ` Note: ${committed} earlier change(s) in this save already committed to GitHub.` : "";
        session.statusMessage = `${detail.replace("{name}", `'${name}'`)}${earlier}`;
    };

    // Advance the session's baseline for a file that just committed: treat
    // originalCommands as "what GitHub now has", so a retry after a mid-batch
    // failure diffs only the still-pending files instead of re-attempting
    // (and re-conflicting on) already-committed ones. The commit is ALSO
    // recorded on session.pendingSync — advancing the baseline removes it
    // from future diffs, so without the record a retry's applyLocal would
    // never bring the live corpus/snapshot up to what GitHub already has.
    const advanceBaseline = (name: string, committedBody: CustomCommand | null): void => {
        const idx = session.originalCommands.findIndex(c => c.name === name);
        if (committedBody === null) {
            if (idx !== -1) session.originalCommands.splice(idx, 1);
        } else if (idx !== -1) {
            session.originalCommands[idx] = jsonClone(committedBody);
        } else {
            session.originalCommands.push(jsonClone(committedBody));
        }

        const pending = (session.pendingSync ??= {
            upserts: {},
            deletes: [],
            registrationBaseline: jsonClone(registrationBaseline),
        });
        if (committedBody === null) {
            delete pending.upserts[name];
            if (!pending.deletes.includes(name)) pending.deletes.push(name);
        } else {
            pending.upserts[name] = jsonClone(committedBody);
            pending.deletes = pending.deletes.filter(pendingName => pendingName !== name);
        }
    };

    // Advance the LIVE corpus for one just-committed file. commandSync's per-file
    // SHA/raw state advances in applyCommit/applyDelete immediately, but
    // client.custom_commands is otherwise only replaced in applyLocal after the
    // WHOLE batch — so a mid-batch failure would leave the live body stale while
    // its blob SHA is fresh. A second editor session seeding its working copy
    // from client.custom_commands and anchoring SHAs from snapshotShas() would
    // then commit the stale body over the fresh SHA and silently clobber this
    // change. Advancing the live corpus in lockstep per file closes that window.
    const applyLiveCommand = (name: string, committedBody: CustomCommand | null): void => {
        const next = client.custom_commands.filter(c => c.name !== name);
        if (committedBody !== null) next.push(jsonClone(committedBody));
        next.sort((a, b) => a.name.localeCompare(b.name));
        client.custom_commands = next;
    };

    const deleteOne = async (name: string): Promise<boolean> => {
        const message = clampCommitMessage(`Delete command '${name}' (edited by ${safeAuthor})`);
        const sha = session.fileShas?.[name];
        if (!sha) {
            failWith(name, "No known GitHub revision for {name}. Run /reload_commands and reopen the editor.");
            return false;
        }
        const result = await files.deleteCommand(name, message, sha);
        if (result.status !== "ok") {
            if (result.status === "sha_conflict")
                failWith(
                    name,
                    "GitHub changed since you opened {name}. Run /reload_commands, then discard and re-apply your edits.",
                );
            else if (result.status === "timeout")
                failWith(
                    name,
                    "GitHub timed out deleting {name} — the delete may have landed; run /reload_commands before retrying.",
                );
            else failWith(name, `GitHub sync failed deleting {name}: ${result.message}`);
            return false;
        }
        client.commandSync.applyDelete(name);
        if (session.fileShas) delete session.fileShas[name];
        advanceBaseline(name, null);
        applyLiveCommand(name, null);
        return true;
    };

    const commitOne = async (command: CustomCommand, kind: "create" | "edit"): Promise<boolean> => {
        const name = command.name;
        const message = clampCommitMessage(
            `${kind === "create" ? "Create" : "Update"} command '${name}' (edited by ${safeAuthor})`,
        );
        const sha = kind === "edit" ? session.fileShas?.[name] : undefined;
        if (kind === "edit" && !sha) {
            failWith(name, "No known GitHub revision for {name}. Run /reload_commands and reopen the editor.");
            return false;
        }
        const body = command as unknown as Record<string, unknown>;
        const result = await files.commitCommand(name, body, message, sha);
        if (result.status !== "ok") {
            if (result.status === "sha_conflict")
                failWith(
                    name,
                    kind === "create"
                        ? "{name} already exists on GitHub. Run /reload_commands, then reopen the editor."
                        : "GitHub changed since you opened {name}. Run /reload_commands, then discard and re-apply your edits.",
                );
            else if (result.status === "timeout")
                failWith(
                    name,
                    "GitHub timed out saving {name} — the commit may have landed; run /reload_commands before retrying.",
                );
            else failWith(name, `GitHub sync failed saving {name}: ${result.message}`);
            return false;
        }
        session.fileShas = session.fileShas ?? {};
        if (result.newSha) session.fileShas[name] = result.newSha;
        else delete session.fileShas[name];
        client.commandSync.applyCommit(name, result.newSha, body);
        advanceBaseline(name, command);
        applyLiveCommand(name, command);
        return true;
    };

    // Deterministic order: creates → edits → deletes (a rename is create+delete,
    // so the new file exists before the old one goes).
    for (const command of diff.created) {
        if (!(await commitOne(command, "create"))) return;
        committed++;
    }
    for (const command of diff.changed) {
        if (!(await commitOne(command, "edit"))) return;
        committed++;
    }
    for (const name of diff.deleted) {
        if (!(await deleteOne(name))) return;
        committed++;
    }

    await client.commandSync.refreshDigest();
    await applyLocal(`Changes synced to GitHub by ${safeAuthor} (${committed} file${committed === 1 ? "" : "s"}).`);
}

/**
 * Apply files committed by an earlier PARTIAL save (recorded on
 * session.pendingSync) to the snapshot and slash registration. Called when a
 * session is abandoned via Close: without it, a committed create would stay
 * live-but-unregistered forever — the poller can't heal that, because it
 * compares corpus-before vs corpus-after and both already contain the file.
 * Exported for tests.
 */
export async function drainPendingSync(client: KrytenClient, session: EditorSession): Promise<void> {
    if (!session.pendingSync) return;
    const baseline = session.pendingSync.registrationBaseline;
    client.custom_commands = mergeSessionDiffIntoCommands(client.custom_commands, {
        created: [],
        changed: Object.values(session.pendingSync.upserts),
        deleted: session.pendingSync.deletes,
    });
    delete session.pendingSync;
    client.commandSync.saveSnapshot();
    try {
        await client.registerIfChanged(baseline);
    } catch (error) {
        // Data is consistent (GitHub/disk/live) — only the slash registration
        // failed, and /reload_commands retries it.
        console.error("Failed to re-register slash commands while draining earlier commits:", error);
    }
}

const SESSION_EXPIRED_TEXT = "This editor session has expired. Run /edit_command to start again.";

/**
 * Expired-session repaint for the clicked editor message. Sessions are
 * in-memory, so this is the one editor path that can hit a message from a
 * previous deploy — match the message's own format (the CV2 flag is
 * per-message and can't be added or removed on update).
 */
function sessionExpiredResponse(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
): InteractionUpdateOptions {
    if (interaction.message.flags.has(MessageFlags.IsComponentsV2)) {
        return {
            components: [new TextDisplayBuilder().setContent(SESSION_EXPIRED_TEXT).toJSON()],
            allowedMentions: { parse: [] },
        };
    }
    return { content: SESSION_EXPIRED_TEXT, embeds: [], components: [], allowedMentions: { parse: [] } };
}

export const SAVE_IN_PROGRESS_MESSAGE = "A save is already in progress — please wait for it to finish.";

const STALE_VIEW_MESSAGE =
    "This editor view is out of date — your submission was not applied. Reopen the modal and try again.";

export function handleSectionSelection(interaction: StringSelectMenuInteraction, client: KrytenClient) {
    // Peek only: silently creating a fresh session here would let a Save on an
    // expired editor report success while discarding the on-screen edits.
    const session = client.commandEditor.getSession(interaction.user.id);
    if (!session) {
        return interaction.update(sessionExpiredResponse(interaction));
    }
    if (session.saving) {
        return interaction.reply({ content: SAVE_IN_PROGRESS_MESSAGE, ephemeral: true });
    }
    const value = interaction.values[0]!;

    if (!session.selectedCommandName) {
        return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
    }

    const command = client.commandEditor.getSelectedCommand(session);
    if (!command) {
        return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
    }

    if (value === ADD_PAGE_VALUE) {
        // The Add Page button disables itself at the cap; this select option
        // must enforce it too or pages past the cap become unreachable dead data.
        if ((command.pages?.length ?? 0) >= MAX_PAGES) {
            session.statusMessage = `Commands support at most ${MAX_PAGES} pages.`;
            return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
        }
        const modal = new ModalBuilder()
            .setCustomId(scopedModalId(MODAL_ADD_PAGE_ID, command.name))
            .setTitle(clampModalTitle("Add New Page"));

        const nameInput = new TextInputBuilder()
            .setCustomId("page_name")
            .setLabel("Page Name (lowercase, 1-32 chars)")
            .setStyle(TextInputStyle.Short)
            .setRequired(true)
            .setMaxLength(32);

        const titleInput = new TextInputBuilder()
            .setCustomId("page_title")
            .setLabel("Page Title")
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setMaxLength(100);

        const descriptionInput = new TextInputBuilder()
            .setCustomId("page_description")
            .setLabel("Page Description")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false)
            .setMaxLength(4000);

        modal.addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
            new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput),
        );

        return showModal(interaction, modal);
    }

    if (value.startsWith(PAGE_VALUE_PREFIX)) {
        const pageName = value.slice(PAGE_VALUE_PREFIX.length);
        client.commandEditor.setView(session, "page", pageName);
        session.statusMessage = `Selected page '${pageName}'.`;
    } else if (value === "general" || value === "embed") {
        client.commandEditor.setView(session, value as EditorSection, session.selectedPageName);
        session.statusMessage = `Editing section '${value}'.`;
    }

    return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
}

export function handleBlockSelection(interaction: StringSelectMenuInteraction, client: KrytenClient) {
    const session = client.commandEditor.getSession(interaction.user.id);
    if (!session) {
        return interaction.update(sessionExpiredResponse(interaction));
    }
    if (session.saving) {
        return interaction.reply({ content: SAVE_IN_PROGRESS_MESSAGE, ephemeral: true });
    }
    const command = client.commandEditor.getSelectedCommand(session);
    const page = client.commandEditor.getSelectedPage(session);
    const unit = viewedUnit(session, command, page);
    const unitTag = viewedUnitTag(session);
    if (!command || !unit || unitTag === undefined) {
        return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
    }
    const blocks = unit.blocks ?? [];
    const value = interaction.values[0]!;

    if (value.startsWith(BLOCK_VALUE_PREFIX)) {
        const index = Number(value.slice(BLOCK_VALUE_PREFIX.length));
        if (!Number.isInteger(index) || index < 0 || index >= blocks.length) {
            // Stale select (blocks changed since this message rendered).
            session.selectedBlockIndex = undefined;
            session.statusMessage = "That block no longer exists.";
        } else {
            session.selectedBlockIndex = index;
            session.statusMessage = `Selected block ${index + 1} (${blocks[index]!.type}).`;
        }
        return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
    }

    if (value.startsWith(ADD_BLOCK_VALUE_PREFIX)) {
        const type = value.slice(ADD_BLOCK_VALUE_PREFIX.length) as BlockType;
        if (!BLOCK_TYPES.includes(type)) {
            return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
        }
        if (blocks.length >= MAX_BLOCKS_PER_UNIT) {
            session.statusMessage = `A view supports at most ${MAX_BLOCKS_PER_UNIT} blocks.`;
            return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
        }
        // New blocks land right after the cursor, else at the end.
        const insertPosition =
            session.selectedBlockIndex !== undefined && session.selectedBlockIndex < blocks.length
                ? session.selectedBlockIndex + 2
                : blocks.length + 1;
        if (type === "divider") {
            // Nothing to collect — insert without a modal round-trip.
            const error = commitBlockEdit(client, session, unit, unitTag, {
                kind: "insert",
                block: { type },
                position: insertPosition,
            });
            session.statusMessage = error ?? `Added divider at position ${insertPosition}.`;
            return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
        }
        const modal = buildBlockModal(command.name, unitTag, type, "new", undefined, insertPosition, blocks.length + 1);
        if ("error" in modal) {
            session.statusMessage = modal.error;
            return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
        }
        return showModal(interaction, modal);
    }

    return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
}

export async function handleEditorButton(interaction: ButtonInteraction, client: KrytenClient) {
    const session = client.commandEditor.getSession(interaction.user.id);
    if (!session) {
        return interaction.update(sessionExpiredResponse(interaction));
    }
    if (session.saving) {
        return interaction.reply({ content: SAVE_IN_PROGRESS_MESSAGE, ephemeral: true });
    }
    const command = client.commandEditor.getSelectedCommand(session);
    const page = client.commandEditor.getSelectedPage(session);

    // Page-action buttons scope both command and page into the custom-id
    // (base:commandName:pageName). A stale card from another command must not
    // resolve a common page name against the session's newly selected command.
    // Unscoped legacy ids and malformed scopes deliberately resolve to no target.
    const [baseId = interaction.customId, ...buttonScope] = interaction.customId.split(":");
    const targetPage =
        command && buttonScope.length === 2 && buttonScope[0] === command.name
            ? command.pages?.find(p => p.name === buttonScope[1])
            : undefined;

    switch (baseId) {
        case BUTTON_EDIT_GENERAL_ID: {
            if (!command) break;
            const modal = new ModalBuilder()
                .setCustomId(scopedModalId(MODAL_GENERAL_ID, command.name))
                .setTitle(clampModalTitle(`Edit ${command.name} — General`));

            const nameInput = new TextInputBuilder()
                .setCustomId("name")
                .setLabel("Command Name")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setValue(command.name)
                .setMaxLength(32);

            const descriptionInput = new TextInputBuilder()
                .setCustomId("description")
                .setLabel("Command Description")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setValue(command.description)
                .setMaxLength(MAX_COMMAND_DESCRIPTION_LENGTH);

            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput),
            );

            return interaction.showModal(modal);
        }
        case BUTTON_EDIT_BLOCKS_ID: {
            if (!command) break;
            const serialized = serializeBlocksForInput(command.blocks);
            if (serialized.length > MAX_BLOCKS_INPUT_CHARS) {
                return interaction.reply({
                    content: `This command's blocks are too large to edit here (Discord caps the editor box at ${MAX_BLOCKS_INPUT_CHARS} characters). Split content across pages, or edit the command file directly in the GitHub repo.`,
                    ephemeral: true,
                });
            }
            const modal = new ModalBuilder()
                .setCustomId(scopedModalId(MODAL_BLOCKS_ID, command.name))
                .setTitle(clampModalTitle(`Edit ${command.name} — Content`));

            const colorInput = new TextInputBuilder()
                .setCustomId("accent_color")
                .setLabel("Accent Color (hex or decimal, optional)")
                .setStyle(TextInputStyle.Short)
                .setRequired(false);
            if (command.accent_color !== undefined) {
                colorInput.setValue(`#${command.accent_color.toString(16).padStart(6, "0")}`);
            }

            const thumbnailInput = new TextInputBuilder()
                .setCustomId("thumbnail_url")
                .setLabel("Thumbnail URL (small corner image)")
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(MAX_THUMBNAIL_URL);
            if (command.thumbnail_url !== undefined) thumbnailInput.setValue(command.thumbnail_url);

            const blocksInput = new TextInputBuilder()
                .setCustomId("blocks_json")
                .setLabel("Blocks JSON (blank if pages carry content)")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setMaxLength(MAX_BLOCKS_INPUT_CHARS);
            if (serialized.length) blocksInput.setValue(serialized);

            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(colorInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(thumbnailInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(blocksInput),
            );
            return showModal(interaction, modal);
        }
        case BUTTON_EDIT_PAGE_BLOCKS_ID: {
            if (!command || !page) break;
            const serialized = serializeBlocksForInput(page.blocks);
            if (serialized.length > MAX_BLOCKS_INPUT_CHARS) {
                return interaction.reply({
                    content: `This page's blocks are too large to edit here (Discord caps the editor box at ${MAX_BLOCKS_INPUT_CHARS} characters). Split content across pages, or edit the command file directly in the GitHub repo.`,
                    ephemeral: true,
                });
            }
            const modal = new ModalBuilder()
                .setCustomId(scopedModalId(MODAL_PAGE_BLOCKS_ID, command.name, page.name))
                .setTitle(clampModalTitle(`Edit Page Content — ${page.title ?? page.name}`));

            const colorInput = new TextInputBuilder()
                .setCustomId("accent_color")
                .setLabel("Accent Color (hex, blank = command color)")
                .setStyle(TextInputStyle.Short)
                .setRequired(false);
            if (page.accent_color !== undefined) {
                colorInput.setValue(`#${page.accent_color.toString(16).padStart(6, "0")}`);
            }

            const thumbnailInput = new TextInputBuilder()
                .setCustomId("thumbnail_url")
                .setLabel("Thumbnail URL (small corner image)")
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(MAX_THUMBNAIL_URL);
            if (page.thumbnail_url !== undefined) thumbnailInput.setValue(page.thumbnail_url);

            const blocksInput = new TextInputBuilder()
                .setCustomId("blocks_json")
                .setLabel("Blocks JSON")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(MAX_BLOCKS_INPUT_CHARS);
            if (serialized.length) blocksInput.setValue(serialized);

            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(colorInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(thumbnailInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(blocksInput),
            );
            return showModal(interaction, modal);
        }
        case BUTTON_EDIT_PAGE_INFO_ID: {
            if (!command || !targetPage) break;
            const modal = new ModalBuilder()
                .setCustomId(scopedModalId(MODAL_PAGE_INFO_ID, command.name, targetPage.name))
                .setTitle(clampModalTitle(`Edit Page — ${targetPage.title ?? targetPage.name}`));

            const nameInput = new TextInputBuilder()
                .setCustomId("name")
                .setLabel("Page Name (lowercase, 1-32 chars)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setValue(targetPage.name)
                .setMaxLength(32);

            // Clamp prefills to the inputs' max lengths: a longer value (e.g.
            // from a file committed straight to GitHub) makes Discord reject
            // the showModal call, leaving the page uneditable in-app.
            const titleInput = new TextInputBuilder()
                .setCustomId("title")
                .setLabel("Title")
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setValue(clampText(targetPage.title ?? "", 100, ""))
                .setMaxLength(100);

            const descriptionInput = new TextInputBuilder()
                .setCustomId("description")
                .setLabel("Description")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setValue(clampText(targetPage.description ?? "", 4000, ""))
                .setMaxLength(4000);

            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput),
            );

            return interaction.showModal(modal);
        }
        case BUTTON_EDIT_BLOCK_ID: {
            const selected = resolveSelectedBlock(session, command, page);
            if (!command || !selected) break;
            const modal = buildBlockModal(
                command.name,
                selected.unitTag,
                selected.block.type,
                String(selected.index),
                selected.block,
                selected.index + 1,
                selected.blocks.length,
            );
            if ("error" in modal) {
                return interaction.reply({ content: modal.error, ephemeral: true });
            }
            session.pendingBlockEdit = {
                unitTag: selected.unitTag,
                index: selected.index,
                block: jsonClone(selected.block),
            };
            return showModal(interaction, modal);
        }
        case BUTTON_DELETE_BLOCK_ID: {
            const selected = resolveSelectedBlock(session, command, page);
            if (!command || !selected) break;
            const { unit, blocks, index, block } = selected;
            const remaining = blocks.filter((_, i) => i !== index);
            if (remaining.length === 0) {
                if (session.selectedSection === "page") {
                    session.statusMessage = "A page needs at least one block — delete the page instead.";
                    return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
                }
                if (!command.pages?.length) {
                    session.statusMessage = "A command needs content blocks or at least one page.";
                    return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
                }
                // Pages carry the content — an empty top-level list is stored
                // as no `blocks` at all, matching what the validator accepts.
                delete (unit as CustomCommand).blocks;
            } else if (!remaining.some(b => b.type !== "divider")) {
                session.statusMessage = "Cannot delete — the view would contain only dividers.";
                return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
            } else {
                unit.blocks = remaining;
            }
            let statusMessage = `Deleted block ${index + 1} (${block.type}). Discard reverts it.`;
            // A thumbnail needs a text block to sit beside; deleting the last
            // one would leave a value the validator silently strips on save.
            if (unit.thumbnail_url !== undefined && !remaining.some(b => blockText(b) !== undefined)) {
                delete unit.thumbnail_url;
                statusMessage += " Also removed the thumbnail — no text block left to attach it to.";
            }
            session.selectedBlockIndex = remaining.length ? Math.min(index, remaining.length - 1) : undefined;
            client.commandEditor.markDirty(session);
            session.statusMessage = statusMessage;
            return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
        }
        case BUTTON_ADD_PAGE_ID: {
            if (!command) break;
            const modal = new ModalBuilder()
                .setCustomId(scopedModalId(MODAL_ADD_PAGE_ID, command.name))
                .setTitle(clampModalTitle("Add New Page"));

            const nameInput = new TextInputBuilder()
                .setCustomId("page_name")
                // Match the submit-time NAME_PATTERN (1-32) and the sibling Add-Page
                // modal, so an over-long name is stopped at the keyboard, not after
                // submit (which would discard the author's input).
                .setLabel("Page Name (lowercase, 1-32 chars)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(32);

            const titleInput = new TextInputBuilder()
                .setCustomId("page_title")
                .setLabel("Title")
                .setStyle(TextInputStyle.Short)
                .setRequired(false)
                .setMaxLength(100);

            const descriptionInput = new TextInputBuilder()
                .setCustomId("page_description")
                .setLabel("Description")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setMaxLength(4000);

            modal.addComponents(
                new ActionRowBuilder<TextInputBuilder>().addComponents(nameInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
                new ActionRowBuilder<TextInputBuilder>().addComponents(descriptionInput),
            );

            return interaction.showModal(modal);
        }
        case BUTTON_DUPLICATE_PAGE_ID: {
            if (!command || !targetPage) break;
            command.pages = command.pages ?? [];
            if (command.pages.length >= MAX_PAGES) {
                session.statusMessage = `Commands support at most ${MAX_PAGES} pages.`;
                return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
            }
            const clone = JSON.parse(JSON.stringify(targetPage)) as CommandPage;
            const candidate = nextDuplicatePageName(clone.name, command.pages);
            if (!candidate) {
                session.statusMessage = "Could not generate a valid duplicate page name.";
                return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
            }
            clone.name = candidate;
            // Clamp to the Edit Page Info modal's 100-char title input, or a
            // long title's copy could never be edited in-app again.
            if (clone.title) clone.title = clampText(`${clone.title} (Copy)`, 100, "");
            command.pages.push(clone);
            client.commandEditor.setView(session, "page", clone.name);
            client.commandEditor.markDirty(session);
            session.statusMessage = `Duplicated page '${targetPage.name}'.`;
            return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
        }
        case BUTTON_DELETE_PAGE_ID: {
            if (!command || !targetPage) break;
            if (!command.pages) break;
            command.pages = command.pages.filter(p => p.name !== targetPage.name);
            client.commandEditor.setView(session, command.pages.length ? "page" : "general", command.pages[0]?.name);
            client.commandEditor.markDirty(session);
            session.statusMessage = `Deleted page '${targetPage.name}'.`;
            return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
        }
        case BUTTON_SAVE_ID: {
            // Hold the session lock across the whole GitHub round-trip so a
            // concurrent button/select/modal on this session is refused (the
            // guards above) instead of mutating the body mid-commit. Set before
            // the first await; cleared in finally so a thrown save can't wedge
            // the editor permanently.
            session.saving = true;
            try {
                const alreadyAcknowledged = interaction.deferred || interaction.replied;
                if (!alreadyAcknowledged) {
                    try {
                        await interaction.deferUpdate();
                    } catch (error) {
                        console.error("Failed to defer editor save interaction:", error);
                    }
                }

                try {
                    const member: any = interaction.member;
                    const authorLabel =
                        member && (member.displayName || member.nickname)
                            ? String(member.displayName || member.nickname)
                            : (interaction.user.globalName ?? interaction.user.username);

                    await commitSessionChanges(client, session, authorLabel);
                } catch (error) {
                    console.error("Failed to save commands:", error);
                    session.statusMessage = "Failed to save. Check logs.";
                }
            } finally {
                session.saving = false;
            }

            const response = buildEditorResponse(session);
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(response as InteractionEditReplyOptions);
            }

            return interaction.update(response as InteractionUpdateOptions);
        }
        case BUTTON_DISCARD_ID: {
            client.commandEditor.resetSession(session);
            return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
        }
        case BUTTON_CLOSE_ID: {
            const alreadyAcknowledged = interaction.deferred || interaction.replied;
            if (!alreadyAcknowledged) {
                try {
                    await interaction.deferUpdate();
                } catch (error) {
                    console.error("Failed to defer editor close interaction:", error);
                }
            }
            // Abandoning the session must not orphan commits from an earlier
            // partial save — catch up the snapshot/registration first.
            await drainPendingSync(client, session);
            client.commandEditor.endSession(session.userId);
            const response = {
                components: [
                    new TextDisplayBuilder()
                        .setContent("Editor session closed. Run /edit_command to start again.")
                        .toJSON(),
                ],
                allowedMentions: { parse: [] },
            };
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply(response as InteractionEditReplyOptions);
            }
            return interaction.update(response as InteractionUpdateOptions);
        }
        default:
            break;
    }

    return interaction.update(buildEditorResponse(session) as InteractionUpdateOptions);
}

/**
 * Parse an accent-color input, returning undefined for anything Discord would
 * reject. The caller turns undefined into immediate modal feedback rather than
 * saving a value that breaks the command's reply.
 */
function parseColorInput(value?: string | null): number | undefined {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    let numeric: number;
    if (trimmed.startsWith("#")) {
        let hex = trimmed.slice(1);
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) return undefined;
        // CSS shorthand: "#fff" means white, not 0x000fff — expand it like a
        // browser would, or shorthand input silently saves the wrong color.
        if (hex.length === 3) hex = [...hex].map(ch => ch + ch).join("");
        numeric = parseInt(hex, 16);
    } else {
        numeric = Number(trimmed);
    }
    // Discord rejects colors outside 0..0xFFFFFF (and non-integers) — a bad
    // value saved here would 400 the command's reply on every invocation.
    return Number.isInteger(numeric) && numeric >= 0 && numeric <= 0xffffff ? numeric : undefined;
}

/**
 * Validate a thumbnail-URL modal input against the shared validator's rules,
 * returning the message to surface or null when empty/valid. Saving a value
 * validateCustomCommandDetailed would repair-strip on load would silently
 * undo the edit — the editor errors loudly instead.
 */
function thumbnailInputError(url: string, blocks: CommandBlock[] | undefined): string | null {
    if (!url) return null;
    if (!isValidEmbedUrl(url) || url.length > MAX_THUMBNAIL_URL) {
        return "Thumbnail URL must be an http(s) link.";
    }
    if (
        !blocks?.some(
            block =>
                typeof block === "object" && block !== null && !Array.isArray(block) && blockText(block) !== undefined,
        )
    ) {
        return "A thumbnail needs at least one text block (heading, text, field, or small) in this view to sit beside.";
    }
    return null;
}

export async function handleEditorModal(interaction: ModalSubmitInteraction, client: KrytenClient) {
    const session = client.commandEditor.getSession(interaction.user.id);
    if (!session) {
        return interaction.reply({
            content:
                "This editor session has expired — your submission was not applied. Run /edit_command to start again.",
            ephemeral: true,
        });
    }
    if (session.saving) {
        return interaction.reply({ content: SAVE_IN_PROGRESS_MESSAGE, ephemeral: true });
    }
    const command = client.commandEditor.getSelectedCommand(session);
    let didChange = false;

    // The id's scope names the target the modal was opened for. Refuse a
    // submit whose target no longer matches the session selection — possible
    // when the modal came from a stale editor message. Block modals scope by
    // [command, unit, index|"new", type] where unit "" is the command's own
    // blocks; every other modal scopes by [command, page?].
    const { baseId, scope } = parseEditorModalId(interaction.customId);
    if (modalScopeMismatch(baseId, scope, session, command)) {
        return interaction.reply({ content: STALE_VIEW_MESSAGE, ephemeral: true });
    }

    switch (baseId) {
        case MODAL_GENERAL_ID: {
            if (!command) break;
            const name = interaction.fields.getTextInputValue("name").trim().toLowerCase();
            const descriptionRaw = interaction.fields.getTextInputValue("description").trim();
            const description = descriptionRaw.slice(0, MAX_COMMAND_DESCRIPTION_LENGTH);

            if (!NAME_PATTERN.test(name)) {
                return interaction.reply({
                    content: "Name must be 1-32 characters using lowercase letters, numbers, underscores or hyphens.",
                    ephemeral: true,
                });
            }

            if (session.commands.some(c => c !== command && c.name === name)) {
                return interaction.reply({ content: "A command with that name already exists.", ephemeral: true });
            }

            // A custom command sharing a built-in's name produces a duplicate
            // entry in the registration payload — Discord 400s the whole set.
            if (client.commands.loaded_classes.has(name)) {
                return interaction.reply({
                    content: `'${name}' is reserved for a built-in command.`,
                    ephemeral: true,
                });
            }

            // Editor component ids ("cmd-editor-…") are matched first by the
            // router — a command with that prefix could never route its page
            // selects.
            if (name.startsWith("cmd-editor-")) {
                return interaction.reply({
                    content: "Names starting with 'cmd-editor-' are reserved.",
                    ephemeral: true,
                });
            }

            if (!description.length) {
                return interaction.reply({
                    content: "Description must be between 1 and 100 characters.",
                    ephemeral: true,
                });
            }

            command.name = name;
            command.description = description;

            session.selectedCommandName = command.name;
            client.commandEditor.markDirty(session);
            session.statusMessage = "Updated general info.";
            didChange = true;
            break;
        }
        case MODAL_PAGE_INFO_ID: {
            const page = client.commandEditor.getSelectedPage(session);
            if (!command || !page) break;
            const name = interaction.fields.getTextInputValue("name").trim().toLowerCase();
            const title = interaction.fields.getTextInputValue("title").trim();
            const description = interaction.fields.getTextInputValue("description").trim();

            if (!NAME_PATTERN.test(name)) {
                return interaction.reply({
                    content:
                        "Page name must be 1-32 characters using lowercase letters, numbers, underscores or hyphens.",
                    ephemeral: true,
                });
            }

            if (command.pages?.some(p => p !== page && p.name === name)) {
                return interaction.reply({ content: "Another page already uses that name.", ephemeral: true });
            }

            page.name = name;
            page.title = title || undefined;
            page.description = description || undefined;
            session.selectedPageName = name;
            client.commandEditor.markDirty(session);
            session.statusMessage = "Updated page info.";
            didChange = true;
            break;
        }
        case MODAL_BLOCKS_ID: {
            if (!command) break;
            const colorRaw = interaction.fields.getTextInputValue("accent_color").trim();
            let accent: number | undefined;
            if (colorRaw) {
                accent = parseColorInput(colorRaw);
                if (accent === undefined) {
                    return interaction.reply({
                        content: "Color must be a decimal number or hex like #ff0000 (0 to #ffffff).",
                        ephemeral: true,
                    });
                }
            }
            let blocks: CommandBlock[] | undefined;
            try {
                blocks = parseBlocksInput(interaction.fields.getTextInputValue("blocks_json"));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return interaction.reply({ content: `Failed to parse blocks: ${message}`, ephemeral: true });
            }
            const thumbnailRaw = interaction.fields.getTextInputValue("thumbnail_url").trim();
            if (!blocks) {
                if (!command.pages?.length) {
                    return interaction.reply({
                        content: "A command needs content blocks or at least one page.",
                        ephemeral: true,
                    });
                }
                const thumbnailError = thumbnailInputError(thumbnailRaw, blocks);
                if (thumbnailError) {
                    return interaction.reply({ content: thumbnailError, ephemeral: true });
                }
                delete command.blocks;
            } else {
                const blocksError = validateBlocksDetailed(blocks, "content");
                if (blocksError) {
                    return interaction.reply({ content: blocksError, ephemeral: true });
                }
                const thumbnailError = thumbnailInputError(thumbnailRaw, blocks);
                if (thumbnailError) {
                    return interaction.reply({ content: thumbnailError, ephemeral: true });
                }
                command.blocks = blocks;
            }
            if (accent !== undefined) command.accent_color = accent;
            else delete command.accent_color;
            if (thumbnailRaw) command.thumbnail_url = thumbnailRaw;
            else delete command.thumbnail_url;
            session.selectedBlockIndex = undefined;
            client.commandEditor.markDirty(session);
            session.statusMessage = "Updated content blocks.";
            didChange = true;
            break;
        }
        case MODAL_PAGE_BLOCKS_ID: {
            const page = client.commandEditor.getSelectedPage(session);
            if (!command || !page) break;
            const colorRaw = interaction.fields.getTextInputValue("accent_color").trim();
            let accent: number | undefined;
            if (colorRaw) {
                accent = parseColorInput(colorRaw);
                if (accent === undefined) {
                    return interaction.reply({
                        content: "Color must be a decimal number or hex like #ff0000 (0 to #ffffff).",
                        ephemeral: true,
                    });
                }
            }
            let blocks: CommandBlock[] | undefined;
            try {
                blocks = parseBlocksInput(interaction.fields.getTextInputValue("blocks_json"));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return interaction.reply({ content: `Failed to parse blocks: ${message}`, ephemeral: true });
            }
            if (!blocks) {
                return interaction.reply({ content: "A page needs at least one block.", ephemeral: true });
            }
            const blocksError = validateBlocksDetailed(blocks, `page '${page.name}'`);
            if (blocksError) {
                return interaction.reply({ content: blocksError, ephemeral: true });
            }
            const thumbnailRaw = interaction.fields.getTextInputValue("thumbnail_url").trim();
            const thumbnailError = thumbnailInputError(thumbnailRaw, blocks);
            if (thumbnailError) {
                return interaction.reply({ content: thumbnailError, ephemeral: true });
            }
            page.blocks = blocks;
            if (accent !== undefined) page.accent_color = accent;
            else delete page.accent_color;
            if (thumbnailRaw) page.thumbnail_url = thumbnailRaw;
            else delete page.thumbnail_url;
            session.selectedBlockIndex = undefined;
            client.commandEditor.markDirty(session);
            session.statusMessage = "Updated page content.";
            didChange = true;
            break;
        }
        case MODAL_ADD_PAGE_ID: {
            if (!command) break;
            const name = interaction.fields.getTextInputValue("page_name").trim().toLowerCase();
            const title = interaction.fields.getTextInputValue("page_title").trim();
            const description = interaction.fields.getTextInputValue("page_description").trim();

            if (!NAME_PATTERN.test(name)) {
                return interaction.reply({
                    content:
                        "Page name must be 1-32 characters using lowercase letters, numbers, underscores or hyphens.",
                    ephemeral: true,
                });
            }

            command.pages = command.pages ?? [];

            if (command.pages.length >= MAX_PAGES) {
                return interaction.reply({
                    content: `Commands support at most ${MAX_PAGES} pages.`,
                    ephemeral: true,
                });
            }

            if (command.pages.some(p => p.name === name)) {
                return interaction.reply({ content: "A page with that name already exists.", ephemeral: true });
            }

            const newPage: CommandPage = {
                name,
                title: title || undefined,
                description: description || undefined,
                blocks: [{ type: "text", text: description || "Update this page." }],
            };
            command.pages.push(newPage);
            client.commandEditor.setView(session, "page", name);
            client.commandEditor.markDirty(session);
            session.statusMessage = `Added page '${name}'.`;
            didChange = true;
            break;
        }
        case MODAL_BLOCK_ID: {
            if (!command) break;
            const unitTag = scope[1] ?? "";
            const unit = unitTag === "" ? command : command.pages?.find(p => p.name === unitTag);
            const type = scope[3] as BlockType;
            if (!unit || !BLOCK_TYPES.includes(type)) break;
            const blocks = unit.blocks ?? [];

            // Typed block modals mix input sets per type — read via the field
            // collection so absent inputs yield "" instead of throwing.
            const readField = (key: string): string => {
                const field = interaction.fields.fields.get(key);
                return field && "value" in field && typeof field.value === "string" ? field.value : "";
            };

            const positionRaw = readField(POSITION_INPUT_ID).trim();
            if (!/^\d{1,2}$/.test(positionRaw)) {
                return interaction.reply({ content: "Position must be a number.", ephemeral: true });
            }
            const position = Number(positionRaw);

            const inputs = {
                text: readField("text"),
                url: readField("url"),
                name: readField("name"),
                value: readField("value"),
                urls: readField("urls"),
            };
            let index: number | undefined;
            if (scope[2] !== "new") {
                index = Number(scope[2]);
                // The modal anchors its target by index, but indices aren't
                // identity — refuse unless the block there still matches the
                // snapshot taken when the modal opened (a delete, reorder, or
                // JSON rewrite would otherwise retarget another block).
                const target = Number.isInteger(index) ? blocks[index] : undefined;
                const pending = session.pendingBlockEdit;
                if (
                    !target ||
                    !pending ||
                    pending.unitTag !== unitTag ||
                    pending.index !== index ||
                    !deepEqual(pending.block, target)
                ) {
                    return interaction.reply({ content: STALE_VIEW_MESSAGE, ephemeral: true });
                }
            }

            const built = buildBlockFromInputs(type, inputs);
            if ("error" in built) return interaction.reply({ content: built.error, ephemeral: true });
            const action: BlockEditAction =
                index === undefined
                    ? { kind: "insert", block: built.block, position }
                    : { kind: "edit", index, block: built.block, position };

            const error = commitBlockEdit(client, session, unit, unitTag, action);
            if (error) return interaction.reply({ content: error, ephemeral: true });
            session.pendingBlockEdit = undefined;
            session.statusMessage =
                action.kind === "insert"
                    ? `Added ${type} block at position ${position}.`
                    : `Updated block ${position} (${type}).`;
            didChange = true;
            break;
        }
        default:
            break;
    }

    if (!didChange) {
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: "No changes recorded.", ephemeral: true });
        }
        return;
    }

    const response = buildEditorResponse(session);

    // Editor modals are always opened from a component on the editor message,
    // so the submit carries a FRESH interaction token for that message — repaint
    // with interaction.update() rather than patching via the original slash
    // token (session.responseToken), which expires after 15 min and 404s a
    // repaint for any session edited longer than that. The mutation is already
    // applied to the session, so a failed repaint here isn't data loss.
    if (interaction.isFromMessage()) {
        try {
            await interaction.update(response as InteractionUpdateOptions);
        } catch (error) {
            console.error("Failed to update editor message after modal:", error);
        }
        return;
    }

    // Fallback for a modal not shown from a message component (not expected in
    // the editor): patch the original ephemeral message via the token.
    try {
        await interaction.deferReply({ ephemeral: true });
    } catch (error) {
        console.error("Failed to defer modal reply:", error);
        return;
    }

    if (session.responseToken && session.applicationId) {
        try {
            await updateOriginalEditorMessage(client, session, response);
            await interaction.deleteReply().catch(() => undefined);
        } catch (error) {
            console.error("Failed to update editor message after modal:", error);
            await interaction
                .editReply({ content: "Failed to update editor view. Check logs." })
                .catch(() => undefined);
        }
    } else {
        await interaction
            .editReply({ content: "Missing response context. Please rerun /edit_command." })
            .catch(() => undefined);
    }

    return;
}
