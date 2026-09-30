# Classifier providers

Both beta routing (`ROUTE`/`IGNORE`) and beta greeting retention (`KEEP`/`DELETE`)
use the primary factory in `src/llm/classifier.ts`. The template remains Fireworks
for compatibility. To select TypeSafe Jev, set these fields within `llm_classifier`:

```json
{
  "enabled": true,
  "provider": "typesafe",
  "model": "jev-1.13.0",
  "api_key_env": "TYPESAFE_API_KEY",
  "timeout_ms": 2500,
  "max_concurrency": 2,
  "max_queue_depth": 4,
  "max_queue_age_ms": 3000,
  "max_requests_per_minute": 60
}
```

Set `typesafe_shadow.enabled` to `false`. The primary also suppresses shadow
observers and comparisons defensively when TypeSafe is selected. There are no
Fireworks calls or automatic provider failovers in this mode. Keep the existing
classification audit channel configured. Cards include provider/model identity;
Jev failures expose status without raw response text. Health `metrics.llmClassifier`
includes the current configured provider/model and cumulative process counters
(including work before a reload). Input/output tokens are taken from Jev usage;
absent cached/reasoning usage is zero and total is input plus output.

Jev uses the existing fixed `/v1/systemone` endpoint and strict decision contract,
including model, label, probability shape and usage validation. Probabilities
are validated, not converted to behavioral thresholds. The five limits above
are also hard ceilings for Jev primary, so leftover Fireworks settings cannot
extend Jev's deadline or overload its queue. Smaller configured limits are
honored. Fireworks-only sampling and output-token fields may remain for rollback;
they are never sent to Jev.

The existing sanitized input, private policies, candidate gates, campaign state,
and action timing remain in use. Routing classifies before its nonpinging send.
Greeting sends immediately and examines at most two messages; without a timely
KEEP it is deleted at the existing configured deadline (45 seconds in the
prepared operator configuration). Reload invalidates older queued/building work
and aborts Jev requests. Shutdown aborts transport and uses the existing bounded
beta shutdown. No campaign reset or data migration is needed.

## Synthetic checks

After building, run `node scripts/probePrimary.cjs`. This offline check uses the
same primary factory as the bot with a fake transport, checks all four labels,
rejects any non-Jev endpoint, and prints metadata and token counts only. It does
not instantiate the Discord client, read private prompts, or open databases.

A future authorized live smoke uses the installed candidate's **same script**
with `--live /absolute/path/to/candidate-config.json`. Run as the service identity
using the existing protected systemd EnvironmentFile, without displaying or
copying its contents. For example, substitute the reviewed candidate paths and
existing secret EnvironmentFile in this command:

```sh
sudo systemd-run --wait --pipe --collect \
  --unit=kryten-primary-smoke \
  -p User=kryten -p Group=kryten \
  -p EnvironmentFile=/absolute/path/to/existing/protected.env \
  -p WorkingDirectory=/absolute/path/to/candidate \
  -p RuntimeMaxSec=30 -p NoNewPrivileges=yes -p ProtectSystem=strict \
  /absolute/path/to/node /absolute/path/to/candidate/scripts/probePrimary.cjs \
  --live /absolute/path/to/candidate-config.json
```

The script refuses a disabled/non-Jev/unpinned primary. It makes four sequential
synthetic requests through `classifyLazy`, covering ROUTE, IGNORE, KEEP, DELETE.
Require status `ok`, exact expected label, TypeSafe identity and pinned model for
each. A failure stops the smoke; it must not be treated as success merely because
the safe fallback happens to equal the expected label. This proves transport and
factory selection, not private-policy quality on real conversations. It sends no
Discord requests and creates no message, campaign, or DB changes. This live step
has not been performed during preparation.

## Review, activation and recovery

Apply only the reviewed JSON Patch to a fresh config copy, honoring its `test`
operations for the previous provider/model and shadow flag. Validate the candidate
and compare all untouched fields. Do not replace configuration from a stale full
snapshot. Independent review precedes activation; preparation does not authorize
commit, push, deployment, or the live smoke.

Before any future cutover, retain the previous release and exact config with
ownership/mode/hash metadata in durable `/var/lib/beacon/kryten/recovery`, outside
auto-pruned scratch. Preserve campaign/templates/backfill and encrypted state.
Follow the existing sealed-release/native-dependency lane: verify identical
package manifests and old file/symlink manifest, copy dependencies with separate
inodes, verify SQLite/sharp under the installed Node/service identity, then seal
and verify the candidate. Do not modify the previous release's ownership or files.
Rollback selects the matched previous release and configuration. A provider-only
switch does not justify restoring an old database or erasing new interaction state.
