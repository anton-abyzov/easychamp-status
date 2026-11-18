# Incident management

The component collector is the single incident authority. Two fresh complete component observations confirm a failure. Two fresh complete successful observations confirm recovery. Every required probe must advance; cached rendering, replayed destination samples, missing evidence, maintenance and `unknown` do not resolve an incident. An intervening unknown or maintenance observation breaks the recovery streak. Confirmation counters retain the highest confirmed incident severity through lower-severity failures, unknown evidence and the first recovery observation, so aggregate New Relic recovery notifications cannot precede confirmed public recovery.

Upptime's pinned `update` and `response-time` commands also create issues on raw HTTP transitions; neither supports an issue-disable switch. The workflow therefore preserves endpoint history directly from the same collected HTTP samples. It makes no additional HTTP calls. The historical `history/*.yml` format remains readable, with unavailable evidence explicitly `unknown`. These individual endpoint records are diagnostic observations, not separate customer incident declarations. Existing old Upptime issues require an owner reconciliation; the new writer never edits unrelated issues.

## Public data contract

`data/incidents.json` keeps `schemaVersion: 1` and the legacy incident fields: `id`, `componentId`, `title`, `status`, `reasonCode`, `openedAt`, `updatedAt`, `resolvedAt`. Additions:

- `stage`: `investigating`, `identified`, `monitoring`, `resolved` or `writeup_published`.
- `updates`: chronological `{id, stage, at, message, source}` entries. `source` is `monitor` or `owner`; owner entries include `{author: {login}}`. Monitor entries may contain public-safe `{evidence: {status, reasonCode, observedAt}}`. Repeated stable failures update `updatedAt` without flooding the timeline.
- `deadlineAt`: the public scheduled-update deadline observed when an import incident opened, if supplied by the existing freshness projection. It does not establish a root cause.
- `postmortem`: `{state: 'draft' | 'published', generatedAt, summary, url?, publishedAt?}`. A published write-up requires a resolved incident, a safe HTTPS URL, a publication timestamp at or after resolution, and an audited owner action.
- `issue`: `{number, url}` persisted only after GitHub accepts the canonical issue mutation.

`public/incident-model.mjs` exports `normalizeIncident`, `normalizeIncidents`, `INCIDENT_STAGES`, `STAGE_LABELS` and `safePublicUrl`. Legacy incidents display a synthetic opening and, when present, resolution entry that explicitly says earlier detailed observations are unavailable. Legacy fields are not evidence of a published postmortem. Invalid documents and duplicate open incident records stop durable writes instead of silently discarding incidents. All open incidents remain retained; the newest 300 resolved incidents remain in the live projection, and Git history preserves older records.

## Automatic issue and postmortem drafts

After collection, the monitor synchronizes GitHub issues using the deterministic `<!-- easychamp-incident:ID -->` marker. It persists the issue number and verifies the marker and `github-actions[bot]` ownership before updating or closing an existing issue. If issue creation succeeds but the mapping commit fails, the next run finds the marker and reuses the issue. Unrelated Upptime issues and human-created issues are not adopted.

Issue synchronization searches at most five pages of 100 issues and requires a complete search before any mutation. It permits at most 20 issue write calls and 40 total API calls per run, uses 10-second request deadlines, bounds response bodies to 2 MB and refuses redirects. Excess new incident work remains pending for the next run. A repository with 500 or more issue/PR search results requires an explicit pagination design update; the writer fails closed rather than risk duplicates. GitHub API failures log a sanitized message and leave public collection/publication available. Partial remote writes reconcile on the next run by marker.

Confirmed resolution automatically appends the recovery update and creates an **evidence-only postmortem draft** in the public incident record and issue. Its summary contains the confirmed opening and recovery times, observed duration, and an explicit owner-review requirement. It does not infer root cause, affected user counts, migration causation, repairs or preventive actions. The GitHub repository, issue body, JSON data and workflow logs are public. A draft is public observed evidence, not an automatically published final write-up.

The workflow uses the existing `GITHUB_TOKEN` with `contents: write` and `issues: write`. No paid service, additional key, telemetry payload or notification channel is introduced. GitHub issues may notify repository watchers according to their existing GitHub settings.

