# Classifier providers

Beta routing (`ROUTE`/`IGNORE`) and beta greeting retention (`KEEP`/`DELETE`)
use the shared primary factory in `src/llm/classifier.ts`. The checked-in template
remains disabled with Fireworks selected for compatibility. No provider is an
automatic fallback for another.

## Local Clef

Select the local provider with:

```json
{
    "enabled": true,
    "provider": "clef",
    "model": "Cloudflare/clef-flash",
    "classification_log_channel_id": "YOUR_LLM_CLASSIFICATION_LOG_CHANNEL_ID_HERE"
}
```

Clef has no API key or configurable endpoint. Kryten posts only to
`http://127.0.0.1:58756/v1/systemone`, rejects redirects, and requires the
response identity `Cloudflare/clef-flash`. The request contains an embedded,
versioned beta-routing or beta-greeting policy and sanitized message text. It
does not contain the private cloud-provider prompt or a conversation transcript.

Routing sends only the triggering message. It retains the candidate gate, but
an ambiguous reply continuation fails closed without fetching its parent or
channel history. Before campaign/store admission, routing also excludes a
trigger that explicitly says `Steam edition`, `Steam-edition`, `Steam version`,
or `Steam-version`; negated and mixed references are deliberately excluded too.
This deterministic guard is Clef-only. `SteamVR` and Steam game references do
not match it, and the Fireworks and TypeSafe paths are unchanged. Greeting
retention sends at most the trigger and first same-user follow-up, preserving
the existing cumulative character bound. A message over Discord's
4,000-character limit is rejected instead of truncated.

Both feature paths share one active Clef request and two queued requests. Routing
retains its hard 15-second local deadline from admission, including queue time.
Greeting requests instead use the remaining absolute greeting decision window,
including queue time, so they can run until 240 seconds after the greeting was
sent. Stale queued jobs are rejected before their input is built. Request and
response bytes are bounded, and the response model, label, probabilities,
confidence, and usage are validated. There are no retries, cloud fallback calls,
or shadow comparisons. Reload, user deletion, campaign/config changes, and the
greeting deadline still revoke positive results.

A greeting is visible for at least 45 seconds. A successful DELETE removes it at
the later of that minimum and decision completion; a successful KEEP received
before the 240-second cap retains it indefinitely. Failed inference does not count
as a successful DELETE, and no usable decision at the cap deletes the greeting.
Deletion retries remain bounded and may finish shortly after the cap. At most the
trigger and first same-user follow-up participate; a pending first-follow-up
decision supersedes an earlier scheduled DELETE.

## TypeSafe Jev

TypeSafe remains available with model `jev-1.13.0` and the fixed
`TYPESAFE_API_KEY` credential selector. Its primary limits are capped at 2.5
seconds, two active requests, four queued, 3 seconds of queue age, and 60
requests per minute. Fireworks sampling/output options are not sent to Jev.
Jev primary suppresses shadow comparisons.

## Fireworks and optional shadowing

Fireworks remains the template selection and retains its existing chat
completion payload and configurable bounds. With Fireworks primary only,
operators may enable the TypeSafe Jev shadow. Shadow results are observational
and metadata-only. Selecting TypeSafe or Clef as primary suppresses the shadow
even if its configuration remains enabled.

All providers keep safe fallback labels (`IGNORE` and `DELETE`), the same
candidate gates, campaign eligibility/state, audit metadata, and configuration
generation checks. Health `metrics.llmClassifier` reports the configured
provider/model and cumulative process counters.

## Synthetic checks

After building, `node scripts/probePrimary.cjs` performs an offline transport
contract check. A live Clef probe may be run only against the fixed loopback
service with `node scripts/probePrimary.cjs --live-clef`; it checks the local
admission guard, then sends five serial admitted message-only requests and
performs no Discord, database, configuration, or deployment action. Require
`status: "ok"`, exact labels, provider `clef`, and model
`Cloudflare/clef-flash`; a safe fallback label is not a successful probe.

The last full raw-model policy suite scored 23/24: Clef misclassified the
explicit Steam edition routing report as `ROUTE`. The live probe therefore
reports excluded Steam edition/version inputs as deterministic local exclusions
that make no transport call; it does not count or describe them as correct raw
model classifications. The live model checks cover only supported admitted
inputs.

Provider activation remains an operator configuration/deployment action. Review
and validate a minimal config patch, retain the matched prior release and config,
and do not reset or restore encrypted interaction state for a provider-only
rollback.
