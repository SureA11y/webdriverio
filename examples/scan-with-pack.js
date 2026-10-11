'use strict';

/**
 * Scans a page against a pack's checklist (see acme-policy-pack.js) and
 * prints each checklist item's result, then any finding.
 *
 * Uses WebdriverIO in standalone mode (`remote()`), like basic-scan.js.
 *
 * Run: npm run example:pack -- https://example.com/
 *      (defaults to a small built-in page if no URL is given)
 */

const { remote } = require('webdriverio');
const { A11yCoreBuilder, formatFailures, getScanGaps } = require('../src/index.js');
const acmePolicy = require('./acme-policy-pack.js');

const SAMPLE =
  'data:text/html,<html lang="en"><head><title>Acme</title></head><body><main>' +
  '<h1>Launch</h1><img src="hero.png"><video src="intro.mp4" autoplay></video></main></body></html>';

async function main() {
  const url = process.argv[2] || SAMPLE;

  const browser = await remote({
    logLevel: 'error',
    capabilities: {
      browserName: 'chrome',
      // Classic WebDriver protocol -- steadier than v9's default BiDi for
      // this execute()-heavy workload.
      'wdio:enforceWebDriverClassic': true,
      'goog:chromeOptions': { args: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] }
    }
  });
  try {
    await browser.url(url);

    const results = await new A11yCoreBuilder({ browser })
      .withPacks(acmePolicy)
      .options({ profile: 'acme-web-2026' })
      .analyze();

    console.log(`Scanned with ${results.engine.packs.join(', ')}, profile ${results.engine.profile}\n`);
    for (const item of results.rulesResults.filter((r) => r.meta && r.meta.standard === 'Acme web policy')) {
      console.log(`${item.outcome.padEnd(13)} ${item.title}`);
    }
    console.log('\n' + formatFailures(results, { outcomes: ['fail'] }));

    // A pack the page didn't run (its core range, or a page on another core)
    // is a gap, not a pass.
    if (getScanGaps(results).length) process.exitCode = 1;
  } finally {
    await browser.deleteSession();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
