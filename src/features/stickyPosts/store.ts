import {
    mkdirSync,
    readFileSync,
    writeFileSync,
    openSync,
    closeSync,
    fsyncSync,
    renameSync,
    unlinkSync,
    fstatSync,
} from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "../../utils/isRecord";
import { SNOWFLAKE } from "../../config/stickyPosts";

function keys(value: unknown, allowed: string[]): asserts value is Record<string, unknown> {
    if (!isRecord(value) || Object.keys(value).some(key => !allowed.includes(key)))
        throw new Error("Invalid sticky state");
}
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): boolean {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
}
function validate(value: unknown): Record<string, StickyState> {
    keys(value, ["version", "channels"]);
    if (value["version"] !== 1 || !isRecord(value["channels"]))
        throw new Error("Invalid sticky state version/channels");
    if (Object.keys(value["channels"]).length > 1000) throw new Error("Sticky state capacity exceeded");
    for (const [id, state] of Object.entries(value["channels"])) {
        if (!SNOWFLAKE.test(id)) throw new Error("Invalid sticky state channel");
        keys(state, ["canonical", "intent", "pending", "count", "hash"]);
        if (!integer(state["count"]) || typeof state["hash"] !== "string" || !/^(?:[a-f0-9]{64})?$/.test(state["hash"]))
            throw new Error("Invalid sticky state count/hash");
        if (
            state["canonical"] !== undefined &&
            (typeof state["canonical"] !== "string" || !SNOWFLAKE.test(state["canonical"]))
        )
            throw new Error("Invalid sticky canonical");
        if (
            state["intent"] !== undefined &&
            (typeof state["intent"] !== "string" || !/^[a-f0-9]{24}$/.test(state["intent"]))
        )
            throw new Error("Invalid sticky intent");
        const pending = state["pending"];
        if (pending !== undefined) {
            keys(pending, ["id", "attempts", "retryAt"]);
            if (
                typeof pending["id"] !== "string" ||
                !SNOWFLAKE.test(pending["id"]) ||
                !integer(pending["attempts"], 10) ||
                !integer(pending["retryAt"]) ||
                pending["id"] === state["canonical"] ||
                !state["canonical"]
            )
                throw new Error("Invalid sticky pending deletion");
        }
    }
    return value["channels"] as unknown as Record<string, StickyState>;
}

export interface StickyState {
    canonical?: string;
    intent?: string;
    pending?: { id: string; attempts: number; retryAt: number };
    count: number;
    hash: string;
}

export class StickyStore {
    private failed = false;
    private channels: Record<string, StickyState>;
    constructor(private readonly path: string) {
        try {
            const fd = openSync(path, "r");
            try {
                const stat = fstatSync(fd);
                if (!stat.isFile() || stat.size > 1_048_576) throw new Error("Invalid sticky state file/size");
                this.channels = validate(JSON.parse(readFileSync(fd, "utf8")));
            } finally {
                closeSync(fd);
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.failed = true;
            this.channels = {};
        }
    }
    get(id: string): StickyState {
        if (this.failed) throw new Error("Sticky persistence failed closed; restart after repair");
        if (!this.channels[id] && Object.keys(this.channels).length >= 1000)
            throw new Error("Sticky state capacity exceeded");
        return structuredClone(this.channels[id] ?? { count: 0, hash: "" });
    }
    save(id: string, state: StickyState): void {
        if (this.failed) throw new Error("Sticky persistence failed closed; restart after repair");
        const channels = { ...this.channels, [id]: structuredClone(state) };
        try {
            mkdirSync(dirname(this.path), { recursive: true });
            const temporary = this.path + ".tmp";
            const fd = openSync(temporary, "wx", 0o600);
            try {
                try {
                    writeFileSync(fd, JSON.stringify({ version: 1, channels }));
                    fsyncSync(fd);
                } finally {
                    closeSync(fd);
                }
                renameSync(temporary, this.path);
                const directory = openSync(dirname(this.path), "r");
                try {
                    fsyncSync(directory);
                } finally {
                    closeSync(directory);
                }
            } finally {
                try {
                    unlinkSync(temporary);
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                }
            }
            this.channels = channels;
        } catch (error) {
            this.failed = true;
            throw error;
        }
    }
}
