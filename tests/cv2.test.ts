import {
    APIContainerComponent,
    APIMessageTopLevelComponent,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ComponentType,
    ContainerBuilder,
    MessageFlags,
    TextDisplayBuilder,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { CV2_TEXT_BUDGET, containerTextChars, resolveCard } from "../src/utils/cv2";

function topLevelTextChars(component: APIMessageTopLevelComponent): number {
    if (component.type === ComponentType.Container) return containerTextChars(component);
    if (component.type === ComponentType.TextDisplay) return component.content.length;
    if (component.type === ComponentType.Section) {
        return component.components.reduce((sum, text) => sum + text.content.length, 0);
    }
    return 0;
}

function textFrom(container: APIContainerComponent): string {
    return container.components
        .flatMap(component => {
            if (component.type === ComponentType.TextDisplay) return [component.content];
            if (component.type === ComponentType.Section) return component.components.map(text => text.content);
            return [];
        })
        .join("\n");
}

describe("resolveCard", () => {
    it("trims existing CV2 card text before appending an outcome note", async () => {
        const container = new ContainerBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent("x".repeat(CV2_TEXT_BUDGET - 5)))
            .addActionRowComponents(
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId("approve").setLabel("Approve").setStyle(ButtonStyle.Success),
                ),
            );
        const editReply = vi.fn().mockResolvedValue(undefined);
        const interaction = {
            message: {
                flags: { has: (flag: MessageFlags) => flag === MessageFlags.IsComponentsV2 },
                components: [{ type: ComponentType.Container, toJSON: () => container.toJSON() }],
            },
            editReply,
        } as unknown as ButtonInteraction;
        const note = `**Outcome**\n⚠️ conflict: ${"n".repeat(900)}`;

        await resolveCard(interaction, note, 0xe67e22);

        const payload = editReply.mock.calls[0]![0] as { components: APIMessageTopLevelComponent[] };
        const totalText = payload.components.reduce((sum, component) => sum + topLevelTextChars(component), 0);
        expect(totalText).toBeLessThanOrEqual(CV2_TEXT_BUDGET);

        const resolvedContainer = payload.components.find(
            (component): component is APIContainerComponent => component.type === ComponentType.Container,
        );
        expect(resolvedContainer).toBeDefined();
        expect(resolvedContainer!.components.some(component => component.type === ComponentType.ActionRow)).toBe(false);
        expect(textFrom(resolvedContainer!)).toContain("conflict:");
        expect(textFrom(resolvedContainer!)).toContain("…");
    });
});
