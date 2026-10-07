# EasyChamp Status

Independent public availability, rendering performance and scheduled data freshness. Hosted by GitHub Pages; standard public Linux Actions runners perform checks outside the production cluster. Upptime records HTTP endpoint histories and incident Issues; a small renderer adds grouped components, verified scraper freshness and explicit Unknown states.

## Local verification

```
npm ci
npm test
npm run check
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npx playwright install chromium
PWDEBUG=0 PLAYWRIGHT_HTML_OPEN=never npm run monitor -- --browser
npm run build
```

The registry contains only public names, URLs and coverage. It has no internal hosts, credentials, private service inventory or customer records. The read-only freshness endpoint permits a strict field allowlist. Each feed must provide both successful-run and destination-verification timestamps; liveness does not satisfy this contract.

HTTP checks run about every five minutes and rendering about every fifteen. GitHub schedules can be delayed or dropped. HTTP evidence expires after 15 minutes, rendering after 35, and sanitized collector evidence after 20. Expiry is recomputed in the browser every 30 seconds; a stopped monitor cannot freeze the page green. An initial or inaccessible monitor remains Unknown. Automation-protected pages need the scoped STATUS_MONITOR_TOKEN repository secret; the header is attached only to the explicit public host/path allowlist and never third-party requests.

The grouped site retains 90 days of daily observed-check counts and incident transitions. Unknown checks are excluded from the known-observation success fraction; these samples are not a continuous uptime SLA. Every required evidence timestamp must advance before counting another component observation. Replayed browser/destination samples and expiry alone cannot confirm failure or recovery. Known failures require two fresh observations to open an incident and two fresh operational observations to close it. Raw Upptime history and Issues also remain available. No fabricated historical uptime is prefilled.

## Deployment

Enable GitHub Pages with source `GitHub Actions`, then dispatch `Collect and publish service status`. Review source and tests before publishing. A custom domain is configured separately after DNS verification; no cluster ingress or new paid subscription is required. GitHub Pages can redirect its github.io URL to a configured custom domain, so the independent fallback is the timestamped data and incident Issues on github.com. Do not install a PAT, production provider keys, admin bearer tokens or SMTP credentials in this public repository.

An optional NEW_RELIC_STATUS_LICENSE_KEY secret and NEW_RELIC_STATUS_ACCOUNT_ID repository variable send small aggregate heartbeat events to the existing notification system. EasyChampPublicStatusHeartbeat proves completed collection. EasyChampPublicStatusPublishedHeartbeat is sent separately only after deployment and a live read of the exact fresh state generation, so collection success cannot hide repeated publication failures. Both contain raw counts plus confirmedOutageComponents/confirmedDegradedComponents requiring two fresh observations. Only aggregate counts, success and timestamps are transmitted; no request bodies, users or raw logs. A missing/rejected heartbeat does not prevent the independent page from publishing. Existing operator notification systems remain responsible for email routing; Upptime Issues provide public incident updates. Full authenticated workflows and media completion are shown Unknown until dedicated evidence is connected.

References: [Upptime](https://upptime.js.org/docs/), [GitHub public Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [scheduled workflow limits](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).
