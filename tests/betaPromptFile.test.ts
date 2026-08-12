import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBetaClassifierPrompt } from "../src/features/betaClassifier/promptFile";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function promptFile(contents: unknown): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "kryten-beta-prompt-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "prompt.json");
    await writeFile(path, JSON.stringify(contents));
    return path;
}

describe("loadBetaClassifierPrompt", () => {
    it("loads a versioned private prompt file", async () => {
        const path = await promptFile({
            version: "synthetic-v2",
            system_instruction: "Classify this synthetic input as ROUTE or IGNORE.",
        });

        await expect(loadBetaClassifierPrompt(path)).resolves.toEqual({
            version: "synthetic-v2",
            systemInstruction: "Classify this synthetic input as ROUTE or IGNORE.",
        });
    });

    it.each([
        [{ system_instruction: "Missing a version." }],
        [{ version: "bad version", system_instruction: "Synthetic prompt." }],
        [{ version: "synthetic-v1", system_instruction: "" }],
        [["not", "an", "object"]],
    ])("rejects malformed prompt data", async contents => {
        await expect(loadBetaClassifierPrompt(await promptFile(contents))).rejects.toThrow();
    });

    it("rejects an oversized prompt file", async () => {
        const path = await promptFile({ version: "synthetic-v1", system_instruction: "x".repeat(128 * 1024) });
        await expect(loadBetaClassifierPrompt(path)).rejects.toThrow(/too large/);
    });

    it("rejects a non-regular prompt path", async () => {
        const directory = await mkdtemp(join(tmpdir(), "kryten-beta-prompt-directory-"));
        temporaryDirectories.push(directory);
        await expect(loadBetaClassifierPrompt(directory)).rejects.toThrow(/regular file/);
    });
});
