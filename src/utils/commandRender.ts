import {
    ContainerBuilder,
    MediaGalleryBuilder,
    MediaGalleryItemBuilder,
    SectionBuilder,
    SeparatorBuilder,
    TextDisplayBuilder,
    ThumbnailBuilder,
} from "discord.js";
import { CommandBlock } from "../types";
import { CV2_COMPONENT_BUDGET, CV2_MEDIA_GALLERY_ITEM_BUDGET, CV2_TEXT_BUDGET } from "./cv2";
import { clampText } from "./format";

/**
 * Native Components-V2 rendering for block-based (format 2) custom commands.
 * One view (a command's top-level `blocks`, or one page's) renders as one
 * container; the page dropdown is appended by the caller.
 *
 * Text budgeting: CV2 caps a message at ~4000 characters across all
 * TextDisplays. Validation keeps every stored view under budget, so the
 * fitting here is a backstop — text blocks are fitted in order (truncated
 * with an ellipsis, dropped once the budget is exhausted) so the renderer
 * can never build an invalid component.
 *
 * Thumbnails: a view's `thumbnail_url` renders as the small corner image —
 * a Section wrapping the view's first consecutive run of text blocks (max 3,
 * Discord's cap) with the thumbnail as its accessory. CV2 has no standalone
 * small image, so a view whose text can't take the section (no text blocks,
 * or the budget backstop dropped them all) renders flat without the
 * thumbnail — the validator repairs those files, this is the render-time
 * backstop.
 */

export { CV2_TEXT_BUDGET };
// A truncated fragment shorter than this reads as noise — drop the part instead.
const MIN_PART_CHARS = 20;
// Discord: a Section holds 1-3 TextDisplay children.
const SECTION_TEXT_CAP = 3;

export interface ContainerRenderOptions {
    textBudget?: number;
    componentBudget?: number;
    truncationText?: string;
}

/** The text a block renders as, or undefined for non-text blocks. */
export function blockText(block: CommandBlock): string | undefined {
    switch (block.type) {
        case "heading":
            return block.url ? `## [${block.text}](${block.url})` : `## ${block.text}`;
        case "text":
            return block.text;
        case "field":
            return `**${block.name}**\n${block.value}`;
        case "small":
            return `-# ${block.text}`;
        default:
            return undefined; // divider, images
    }
}

function blockComponentCost(block: CommandBlock): number {
    if (block.type === "images" && block.urls.length === 0) return 0;
    return 1;
}

