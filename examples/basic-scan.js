'use strict';

/**
 * Minimal runnable example: scans a real page with a real (headless)
 * browser and prints every rule outcome that failed.
 *
 * Uses WebdriverIO in "standalone" mode (`remote()`), the same way this
 * project's own tests/*.test.js do -- no WDIO testrunner/config needed for a
 * plain script. WebdriverIO v9 auto-manages a local chromedriver, so there's
 * no separate Selenium server to start.
 *
 * Run: npm run example -- https://example.com/
 *      (defaults to https://example.com/ if no URL is given)
 */

const { remote } = require('webdriverio');
const { A11yCoreBuilder } = require('../src/index.js');

async function main() {
  const url = process.argv[2] || 'https://example.com/';

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

    const results = await new A11yCoreBuilder({ browser }).analyze();

    const fails = results.checksResults.filter((r) => r.outcome === 'fail');
    console.log(`Scanned ${url}`);
    console.log(`${results.checksResults.length} rules evaluated, ${fails.length} failed.\n`);

    for (const f of fails) {
      console.log(`${f.ruleId} (${f.severity}): ${f.occurrences.length} occurrence(s)`);
      for (const occ of f.occurrences.slice(0, 3)) {
        console.log(`  - ${occ.selector}`);
      }
    }
  } finally {
    await browser.deleteSession();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
