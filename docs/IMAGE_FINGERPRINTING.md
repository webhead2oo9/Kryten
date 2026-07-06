# Scam-Image Fingerprinting

Operator guide for the image-fingerprint feature: what it is, how to configure
it, how to roll it out safely, and how to verify it. Architecture summary lives
in the root `CLAUDE.md` under "Scam-image fingerprinting"; the shared hash
recipe is specified in `docs/PHASH_RECIPE.md`.

---

## 1. What this is (and what it is NOT)

This bot is a **consumer** of **FingerprintHub** — a separate, shared service
that stores perceptual-hash (pHash) fingerprints of known-bad scam images so
that a scam caught on one server protects every participating server.

- **The hub only stores/serves `phash_hex` strings.** It never decodes images
  or computes hashes.
- **All decode / hash / Hamming-matching is done here, locally and in-memory.**
  The hub is a background sync source + contribution target — it is **never**
  on the moderation hot path. If the hub is down, local matching still works.

Two capabilities:

- **A — Known-bad enforcement.** Every posted image is pHashed and matched
  against the local corpus; a hit deletes the message and kicks/times-out the
  poster (honoring `dry_run`), then fire-and-forget reports the hit to the hub.
- **B — Contribute new scams.** The same image crossposted across ≥N channels
  by one user raises a staff **Approve/Deny** card. Approve stores the
  fingerprint locally and pushes it to the hub, so the whole network learns it.

### Where things live

| Thing | Location |
|---|---|
| Feature code | `src/features/imageFingerprint/` |
| Config type | `ImageFingerprintConfig` in `src/types.ts` |
| Config block | `moderation.image_fingerprint` (see `template.config.json`) |
| Env key | `FINGERPRINT_HUB_API_KEY` (see `template.env`) |
| Local DB (runtime) | `./data/image_fingerprints.db` (gitignored via `data/`) |
| The hash recipe (ground truth) | `docs/PHASH_RECIPE.md` + vectors in `tests/fixtures/fingerprint/` |
| Tests | `tests/phash.test.ts`, `tests/imageFingerprintStore.test.ts` |
| The hub (separate service) | reachable at `hub_base_url` (default `http://127.0.0.1:58751`) |

---

## 2. The pHash bit-match contract (do not break this)

To be Hamming-comparable with the shared corpus, the hash MUST be byte-identical
to the recipe every other consumer uses — `phash` / `imagehash.phash` /
`alpha_white_v1`, specified step-by-step in `docs/PHASH_RECIPE.md`.

`src/features/imageFingerprint/phash.ts` implements the recipe exactly and is
held to the PIL-generated vectors in `tests/fixtures/fingerprint/` by
`tests/phash.test.ts` (PNG/GIF match **exactly**; JPEG/WebP within tolerance —
lossy decode may drift a bit or two across decoder builds). Matching tolerance
is 5–6 Hamming bits (clamped to a floor of 0; no upper cap).

To add fixture vectors or verify parity, run the reference generator from
`docs/PHASH_RECIPE.md` under the pinned libs (Pillow 12.2.0 / ImageHash 4.3.2).
Never hand-edit the hashes in `manifest.json`.

---

## 3. Configuration reference

All under `config.json` → `moderation.image_fingerprint`. Defaults in parentheses;
the whole block is safe to omit (feature stays off).

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Master switch for image scanning |
| `dry_run` | `true` | Detect + log + alert, but **never** delete/kick/timeout |
| `report_hits_in_dry_run` | `true` | Send shared hub `/hit` telemetry for dry-run detections |
| `db_path` | `./data/image_fingerprints.db` | Local SQLite cache |
| `match_tolerance` | `5` | Hamming distance that counts as a known-bad match |
| `duplicate_tolerance` | =`match_tolerance` | Overlap distance treated as "already known" (dedupe on contribute) |
| `crosspost_tolerance` | =`match_tolerance` | Distance for grouping the same image across channels |
| `default_action` | `kick` | `kick` or `timeout` on a match; also stamped on synced peer rows |
| `default_category` | `scam` | Category for staff-approved fingerprints |
| `timeout_minutes` | `30` | Timeout duration when `default_action:"timeout"` |
| `delete_on_match` | `true` | Delete the offending message on a match |
| `enforce_known_bad` | `true` | Apply the member action (else delete-only) |
| `recent_window_seconds` | `900` | How long an image is remembered for crosspost grouping |
| `review_channel_threshold` | `2` | Distinct channels before a crosspost review card is raised |
| `review_crossposts` | `true` | Raise Approve/Deny cards for image crossposts |
| `review_channel_id` | — | Staff channel for review cards (required for capability B) |
| `alert_channel_id` | =`review_channel_id` | Channel for known-bad match alerts |
| `ignored_channels` | `[]` | Channels excluded from scanning (thread-aware) |
| `whitelisted_role_ids` | `[]` | Roles exempt from scanning |
| `hub_enabled` | `false` | Sync with the shared hub |
| `hub_base_url` | `http://127.0.0.1:58751` | Hub base URL |
| `hub_sync_interval_seconds` | `300` | Background pull cadence |
| `hub_request_timeout_seconds` | `5` | Per-request timeout |
| `hub_api_key_env` | `FINGERPRINT_HUB_API_KEY` | Env var holding the `fph_…` key |

