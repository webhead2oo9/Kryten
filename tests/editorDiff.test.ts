import { describe, expect, it } from "vitest";
import type { APIMessageTopLevelComponent } from "discord.js";
import {
    buildEditorResponse,
    diffSessionCommands,
    mergeSessionDiffIntoCommands,
    nextDuplicatePageName,
} from "../src/handlers/editorHandler";
import { EditorSession } from "../src/classes/customCommandEditor";
import { CustomCommand } from "../src/types";
import { CV2_COMPONENT_BUDGET, messageComponentCount } from "../src/utils/cv2";

function cmd(name: string, description = "d"): CustomCommand {
    return { name, description, embed: { title: name } };
}

describe("diffSessionCommands", () => {
    it("classifies create, edit, delete, and rename", () => {
        const original = [cmd("keep"), cmd("edited"), cmd("gone"), cmd("oldname")];
        const current = [
            cmd("keep"),
            { ...cmd("edited"), description: "changed" },
            cmd("newname"), // rename of oldname
            cmd("brand-new"),
        ];
        const diff = diffSessionCommands({ commands: current, originalCommands: original });
        expect(diff.created.map(c => c.name).sort()).toEqual(["brand-new", "newname"]);
        expect(diff.changed.map(c => c.name)).toEqual(["edited"]);
        expect(diff.deleted.sort()).toEqual(["gone", "oldname"]);
    });

    it("reports nothing for identical sets", () => {
        const commands = [cmd("a"), cmd("b")];
        const diff = diffSessionCommands({
            commands: JSON.parse(JSON.stringify(commands)),
            originalCommands: commands,
        });
        expect(diff.created).toHaveLength(0);
        expect(diff.changed).toHaveLength(0);
        expect(diff.deleted).toHaveLength(0);
    });

    it("detects deep changes (embed field edits)", () => {
        const original = [{ ...cmd("a"), embed: { title: "a", fields: [{ name: "f", value: "1" }] } }];
        const current = [{ ...cmd("a"), embed: { title: "a", fields: [{ name: "f", value: "2" }] } }];
        const diff = diffSessionCommands({ commands: current, originalCommands: original });
        expect(diff.changed.map(c => c.name)).toEqual(["a"]);
    });
});

describe("mergeSessionDiffIntoCommands", () => {
    it("preserves commands added after the editor session opened", () => {
        const original = [cmd("edited"), cmd("gone")];
        const sessionCommands = [{ ...cmd("edited"), description: "changed" }, cmd("brand-new")];
        const live = [cmd("edited"), cmd("gone"), cmd("concurrent")];

        const diff = diffSessionCommands({ commands: sessionCommands, originalCommands: original });
        const merged = mergeSessionDiffIntoCommands(live, diff);

        expect(merged.map(c => c.name)).toEqual(["brand-new", "concurrent", "edited"]);
        expect(merged.find(c => c.name === "edited")?.description).toBe("changed");
    });
});

describe("nextDuplicatePageName", () => {
    it("truncates long names so duplicate page names remain valid", () => {
        const name = nextDuplicatePageName("abcdefghijklmnopqrstuvwxyz123456", [
            { name: "abcdefghijklmnopqrstuvwxyz123456", embed: { title: "x" } },
        ]);

        expect(name).toBe("abcdefghijklmnopqrstuvwxyz_copy1");
        expect(name).toHaveLength(32);
    });

    it("skips existing duplicate names", () => {
        const name = nextDuplicatePageName("setup", [
            { name: "setup", embed: { title: "x" } },
            { name: "setup_copy1", embed: { title: "x" } },
        ]);

        expect(name).toBe("setup_copy2");
    });
});

describe("buildEditorResponse", () => {
    it("shows the pending-sync hint even when the status message is overwritten", () => {
        const command: CustomCommand = {
            format: 2,
            name: "alpha",
            description: "alpha",
            blocks: [{ type: "text", text: "alpha" }],
        };
        const session: EditorSession = {
            userId: "user",
            commands: [command],
            originalCommands: [command],
            selectedCommandName: "alpha",
            selectedSection: "general",
            hasUnsavedChanges: false,
            lastTouched: Date.now(),
            statusMessage: "Editing 'alpha'.",
            pendingSync: {
                upserts: { alpha: command },
                deletes: [],
                registrationBaseline: [command],
            },
        };

        const response = buildEditorResponse(session);
        const rendered = JSON.stringify(response.components);

        expect(rendered).toContain("Editing 'alpha'.");
        expect(rendered).toContain("Earlier changes already committed to GitHub");
    });

    it("truncates large page previews so editor controls stay within the CV2 component budget", () => {
        const command: CustomCommand = {
            format: 2,
            name: "large",
            description: "large page",
            blocks: [{ type: "text", text: "top" }],
            pages: [
                {
                    name: "details",
                    title: "Details",
                    blocks: Array.from({ length: 30 }, (_, index) => ({
                        type: "text" as const,
                        text: `block ${index}`,
                    })),
                },
            ],
        };
        const session: EditorSession = {
            userId: "user",
            commands: [command],
            originalCommands: [command],
            selectedCommandName: "large",
            selectedSection: "page",
            selectedPageName: "details",
            hasUnsavedChanges: false,
            lastTouched: Date.now(),
        };

        const response = buildEditorResponse(session);
        const components = response.components as APIMessageTopLevelComponent[];

        expect(messageComponentCount(components)).toBeLessThanOrEqual(CV2_COMPONENT_BUDGET);
        expect(JSON.stringify(components)).toContain("Preview truncated");
    });
});
