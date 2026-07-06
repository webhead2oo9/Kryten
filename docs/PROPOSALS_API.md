# Command Proposals API

How an external client — typically an LLM assistant bot — defines a "propose a help-center command change" tool against this bot's HTTP API.

> Command bodies are **format 2 (block-based)** — blocks, never Discord embeds; patch targets `embed`/`field` do not exist. A client submitting embed-shaped proposals gets a clean `400`, never a mis-applied change. See `AUTHORING.md` in the commands repo for the authoring spec.

## What this is (and what it is NOT)

Kryten serves its help-center slash commands (e.g. `/wifi`, `/routers`) from one JSON file per command (`commands/<name>.json`) in the GitHub repo configured via `githubRepoOwner`/`githubRepoName`/`githubCommandsDir`/`githubBranch`.

The proposals API lets the agent **suggest** a change. A suggestion is **not applied immediately** — it is staged and posted as a review card in a staff channel. A human staff member clicks **Approve** or **Reject**. Only on approval does the change commit to GitHub and go live.

So the agent's tool should tell the user something like *"I've submitted a proposal to update `/wifi`; a moderator will review it."* — never *"done, it's live."*

When `proposals.enabled` is on and `PROPOSAL_API_KEY` is set, the API also serves **reads** (same host/port, same `X-API-Key`, shared rate-limit budget; errors are `{ "error": string }`):

```
GET /api/v1/commands                 → { count, commands: [{name, description, has_pages}] }
GET /api/v1/commands?detail=full     → { count, commands: [<raw file bodies>] }
GET /api/v1/commands/<name>          → { command: <raw file body> } | 404 { error }
GET /api/v1/commands/search?q=...    → { query, count, results: [{name, description, score, matched_fields, command}] }
                                       (q max 256 chars / 16 terms; optional limit 1-50 default 10, min_score 0-100 default 45)
```

Reads return the **raw GitHub file bodies**, so `patch` guards copied from a `get` match the live file exactly. To build a correct `patch` (see below) the agent must first **read** the current command via `GET /api/v1/commands/<name>` (fetching the raw file straight from the commands repo is an equivalent alternative — that repo remains the source of truth).

## Endpoint

```
POST https://<bot-host>:<HEALTH_PORT>/api/v1/commands/proposals
```

