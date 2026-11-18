# easychamp-status-vantage

Second vantage for the status page. Design and fail-closed rules: `docs/incident-management.md`, `scripts/vantage.mjs`.

- Deploy: `cd worker/vantage && npx wrangler deploy` (KV namespace `easychamp-status-vantage` already bound).
- Read: `GET https://easychamp-status-vantage.<account>.workers.dev/v1/latest`. Set that URL as the GitHub Actions repository variable `STATUS_VANTAGE_URL`.
- Rollback: unset `STATUS_VANTAGE_URL`; `npx wrangler rollback`; or `npx wrangler delete`.
- Free tier only. Do not raise the cron rate or add probes without updating `test/vantage-worker.test.mjs`.
