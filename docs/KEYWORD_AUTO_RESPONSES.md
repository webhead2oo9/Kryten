# Keyword auto responses

Keyword auto responses are a separate, deterministic message-pipeline feature. They do not use the newcomer greeter, beta classifier, or any LLM.

The feature is opt-in. The checked-in `template.config.json` includes this disabled generic example:

```json
{
    "keyword_auto_responses": {
        "enabled": false,
        "rules": [
            {
                "id": "release-status",
                "channel_ids": ["YOUR_SUPPORT_CHANNEL_ID_HERE"],
                "keywords": ["release status", "status update"],
                "response": "Hi {user}! The current status is available in the linked announcement."
            }
        ]
    }
}
```

Set `enabled` to `true` only in the intended deployment configuration. Each rule ID must remain stable: the encrypted cooldown state is keyed by user ID and rule ID. `channel_ids` match exact channel IDs and never include threads. Keywords are case-insensitive literal phrases with letter/number/underscore boundaries, so `release status` does not match `prerelease status`, `release-status`, or two spaces.

`{user}` is replaced with a Discord mention of the message author. The reply explicitly disables all parsed mentions and permits only that user ID. Other placeholders are rejected during config loading.

Each user can receive each rule once per 24 hours. There is no global or per-channel cooldown. Claims are written to the shared encrypted interaction store before Discord is called, survive restarts, and are removed by `/delete-data`. Expired timestamps are pruned on startup, config reload, or a later interaction-store operation; there is no background expiry timer. Enabling the feature therefore requires `USER_INTERACTIONS_ENCRYPTION_KEY`; changing the shared store path or key still requires a restart.

Bots and staff are excluded. When staff roles are configured, an unknown or unfetchable guild member is skipped fail-safe. A successful response is nonterminal, so later moderation features still inspect the message.
