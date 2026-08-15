# Privacy

Kryten processes Discord data only for configured support, moderation, and utility features in the servers where it is installed.

## Classifiers

Server administrators choose the channels and forum parents included for each classifier. Threads beneath an included channel or forum are included automatically. Messages from configured excluded roles and staff cannot trigger classification, although their messages can appear as pseudonymous surrounding context when another member triggers it.

When a message matches a classifier's local candidate rules, Kryten may retrieve up to 25 text messages from the surrounding channel conversation. Attachments, images, embeds, reactions, and message timestamps are not included. Before inference, Kryten replaces Discord identities with temporary labels and removes Discord identifiers, mentions, links, email addresses, phone numbers, IP and MAC addresses, and common secret formats. Free-form text can still contain personal information that automated redaction does not recognize.

Sanitized text is sent to Fireworks AI for inference. Fireworks states that its open-model inference APIs do not persist prompts or generations unless the customer explicitly opts in, although request metadata is logged and prompts may remain briefly in volatile prompt caches. Kryten does not opt in to prompt logging and does not send a Fireworks end-user identifier. See [Fireworks' data-handling documentation](https://docs.fireworks.ai/guides/security_compliance/data_handling).

Discord messages are not retained as training, fine-tuning, evaluation, or cross-classifier datasets. Kryten does not use Discord content to train an AI model.

## Stored interaction data

Kryten keeps one AES-256-GCM-encrypted interaction record per relevant Discord user. Depending on which features the user encounters, it can contain:

- the Discord user ID, first-seen time, and newcomer-greeting state;
- per-classifier campaign ID, `ROUTE` or `IGNORE` decision, and classification time.
- the current beta campaign ID when the beta-testing greeting has already been
  shown or suppressed by an operator backfill.

Classifier and beta-greeting records do not contain message text, prompts,
model output, reasoning, usernames, or conversation history. Beta-classifier
and beta-greeting records are deleted when the configured beta campaign changes
or 30 days after that campaign starts, whichever happens first. Never-greeted
newcomer records expire after 30 days; greeted records remain so Kryten does not
repeatedly welcome established members.

Staff classification logs contain the decision, processing status, and a link to the original Discord message. They do not copy the message text or username. Provider failure details are bounded and redacted before logging.

## Message lifecycle logs

When a server administrator explicitly enables message logging, Kryten keeps encrypted message snapshots so staff can review edits, single deletions, and bulk deletions. Snapshots can contain message text, Discord user/message/channel IDs, display labels, timestamps, and attachment metadata. Attachment bytes are not stored locally. Kryten may re-upload recoverable raster images directly to the configured staff log channel when an event is delivered.

Logging is limited to one configured guild and excludes identifiable bots, webhooks, system messages, configured ignored channels, moderation-blacklisted channels, and the log destinations themselves. For uncached bulk deletions, Discord supplies message IDs without their authors; Kryten may retain those IDs as unrecovered evidence, but stores no author, content, or attachment data for them. Queued evidence is never delivered to a differently configured guild. Snapshots expire after 30 days by default and are also bounded to 100,000 records by default; retention changes apply to existing snapshots. Pending delivery records expire after seven days. Stored snapshot and delivery payloads are encrypted with AES-256-GCM using a dedicated operator-managed key; routing IDs and retention timestamps remain plaintext in SQLite so Kryten can expire and deliver records.

## Deletion and contact

Use `/delete-data` in the Discord server to delete your complete encrypted
Kryten interaction record. Future qualifying activity can create a new record,
and deleting greeting state may cause Kryten to greet you again. You may also
privately contact the server moderation team through the server's established
staff-contact method for privacy questions or deletion assistance.
The `/delete-data` command covers interaction state, not staff moderation evidence; contact the moderation team for requests concerning lifecycle logs.
