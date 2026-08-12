import { open } from "node:fs/promises";

const MAX_PROMPT_BYTES = 128 * 1024;

export interface BetaClassifierPrompt {
    version: string;
    systemInstruction: string;
}

export async function loadBetaClassifierPrompt(path: string): Promise<BetaClassifierPrompt> {
    const contents = await readPromptFile(path);

    const parsed = JSON.parse(contents) as unknown;
    if (!isObject(parsed)) throw new Error("beta classifier prompt file must contain an object");

    const version = typeof parsed["version"] === "string" ? parsed["version"].trim() : "";
    const systemInstruction =
        typeof parsed["system_instruction"] === "string" ? parsed["system_instruction"].trim() : "";

    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(version)) {
        throw new Error("beta classifier prompt version is invalid");
    }
    if (!systemInstruction || systemInstruction.length > 100_000) {
        throw new Error("beta classifier system instruction is invalid");
    }
    return { version, systemInstruction };
}

async function readPromptFile(path: string): Promise<string> {
    const file = await open(path, "r");
    try {
        const metadata = await file.stat();
        if (!metadata.isFile()) throw new Error("beta classifier prompt path must be a regular file");
        if (metadata.size > MAX_PROMPT_BYTES) throw new Error("beta classifier prompt file is too large");

        const buffer = Buffer.allocUnsafe(MAX_PROMPT_BYTES + 1);
        let offset = 0;
        while (offset < buffer.byteLength) {
            const { bytesRead } = await file.read(buffer, offset, buffer.byteLength - offset, offset);
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        if (offset > MAX_PROMPT_BYTES) throw new Error("beta classifier prompt file is too large");
        return buffer.subarray(0, offset).toString("utf8");
    } finally {
        await file.close();
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
