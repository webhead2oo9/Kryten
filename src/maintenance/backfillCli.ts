import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { validateConfig } from "../config/validate";
import { migrateCampaignGreetings } from "./campaignBackfill";

async function main(): Promise<void> {
    const [configPath, exportPath, mode] = process.argv.slice(2);
    if (!configPath || !exportPath || !["--dry-run", "--apply"].includes(mode ?? "") || process.argv.length !== 5) {
        throw new Error(
            "usage: backfillCli.js STAGED_CONFIG EXPORT --dry-run|--apply (cwd must be service state directory)",
        );
    }
    const config = validateConfig(JSON.parse(await readFile(resolve(configPath), "utf8")));
    const input: unknown = JSON.parse(await readFile(resolve(exportPath), "utf8"));
    const assertWriterStopped = () => {
        const state = execFileSync("systemctl", ["show", "kryten.service", "--property=ActiveState", "--value"], {
            encoding: "utf8",
        }).trim();
        if (state !== "inactive") throw new Error("kryten.service must be inactive throughout migration");
    };
    const result = await migrateCampaignGreetings(config, input, {
        apply: mode === "--apply",
        writerStopped: mode === "--apply",
        assertWriterStopped,
    });
    console.log(JSON.stringify(result));
}

if (require.main === module) {
    void main().catch(() => {
        // Never expose parsed data, credentials, or private configuration in a CLI error.
        console.error("Backfill failed; keep the writer stopped, retain backups, and investigate offline.");
        process.exitCode = 1;
    });
}
