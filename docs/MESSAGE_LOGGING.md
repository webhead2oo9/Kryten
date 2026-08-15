# Message lifecycle logging

Kryten can record human-authored message edits, single deletions, and bulk deletions for one guild. The feature is disabled by default.

## Configuration

Add the `logging` section from `template.config.json` and set an independent 32-byte `MESSAGE_LOG_ENCRYPTION_KEY` in `.env`. `guild_id` is the only guild captured. `message_channel_id` receives message lifecycle events; when it is omitted, `default_channel_id` is used.

The bot needs the Guild Messages and Message Content gateway intents. Guild Moderation plus View Audit Log permission enables best-effort moderator attribution. Discord does not include a message ID in deletion audit entries, so Kryten only names a moderator when exactly one recent audit entry matches the guild, channel, author/count, and event time. Otherwise the card says “Author or unknown.”

The following are always excluded:

- bots, webhooks, and system messages;
- `logging.ignored_channel_ids` and their child threads;
- `moderation.channel_blacklist` and its child threads;
- configured log destinations, preventing feedback loops;
- every guild except `logging.guild_id`.

Discord does not identify the author of an uncached message in a bulk-delete
payload. Kryten records those message IDs as unrecovered evidence so the purge
count can still be matched conservatively to an audit entry; no author, content,
or attachment data is retained for those IDs. A queued event is delivered only
while its captured guild matches the currently configured `guild_id`, so changing
the destination guild cannot forward evidence from the previous guild.

## Storage and retention

Snapshots and retry-outbox payloads are AES-256-GCM encrypted per row in SQLite/WAL. Message IDs and scheduling/expiry timestamps remain plaintext so records can be addressed, expired, and retried. Startup validates an encrypted sentinel and fails when an enabled store is opened with the wrong key.

Snapshots default to 30 days and 100,000 rows. Both limits apply together; changing `retention_days` shifts existing snapshot expirations as well as future captures, including when the changed policy is first loaded after a restart. The row cap is applied by the hourly sweep rather than on every capture, so the table can run briefly over it between sweeps. The durable outbox is capped at 10,000 rows and records expire after seven days. Failed sends retry with exponential backoff and are written off after ten attempts (roughly 85 minutes) so one undeliverable event cannot block the queue behind it. Anything discarded — by the cap or by that write-off — is counted in the `dropped` metric and raises a staff error. Discord nonces make repeat delivery idempotent where Discord supports nonce enforcement.

Attachments are stored as metadata only. When `rehost_images` is enabled, Kryten makes a bounded best-effort download of Discord-hosted raster images at delivery time and uploads them to the staff channel. Long message bodies and bulk deletions include UTF-8 evidence files. No attachment bytes are written to disk.

`retention_days`, `max_snapshots`, destinations, exclusions, and `rehost_images` can be changed with `/reload_config`. Changing `db_path` or `encryption_key_env` while logging is active requires a restart. Disabling logging closes the store; any queued records remain encrypted on disk for a later re-enable.