Env (`.env`): `FINGERPRINT_HUB_API_KEY=fph_…` — required only when `hub_enabled`.

> **Live-reload caveat:** `enabled`, `dry_run`, tolerances, channels, and actions
> are read fresh each message, so `/reload_config` applies them immediately. But
> **hub settings (`hub_enabled`, base URL, key) are read once at store
> construction** — flipping the hub on/off or changing the key needs a **restart**.

---

## 4. Rolling out safely

Never jump straight to enforcement; the defaults (`enabled:false`,
`dry_run:true`) are the starting point.

### Stage 1 — mint a hub consumer key (only if syncing with a hub)

On the machine hosting **FingerprintHub**, mint a consumer key per the hub's own
operations docs:

```bash
python tools/create_consumer.py --name <consumer-name> --scopes read,write
# prints an fph_… key ONCE — copy it now
```

Put it in this bot's `.env` as `FINGERPRINT_HUB_API_KEY=fph_…` and verify the
hub is up: `curl -s <hub_base_url>/v1/health` → `{"status":"ok","db":true}`.

### Stage 2 — local scan, dry-run, no hub

```jsonc
"image_fingerprint": {
  "enabled": true,
  "dry_run": true,
  "review_channel_id": "<staff-channel-id>",
  "alert_channel_id": "<staff-channel-id>",
  "hub_enabled": false
}
```

Restart (or `/reload_config`). Post the same image in 2+ channels and confirm a
crosspost review card appears. Approve it and confirm a row lands in
`./data/image_fingerprints.db`.

### Stage 3 — enable hub sync (still dry-run)

Set `"hub_enabled": true` and **restart** (hub settings aren't live-reloaded).
Within `hub_sync_interval_seconds` the corpus should populate from peers —
check `GET /health` → `metrics.imageFingerprint.corpusSize > 0` and
`hubActive:true`. Re-post a peer-known scam image and confirm a
`[DRY RUN] Known scam image …` log line (no enforcement yet). Before trusting
enforcement, also confirm a hash computed here equals a peer's hash for the
same original image — belt-and-suspenders on the bit-match contract (§2).

### Stage 4 — enforce

Flip `"dry_run": false` (live via `/reload_config`). Start with
`default_action:"timeout"` if you want a softer first offense. Watch the alert
channel and `metrics.imageFingerprint.{knownBadMatches,actionsTaken}`.

### Rollback

Set `"dry_run": true` (instant via `/reload_config`) to stop enforcement while
keeping detection, or `"enabled": false` to stop scanning entirely.

---

## 5. Verifying it works

- **Health:** `GET http://<host>:<HEALTH_PORT>/health` →
  `metrics.imageFingerprint = { imagesScanned, knownBadMatches, actionsTaken,
  reviewsRaised, contributed, corpusSize, hubActive }`.
- **Dry-run logs:** matches log `[DRY RUN] Known scam image: user=… row=… distance=…`.
- **Local DB:** `sqlite3 ./data/image_fingerprints.db "SELECT id,origin,category,action,hub_fingerprint_id FROM known_bad_image_fingerprints;"`
- **Watermark:** `… "SELECT last_sync_seq FROM fingerprint_hub_sync_state;"` should
  advance after syncs.
- **Hub-side:** `curl -s -H "X-API-Key: fph_…" <hub_base_url>/v1/fingerprints/stats`.

---

## 6. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `hubActive:false` in health | `hub_enabled` false, or the API-key env is unset/empty. Hub settings are read at store construction and need a **restart**. |
| `corpusSize` stays 0 with hub on | Wrong/disabled consumer key (hub returns 401), unreachable hub, or a compatibility-triple mismatch (peers must use `phash`/`imagehash.phash`/`alpha_white_v1`). Check bot logs for "hub sync/GET … error". |
| Known scam not caught | Distance > `match_tolerance`; raise to 6. Or the image is lossy-re-encoded enough to drift — confirm with a fresh reference hash (§2). |
| A hash here ≠ Pillow's | Almost always a truncated/animated/exotic input. `decode.ts` sets `failOn:"none"` + first-frame; re-check §2 and add the image to the fixture corpus. |
| Review card buttons say "no longer active" | Bot restarted since the card was posted (pending reviews are in-memory), or the review already resolved/expired (24h TTL). |
| Duplicate contributions rejected | Expected — `duplicate_tolerance` dedupe. The card shows "Skipped — overlaps fingerprint #N". |
