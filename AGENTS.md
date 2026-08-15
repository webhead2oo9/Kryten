# AGENTS.md

This file provides guidance to coding agents (e.g. Codex) when working with code in this repository. It mirrors CLAUDE.md - when updating one, update both.

## What this is

Kryten is a Discord support & moderation bot (discord.js v14, TypeScript) for the Virtual Desktop community. It does two largely independent jobs:

1. **GitHub-backed custom slash commands** - help-center answers stored as one JSON file per command in a GitHub repo, editable in-guild via an interactive editor, registered as guild slash commands.
2. **A message-pipeline of moderation/utility features** - scam-image fingerprinting (shared via FingerprintHub), crosspost-spam detection, mod-ping alerts, message reporting, timeout corner, newcomer greeting (the auto-responder), and Twitter/X link fixing.

## Commands

```bash
npx ts-node src/index.ts     # run in dev (TypeScript in-place; there is no npm "dev" script)
npm run build                # tsc -p . -> dist/
npm start                    # node dist/index.js (requires build first)
npm run lint                 # eslint .
npm run format               # prettier --write src/**/*.ts
npm run format:check         # prettier --check
npm test                     # vitest run over tests/
npm run test:coverage        # vitest + v8 coverage over src/
```

- Tests are excluded from the build (`tsconfig include: ["src"]`) and are transpiled, not type-checked. Conformance fixtures live in `tests/fixtures/` (PIL-generated pHash vectors, difflib similarity vectors + a characterization baseline). Enforcement suites pin the dry-run gating - keep them green before touching anything that kicks or times out users.
- Type-check without emitting: `npx tsc --noEmit` (covers `src/` only).
- `scripts/checkCommandsRepo.ts` (run via ts-node) verifies the commands repo loads and prints the poller digest.
- `tsconfig.json` is aggressively strict (`noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `noUnusedLocals/Parameters`, etc.). Index access yields `T | undefined`, and `process.env` must use bracket notation (`process.env["DISCORD_TOKEN"]`). Expect to handle these or the build fails.

## Required runtime files (all gitignored - copy from templates)

- `.env` - `DISCORD_TOKEN`, `GITHUB_PAT`, `GUILD_ID`, `USER_INTERACTIONS_ENCRYPTION_KEY` (32-byte base64/hex key; required whenever the auto-responder greeter or a persistent classifier is configured - startup fails without it, no fallback), optional `HEALTH_PORT` (default 9010), `HEALTH_HOST` (default `127.0.0.1` - loopback; set `0.0.0.0` to expose deliberately), `PROPOSAL_API_KEY` (required when `proposals.enabled`), and `FINGERPRINT_HUB_API_KEY` (required when `moderation.image_fingerprint.hub_enabled`). Copy from `template.env`.
- `config.json` - all feature config (see `template.config.json` and the `Config` interface in `src/types.ts`). Loaded at startup and hot-reloadable via `/reload_config`.
- Generated at runtime: `.commands-cache.json` (last-good commands snapshot and the ONLY local command artifact - v2 format with per-file SHAs + digest, written atomically), encrypted `data/user_interactions.json` (greeter and classifier state, AES-256-GCM via `src/utils/encryptedJson.ts`), `data/proposals.db` (staged LLM proposals, SQLite/WAL).

## Architecture

### Startup (`src/index.ts`)

On `ready`, `KrytenClient`:

1. Starts the health server first, so the dashboard has signal even when startup breaks.
2. Loads built-in command classes, context-menu classes, then custom commands (GitHub -> snapshot -> empty).
3. Registers all three with `application.commands.set(..., GUILD_ID)` - guild-scoped, never global. Exception: when the custom corpus couldn't load at all (`lastLoadSource === "none"`: GitHub down/unconfigured AND no snapshot), it calls `registerBuiltinsPreservingCustom()` instead, registering built-ins + contexts while preserving the custom commands Discord still holds from a prior run rather than deregistering them.
4. Starts the commands-repo poller and (when `proposals.enabled`) the proposal service.

If the startup registration throws, the failure is handed to the poller's per-tick retry via `poller.markRegistrationPending()` - a plain re-poll would see "no change" forever because the digest was already adopted. The hand-off is skipped in the `"none"` case, where retrying would push an empty custom corpus and deregister the commands Discord kept.

`shutdown()` (SIGINT/SIGTERM) stops the poller, proposal service, and fingerprint background tasks, closes the health server, destroys the client, **then** flushes the shared interaction store, bounded to 5s and wrapped in try/finally so shutdown always exits.

The single `interactionCreate` listener delegates to `handleInteraction` (`src/handlers/interactionRouter.ts`): a first-match route table (context menus, editor selects/buttons/modals, proposal and image-fingerprint review buttons by prefix, custom commands + their page selects via `src/handlers/customCommandHandler.ts`, a stale-component deferUpdate catch-all, then built-in chat commands). Each route runs in a try/catch that reports to `logError` and replies ephemerally.

### Two registries of "commands"

- **Built-in commands** (`src/commands/*.ts`) and **context-menu commands** (`src/contexts/*.ts`) are classes (extending `Command` / `ContextCommand`) auto-loaded by `Store` (`src/stores/store.ts`): each file's default export is instantiated and keyed by `command.name`. **To add one, drop a file in the folder** - no manual registration.
- **Custom commands** are plain data (`CustomCommand[]` in `src/types.ts`), not classes: block-based **format 2** JSON (`format: 2` + `blocks`: heading/text/field/divider/images/small, plus an optional per-view `thumbnail_url` - see the commands repo's `AUTHORING.md`), rendered natively as Components-V2 containers via `blocksToContainer` (`src/utils/commandRender.ts`) with the page select inside the card. A view's `thumbnail_url` renders as a Section wrapping the first run of text blocks with the thumbnail as accessory (`images` blocks stay the full-width gallery); it requires a text block in the view - the validator repair-strips it otherwise, and the commands repo CI errors. Files without `format: 2` are rejected outright. Every view is budgeted to CV2's ~4000-char/40-component message caps (`validateCommand.ts` enforces 3800 with headroom, matching the repo CI). Managed entirely through the editor, never code.

### Custom-command sync (`src/github/`)

The most intricate area. Commands live as one JSON file per command (`commands/<name>.json`, filename must equal `name`) in the `webhead2oo9/VirtualDesktopCommands` repo, which also carries `commands.schema.json` + CI validation. Config: `githubRepoOwner`/`githubRepoName`/`githubCommandsDir`/`githubBranch`.

- `contentsApi.ts` - typed Contents API client (`getContents`/`putFile`/`deleteFile` -> `ok | sha_conflict | timeout | error`; 409 maps to `sha_conflict`, 422 only when the error body is sha-shaped - other 422s like branch protection surface as `error`).
- `commandFiles.ts` - per-file semantics: `CommandFilesClient` (list/fetch/commit/delete one command), commit author/message sanitizers, and `computeDirectoryDigest` (sha256 over sorted `path\0sha\n` pairs - **must stay bit-identical everywhere it's computed**, it's the poller's change token; there's a Python cross-check vector in `tests/digest.test.ts`).
- `commandSync.ts` - `CommandSync` on the client: `loadAll()` (GitHub -> snapshot -> empty; a transport failure on the listing or ANY file fails the whole load - a partial corpus must never silently deregister live commands - while per-file validation failures only skip that file), per-name blob SHAs, `rawBodies` (exact parsed file bodies, pre-normalization - the proposal patch engine edits these for minimal diffs), `applyCommit`/`applyDelete`/`refreshDigest` for save paths.
- `poller.ts` - `CommandPoller` (config `githubPollMinutes`, default 60, 0 disables): listing-only digest compare, hot reload + `registerIfChanged` on change. Adopts the new digest only when the reload actually came from GitHub; alerts once (edge-triggered) when the repo becomes unreachable. Also owns the retry for a failed registration push (`markRegistrationPending()`): the pending flag is cleared only when a registration actually reaches Discord - a content-only reload's no-op `registerIfChanged` must not clear it. `/reload_config` re-applies the interval (`poller.start()` is idempotent).

`KrytenClient.registerIfChanged(previous)` re-registers slash commands only when some command's `(name, description)` changed - content-only edits and no-op polls never touch `application.commands.set`. If GitHub config/PAT is absent, everything still works locally.

### In-guild editor (`src/handlers/editorHandler.ts` + `src/classes/customCommandEditor.ts`)

`/create_command` and `/edit_command` open an **ephemeral** editor. `CustomCommandEditor` holds per-user `EditorSession`s (working copy + `originalCommands` for discard, dirty flag, and the interaction `responseToken`/`applicationId` used to patch the original ephemeral message after modal submits). `editorHandler.ts` builds the selects/buttons/modals and mutates the session; the editor message is CV2, previewed via the same unified renderer as live replies.

- **Modal custom-ids are scoped to their edit target** (`base:command[:page]`; block modals use `base:command:unit:index|new:type` where unit `""` means the command's own blocks) and submits validate that scope. Discord's client restores dismissed-modal drafts by custom-id, so a static id would leak one command's draft into another's modal.
- Content is edited **block-by-block**: a block select (one option per block plus trailing "Add <type>" entries; `session.selectedBlockIndex` is the cursor) drives typed per-block modals - each with a 1-based Position input that doubles as move - plus a Delete Block button. Every submit re-validates the whole resulting view via `applyBlockEdit`. The raw-JSON **Edit JSON** modal is the advanced fallback.
- **Save** (`BUTTON_SAVE_ID` -> `commitSessionChanges`) diffs the session against `originalCommands` (create/edit/delete; a rename is create+delete) and commits each changed file individually to GitHub first with its per-file blob SHA, then updates `client.custom_commands`, rewrites the snapshot, and calls `registerIfChanged`.
- The first `sha_conflict` stops the batch: the session stays dirty and local/live state is untouched, but earlier commits in the batch stay committed and the session baseline (`originalCommands` + `fileShas`) is advanced per committed file, so a retry only attempts the still-pending changes. Those earlier commits are recorded on `session.pendingSync` and caught up (snapshot + slash registration) by the next Save - which stays enabled while `pendingSync` exists, even after a Discard - or by `drainPendingSync` on Close or on stale-session eviction (sessions expire after 30 idle minutes; the eviction drainer is wired via `setPendingSyncDrainer` in `index.ts`). The poller can't heal a committed-but-unregistered create: it compares corpus-before vs corpus-after and both already contain it.
- Sessions anchor `fileShas` when (and only when) their working copy is refreshed; edits/deletes refuse to run when the revision is unknown.
- Editor buttons and the section/block selects are matched by exact ID (`EDITOR_BUTTON_IDS` / `SECTION_SELECT_ID` / `BLOCK_SELECT_ID`) in `src/handlers/interactionRouter.ts`'s route table - **if you add an editor button/select, add its ID to those arrays or the router won't dispatch it**. Modals route by the shared `EDITOR_MODAL_PREFIX` (`cmd-editor-modal-`), so a new modal just needs that prefix.

### Message-pipeline feature registry (`src/handlers/messageHandler.ts`)

The extension seam for non-command behavior. `handleMessage` applies shared short-circuits (ignore bots, channel blacklist, and `client.configLoadFailed` - a bad `config.json` disables the whole pipeline until `/reload_config` succeeds, so moderation never runs on defaults nobody configured), then iterates a `Feature[]` registry, calling each enabled `onMessage`/`onMessageDelete` hook inside a try/catch that routes errors to `client.logError` - **one feature throwing cannot take down the pipeline.** An `onMessage` hook that resolves `true` stops the pipeline for that message (image-fingerprint returns it after deleting a known-bad image so crosspost never tracks a gone message).

To add a feature, implement the `Feature` interface (`src/features/feature.ts`) and append one entry to the registry in `build()`. Stateful handlers (e.g. `CrosspostHandler`) are constructed once and held in module scope; `getCrosspostHandler` exposes the instance to the health endpoint. Features read config fresh on each call so `/reload_config` takes effect without restart.

### Crosspost detection (`src/features/crosspost/`)

`similarity.ts` is a **pure, Discord-free** engine: a `difflib.SequenceMatcher`-equivalent ratio scorer + Jaccard + char-n-gram cosine, with VD-specific canonical term substitutions ("quest", "wifi", "pcvr", ...). It is intentionally bit-compatible with Python difflib - **preserve normalization order and the autojunk heuristic if you touch it**. Thresholds were tuned against these exact scores, and `tests/similarity.test.ts` enforces parity (difflib-generated ratio vectors + a checked-in characterization baseline); several normalization quirks are deliberate and locked by tests - don't "fix" them (see the comment on `normalizeContent`).

`crosspostHandler.ts` owns all Discord coupling and enforcement: tracks each user's recent messages, votes across the 3 algorithms (`min_algorithms_to_match`), warns on 2-3 channel crossposts, and escalates mass crossposting ("burst spam") to timeout -> kick. **`dry_run` defaults to `true`** - detection runs and metrics increment but no enforcement happens until it's disabled.

### Shared moderation actions (`src/features/moderation/actions.ts`)

`timeoutMember` / `kickMember` / `deleteMessageById` / `sendModAlert` each return a structured `ActionResult` and **never throw** - the seam to reuse when adding mod actions. The Report Message context command and mod-ping feature alert moderators directly.

### LLM command proposals (`src/proposals/` + `src/handlers/proposalHandler.ts` + `src/api/proposalIntake.ts` + `src/api/commandRead.ts`)

Opt-in (`proposals.enabled` + `PROPOSAL_API_KEY` env). An external LLM bot POSTs `{operation: create|edit|delete|patch, command_name, command?, edits?, rationale?, proposer?}` to `POST /api/v1/commands/proposals` on the health port (`X-API-Key` auth, constant-time compare, per-key rate limit). The contract is shared with the external proposer bot's client - **treat the request shape as frozen**. `"edit"` is normalized to `"patch"`; full-body edits are rejected. `commandRead.ts` serves the matching read side (`GET /api/v1/commands[/{name}|/search?q=]`, same key + shared rate budget, gated by `proposals.enabled`/`client.proposalService` and `PROPOSAL_API_KEY`): raw file bodies (so patch `old` guards copied from a `get` match GitHub exactly) plus bounded weighted token/prefix/one-edit fuzzy search over name/description/block text. Contract doc: `docs/PROPOSALS_API.md`.

- `patchEngine.ts` - pure semantic-edit engine (`replace_text` must match exactly once; `set_property`/`remove_item` carry deep-equal `old` guards; `insert_item`/`move_item` bounds-checked; page refs by index or name/title with ambiguity -> conflict). Target kinds: `command`/`page`/`block` (blocks by index, or exact `field`-block name); `item_type`: `page`/`block`. Edits apply to the raw file body (`commandSync.rawBodies`) and the result is re-validated. `ProposalValidationError` -> 400, `ProposalConflictError` -> 409.
- `store.ts` - SQLite (better-sqlite3, WAL) staging with a configurable TTL (`proposals.ttl_hours`, default 72h); the expiry sweep also purges terminal rows past a 7-day retention (`purgeResolved`) so the table can't grow unbounded. Status flow `pending -> applying -> approved|conflict|failed`, `pending -> rejected|expired`. The approve claim is a conditional UPDATE checked via `info.changes` - **never SELECT-then-UPDATE** (double-click gate).
- `service.ts` - submit (validate -> prove the patch applies against the live raw body, refusing when the corpus is running from a fallback -> dedupe by pending op+name -> max_pending -> stage -> post card) and approve (atomic claim -> re-fetch the live file -> re-apply -> commit with one retry on `sha_conflict` only -> in-memory corpus update + digest refresh + `saveSnapshot` + `registerIfChanged` - no full refetch; committed-but-sync-failed is surfaced explicitly). Constructed via `ensureProposalService(client)` (proposalHandler.ts), which `/reload_config` also calls so `proposals.enabled` can be flipped live - and which rebuilds the running store when `ttl_hours`/`db_path` changed (both are baked in at construction; `max_pending` is read fresh, so it needs no rebuild).
- `reviewCard.ts`/`proposalHandler.ts` - staff review card (metadata Components-V2 container + rendered preview, chunked to the CV2 per-message budgets of <=40 components / <=4000 chars). Buttons `cmdprop:{approve|reject}:{32hex}` survive restarts because the id is in the custom-id and the record is in SQLite; routed in `interactionRouter.ts` by the `cmdprop:` prefix (before the editor's exact-id matching). Staff-gated via `config.staff_roles`.

### Scam-image fingerprinting (`src/features/imageFingerprint/`)

A FingerprintHub *consumer*: shares perceptual-hash (pHash) fingerprints of known-bad scam images across the peer moderation bots that use the hub. The hub (a separate service, config `hub_base_url`, default `http://127.0.0.1:58751`) only stores/serves `phash_hex` - all decode/hash/matching is client-side and local, so the hub is never on the moderation hot path. Operator guide: `docs/IMAGE_FINGERPRINTING.md`; the shared hash recipe is specified in `docs/PHASH_RECIPE.md`.

- `phash.ts` - **bit-exact TS implementation** of `imagehash.phash` + `alpha_white_v1` (the recipe every hub consumer uses; the compatibility contract is `docs/PHASH_RECIPE.md`, pinned to Pillow 12.2.0 / ImageHash 4.3.2). Reproduces PIL's `convert("L")` + fixed-point LANCZOS resample + DCT-II + median hash. **Must stay Hamming-comparable with the shared corpus** - validated against PIL-generated vectors in `tests/fixtures/fingerprint/` (all match exactly). The `EPS` snap exists because our O(n^2) DCT leaves ~1e-9 noise where scipy's FFT DCT yields exact 0.0 on flat/regular images; snapping sub-epsilon coefficients to 0 keeps signs correct. `decode.ts` uses `sharp` only as a decoder (`failOn:"none"`, first-frame, 8MiB/50MP guards).
- `store.ts` - better-sqlite3 local cache + in-memory Hamming index (`match(phash, tolerance)`), plus the hub sync loop (incremental `sync_seq` watermark, suppressions, tombstones, contribute/hit). Boots from local SQLite - no hard hub dependency. `origin='local'` (we contributed -> delete from hub) vs `'hub'` (synced peer -> removal records a suppression + flags). Synced rows' `action` is overridden to our configured default (a peer's action is only a hint).
- `hubClient.ts` - `fetch`-based `/v1` client; every method returns a structured result and **never throws** (hub outage degrades silently).
- `imageFingerprintHandler.ts` - the `Feature`. **(A)** every image is pHashed and matched; a hit deletes + kicks/times-out (honoring `dry_run`, default true) and reports `/hit` telemetry unless `report_hits_in_dry_run:false` suppresses dry-run observations. **(B)** a same-image crosspost across >= `review_channel_threshold` channels raises a staff review card with buttons `imgfp:{approve|deny}:{token}` (routed by prefix in `interactionRouter.ts`, staff-gated via `config.staff_roles`); Approve contributes locally + to the hub. Pending reviews are in-memory (lost on restart). Config under `moderation.image_fingerprint.*` (all `enabled:false`/`dry_run:true` by default); hub key from env `FINGERPRINT_HUB_API_KEY`. Hub settings are read at store construction - flipping `hub_enabled` or the key needs a restart (feature scanning `enabled` is live). Started via `getImageFingerprintHandler(client).startBackgroundTasks()` in `index.ts`.

### Health endpoint (`src/health.ts`)

`GET /health` on `HEALTH_PORT` (9010) returns gateway status, uptime, version, and metrics (guilds/members/commands-handled/custom-command count + crosspost metrics) for an external dashboard. The same server routes `POST /api/v1/commands/proposals` to the proposal intake and `GET /api/v1/commands...` to the commands read API.

## Conventions worth matching

- Errors in async Discord work are swallowed with `.catch(() => null)` / `.catch(console.error)` and surfaced to users via ephemeral replies or to staff via `logError`. The bot is designed to degrade, not crash - keep that posture.
- Comments are load-bearing or absent: keep invariants, non-obvious "why", concurrency/crash-safety guards, and algorithm-compat notes (bit-exact pHash, the digest identity); don't add comments that restate adjacent code, narrate a change, or reference prior/external implementations. When the same rationale applies at several sites, consolidate it in the method/class docblock and keep call sites bare.
- Staff gating is config-driven: built-in commands set `staff_only` and are checked against `config.staff_roles` in `commandHandler.ts`; context commands check their own `allowed_role_ids`.
- Custom-command and page names are normalized to `^[a-z0-9_-]{1,32}$` (lowercased) via the shared `NAME_PATTERN` in `src/utils/format.ts`. A stray `ephemeral` field is unsupported and stripped on load/save everywhere it appears.
- The custom-command registration payload (`type:1` chat-input + a `hidden` boolean option) is centralized in `client.ts`'s `buildCustomCommandPayload()` and reused everywhere via `registerApplicationCommands()` - `reloadCommands.ts` and the editor save path both call that, so there is a single source of truth.
