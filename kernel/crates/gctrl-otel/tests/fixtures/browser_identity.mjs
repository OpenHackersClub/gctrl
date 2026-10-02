// Run by browser_identity.rs against its real ephemeral HTTP/CDP server.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(`${process.cwd()}/apps/gctrl-board/package.json`);
const { chromium } = require('@playwright/test');
const base = process.env.GCTRL_LIVE_BROWSER_URL;
const identities = [];
async function acquire() {
  const response = await fetch(`${base}/api/browser/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ttlSeconds: 60 }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const identity = await response.json();
  identities.push(identity);
  return identity;
}
const browsers = [];
try {
  const [a, b] = await Promise.all([acquire(), acquire()]);
  assert.notEqual(a.browserContextId, b.browserContextId);
  for (const identity of [a, b]) {
    browsers.push(await chromium.connectOverCDP(identity.cdpEndpoint, { timeout: 15000 }));
  }
  const contexts = await Promise.all(browsers.map(browser => browser.newContext()));
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  await Promise.all(pages.map(page => page.goto(`${base}/identity`)));
  const pageSession = await contexts[0].newCDPSession(pages[0]);
  await pageSession.send('Performance.enable');
  assert.ok((await pageSession.send('Performance.getMetrics')).metrics.length > 0);
  await pageSession.detach();
  const rootSession = await browsers[0].newBrowserCDPSession();
  const discovered = await rootSession.send('Target.getTargets');
  assert.ok(discovered.targetInfos.every(target => target.browserContextId === a.browserContextId));
  await assert.rejects(rootSession.send('Browser.close'), /not permitted/);
  await assert.rejects(rootSession.send('Runtime.evaluate', { expression: '1+1' }), /not permitted/);
  await rootSession.detach();
  await contexts[0].addCookies([{ name: 'identity', value: 'alice', url: base }]);
  await pages[0].evaluate(() => localStorage.setItem('identity', 'alice'));
  assert.equal((await contexts[1].cookies()).length, 0);
  assert.equal(await pages[1].evaluate(() => localStorage.getItem('identity')), null);
  await pages[0].setContent('<label>Name<input aria-label="Name"></label><output></output><script>document.querySelector("input").oninput=e=>document.querySelector("output").textContent=e.target.value</script>');
  await pages[0].getByRole('textbox', { name: 'Name' }).fill('verified');
  assert.equal(await pages[0].locator('output').textContent(), 'verified');
  assert.ok((await pages[0].screenshot()).byteLength > 0);
  await pages[0].evaluate(() => console.log('private-alice-identity'));
  await pages[1].evaluate(() => console.log('public-bob-identity'));
  const [reportA, reportB] = await Promise.all([a, b].map(async identity => {
    const response = await fetch(`${base}/api/browser/sessions/${identity.id}/report`);
    assert.equal(response.status, 200);
    return response.json();
  }));
  assert.ok(reportA.console.some(entry => entry.text.includes('private-alice-identity')), 'recorder missed frames before the first report query');
  assert.ok(reportB.console.some(entry => entry.text.includes('public-bob-identity')));
  assert.ok(reportB.console.every(entry => !entry.text.includes('private-alice-identity')), 'recorder leaked sibling frames');
  assert.ok(reportA.requests.some(request => request.url === `${base}/identity`));
  await contexts[0].close();
  // Disposing one managed context fences that identity, never its sibling.
  await pages[1].reload();
  assert.equal(await pages[1].evaluate(() => localStorage.getItem('identity')), null);
  await contexts[1].close();
  console.log('Playwright: independent identities, verified input, screenshot, and peer-safe disposal');
} finally {
  await Promise.all(browsers.map(browser => browser.close().catch(() => {})));
  await Promise.all(identities.map(identity => fetch(`${base}/api/browser/sessions/${identity.id}`, { method: 'DELETE' })));
}
