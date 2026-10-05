# Privacy

Kryten processes Discord data only for configured support, moderation, and utility features in the servers where it is installed.

## Classifiers

Server administrators choose the channels and forum parents included for each classifier. Threads beneath an included channel or forum are included automatically. Messages from configured excluded roles and staff cannot trigger classification, although their messages can appear as pseudonymous surrounding context when another member triggers it.

When a message matches a classifier's local candidate rules, Kryten may retrieve up to 25 text messages from the surrounding channel conversation. Attachments, images, embeds, reactions, and message timestamps are not included. Before inference, Kryten replaces Discord identities with temporary labels and removes Discord identifiers, mentions, links, email addresses, phone numbers, IP and MAC addresses, and common secret formats. Free-form text can still contain personal information that automated redaction does not recognize.

The configured authoritative provider can be local Clef (`clef`, model
`Cloudflare/clef-flash`), Fireworks AI (`fireworks`), or TypeSafe AI (`typesafe`,
model `jev-1.13.0`). There is no automatic fallback to another provider. Clef
runs on the same private host and receives sanitized message text through a
loopback-only endpoint; it uses Kryten's compact embedded policy and receives no
private cloud-provider prompt. Clef routing receives only the triggering message
and does not fetch channel history or a referenced parent. When Fireworks is
selected, sanitized text and the private policy are sent to Fireworks AI for
inference. Fireworks states that its open-model inference APIs do not persist
prompts or generations unless the customer explicitly opts in, although request
metadata is logged and prompts may remain briefly in volatile prompt caches.
Kryten does not opt in to prompt logging and does not send a Fireworks end-user
identifier. See [Fireworks' data-handling documentation](https://docs.fireworks.ai/guides/security_compliance/data_handling).

The cloud providers are explicit administrator-selected alternatives. They are
not active when Clef is selected and are never used as a fallback for Clef.

With Fireworks as primary, administrators may optionally enable a TypeSafe Jev shadow comparison. When
enabled, Kryten sends TypeSafe AI the same already-sanitized transcript snapshot
and private classifier policy used for the authoritative Fireworks decision.
In shadow mode, Jev's result is observational only: it cannot route, reply, retain, or delete a
message or greeting. TypeSafe is then an additional recipient of the sanitized
text for these requests. When TypeSafe or Clef is primary, shadow comparisons are suppressed even if enabled in config, so there is only one inference recipient. See [TypeSafe's model and data-handling
documentation](https://docs.typesafe.ai/models).

When beta-greeting retention is enabled, Kryten may send the triggering message
and at most one same-user follow-up message from the greeting's deletion window
through the same sanitization and inference path. With Clef, these are sent as
message-only inputs with no surrounding history. Only an affirmative, timely
classification retains Kryten's greeting. Provider failures, uncertain or late
results, configuration changes, and deletion requests do not retain it. This path
does not include provider raw output in staff classification logs.

Discord messages are not retained as training, fine-tuning, evaluation, or cross-classifier datasets. Kryten does not use Discord content to train an AI model.

## Stored interaction data

Kryten keeps one AES-256-GCM-encrypted interaction record per relevant Discord user. Depending on which features the user encounters, it can contain:

- the Discord user ID, first-seen time, and newcomer-greeting state;
- per-classifier campaign ID, `ROUTE` or `IGNORE` decision, and classification time.
- the current beta campaign ID when the beta-testing greeting has already been
  shown or suppressed by an operator backfill.
- per-rule timestamps for keyword auto-response cooldowns.

Classifier and beta-greeting records do not contain message text, prompts,
model output, reasoning, usernames, or conversation history. Beta-classifier
and beta-greeting records are deleted when the configured beta campaign changes
or 30 days after that campaign starts, whichever happens first. Never-greeted
newcomer records expire after 30 days; greeted records remain so Kryten does not
repeatedly welcome established members.

Keyword auto-response records contain no message content. Expired timestamps
are pruned on startup, config reload, or a later interaction-store operation;
there is no background expiry timer, so an idle record can remain past 24 hours.

Staff classification logs contain the decision, processing status, provider/model identity, and a link to the original Discord message. They do not copy the message text or username. Provider failure details are bounded and redacted before logging.

Optional TypeSafe shadow comparison logs are also metadata-only. They contain
the task type, Fireworks and Jev labels/statuses, Jev probabilities, confidence
and model version, provider latencies, running agreement counts, and a link to
the original message. They do not contain message excerpts, transcripts,
prompts, raw provider output, or usernames. Agreement measures consistency
between providers; it does not establish that either decision is correct.

## Deletion and contact

Use `/delete-data` in the Discord server to delete your complete encrypted
Kryten interaction record. Future qualifying activity can create a new record,
and deleting greeting state may cause Kryten to greet you again. You may also
privately contact the server moderation team through the server's established
staff-contact method for privacy questions or deletion assistance.
