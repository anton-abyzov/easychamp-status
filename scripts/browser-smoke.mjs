import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true, ...(process.env.STATUS_BROWSER_CHANNEL === 'chrome' ? { channel: 'chrome' } : {}) });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>Status browser smoke</title><main>Browser startup and rendering verified</main>');
  assert.equal(await page.title(), 'Status browser smoke');
  assert.equal(await page.locator('main').innerText(), 'Browser startup and rendering verified');
  console.log(JSON.stringify({ headlessBrowser: 'verified', version: browser.version() }));
} finally { await browser.close(); }
