# Kryten

Kryten is the Virtual Desktop community's Discord support & moderation bot (discord.js v14, TypeScript). It does two largely independent jobs: it keeps a set of help-center slash commands in sync with a GitHub repository (with an in-guild editor, validation, and cached fallback), and it runs a message pipeline of moderation/utility features — scam-image fingerprinting, crosspost-spam detection, mod-ping alerts, message reporting, and more.

> The name is an affectionate nod to the service mechanoid from *Red Dwarf*. This project is a community effort and is not affiliated with or endorsed by the BBC or the Red Dwarf rights holders.

## Feature Overview
- **GitHub-backed storage**: command files live in a GitHub repo (one JSON file per command); the bot commits edits through the REST API using a PAT.
- **In-guild editor**: Staff can create, edit, and delete commands — and duplicate pages within a command — with `/create_command` + `/edit_command` without touching JSON by hand.
- **Resilient syncing**: Cached copies in `.commands-cache.json`, validation, and GitHub SHA tracking prevent corrupt data and overwrite conflicts.
- **Discord-first feedback**: Critical GitHub or command registration failures are surfaced in a configured Discord channel.

## Requirements
- Node.js 22+ (Discord.js v14 needs 18.17+; this project pins Node 22)
- A Discord bot application with the `applications.commands` scope and a guild to deploy to
- GitHub Personal Access Token with `contents:write` (fine-grained) or `repo` (classic) scope
- Role IDs for staff trusted to manage commands

## Quick Start
1. **Clone & install**
   ```bash
   git clone https://github.com/your-org/Kryten.git
   cd Kryten
   npm install
   ```

2. **Copy templates**
   ```bash
   cp template.env .env
   cp template.config.json config.json
   ```
   Custom commands live in the configured GitHub repo (one JSON file per command) and are pulled on startup; there is no local commands file to seed.

3. **Configure environment** (`.env`)
   ```env
   DISCORD_TOKEN=bot_token_goes_here
   GITHUB_PAT=github_pat_with_repo_scope
   GUILD_ID=primary_guild_id_for_registration
   HEALTH_PORT=9010              # optional, defaults to 9010
   USER_INTERACTIONS_ENCRYPTION_KEY=base64_32_byte_key_for_greeter_state
   ```

4. **Configure runtime** (`config.json`)
   | Key | Description |
   | --- | --- |
   | `staff_roles` | Guild role IDs allowed to run staff commands and open the editor. |
   | `githubRepoOwner` | GitHub org/user that hosts the commands repo. |
   | `githubRepoName` | Repository that stores the per-command files. |
   | `githubCommandsDir` | Directory in the repo holding the `<name>.json` command files. |
   | `githubBranch` | Branch to read and commit commands on. |
   | `error_log_channel_id` | Optional Discord channel to receive error report cards. |

5. **Run the bot**
   ```bash
   # Development (TypeScript in-place)
   npx ts-node src/index.ts

   # Production build + run
   npm run build
   npm start
   ```
   > There is no `npm run dev` script — use `npx ts-node src/index.ts` for local iteration.

## GitHub Sync Explained
- When staff press **Save** in the editor, the bot:
  1. Commits each changed command file (`commands/<name>.json`) to GitHub individually, using its stored blob SHA to detect conflicts.
  2. Updates the in-memory corpus and rewrites the local snapshot (`.commands-cache.json`).
  3. Re-registers slash commands in the configured guild only when a name or description changed.
- Commits are attributed to the staff member who saved (sanitized display name).
- Missing credentials or API failures fall back to local saves and are logged to console + Discord (if `error_log_channel_id` is set).
- `.commands-cache.json` is the only local persistence artifact: the last-good snapshot (commands + per-file SHAs + directory digest), used for cold starts and GitHub outages.

## Managing Commands In-Discord
| Command | Audience | Purpose |
| --- | --- | --- |
| `/create_command name:<slug>` | Staff | Bootstrap a new custom command and open the editor session. |
| `/edit_command name:<slug>` | Staff | Load an existing custom command into the editor UI. |
| `/reload_commands` | Staff | Force refresh from GitHub and re-register slash commands. |
| `/reload_config` | Staff | Reload `config.json` without restarting the bot. |

