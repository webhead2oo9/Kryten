/**
 * Shared helpers for Components-V2 messages (flag IsComponentsV2). CV2 replaces
 * `content`/`embeds` with a component tree; these helpers cover the things
 * every CV2 surface repeats — embed-field-style bodies, the recurring accent
 * colors, and resolving a staff review card in place. Container layouts stay
 * inline per surface.
 *
 * NOTE: unlike embeds, mentions inside TextDisplay components DO notify, gated
 * only by allowedMentions — every CV2 send must set allowedMentions explicitly.
 */
import {
    APIContainerComponent,
    APIMessageTopLevelComponent,
    ButtonInteraction,
    ComponentType,
    MessageFlags,
    SeparatorBuilder,
    TextDisplayBuilder,
} from "discord.js";
import { ellipsize } from "./format";

/** Discord's cap on total TextDisplay characters per CV2 message. */
export const CV2_TEXT_BUDGET = 4000;
/** Discord's cap on total components in one CV2 message, including descendants. */
export const CV2_COMPONENT_BUDGET = 40;
/** Discord's cap on items in one Media Gallery component. */
export const CV2_MEDIA_GALLERY_ITEM_BUDGET = 10;

/** Standard accent colors for the alert/review surfaces. */
export const AccentColor = {
    Red: 0xff0000,
    Amber: 0xffaa00,
    Yellow: 0xffff00,
    Orange: 0xffa500,
} as const;

/** Render embed-style fields as one TextDisplay body: `**Name**\nvalue`, blank line between. */
export function renderFields(fields: { name: string; value: string }[]): string {
    return fields.map(field => `**${field.name}**\n${field.value}`).join("\n\n");
}

/** Total component count of a container as the API tallies it (self + descendants). */
export function containerComponentCount(container: APIContainerComponent): number {
    let count = 1;
    for (const child of container.components) {
        count += 1;
        if (child.type === ComponentType.Section) {
            count += child.components.length + 1; // text children + accessory
        } else if (child.type === ComponentType.ActionRow) {
            count += child.components.length;
        }
    }
    return count;
}

export function topLevelComponentCount(component: APIMessageTopLevelComponent): number {
    if (component.type === ComponentType.Container) return containerComponentCount(component);
    if (component.type === ComponentType.ActionRow) return 1 + component.components.length;
    if (component.type === ComponentType.Section) return 1 + component.components.length + 1;
    return 1;
}

export function messageComponentCount(components: readonly APIMessageTopLevelComponent[]): number {
    return components.reduce((sum, component) => sum + topLevelComponentCount(component), 0);
}

/** Total TextDisplay characters in a container (the CV2 per-message text budget). */
export function containerTextChars(container: APIContainerComponent): number {
    let chars = 0;
    for (const child of container.components) {
        if (child.type === ComponentType.TextDisplay) {
            chars += child.content.length;
        } else if (child.type === ComponentType.Section) {
            for (const text of child.components) chars += text.content.length;
        }
    }
    return chars;
}

function topLevelTextChars(component: APIMessageTopLevelComponent): number {
    if (component.type === ComponentType.Container) return containerTextChars(component);
    if (component.type === ComponentType.TextDisplay) return component.content.length;
    if (component.type === ComponentType.Section) {
        return component.components.reduce((sum, text) => sum + text.content.length, 0);
    }
    return 0;
}

function messageTextChars(components: readonly APIMessageTopLevelComponent[]): number {
    return components.reduce((sum, component) => sum + topLevelTextChars(component), 0);
}

/** Truncate to a text budget, capped at Discord's total CV2 message budget. */
function fitText(text: string, maxChars: number): string {
    return ellipsize(text, Math.max(0, Math.min(maxChars, CV2_TEXT_BUDGET)));
}

function trimTextDisplay(display: { content: string }, excessChars: number): number {
    if (excessChars <= 0 || display.content.length === 0) return 0;
    const originalLength = display.content.length;
    display.content = fitText(display.content, originalLength - excessChars);
    return originalLength - display.content.length;
}

