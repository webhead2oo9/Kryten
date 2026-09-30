# Campaign messages and offline greeting backfill

`beta_classifier.greeting_template` and `routing_template` optionally replace
campaign message text. Omitting them preserves the legacy messages. Supported
placeholders are `{user}`, `{target}`, and `{announcements}`, rendered as Discord
mentions from the current message/config. Templates must be nonempty, use only
these placeholders, and render within Discord's 2000-character message limit.
Configure the referenced channel IDs. Use `[label](<https://example.org/file>)`
for links without previews. Mention permissions stay controlled by each sender:
greeting permits only its recipient; routing does not ping anyone.

Templates do not change classification, suppression, retention, deletion timing,
or shadow comparisons. Campaign identity and start time remain shared between
routing and greeting, with the existing 30-day lifetime.

`dist/maintenance/backfillCli.js STAGED_CONFIG EXPORT --dry-run|--apply` is an
offline helper; it does not start the bot or contact Discord. Run from the service
state directory using the new campaign config and the protected encryption-key
environment supplied by systemd. Never source or print the secrets file. The
export requires `guild_id`, `channel_id`, `since_utc`, `through_utc`,
`last_message_id`, `complete: true`, and a nonempty deduplicated `user_ids` array
of Discord ID strings. Coverage must start at the configured campaign start and
end at or before the current time. No coverage after `through_utc` is implied.

Before apply, stop and fence **all** writers, including automatic starts, then
snapshot. The CLI checks `kryten.service` is inactive before reading and before
replacement, but this does not replace maintenance fencing. Dry-run is read-only.
Apply keeps an encrypted mode-0600 backup, seeds a separate encrypted file using
`UserInteractionStore`, compares the entire decrypted result against the expected
change, checks the source did not change, atomically renames the staged file, then
fresh-reads and verifies it. Error output omits data. Preserve backups on failure
and leave the service stopped pending investigation.

The import adds only beta greeting markers; existing markers for the new campaign
(including users outside the export), classifier decisions, and unrelated records
are preserved. The offline store import deliberately bypasses normal retention
pruning. Normal startup then applies existing retention rules using the **new**
config: old beta routing/greeting suppression resets, new suppression survives.
Do not run the helper or restart using the expired campaign configuration.
