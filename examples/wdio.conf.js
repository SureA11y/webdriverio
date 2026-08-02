'use strict';

/**
 * WDIO testrunner config for the E2E accessibility-gate example
 * (examples/e2e-test-example.test.js). Run: `npm run example:e2e`
 * (i.e. `wdio run examples/wdio.conf.js`).
 *
 * Runner choice: unlike the sibling Puppeteer binding,
 * which picked plain `node:test` because Puppeteer has no first-party test
 * runner, WebdriverIO DOES ship its own testrunner (`@wdio/cli`) and it is by
 * far how real WebdriverIO suites are written -- a `wdio.conf.js` plus specs
 * that use the injected global `browser`. Using it here makes the E2E example
 * genuinely representative of a real WebdriverIO project, and demonstrates the
 * binding working against the testrunner's managed global `browser`, not just
 * the standalone `remote()` object the tests/*.test.js suite uses. (The unit
 * suite still uses node:test + remote() -- that's the right tool for exercising
 * the builder API in isolation; the testrunner is the right tool for the E2E
 * gate example.)
 */
exports.config = {
  runner: 'local',
  specs: ['./e2e-test-example.test.js'],
  maxInstances: 1,
  capabilities: [
    {
      browserName: 'chrome',
      // Classic WebDriver protocol -- steadier than v9's default BiDi for this
      // execute()-heavy binding.
      'wdio:enforceWebDriverClassic': true,
      'goog:chromeOptions': { args: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] }
    }
  ],
  logLevel: 'error',
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: 60000 }
};