function trimSectionText(section: { components: { content: string }[] }, excessChars: number): number {
    let removed = 0;
    for (let i = section.components.length - 1; i >= 0 && removed < excessChars; i--) {
        const text = section.components[i];
        if (!text) continue;
        removed += trimTextDisplay(text, excessChars - removed);
        if (text.content.length === 0) section.components.splice(i, 1);
    }
    return removed;
}

function trimContainerText(container: APIContainerComponent, excessChars: number): number {
    let removed = 0;
    for (let i = container.components.length - 1; i >= 0 && removed < excessChars; i--) {
        const child = container.components[i];
        if (!child) continue;
        if (child.type === ComponentType.TextDisplay) {
            removed += trimTextDisplay(child, excessChars - removed);
            if (child.content.length === 0) container.components.splice(i, 1);
        } else if (child.type === ComponentType.Section) {
            removed += trimSectionText(child, excessChars - removed);
            if (child.components.length === 0) container.components.splice(i, 1);
        }
    }
    return removed;
}

function trimMessageTextToBudget(
    components: APIMessageTopLevelComponent[],
    maxChars: number,
    keepContainer: APIContainerComponent,
): void {
    let excess = messageTextChars(components) - Math.max(0, maxChars);
    for (let i = components.length - 1; i >= 0 && excess > 0; i--) {
        const component = components[i];
        if (!component) continue;
        if (component.type === ComponentType.Container) {
            excess -= trimContainerText(component, excess);
        } else if (component.type === ComponentType.TextDisplay) {
            const removed = trimTextDisplay(component, excess);
            excess -= removed;
            if (component.content.length === 0) components.splice(i, 1);
        } else if (component.type === ComponentType.Section) {
            const removed = trimSectionText(component, excess);
            excess -= removed;
            if (component.components.length === 0) components.splice(i, 1);
        }
    }

    for (let i = components.length - 1; i >= 0; i--) {
        const component = components[i];
        if (
            component?.type === ComponentType.Container &&
            component !== keepContainer &&
            component.components.length === 0
        ) {
            components.splice(i, 1);
        }
    }
}

/**
 * Resolve a CV2 review card in place: rebuild the clicked message's components,
 * drop every action row (the buttons), and append `note` to the first container
 * with the outcome accent color. Works from the message alone, so it also
 * covers post-restart stale cards. Passing no `files`/`attachments` keeps any
 * originally uploaded media on the message.
 */
export async function resolveCard(interaction: ButtonInteraction, note: string, color: number): Promise<void> {
    if (!interaction.message.flags.has(MessageFlags.IsComponentsV2)) {
        // A non-CV2 card (embed-based): leave the embeds as-is, drop the
        // buttons, and carry the note in the content line.
        // allowedMentions matters here too — the note may embed a reviewer's
        // display name, which could otherwise ping (e.g. a nickname "everyone").
        await interaction
            .editReply({ content: note, components: [], allowedMentions: { parse: [] } })
            .catch(() => undefined);
        return;
    }
    const rebuilt: APIMessageTopLevelComponent[] = [];
    let annotatedContainer: APIContainerComponent | undefined;
    for (const component of interaction.message.components) {
        if (component.type === ComponentType.Container) {
            const container = component.toJSON() as APIContainerComponent;
            container.components = container.components.filter(child => child.type !== ComponentType.ActionRow);
            if (!annotatedContainer) {
                container.accent_color = color;
                annotatedContainer = container;
            }
            rebuilt.push(container);
        } else if (component.type === ComponentType.ActionRow) {
            continue; // dropping the buttons is what resolves the card
        } else {
            rebuilt.push(component.toJSON() as APIMessageTopLevelComponent);
        }
    }
    if (!annotatedContainer) {
        annotatedContainer = { type: ComponentType.Container, accent_color: color, components: [] };
        rebuilt.push(annotatedContainer);
    }
    const fittedNote = fitText(note, CV2_TEXT_BUDGET);
    trimMessageTextToBudget(rebuilt, CV2_TEXT_BUDGET - fittedNote.length, annotatedContainer);
    annotatedContainer.components.push(
        new SeparatorBuilder().toJSON(),
        new TextDisplayBuilder().setContent(fittedNote).toJSON(),
    );
    await interaction
        .editReply({ components: rebuilt, flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } })
        .catch(() => undefined);
}