Editor sessions support page creation, duplication, deletion, and content-block editing through buttons, select menus, and modals. Unsaved sessions are guarded to stop accidental overwrites, and validation enforces Discord's 1-32 lowercase slug format plus the block layout and per-view budgets.

## Custom Command Schema
Commands are block-based (**format 2**) and render as Components-V2 cards; see `src/types.ts` and the commands repo's `AUTHORING.md` for the full spec. A minimal example:

```json
[
  {
    "format": 2,
    "name": "welcome",
    "description": "Send onboarding info",
    "blocks": [
      { "type": "heading", "text": "Welcome to the server!" },
      { "type": "text", "text": "Here are the steps to get started..." }
    ]
  },
  {
    "format": 2,
    "name": "faq",
    "description": "Answer a frequently asked question",
    "pages": [
      {
        "name": "billing",
        "title": "Billing",
        "description": "How billing works",
        "blocks": [
          { "type": "heading", "text": "Billing Help" },
          { "type": "text", "text": "All of the billing info you need." }
        ]
      }
    ]
  }
]
```

- `pages` map onto the select menu rendered inside the command's card. Commands support up to 25 pages (Discord's dropdown limit; the validator drops any beyond 25) — the in-guild editor caps authoring at 22.
- Block types: `heading`, `text`, `field`, `divider`, `images`, `small`. Each view (top-level `blocks` or one page's) is budgeted to ≤30 blocks / ≤3800 rendered characters.
- The editor strips unsupported fields (e.g., legacy `ephemeral`) before committing; legacy embed-shaped files are rejected outright.

## Project Layout
```
src/
  classes/        # Discord client + command editor internals
  commands/       # Built-in slash commands (reload/config/edit/create)
  handlers/       # Interaction + modal orchestration
  stores/         # Persistent storage helpers
  types.ts        # Shared TypeScript contracts
dist/             # Compiled JavaScript (tsc output)
.commands-cache.json # Generated last-good snapshot (only local command artifact)
```

## Troubleshooting
- **401 / 404 from GitHub**: Verify PAT scope, repo path, and secrets. Critical failures are posted to the error channel when configured.
- **Command saves fail with conflict**: Another editor updated GitHub first; run `/reload_commands` to pull latest, then reapply changes.
- **Slash commands missing**: Confirm `GUILD_ID` is set and the bot has Manage Guild + Manage Commands permissions.
- **Bot starts but moderation features are inactive**: `config.json` failed to read/parse — the bot runs on an empty config with the message pipeline disabled (the startup log shows the parse error). Fix the file and run `/reload_config`.
- **Bot crashes on startup**: Ensure `.env` entries are set before launch (e.g. the greeter requires a valid `USER_INTERACTIONS_ENCRYPTION_KEY`).

## Health Endpoint

The bot exposes a `GET /health` endpoint on port **9010** (configurable via `HEALTH_PORT` env var) for the [Service Dashboard](http://localhost:3010). The endpoint returns JSON with:

- `status` — `healthy` / `unhealthy` based on Discord gateway connection
- `uptime` — seconds since process start
- `version` — from `package.json`
- `connections` — Discord WebSocket status and latency
- `metrics` — guild count, member count, commands handled, custom command count
- `errors` — error count since last restart and timestamp of the most recent error

```bash
curl http://localhost:9010/health
```

> The health server binds to loopback (`127.0.0.1`) by default — `/health` is unauthenticated and the proposal intake API shares this port. To expose it deliberately (behind a trusted proxy/firewall), set the `HEALTH_HOST` env var (e.g. `0.0.0.0`).

## Contributing
1. Fork the repo and create a feature branch (`git checkout -b feature/awesome`)
2. Install dependencies + run the bot locally to verify changes
3. Keep TypeScript clean (`npx tsc --noEmit`)
4. Commit using imperative subjects (`Add command editor docs`)
5. Open a PR with problem statement, change summary, testing evidence, and rollout notes

## License
MIT

