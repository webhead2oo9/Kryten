# Sticky Posts v1

Sticky posts are opt-in, embed-only messages managed through the existing private, gitignored `config.json`. There is no slash-command editor, separate content file, button, component, plain message content, or automatic pinning. The public `template.config.json` contains only a disabled empty block.

## Configuration

Add `sticky_posts` to the main config:

```json
{
    "sticky_posts": {
        "enabled": false,
        "channels": {}
    }
}
```

To enable, set `enabled` to `true` and add an entry keyed by the exact Discord channel ID string. Each entry has:

- `embed`: one Discord embed object, required.
- `interval_messages`: a positive safe integer, default `10` when omitted. This is a message count, not a timer.

Keep actual channel IDs, content, links, and chosen intervals in private config, not in public source. Channel IDs must be decimal snowflake strings (17 to 20 digits, no leading zero). At most 100 channels may be configured. Unknown keys, nulls in place of defaults, arrays of embeds, components, buttons, and plain content are rejected rather than silently stripped.

Supported embed keys: `title`, `description`, `url`, integer `color`, `timestamp`, `footer` (`text`, optional `icon_url`), `author` (`name`, optional `url`/`icon_url`), `image`/`thumbnail` (each `url`), and `fields` (`name`, `value`, optional boolean `inline`). URLs must be HTTP(S); timestamps must parse as dates. Discord limits are enforced: title/author/field name 256 characters, description 4096, footer 2048, field value 1024, 25 fields, and 6000 total textual characters. An embed must contain visible text or an image/thumbnail.

## Counting and scope

The first qualifying human message creates a sticky. The next N qualifying messages cause a replacement, with the count reset only after a successful durable replacement. Staff messages count exactly like other human messages. Ordinary messages and replies qualify; bots, webhooks, system messages, DMs, and other guilds do not. `GUILD_ID` must match the message/channel guild.

Channel matching is exact. A configured parent does not enable its threads. Add the exact thread ID to enable that thread. The shared moderation blacklist still excludes both directly listed channels and threads of blacklisted parents. A failed config load stops the shared pipeline. Earlier terminal moderation actions still stop the pipeline before the sticky feature.

The bot needs View Channel, Read Message History, Send Messages, and Embed Links, plus Send Messages in Threads/access to the thread when applicable. Manage Messages is not required to delete its own posts. Mentions are explicitly suppressed, including user/role/everyone parsing and reply pings.

Each qualifying message checks the canonical message through an uncached Discord REST fetch, including after restart. Only Discord error 10008 (Unknown Message) means it is absent. A manually deleted sticky is recreated on the next qualifying message even if its old SDK cache entry remains. Forbidden, missing access, or transport errors never authorize a duplicate creation. The human count is persisted even when a subsequent REST check fails.

## Reload and disable lifecycle

A successful `/reload_config` immediately refreshes changed embeds on existing tracked posts, without waiting for the threshold. New configured channels still wait for their first qualifying human message. Unchanged content does not repost merely because the count is due during reload. The command defers its ephemeral response while refresh work runs. Validation/interaction-retention failure retains the previous configuration; a Discord or sticky-state refresh failure keeps the newly loaded config and reports a partial refresh failure, not a false success.

Disabling the block or removing a channel leaves its current canonical post in place, stops its refreshes, and retains its ID/count/hash for re-enable. It does not delete the post or forget state. Re-enable uses the same canonical ID and refreshes changed content immediately. Already submitted Discord requests cannot be recalled; their results are still recorded safely. Queued work rechecks current configuration before sending.

## Persistence and failure handling

Default state: `./data/sticky_posts.json`, relative to the bot working directory. `data/` is gitignored. The store writes mode-0600 snapshots through an exclusive `.tmp` file, file fsync, atomic rename, and directory fsync. It holds only IDs, counts, embed hashes, a send nonce/intent, and one bounded pending-deletion record per channel. No human message content or configured embed content is stored.

Replacement order is:

1. Persist the due count and send intent/nonce.
2. Send one new embed with nonce uniqueness enforcement.
3. Durably make its returned ID canonical and retain the old ID as pending deletion.
4. Force-fetch the old message, verify this bot owns it and it is not a webhook message, then delete it.

A rejected send with a definite HTTP 4xx response keeps the old canonical and due count for the next human message. A transport/5xx or otherwise uncertain send leaves the durable intent in place and blocks further sends for that channel across restarts. Discord's nonce deduplication window is short, so v1 deliberately does not automatically replay uncertain sends later. This avoids accumulating duplicates after lost acknowledgements or a crash between send and save.

A failed old-message deletion keeps at most one old ID alongside the canonical. An existing canonical is not replaced while that deletion is unresolved. Retries are message-driven (also checked on reload), start with 30-second backoff, double to a one-hour cap, and stop after 10 failed attempts. The attempt count/deadline survive restart. Unknown Message clears the pending ID; ownership or permission failures do not. A failed cleanup can therefore leave two bot posts temporarily, but cannot create an unbounded trail. Blocked deletion can delay content changes while the canonical exists. If an uncached check confirms the canonical was manually deleted, v1 recreates it immediately while retaining the same pending old ID, still bounding the channel to two posts.

If saving the new canonical fails, v1 attempts an ownership-verified deletion of the just-sent untracked message without deleting the old canonical. Any read/parse/write failure latches the feature closed. If cleanup also fails, the durable send intent guards against further duplicates after restart. Do not delete state to recover from an error.

Bounds: 100 queued events per channel, 1000 total queued events, 1000 retained channel records, and a 1 MiB state-file read limit. Queue overflow reports an error and does not count the excess event. Removed entries are deliberately not automatically pruned because forgetting their IDs would orphan retained posts. State is single-process/single-writer, not a shared store for multiple bot instances. Synchronous durable writes favor correctness over throughput; this feature is intended for a small configured channel set.

Graceful shutdown stops accepting new work and drains accepted work before Discord destruction, with a five-second deadline. After the deadline, queued work and late fetch continuations cannot start new sends. An already in-flight send may still complete; its durable intent or returned canonical ID protects restart recovery.

## Operator recovery

Stop the bot before repairing state. Back up the JSON and any `.tmp` file. Inspect the affected channel through Discord and verify message authorship; never substitute another user's message ID. Restore a known-good state backup for corruption/unreadability rather than resetting the file. Fix filesystem permissions/storage first. A stale `.tmp` is a fail-closed condition; inspect it and remove it only while the bot is stopped and after reconciling its state with Discord.

For an uncertain `intent`, determine whether the send was delivered. Keep one verified bot-owned canonical, remove confirmed surplus bot posts, record the surviving canonical ID, and clear the intent only after that reconciliation. Keeping the previous hash/count is safe: a later changed-content refresh or threshold will reconcile the configured embed. Never blindly clear an intent and retry.

For exhausted `pending` deletion, fix access and either delete the verified old post and clear `pending`, or reset its `attempts`/`retryAt` to zero to allow another bounded retry cycle. Preserve the canonical ID. Capacity recovery requires deliberately reconciling/removing old inactive records, not automatic eviction. Restart only after state and Discord agree. Normal `/reload_config` does not clear a latched persistence failure.

## Verification

`tests/stickyPosts.test.ts` exercises the production handler/store, native discord.js MessageManager caching and send serialization, config validation, the actual Feature pipeline, and `/reload_config`, replacing only Discord transport and synthetic runtime dependencies. It never logs in a bot. A source-level lifecycle assertion pins the tested drain call before index destroys Discord; shutdown behavior itself is exercised with delayed fake REST responses. `tests/stickyConfig.test.ts` covers strict config validation.
