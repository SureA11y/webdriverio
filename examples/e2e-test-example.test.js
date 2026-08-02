'use strict';

/**
 * Demonstrates the pattern that actually matters for E2E test suites: using
 * A11yCoreBuilder as an accessibility gate inside a real test, not just a
 * standalone script -- see basic-scan.js for that simpler case.
 *
 * Runner choice: the WebdriverIO testrunner (`@wdio/cli`
 * + mocha), driven by examples/wdio.conf.js. This is the idiomatic way real
 * WebdriverIO suites are written -- specs using the injected global `browser`,
 * describe/it from the framework -- so an E2E example built this way reads as
 * "this is how a real WebdriverIO suite would use the binding," unlike the
 * sibling Puppeteer project (which reached for node:test only because Puppeteer
 * has no first-party runner). `expect` is WebdriverIO's own bundled matcher
 * (auto-injected as a global by the testrunner).
 *
 * One real WebdriverIO-specific wrinkle vs. the Playwright binding's example:
 * WebdriverIO's bundled `expect` takes *at most one argument* -- there is no
 * `expect(value, message)` custom-failure-message overload the way Playwright's
 * has. So the "clean page" gate below uses `node:assert`'s message parameter
 * to surface formatFailures()' readable block on failure (which is exactly the
 * assertion-library-agnostic pattern formatFailures() is built for -- see the
 * README's "Readable console/CI output on failure" section).
 *
 * Run: npm run example:e2e   (i.e. `wdio run examples/wdio.conf.js`)
 */

const assert = require('node:assert');
const { A11yCoreBuilder, formatFailures } = require('../src/index.js');

describe('accessibility gate (@surea11y/webdriverio)', () => {
  it('flags real accessibility issues (unlabeled button, missing alt)', async () => {
    await browser.url('data:text/html,<html><body><img src="logo.png"><button></button></body></html>');

    const results = await new A11yCoreBuilder({ browser })
      .reportOnly(['fail'])
      .analyze();

    const failedRuleIds = results.checksResults.map((r) => r.ruleId);
    expect(failedRuleIds).toContain('img-alt-present');
    expect(failedRuleIds).toContain('button-name-present');
  });

  it('a well-formed page has no accessibility violations', async () => {
    await browser.url(
      'data:text/html,<html lang="en"><head><title>Example</title></head>' +
      '<body><main><h1>Hello</h1><button>Click me</button></main></body></html>'
    );

    const results = await new A11yCoreBuilder({ browser })
      .reportOnly(['fail'])
      .analyze();

    // The real assertion shape you'd use as an accessibility gate in CI --
    // formatFailures() turns checksResults into a readable block (rule,
    // severity, selector, hint per occurrence) instead of a bare object diff,
    // so a failure is scannable straight from CI/terminal output. node:assert
    // is used here rather than WebdriverIO's `expect` because the latter has
    // no custom-failure-message parameter (see this file's header comment).
    assert.strictEqual(results.checksResults.length, 0, formatFailures(results.checksResults));
  });
});
