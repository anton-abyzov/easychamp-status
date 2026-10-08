# EasyChamp Status

Independent public availability, rendering performance and scheduled data freshness. Hosted by GitHub Pages; standard public Linux Actions runners perform checks outside the production cluster. A compact renderer exposes nested services, daily observations, verified scraper freshness and incident timelines. One confirmed component incident writer creates GitHub issues; Upptime-compatible raw endpoint histories remain diagnostic.

## Local verification

```
npm ci
npm test
npm run check
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npx playwright install chromium
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npm run monitor -- --browser
npm run build
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npm run check:ui
```

The registry contains only public names, URLs and coverage. It has no internal hosts, credentials, private service inventory or customer records. The read-only freshness endpoint permits a strict field allowlist. The fixed 29-row collector contract distinguishes seven destination-validation checks, 21 execution-only scheduled jobs and one cluster-resource aggregate. Destination checks require successful-import and destination-verification timestamps. Execution-only greens prove job completion against a pinned schedule, never destination freshness. Every row publishes its measurement kind, actual attempt/outcome, schedule/time zone and suspension; elapsed-running degradation requires actual start and a matching bounded job deadline, proven at observation time.

HTTP checks run about every five minutes and rendering about every fifteen. GitHub schedules can be delayed or dropped. HTTP evidence expires after 15 minutes, rendering after 35, and sanitized collector evidence after 20. Expiry is recomputed in the browser every 30 seconds; a stopped monitor cannot freeze the page green. An initial or inaccessible monitor remains Unknown. Automation-protected pages need the scoped STATUS_MONITOR_TOKEN repository secret; the header is attached only to the explicit public host/path allowlist and never third-party requests.

Hosted Linux runs use the runner's existing stable Chrome through Playwright with explicit headless mode. A startup/rendering smoke must pass before collection; no recurring apt install is needed. Local runs use the bundled Chromium installed by the command above. Browser runtime failure cannot be silently counted as successful rendering.

The grouped site retains 90 days of daily observed-check counts and incident transitions. Unknown checks are excluded from the known-observation success fraction; these samples are not a continuous uptime SLA. Every required evidence timestamp must advance before counting another component observation. Replayed browser/destination samples and expiry alone cannot confirm failure or recovery. Known failures require two fresh observations to open an incident and two fresh operational observations to close it. Raw endpoint history remains available. Legacy Upptime issues are archived diagnostic records; the component collector is the incident authority. No fabricated historical uptime is prefilled.

Resource monitoring reuses the existing Prometheus, kube-state-metrics and node-exporters. The public aggregate contains all-node readiness, latest bounded utilization and coverage only; no private labels or raw Kubernetes objects. A point CPU spike does not establish a sustained outage. Stale or incomplete resource coverage is Unknown.

The page exposes five independent dimensions across 43 nested services in seven groups: public endpoints, page performance, destination data, scheduled jobs and Kubernetes. A data-job incident does not imply slow pages. Authentic EasyChamp UIKit assets and typography are documented in [brand provenance](docs/brand-provenance.md).

## Deployment

Enable GitHub Pages with source `GitHub Actions`, then dispatch `Collect and publish service status`. Review source and tests before publishing. A custom domain is configured separately after DNS verification; no cluster ingress or new paid subscription is required. GitHub Pages can redirect its github.io URL to a configured custom domain, so the independent fallback is the timestamped data and incident Issues on github.com. Do not install a PAT, production provider keys, admin bearer tokens or SMTP credentials in this public repository.

An optional NEW_RELIC_STATUS_LICENSE_KEY secret and NEW_RELIC_STATUS_ACCOUNT_ID repository variable send small aggregate heartbeat events to the existing notification system. EasyChampPublicStatusHeartbeat proves completed collection. EasyChampPublicStatusPublishedHeartbeat is sent separately only after deployment and a live read of the exact fresh state generation, so collection success cannot hide repeated publication failures. Both contain raw counts plus confirmedOutageComponents/confirmedDegradedComponents. Confirmed severity survives unknown evidence and the first recovery check; two fresh successful observations clear it. Only aggregate counts, success and timestamps are transmitted; no request bodies, users or raw logs. A missing/rejected heartbeat does not prevent the independent page from publishing. Existing operator notification systems remain responsible for email routing; confirmed GitHub issues provide public incident updates. Full authenticated workflows and media completion are shown Unknown until dedicated evidence is connected.

References: [Upptime](https://upptime.js.org/docs/), [GitHub public Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [scheduled workflow limits](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Incident operation and public updates

Open a service or an incident for check scope, daily observations, affected services and a timestamped timeline. Operational means current configured checks pass; Unknown never implies customer availability. GitHub Watch provides public subscriptions according to the subscriber's notification preferences; owner email alerts continue through the existing New Relic route.

Resolution automatically prepares an evidence-only postmortem draft. An authorized owner uses the permission-checked default-branch **Manage incident** workflow for Investigating, Identified, Monitoring or a reviewed published write-up. Root cause and customer impact require review; automation never invents them. See [incident management](docs/incident-management.md) for authorization, schema, retry guards, API bounds and publication steps. All content in this repository is public.
