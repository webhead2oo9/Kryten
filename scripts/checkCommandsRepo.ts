/**
 * Ops check: list + fetch + validate every command file in the configured
 * GitHub commands repo (or an owner/repo passed as args) without touching
 * Discord. Prints the directory digest the poller would see.
 *
 * Usage: npx ts-node scripts/checkCommandsRepo.ts [owner repo [dir]]
 */
import { config as loadEnv } from "dotenv";
import { readFileSync } from "fs";
import { CommandFilesClient, computeDirectoryDigest } from "../src/github/commandFiles";
import { validateCustomCommand } from "../src/utils/validateCommand";
import type { Config } from "../src/types";

loadEnv();

async function main(): Promise<void> {
    let config: Config;
    const argOwner = process.argv[2];
    const argRepo = process.argv[3];
    if (argOwner && argRepo) {
        config = { githubRepoOwner: argOwner, githubRepoName: argRepo, githubCommandsDir: process.argv[4] ?? "commands" };
    } else {
        config = JSON.parse(readFileSync("./config.json", "utf-8")) as Config;
    }

    const client = CommandFilesClient.fromConfig(config);
    if (!client) {
        console.error("Not configured: need githubRepoOwner, githubRepoName, and GITHUB_PAT.");
        process.exit(1);
    }

    const listing = await client.listCommandDir();
    if ("error" in listing) {
        console.error(`Directory listing failed: ${listing.error} (status ${listing.status ?? "?"})`);
        process.exit(1);
    }
    const entries = listing.entries;
    console.log(`Listing: ${entries.length} .json files`);
    console.log(`Digest:  ${computeDirectoryDigest(entries)}`);

    let ok = 0;
    let bad = 0;
    for (const entry of entries) {
        const result = await client.fetchCommandFile(entry.path);
        if (result === "not_found" || result === "error" || result === "invalid") {
            console.error(`  ${result === "invalid" ? "INVALID FILE" : "FETCH FAIL"}: ${entry.path}`);
            bad++;
            continue;
        }
        const command = { ...result.raw };
        if (!validateCustomCommand(command)) {
            console.error(`  INVALID:    ${entry.path}`);
            bad++;
            continue;
        }
        ok++;
    }
    console.log(`Fetched + validated: ${ok} ok, ${bad} failed`);
    process.exit(bad ? 1 : 0);
}

void main();