export function blocksToContainer(
    blocks: CommandBlock[],
    accentColor?: number,
    textBudget = CV2_TEXT_BUDGET,
    componentBudget = CV2_COMPONENT_BUDGET,
    truncationText?: string,
    thumbnailUrl?: string,
): ContainerBuilder {
    const container = new ContainerBuilder();
    if (accentColor !== undefined) container.setAccentColor(accentColor);

    // Plan the thumbnail section up front: it wraps the first consecutive run
    // of text blocks and costs 2 extra components (the section + accessory)
    // on top of its text children, which cost 1 each either way.
    let sectionStart = -1;
    let sectionLen = 0;
    if (thumbnailUrl) {
        sectionStart = blocks.findIndex(block => blockText(block) !== undefined);
        if (sectionStart !== -1) {
            while (
                sectionLen < SECTION_TEXT_CAP &&
                sectionStart + sectionLen < blocks.length &&
                blockText(blocks[sectionStart + sectionLen]!) !== undefined
            ) {
                sectionLen++;
            }
        }
    }
    let pendingSection = sectionLen > 0;

    let remaining = Math.min(textBudget, CV2_TEXT_BUDGET);
    let remainingComponents = Math.max(0, componentBudget - 1);
    const needsComponentTruncation =
        blocks.reduce((sum, block) => sum + blockComponentCost(block), 0) + (pendingSection ? 2 : 0) >
        remainingComponents;
    const reservedTruncationComponent = Boolean(truncationText && needsComponentTruncation && remainingComponents > 0);
    if (reservedTruncationComponent) remainingComponents -= 1;
    let componentTruncated = false;
    const consumeComponent = (): boolean => {
        if (remainingComponents <= 0) {
            componentTruncated = true;
            return false;
        }
        remainingComponents -= 1;
        return true;
    };
    // Fit one block's text against the remaining budget exactly as the flat
    // path does: full, clamped, or dropped. Shared so a section child and a
    // flat block always render identically.
    const fitText = (text: string): string | undefined => {
        if (text.length <= remaining) {
            remaining -= text.length;
            return text;
        }
        if (remaining >= MIN_PART_CHARS) {
            const fitted = clampText(text, remaining);
            remaining -= fitted.length;
            return fitted;
        }
        return undefined;
    };
    for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index]!;
        if (pendingSection && index === sectionStart) {
            // Needs at least the section + one text child + the accessory;
            // when the budget can't take that (or no text fits), drop the
            // thumbnail and render the run flat rather than truncating text
            // a flat view could still show.
            if (remainingComponents >= 3) {
                const maxChildren = Math.min(sectionLen, remainingComponents - 2);
                const texts: string[] = [];
                let taken = 0;
                while (taken < sectionLen && texts.length < maxChildren) {
                    const fitted = fitText(blockText(blocks[index + taken]!)!);
                    if (fitted !== undefined) texts.push(fitted);
                    taken++;
                }
                if (texts.length) {
                    remainingComponents -= 2 + texts.length;
                    container.addSectionComponents(
                        new SectionBuilder()
                            .addTextDisplayComponents(texts.map(text => new TextDisplayBuilder().setContent(text)))
                            .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnailUrl!)),
                    );
                    index += taken - 1;
                    continue;
                }
            }
            pendingSection = false;
        }
        if (block.type === "divider") {
            if (!consumeComponent()) break;
            container.addSeparatorComponents(new SeparatorBuilder());
            continue;
        }
        if (block.type === "images") {
            if (block.urls.length) {
                if (!consumeComponent()) break;
                container.addMediaGalleryComponents(
                    new MediaGalleryBuilder().addItems(
                        block.urls
                            .slice(0, CV2_MEDIA_GALLERY_ITEM_BUDGET)
                            .map(url => new MediaGalleryItemBuilder().setURL(url)),
                    ),
                );
            }
            continue;
        }
        const text = blockText(block);
        if (!text) continue;
        const fitted = remainingComponents > 0 ? fitText(text) : undefined;
        if (fitted !== undefined) {
            if (!consumeComponent()) break;
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(fitted));
        } else if (remainingComponents <= 0) {
            componentTruncated = true;
            break;
        }
    }
    if (reservedTruncationComponent && componentTruncated && truncationText && remaining > 0) {
        const fitted = truncationText.length <= remaining ? truncationText : clampText(truncationText, remaining);
        if (fitted.length > 0) {
            container.addTextDisplayComponents(new TextDisplayBuilder().setContent(fitted));
        }
    }
    return container;
}

/**
 * A command/page view holder. `thumbnail_url` is per-view and deliberately has
 * no command→page fallback (unlike accent_color): a command icon repeating on
 * every page reads as a rendering bug, not a default.
 */
export interface RenderUnit {
    blocks?: CommandBlock[];
    accent_color?: number;
    thumbnail_url?: string;
}

export function isBlockUnit(unit: RenderUnit): boolean {
    return Array.isArray(unit.blocks) && unit.blocks.length > 0;
}

/**
 * Render one command view (page accent falls back to the command's). Used by
 * the live reply path, the editor preview, and the proposal review card so
 * all three always agree. Empty views render nothing (Discord rejects an
 * empty container).
 */
export function unitContainers(
    unit: RenderUnit,
    fallbackAccent?: number,
    optionsOrTextBudget: ContainerRenderOptions | number = CV2_TEXT_BUDGET,
): ContainerBuilder[] {
    if (!isBlockUnit(unit)) return [];
    const options = typeof optionsOrTextBudget === "number" ? { textBudget: optionsOrTextBudget } : optionsOrTextBudget;
    const container = blocksToContainer(
        unit.blocks!,
        unit.accent_color ?? fallbackAccent,
        options.textBudget ?? CV2_TEXT_BUDGET,
        options.componentBudget ?? CV2_COMPONENT_BUDGET,
        options.truncationText,
        unit.thumbnail_url,
    );
    return container.components.length ? [container] : [];
}