- Default port is `9010` (the bot's health server; configurable via `HEALTH_PORT`).
- Header `X-API-Key: <PROPOSAL_API_KEY>` — the shared secret set in the bot's env. Missing/wrong key → **401**.
- `Content-Type: application/json`.
- Rate limit: 100 requests/minute per key (default) → **429** over that.
- Body cap: 256 KB.

## Request body

```jsonc
{
  "operation":    "create" | "edit" | "delete" | "patch",  // required
  "command_name": "wifi",                                    // required, ^[a-z0-9_-]{1,32}$
  "command":      { ... },        // required for "create"; forbidden otherwise
  "edits":        [ ... ],        // required for "patch"/"edit"
  "rationale":    "why this change (shown to staff)",        // optional but strongly recommended
  "proposer":     "llm-agent"                                // optional; defaults to "chatbot"
}
```

- `"edit"` is accepted as an **alias for `"patch"`** — it is normalized to `patch`, and (like patch) requires `edits`, not a `command` body. Full-body edits are rejected; **use `patch` to change an existing command**.
- `rationale` is truncated to 1024 chars and shown verbatim on the review card. Write it for the human reviewer.

## Response

Always `{ "status": string, "message": string, "proposal_id": string | null }`.

| `status`           | HTTP | Meaning | What the agent should do |
|--------------------|------|---------|--------------------------|
| `staged`           | 201  | Queued for staff review. | Tell the user it's submitted for review. Keep `proposal_id`. |
| `duplicate`        | 200  | A pending proposal with the same operation + command already exists (its id is returned). | Don't resubmit; tell the user one is already pending. |
| `too_many_pending` | 429  | The review queue is full (default max 5). | Ask the user to try later; staff need to clear the queue. |
| `invalid`          | 400  | Malformed proposal (bad name, non-format-2 body, unknown block type, over-budget view, un-parseable edit, etc.). `message` says why. | Fix and retry, or tell the user it couldn't be built. |
| `conflict`         | 409  | Doesn't fit current state: create of a name that exists, delete/patch of a name that doesn't, a patch guard that no longer matches the live file, or a `replace_text` whose `old` doesn't match exactly once. | Re-read the current file and rebuild, or report the mismatch. |
| `unavailable`      | 503  | Proposals turned off on the bot, corpus not loaded, GitHub temporarily unreachable, or the review card couldn't post. | Retry later (or report proposals as unavailable). |
| `error`            | 500  | Internal bot error. | Retry later / report. |

(HTTP 401 = bad API key, 413 = body too large — transport-level, not in the table above.)

## The three operations

### `create` — add a new command

Requires a full `command` body (format 2 — see shape below). Fails `conflict` if the name already exists, `invalid` if it collides with a built-in command name.

```jsonc
{
  "operation": "create",
  "command_name": "sgsr",
  "rationale": "User asked for a Snapdragon GSR explainer; none exists.",
  "command": {
    "format": 2,
    "name": "sgsr",
    "description": "Snapdragon Game Super Resolution",
    "accent_color": 3447003,
    "thumbnail_url": "https://cdn.example.com/sgsr-icon.png",
    "blocks": [
      { "type": "heading", "text": "Snapdragon GSR" },
      { "type": "text", "text": "SGSR sharpens the streamed image on Quest…" }
    ]
  }
}
```

### `delete` — remove a command

Only `command_name` is needed. Fails `conflict` if it doesn't exist.

```jsonc
{ "operation": "delete", "command_name": "oldcmd", "rationale": "Superseded by /newcmd." }
```

### `patch` — change an existing command (preferred for edits)

Provide `edits` — an ordered list of **semantic edits** applied to the current file. Patch is preferred over delete+create: it produces a minimal GitHub diff and can't accidentally drop unrelated pages/blocks. Fails `conflict` if the command doesn't exist or a guard no longer matches.

```jsonc
{
  "operation": "patch",
  "command_name": "wifi",
  "rationale": "5GHz → 6GHz recommendation per the new router guide.",
  "edits": [
    { "type": "replace_text", "old": "Use 5GHz", "new": "Use 6GHz" }
  ]
}
```

## Command body shape (`create`) — format 2

```jsonc
{
  "format": 2,                          // required, always 2
  "name": "wifi",                       // required, ^[a-z0-9_-]{1,32}$, must equal command_name
  "description": "…",                   // required, ≤100 chars (the slash-command blurb)
  "accent_color": 5793266,              // optional, integer 0–16777215 (the card's color bar)
  "thumbnail_url": "https://…",         // optional, https URL ≤1024 — small corner image (see below)
  // at least one of blocks / pages is required:
  "blocks": [ { /* Block */ } ],        // the initial reply (1–30 blocks), AND/OR
  "pages":  [ { /* Page */ } ]          // extra views behind a dropdown
}
```

**Blocks** (rendered top-to-bottom as a Components-V2 card; all text is Discord markdown):

```jsonc
{ "type": "heading", "text": "…", "url": "https://…" }   // ## title, linked if url; text ≤256
{ "type": "text", "text": "…" }                            // markdown paragraph(s); ≤3800
{ "type": "field", "name": "…", "value": "…" }            // **Name** over value; name ≤256, value ≤1024
{ "type": "divider" }                                       // horizontal rule
{ "type": "images", "urls": ["https://…"] }                // LARGE full-width gallery, 1–10 https URLs
{ "type": "small", "text": "…" }                           // small grey text; ≤1024
```

**Thumbnail vs. `images`:** for a single illustrative image, set the view's
`thumbnail_url` — it renders as the small corner image beside the view's first
text blocks (the old embed-thumbnail look) and is almost always what you want.
An `images` block renders full-width and is only for content that must be
big (screenshots, diagrams, multi-image galleries). A `thumbnail_url` requires
at least one text block (`heading`/`text`/`field`/`small`) in the same view to
sit beside; on a view with no text it is stripped with a warning.

**Page**:
```jsonc
{
  "name": "setup",             // required, ^[a-z0-9_-]{1,32}$, unique within the command
  "title": "Setup",            // optional (shown in the select menu), ≤100
  "description": "…",          // optional, ≤100
  "accent_color": 5793266,     // optional; defaults to the command's
  "thumbnail_url": "https://…",// optional, per view — pages do NOT inherit the command's
  "blocks": [ { /* Block */ } ] // required, 1–30
}
```

Max 25 pages — Discord's page-select dropdown shows at most 25 options. The validator does **not** reject an over-limit proposal; it truncates pages beyond 25 (with a warning), so keep the command to 25 pages or fewer to avoid silently dropping content. (The in-guild editor caps authoring at 22.) **Per-view budget** (CI- and bot-enforced): each view — the top-level `blocks`, or one page's — must render ≤3800 text characters, where rendered length is `heading` = 3 + text (+ url + 4 if linked) · `text` = text · `field` = name + 5 + value · `small` = 3 + text · `divider`/`images` = 0. Too much content? Split it into pages. The schema in the commands repo (`commands.schema.json`) is the machine-checkable version of all this and CI-enforces it.

## Patch edits (the subtle part)

Each entry in `edits` is `{ "type": ..., ... }`. Edits apply **in order** to a deep copy of the current file; the result is re-validated. **To build these correctly the agent must have the current file content** (fetch it from GitHub first — see top).

All edits take an optional **`target`** locating what to edit:

```jsonc
"target": {
  "kind": "command" | "page" | "block",  // default "command"
  "page":  0 | "setup",     // page index, OR its name/title (case-insensitive; must be unambiguous)
  "block": 1 | "Band"       // block index within the owner's blocks, OR a field-block's exact name
}
```
Omit `page` to target the command's top-level `blocks`. Only `field` blocks can be referenced by name (their `name`, case-sensitive). An ambiguous `page`/`block` reference (matches >1) → `conflict`.

### `replace_text` — swap a substring
```jsonc
{ "type": "replace_text", "old": "5GHz", "new": "6GHz", "target": {…}?, "property": "value"? }
```
- `old` (required, non-empty) must appear **exactly once**, or it fails `conflict` (never a blind replace-all).
- With `property`: match within that one property of the target (e.g. a field block's `"value"`).
- Without `property`: match across all **visible text** of the target — keys `title, description, value, name, text, url`, recursively. Total occurrences must be exactly 1.

### `set_property` — set a property to a new value with a guard
```jsonc
{ "type": "set_property", "target": { "kind": "block", "block": 2 }, "property": "value",
  "old": "5GHz only", "new": "6GHz preferred" }
```
- `old` is **required** and is an optimistic-concurrency guard: the current value must deep-equal `old` or it fails `conflict`. Read the current value first and pass it as `old`.
- `old: null` also matches a **missing** property (JSON can't express "absent"), so it's the guard for adding an optional property that isn't set yet.
- `new` may be any JSON value.
- This is also how a view's thumbnail is set or changed (use `old: null` when the property doesn't exist yet):
```jsonc
{ "type": "set_property", "target": { "kind": "page", "page": "setup" },
  "property": "thumbnail_url", "old": null, "new": "https://cdn.example.com/icon.png" }
```

### `insert_item` — add a page / block
```jsonc
{ "type": "insert_item", "item_type": "block", "item": { "type": "divider" },
  "target": { "page": "setup" }?, "position": 1 }
```
- `item_type`: `page` | `block`. `item` is the object to insert.
- `position`: 0-based index, or `"end"`/omitted to append.

### `remove_item` — delete a page / block with a guard
```jsonc
{ "type": "remove_item", "target": { "kind": "block", "page": "setup", "block": "Band" },
  "old": { "type": "field", "name": "Band", "value": "5GHz only" } }
```
- `target.kind` must be `page` | `block`.
- `old` is **required**: the resolved item must deep-equal it or it fails `conflict`. Pass the exact current object.

### `move_item` — reorder a page / block
```jsonc
{ "type": "move_item", "target": { "kind": "block", "block": 1 }, "position": "end" }
```
- No guard. `position` is the new index, or `"end"`.

## Suggested tool definition (JSON Schema)

Drop this into the agent's tool spec as the input schema. Keep the description text — it's what steers the model to patch instead of recreating.

```jsonc
{
  "name": "propose_command_change",
  "description": "Propose a change to a help-center slash command (e.g. /wifi). The change is NOT applied immediately: it is sent to Discord staff for review and only goes live if a moderator approves. Prefer 'patch' to edit an existing command (minimal diff). To build a patch you must first read the current command via GET /api/v1/commands/<name> so your 'old' guards and single-match strings are exact. Command bodies are block-based (format 2): a 'blocks' list of {heading|text|field|divider|images|small} objects — never Discord embeds. For a single illustrative image set the view's 'thumbnail_url' (small corner image); an 'images' block renders full-width and is only for content that must be big.",
  "input_schema": {
    "type": "object",
    "required": ["operation", "command_name"],
    "properties": {
      "operation": { "type": "string", "enum": ["create", "delete", "patch"] },
      "command_name": { "type": "string", "pattern": "^[a-z0-9_-]{1,32}$" },
      "command": {
        "type": "object",
        "description": "Full format-2 command body. Required for 'create', omit otherwise.",
        "required": ["format", "name", "description"],
        "properties": {
          "format": { "const": 2 },
          "name": { "type": "string", "pattern": "^[a-z0-9_-]{1,32}$" },
          "description": { "type": "string", "maxLength": 100 },
          "accent_color": { "type": "integer", "minimum": 0, "maximum": 16777215 },
          "thumbnail_url": { "type": "string", "pattern": "^https?://", "maxLength": 1024 },
          "blocks": { "type": "array", "items": { "type": "object" } },
          "pages": { "type": "array", "items": { "type": "object" } }
        }
      },
      "edits": {
        "type": "array",
        "description": "Ordered semantic edits. Required for 'patch'.",
        "items": {
          "type": "object",
          "required": ["type"],
          "properties": {
            "type": { "type": "string", "enum": ["replace_text", "set_property", "insert_item", "remove_item", "move_item"] },
            "target": { "type": "object" },
            "old": {},
            "new": {},
            "property": { "type": "string" },
            "item_type": { "type": "string", "enum": ["page", "block"] },
            "item": { "type": "object" },
            "position": {}
          }
        }
      },
      "rationale": { "type": "string", "description": "One or two sentences for the human reviewer explaining why." }
    }
  }
}
```

## Rules to bake into the agent's prompt

1. **It's a suggestion, not an action.** A `staged` response means "queued for a moderator," not "done." Never claim the command changed.
2. **Read before you patch.** Fetch the current command via `GET /api/v1/commands/<name>` so `old` guards and `replace_text` `old` strings exactly match the live file. A stale guard returns `409 conflict`.
3. **Prefer `patch` over delete+create** when editing an existing command.
4. **`replace_text` must match exactly once.** If a phrase appears multiple times, scope it with `target`/`property` or use `set_property` on the specific block.
5. **Always include a `rationale`** — it's the reviewer's only context.
6. **Handle the response status** per the table: back off on `duplicate`/`too_many_pending`, surface `invalid`/`conflict` reasons, retry `unavailable`/`error`/`503`.
7. **Bodies are blocks, never embeds.** `format: 2` is required; `embed`/`embeds` anywhere → `400`. Colors (`accent_color`) are **decimal integers**, not hex strings.
8. **Respect the per-view budget** (≤30 blocks, ≤3800 rendered chars — formula above). Over-budget content belongs in additional pages. Each view must also carry at least one content block — a view of only `divider`s is rejected (`invalid`).
9. **Prefer `thumbnail_url` over `images` for a single illustrative image.** It renders as the small corner image; `images` is the full-width gallery for content that must be big. A thumbnail needs a text block in the same view — on a view with none it is stripped with a warning, not rejected.

## Enabling it on the bot (server side, for reference)

The agent can't submit until the bot has this in `config.json`:

```jsonc
"proposals": {
  "enabled": true,
  "review_channel_id": "<staff channel id>",
  "max_pending": 5,
  "ttl_hours": 72,
  "rate_limit_per_minute": 100
}
```

…and `PROPOSAL_API_KEY=<same secret the agent sends>` in the bot's `.env`. The bot's GitHub commands-repo config must point at the repo proposals should commit to.