## Owner workflow

Open **Actions → Manage incident → Run workflow**, select `main`, and enter the existing incident ID and one of:

1. `investigating`: a reviewed public update while cause or recovery remains unconfirmed.
2. `identified`: a reviewed public update describing what the owner has established.
3. `monitoring`: a reviewed public update about the owner's observation period. This does not close the incident or clear confirmed alert counts.
4. `writeup_published`: after automatic resolution, a reviewed public summary and the public HTTPS URL of the completed write-up.

The workflow requires `workflow_dispatch` on the repository default branch, a matching human actor, and current repository `write`, `maintain` or `admin` collaborator permission. It records the GitHub login and workflow-run update ID, rejects old timestamps and deduplicates reruns. It does not accept a manual `resolved` stage. Owner updates and monitoring share the `independent-status` concurrency group, with no running-run cancellation. Both check out current `main` after obtaining the concurrency slot; pushes reject any intervening remote change instead of force-pushing. The owner workflow requests a fresh collection and Pages publication after committing its update.

Review every message and linked document for public disclosure before dispatching. Submit one plain paragraph of at most 1200 characters. The validator rejects control characters, HTML, common credential patterns, private-key/certificate markers, credential-bearing connection strings and obvious private HTTPS destinations. Pattern checks cannot identify every opaque secret or private fact. Never submit raw logs, request bodies, customer identities, secrets or private links. A published write-up is an explicit owner action; the automation never generates or publishes an unreviewed conclusion.

## Verification and remaining release proof

`npm test` covers two-failure/two-success lifecycle, unknown and maintenance interruptions, cached/replayed evidence, legacy unknown-counter migration, repeated failures, new incidents after recovery, owner authorization, draft/publication separation, URL/credential guards, crash reconciliation, mapping/author mismatch, duplicate markers, API bounds and serialized latest-main checkouts. Run `npm run check` and `git diff --check` as well. Lifecycle tests use local fixtures and mocked GitHub calls; they do not create artificial production incidents or send test notifications. Production release must separately read back the existing real incident, its GitHub mapping, fresh public state and accepted monitoring heartbeats.

## Second vantage (probe-path guard)

The collector runs on one GitHub runner. On November 18, 2026, unrelated services timed out in the same minute while the origin never saw the probe or answered in 0.26 s: the runner's path, not the services. `worker/vantage` is a Cloudflare Worker cron (every 2 minutes) that probes the same HTTP URLs, tokenless, from Cloudflare's network and publishes `/v1/latest`. The collector reads it through the repository variable `STATUS_VANTAGE_URL`.

- A failure counts only when both vantages fail. A failure only the runner saw is stored as `probe_path_suspect`: an `unknown` check, visible in the evidence and timeline, never counted toward 2-of-4.
- **Fail closed.** If the variable is unset, or the Worker is missing, older than one cycle, erroring, skewed more than 180 s from the runner's check, blocked (HTTP 429) or did not measure that probe, the runner's result counts exactly as before.
- Four or more unrelated components failing within 2 minutes are suspect only while the Worker passes them. If the Worker also fails them, they count immediately, so a real shared outage still confirms in the same or next cycle.
- When a cluster forms and the Worker has no fresh result for those probes they count at once (stricter than "suspect until the next result", by design). Render (browser) probes are held back only inside such a cluster, and only when the Worker reached the same URL.
- Safety valve: a probe held back 3 times within 30 minutes (consecutive or flapping) counts again (`counted_persistent`).
- Feed and scraper `collector_unavailable` is outside this. The 2-of-4 rule, six-pass clear and all thresholds are unchanged.
- Events are kept 14 days in `data/vantage.json`. `node scripts/vantage-report.mjs 7` compares suspect events with confirmed incidents.
- Free tier only: 720 cron runs and 720 KV writes a day (limit 1,000), about 11 subrequests per run, hard-capped at 45 including redirect hops (limit 50). `test/vantage-worker.test.mjs` fails if that grows.
- Rollback: unset `STATUS_VANTAGE_URL` (runner behaves as before); `cd worker/vantage && npx wrangler rollback`, or `wrangler delete` to remove the Worker.
