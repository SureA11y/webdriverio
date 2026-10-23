'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { remote } = require('webdriverio');
const { A11yCoreBuilder, EngineError, getScanGaps } = require('../src/index.js');

// WebdriverIO sessions are heavier to spin up than a puppeteer.launch()
// (each starts a real chromedriver process), so -- unlike the sibling
// Puppeteer/Playwright suites, which launch a fresh browser per test -- this
// suite shares ONE headless-Chrome session for the whole file and navigates
// per test with browser.url(). node:test runs the tests in a single file
// sequentially, and every test that touches frames leaves the browser back
// at the top-level context (analyze() switches to null on the way out), so a
// shared session is safe here. The four validation-only
// tests below construct a builder with a fake browser and need no session.
const CAPS = {
  logLevel: 'error',
  capabilities: {
    browserName: 'chrome',
    // Force the classic WebDriver protocol rather than WebdriverIO v9's
    // default BiDi one. A long-lived session issuing many execute() calls
    // over BiDi degraded catastrophically here (scan latency climbing from
    // ~2s into the minutes, then "Couldn't resolve command" drops); classic
    // holds a steady ~150ms/scan with no degradation, and every operation
    // this binding needs (execute, $, $$, switchFrame) is fully supported on
    // it.
    'wdio:enforceWebDriverClassic': true,
    'goog:chromeOptions': { args: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] }
  }
};

let browser;
test.before(async () => { browser = await remote(CAPS); });
test.after(async () => { if (browser) await browser.deleteSession(); });

// Wait for a page's expected sub-frames to be present (and, for network
// frames like example.org, given a brief moment to load) before scanning --
// the WebdriverIO equivalent of the sibling suites' page.waitForNetworkIdle().
async function waitForFrames(count, settleMs = 0) {
  await browser
    .waitUntil(async () => (await browser.$$('iframe')).length >= count, { timeout: 8000, interval: 50 })
    .catch(() => {});
  if (settleMs) await browser.pause(settleMs);
}

// Shared across the customRules tests below -- reported outcome depends on
// whether ctx.document has a .my-widget element. runInPage must be a
// function-source STRING, not a live function -- engineOptions crosses a
// browser.execute() serialization boundary that can't carry a live Function
// reference.
const MY_ORG_CUSTOM_RULE = {
  id: 'my-org-custom-rule',
  meta: { title: 'My custom rule', tags: ['custom'], defaultSeverity: 'serious' },
  runInPage: (function (ctx) {
    const el = ctx.document.querySelector('.my-widget');
    return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
  }).toString()
};

// Same rule, but as a real, LIVE function -- used to prove
// .withCustomRules() converts it to a source string itself, unlike the raw
// .options({ customRules }) passthrough above, which requires the caller to
// call .toString() themselves.
const MY_ORG_CUSTOM_RULE_LIVE = {
  id: 'my-org-custom-rule',
  meta: { title: 'My custom rule', tags: ['custom'], defaultSeverity: 'serious' },
  runInPage(ctx) {
    const el = ctx.document.querySelector('.my-widget');
    return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
  }
};

// A second, distinct rule ID -- used to prove withCustomRules() can register
// more than one rule at once (array form) and accumulates across calls.
const SECOND_CUSTOM_RULE = {
  id: 'my-org-second-custom-rule',
  meta: { title: 'My second custom rule', tags: ['custom'] },
  runInPage(ctx) {
    const el = ctx.document.querySelector('.my-other-widget');
    return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
  }
};

// Exercises the optional `applicability` field -- also accepted as a live
// function and converted the same way as runInPage. When applicability
// returns false, surea11y reports 'notApplicable' WITHOUT ever invoking
// runInPage; runInPage here always reports 'pass' so the two outcomes are
// unambiguous proof of which path ran.
const CUSTOM_RULE_WITH_APPLICABILITY = {
  id: 'my-org-conditional-custom-rule',
  meta: { title: 'Conditional custom rule', tags: ['custom'] },
  applicability(ctx) {
    return !!ctx.document.querySelector('.applicability-gate');
  },
  runInPage() {
    return { outcome: 'pass', occurrences: [] };
  }
};

test('A11yCoreBuilder.analyze() scans a real page and returns surea11y\'s native result shape', async () => {
  await browser.url('data:text/html,<html><body><img src="x.png"><button></button></body></html>');

  const results = await new A11yCoreBuilder({ browser }).analyze();

  assert.ok(Array.isArray(results.checksResults));
  const fails = results.checksResults.filter((r) => r.outcome === 'fail');
  assert.ok(fails.some((r) => r.ruleId === 'button-name-present'));
  assert.ok(fails.some((r) => r.ruleId === 'img-alt-present'));
});

test('A11yCoreBuilder: include() scopes the scan to one region', async () => {
  await browser.url(
    'data:text/html,<html><body>' +
    '<section id="a"><img src="x.png"></section>' +
    '<section id="b"><img src="y.png" alt=""></section>' +
    '</body></html>'
  );

  const results = await new A11yCoreBuilder({ browser }).include('#b').analyze();
  const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
  assert.strictEqual(rule.outcome, 'pass');
});

test('A11yCoreBuilder: include() called twice scans the union of both regions', async () => {
  await browser.url(
    'data:text/html,<html><body>' +
    '<section id="a"><img src="x.png"></section>' +
    '<section id="b"><img src="y.png"></section>' +
    '<section id="c"><img src="z.png" alt="decorative"></section>' +
    '</body></html>'
  );

  const results = await new A11yCoreBuilder({ browser }).include('#a').include('#b').analyze();
  const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
  assert.strictEqual(rule.outcome, 'fail');
  assert.strictEqual(rule.occurrences.length, 2); // #a and #b's images, not #c's
});

test('A11yCoreBuilder: scoping methods (include/exclude/withRules/etc.) accumulate across analyze() calls on the same instance -- create one builder per scan', async () => {
  await browser.url(
    'data:text/html,<html><body>' +
    '<section id="a"><img src="x.png"></section>' +
    '<section id="b"><img src="y.png"></section>' +
    '</body></html>'
  );

  // The builder is a mutable object with no reset between analyze() calls
  // -- include()/exclude()/withRules()/disableRules()/withTags()/
  // disableTags()/options() all push onto or merge into internal arrays/
  // objects that persist for the instance's lifetime. This is intentional
  // for "call include() multiple times within ONE scan" (see the test
  // above), but the same accumulation applies across separate analyze()
  // calls if you reuse an instance -- documented here so it's a known,
  // tested behavior rather than a silent surprise for anyone holding a
  // builder across multiple assertions. See README.md's own note.
  const builder = new A11yCoreBuilder({ browser });
  const first = await builder.include('#a').analyze();
  const second = await builder.include('#b').analyze(); // scope is now #a AND #b, not just #b

  const firstRule = first.checksResults.find((r) => r.ruleId === 'img-alt-present');
  const secondRule = second.checksResults.find((r) => r.ruleId === 'img-alt-present');
  assert.deepStrictEqual(firstRule.occurrences.map((o) => o.selector), ['#a > img']);
  assert.deepStrictEqual(secondRule.occurrences.map((o) => o.selector), ['#a > img', '#b > img']);
});

test('A11yCoreBuilder: reportOnly()/frames()/elementRef() overwrite on repeated calls, unlike the accumulating scoping methods above', async () => {
  await browser.url('data:text/html,<html><body><button></button></body></html>');

  const builder = new A11yCoreBuilder({ browser }).reportOnly(['fail']);
  await builder.analyze();
  // Calling reportOnly() again REPLACES the previous outcomes list rather
  // than merging with it -- unlike include()/withRules()/etc. above.
  const results = await builder.reportOnly(['pass']).analyze();

  assert.ok(results.checksResults.length > 0);
  assert.ok(results.checksResults.every((r) => r.outcome === 'pass'));
});

test('A11yCoreBuilder: exclude() skips elements inside the excluded subtree', async () => {
  await browser.url(
    'data:text/html,<html><body>' +
    '<div id="excluded"><img src="x.png"></div>' +
    '<div id="included"><img src="y.png" alt=""></div>' +
    '</body></html>'
  );

  const results = await new A11yCoreBuilder({ browser }).exclude('#excluded').analyze();
  const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
  assert.strictEqual(rule.outcome, 'pass');
});

test('A11yCoreBuilder: include() and exclude() combined -- scoped to a region, minus a sub-part of it', async () => {
  await browser.url(
    'data:text/html,<html><body>' +
    '<section id="scope"><div id="excluded"><img src="x.png"></div><img src="y.png"></section>' +
    '<img src="z.png">' + // outside #scope entirely -- must not count either
    '</body></html>'
  );

  const results = await new A11yCoreBuilder({ browser }).include('#scope').exclude('#excluded').analyze();
  const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
  assert.strictEqual(rule.outcome, 'fail');
  assert.deepStrictEqual(rule.occurrences.map((o) => o.selector), ['#scope > img']);
});

test('A11yCoreBuilder: disableRules() removes a rule from the result entirely', async () => {
  await browser.url('data:text/html,<html><body><button></button></body></html>');

  const results = await new A11yCoreBuilder({ browser })
    .disableRules(['button-name-present'])
    .analyze();

  const rule = results.checksResults.find((r) => r.ruleId === 'button-name-present');
  assert.strictEqual(rule, undefined);
});

test('A11yCoreBuilder: withRules() only runs the given rule IDs', async () => {
  await browser.url('data:text/html,<html><body><img src=x.png><button></button></body></html>');

  const results = await new A11yCoreBuilder({ browser })
    .withRules(['img-alt-present'])
    .analyze();

  assert.deepStrictEqual(results.checksResults.map((r) => r.ruleId), ['img-alt-present']);
});

test('A11yCoreBuilder: withRules() and disableRules() combined on the same rule ID -- disableRules wins', async () => {
  await browser.url('data:text/html,<html><body><img src=x.png><button></button></body></html>');

  // surea11y applies excludeRuleIds *after* includeRuleIds (see
  // ../surea11y/docs/ENGINE_OPTIONS.md) -- disableRules() should win over
  // withRules() when the same ID appears in both.
  const results = await new A11yCoreBuilder({ browser })
    .withRules(['img-alt-present', 'button-name-present'])
    .disableRules(['img-alt-present'])
    .analyze();

  assert.deepStrictEqual(results.checksResults.map((r) => r.ruleId), ['button-name-present']);
});

test('A11yCoreBuilder: disableTags() never runs rules carrying any of the given tags', async () => {
  await browser.url('data:text/html,<html><body><button></button></body></html>');

  // button-name-present carries wcag412 -- disabling that tag should remove it.
  const results = await new A11yCoreBuilder({ browser }).disableTags(['wcag412']).analyze();
  assert.ok(!results.checksResults.some((r) => r.ruleId === 'button-name-present'));
});

test('A11yCoreBuilder: withTags() only runs rules carrying at least one of the given tags', async () => {
  await browser.url('data:text/html,<html><body><button></button></body></html>');

  const results = await new A11yCoreBuilder({ browser }).withTags(['wcag412']).analyze();
  assert.ok(results.checksResults.length > 0);
  // button-name-present carries wcag412 -- should still be present.
  assert.ok(results.checksResults.some((r) => r.ruleId === 'button-name-present'));
});

test('A11yCoreBuilder: withTags() and disableTags() combined on the same tag -- disableTags wins, leaving nothing', async () => {
  await browser.url('data:text/html,<html><body><button></button></body></html>');

  const results = await new A11yCoreBuilder({ browser }).withTags(['wcag412']).disableTags(['wcag412']).analyze();
  assert.deepStrictEqual(results.checksResults, []);
});

test('A11yCoreBuilder: withRules() and withTags() combined require BOTH to match (surea11y\'s default "and" includeMode)', async () => {
  await browser.url('data:text/html,<html><body><img src=x.png><button></button></body></html>');

  // surea11y's default includeMode is 'and' when both an ID include and a
  // tag include are given (see ../surea11y/docs/ENGINE_OPTIONS.md) -- this
  // binding doesn't expose includeMode, so combining withRules() and
  // withTags() is stricter than either alone, not an OR of the two. Worth
  // locking down since it's non-obvious: img-alt-present doesn't carry
  // wcag412, so this combination yields nothing even though img-alt-present
  // alone matches withRules() and button-name-present alone matches wcag412.
  const results = await new A11yCoreBuilder({ browser })
    .withRules(['img-alt-present'])
    .withTags(['wcag412'])
    .analyze();

  assert.deepStrictEqual(results.checksResults, []);
});

test('A11yCoreBuilder: options() merges into engineOptions and is actually applied', async () => {
  await browser.url('data:text/html,<html><body><button></button></body></html>');

  const results = await new A11yCoreBuilder({ browser }).options({ locale: 'fr' }).analyze();
  const rule = results.checksResults.find((r) => r.ruleId === 'button-name-present');
  assert.ok(rule, 'button-name-present should be present in the result');
  // Each result echoes back the *resolved* engineOptions it actually ran
  // under (see surea11y's docs/OUTPUT_SCHEMA.md), rather than just
  // presence, confirms .options() really reached the engine instead of
  // being silently dropped.
  assert.strictEqual(rule.engineOptions.locale, 'fr');
});

test('A11yCoreBuilder: options({ customRules }) registers a runtime custom rule via surea11y\'s engineOptions passthrough', async () => {
  await browser.url('data:text/html,<html><body><div class="my-widget"></div></body></html>');

  // No dedicated builder method for this yet -- .options() already
  // forwards arbitrary engineOptions, including surea11y's customRules
  // runtime-registration escape hatch (see ../surea11y/docs/ENGINE_OPTIONS.md).
  const results = await new A11yCoreBuilder({ browser })
    .options({ customRules: [MY_ORG_CUSTOM_RULE] })
    .analyze();

  const custom = results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule');
  assert.ok(custom, 'custom rule should appear in checksResults like a built-in rule');
  assert.strictEqual(custom.outcome, 'fail');
  // Confirms the custom rule's occurrence gets the same automatic
  // selector/structuralPath fill-in a built-in rule's does, not a raw
  // pass-through of whatever the custom runInPage returned.
  assert.strictEqual(custom.occurrences[0].selector, 'html > body > div');
  assert.deepStrictEqual(custom.occurrences[0].structuralPath, [1, 0]);
});

test('A11yCoreBuilder: options({ customRules }) combined with frames(true) -- the custom rule runs in every frame, not just the top one', async () => {
  await browser.url(
    'data:text/html,<html><body>' +
    '<div class="my-widget"></div>' +
    '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cdiv class=my-widget%3E%3C/div%3E%3C/body%3E%3C/html%3E"></iframe>' +
    '</body></html>'
  );
  await waitForFrames(1);

  const results = await new A11yCoreBuilder({ browser })
    .frames(true)
    .options({ customRules: [MY_ORG_CUSTOM_RULE] })
    .analyze();

  assert.strictEqual(results.topFrame.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
  assert.strictEqual(results.frames[0].checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
});

test('A11yCoreBuilder: options({ customRules }) combined with reportOnly() -- the custom rule is filtered the same as a built-in one', async () => {
  await browser.url('data:text/html,<html><body><div class="my-widget"></div></body></html>');

  const results = await new A11yCoreBuilder({ browser })
    .options({ customRules: [MY_ORG_CUSTOM_RULE] })
    .reportOnly(['fail'])
    .analyze();

  assert.ok(results.checksResults.some((r) => r.ruleId === 'my-org-custom-rule'));
  assert.ok(results.checksResults.every((r) => r.outcome === 'fail'));
});

test('A11yCoreBuilder: withCustomRules() registers a runtime custom rule, converting a live runInPage function to a source string automatically', async () => {
  await browser.url('data:text/html,<html><body><div class="my-widget"></div></body></html>');

  // MY_ORG_CUSTOM_RULE_LIVE's runInPage is a real, live function -- unlike
  // the raw .options({ customRules }) passthrough above, which requires a
  // pre-stringified function, withCustomRules() must convert it itself.
  const results = await new A11yCoreBuilder({ browser })
    .withCustomRules(MY_ORG_CUSTOM_RULE_LIVE)
    .analyze();

  const custom = results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule');
  assert.ok(custom, 'custom rule should appear in checksResults like a built-in rule');
  assert.strictEqual(custom.outcome, 'fail');
  assert.strictEqual(custom.occurrences[0].selector, 'html > body > div');
});

test('A11yCoreBuilder: withCustomRules() accepts an array to register multiple rules in one call', async () => {
  await browser.url(
    'data:text/html,<html><body>' +
    '<div class="my-widget"></div>' +
    '<div class="my-other-widget"></div>' +
    '</body></html>'
  );

  const results = await new A11yCoreBuilder({ browser })
    .withCustomRules([MY_ORG_CUSTOM_RULE_LIVE, SECOND_CUSTOM_RULE])
    .analyze();

  assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
  assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-second-custom-rule').outcome, 'fail');
});

test('A11yCoreBuilder: withCustomRules() accumulates across repeated calls, like withRules()/withTags()', async () => {
  await browser.url(
    'data:text/html,<html><body>' +
    '<div class="my-widget"></div>' +
    '<div class="my-other-widget"></div>' +
    '</body></html>'
  );

  const results = await new A11yCoreBuilder({ browser })
    .withCustomRules(MY_ORG_CUSTOM_RULE_LIVE)
    .withCustomRules(SECOND_CUSTOM_RULE) // adds a second rule, doesn't replace the first
    .analyze();

  assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
  assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-second-custom-rule').outcome, 'fail');
});

test('A11yCoreBuilder: withCustomRules() composes with a raw options({ customRules }) call rather than clobbering it', async () => {
  await browser.url(
    'data:text/html,<html><body>' +
    '<div class="my-widget"></div>' +
    '<div class="my-other-widget"></div>' +
    '</body></html>'
  );

  const results = await new A11yCoreBuilder({ browser })
    .options({ customRules: [MY_ORG_CUSTOM_RULE] })
    .withCustomRules(SECOND_CUSTOM_RULE)
    .analyze();

  assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
  assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-second-custom-rule').outcome, 'fail');
});

test('A11yCoreBuilder: withCustomRules() runs the rule in every frame when combined with frames(true)', async () => {
  await browser.url(
    'data:text/html,<html><body>' +
    '<div class="my-widget"></div>' +
    '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cdiv class=my-widget%3E%3C/div%3E%3C/body%3E%3C/html%3E"></iframe>' +
    '</body></html>'
  );
  await waitForFrames(1);

  const results = await new A11yCoreBuilder({ browser })
    .frames(true)
    .withCustomRules(MY_ORG_CUSTOM_RULE_LIVE)
    .analyze();

  assert.strictEqual(results.topFrame.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
  assert.strictEqual(results.frames[0].checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
});

test('A11yCoreBuilder: withCustomRules() is filtered the same as a built-in rule when combined with reportOnly()', async () => {
  await browser.url('data:text/html,<html><body><div class="my-widget"></div></body></html>');

  const results = await new A11yCoreBuilder({ browser })
    .withCustomRules(MY_ORG_CUSTOM_RULE_LIVE)
    .reportOnly(['fail'])
    .analyze();

  assert.ok(results.checksResults.some((r) => r.ruleId === 'my-org-custom-rule'));
  assert.ok(results.checksResults.every((r) => r.outcome === 'fail'));
});

test('A11yCoreBuilder: withCustomRules() converts a live applicability function too, and respects its true/false result', async () => {
  await browser.url('data:text/html,<html><body><div class="applicability-gate"></div></body></html>');
  const applicableResults = await new A11yCoreBuilder({ browser })
    .withCustomRules(CUSTOM_RULE_WITH_APPLICABILITY)
    .analyze();
  assert.strictEqual(
    applicableResults.checksResults.find((r) => r.ruleId === 'my-org-conditional-custom-rule').outcome,
    'pass'
  );

  await browser.url('data:text/html,<html><body></body></html>');
  const notApplicableResults = await new A11yCoreBuilder({ browser })
    .withCustomRules(CUSTOM_RULE_WITH_APPLICABILITY)
    .analyze();
  assert.strictEqual(
    notApplicableResults.checksResults.find((r) => r.ruleId === 'my-org-conditional-custom-rule').outcome,
    'notApplicable'
  );
});

test('A11yCoreBuilder: withCustomRules() still accepts an already-stringified runInPage, same as the raw options() passthrough', async () => {
  await browser.url('data:text/html,<html><body><div class="my-widget"></div></body></html>');

  const results = await new A11yCoreBuilder({ browser })
    .withCustomRules(MY_ORG_CUSTOM_RULE) // runInPage is already a string here
    .analyze();

  assert.strictEqual(results.checksResults.find((r) => r.ruleId === 'my-org-custom-rule').outcome, 'fail');
});

test('A11yCoreBuilder: withCustomRules() throws synchronously on a missing/empty id, instead of failing silently deep in the page', () => {
  assert.throws(
    () => new A11yCoreBuilder({ browser: { execute: () => {} } }).withCustomRules({ runInPage: () => ({}) }),
    /requires a non-empty string `id`/
  );
  assert.throws(
    () => new A11yCoreBuilder({ browser: { execute: () => {} } }).withCustomRules({ id: '', runInPage: () => ({}) }),
    /requires a non-empty string `id`/
  );
});

test('A11yCoreBuilder: withCustomRules() throws synchronously when runInPage is missing or not a function/string', () => {
  assert.throws(
    () => new A11yCoreBuilder({ browser: { execute: () => {} } }).withCustomRules({ id: 'no-run-fn' }),
    /requires a `runInPage` function or function-source string/
  );
  assert.throws(
    () => new A11yCoreBuilder({ browser: { execute: () => {} } }).withCustomRules({ id: 'bad-run-fn', runInPage: 123 }),
    /requires a `runInPage` function or function-source string/
  );
  assert.throws(
    () => new A11yCoreBuilder({ browser: { execute: () => {} } }).withCustomRules({ id: 'empty-run-fn', runInPage: '' }),
    /requires a `runInPage` function or function-source string/
  );
});

test('A11yCoreBuilder: withCustomRules() throws synchronously when applicability is provided but not a function/string', () => {
  assert.throws(
    () => new A11yCoreBuilder({ browser: { execute: () => {} } }).withCustomRules({
      id: 'bad-applicability',
      runInPage: () => ({}),
      applicability: 123
    }),
    /`applicability` must be a function or function-source string/
  );
});

test('A11yCoreBuilder: withCustomRules() rejects the whole call (no partial registration) when one descriptor in an array is invalid', () => {
  const builder = new A11yCoreBuilder({ browser: { execute: () => {} } });
  assert.throws(
    () => builder.withCustomRules([MY_ORG_CUSTOM_RULE_LIVE, { id: '', runInPage: () => ({}) }]),
    /requires a non-empty string `id`/
  );
  // Confirms the valid entry earlier in the array wasn't partially pushed
  // onto internal state before the invalid one threw.
  assert.strictEqual(builder._customRules.length, 0);
});

test('A11yCoreBuilder: frames(true) with no sub-frames returns { topFrame, frames: [] }', async () => {
  await browser.url('data:text/html,<html><body><button></button></body></html>');

  const results = await new A11yCoreBuilder({ browser }).frames(true).analyze();

  assert.ok(Array.isArray(results.topFrame.checksResults));
  assert.ok(results.topFrame.checksResults.some((r) => r.ruleId === 'button-name-present' && r.outcome === 'fail'));
  assert.deepStrictEqual(results.frames, []);
});

test('A11yCoreBuilder: frames(true) scans a sub-frame and keeps its findings separate from the top frame', async () => {
  // <iframe srcdoc> creates a real, distinct sub-frame with zero network
  // dependency and fully deterministic content -- good for verifying the
  // orchestration logic itself (topFrame vs. frames[], not double-counting).
  await browser.url(
    'data:text/html,<html><body>' +
    '<button>Top button, has a name</button>' +
    '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cimg src=x.png%3E%3C/body%3E%3C/html%3E"></iframe>' +
    '</body></html>'
  );
  await waitForFrames(1);

  const results = await new A11yCoreBuilder({ browser }).frames(true).analyze();

  // Top frame has no img-alt-present issue (no <img> there at all) and no
  // button-name-present failure (the button has real text).
  const topButtonRule = results.topFrame.checksResults.find((r) => r.ruleId === 'button-name-present');
  assert.strictEqual(topButtonRule.outcome, 'pass');

  assert.strictEqual(results.frames.length, 1);
  const frameImgRule = results.frames[0].checksResults.find((r) => r.ruleId === 'img-alt-present');
  assert.strictEqual(frameImgRule.outcome, 'fail');
});

test('A11yCoreBuilder: frames(true) recurses into nested iframes-within-iframes, flattening every depth into frames[]', async () => {
  // WebdriverIO's $$("iframe") only sees a context's DIRECT children, so
  // reaching a grandchild frame needs real recursion through switchFrame()
  // (see A11yCoreBuilder._scanChildFrames). This is the
  // WebdriverIO-specific piece with no direct analogue in the sibling
  // bindings' page.frames() (which already returns every frame flat), so it
  // gets its own test. Top -> child (has an <img>) -> grandchild (has an
  // unlabeled <button>); frames[] should carry both, flattened.
  const grandchild = 'data:text/html,<html><body><button></button></body></html>';
  const child = 'data:text/html,' + encodeURIComponent(
    '<html><body><img src="x.png"><iframe src="' + grandchild + '"></iframe></body></html>'
  );
  await browser.url('data:text/html,' + encodeURIComponent(
    '<html><body><h1>top</h1><iframe src="' + child + '"></iframe></body></html>'
  ));
  await waitForFrames(1, 300);

  const results = await new A11yCoreBuilder({ browser }).frames(true).reportOnly(['fail']).analyze();

  assert.strictEqual(results.frames.length, 2, 'both the child and the nested grandchild frame should be scanned');
  const anyImgFail = results.frames.some((f) => f.checksResults && f.checksResults.some((r) => r.ruleId === 'img-alt-present'));
  const anyButtonFail = results.frames.some((f) => f.checksResults && f.checksResults.some((r) => r.ruleId === 'button-name-present'));
  assert.ok(anyImgFail, 'the child frame\'s missing-alt image should be found');
  assert.ok(anyButtonFail, 'the nested grandchild frame\'s unlabeled button should be found');
});

test('A11yCoreBuilder: reportOnly() filters checksResults down to the given outcomes', async () => {
  await browser.url('data:text/html,<html><body><img src="x.png"><button></button></body></html>');

  const results = await new A11yCoreBuilder({ browser }).reportOnly(['fail']).analyze();

  assert.ok(results.checksResults.length > 0);
  assert.ok(results.checksResults.every((r) => r.outcome === 'fail'));
  assert.ok(results.checksResults.some((r) => r.ruleId === 'button-name-present'));
});

test('A11yCoreBuilder: reportOnly() rejects an invalid outcome value', () => {
  assert.throws(
    () => new A11yCoreBuilder({ browser: { execute: () => {} } }).reportOnly(['nope']),
    /invalid outcome "nope"/
  );
});

test('A11yCoreBuilder: reportOnly() applies per-frame when combined with frames(true)', async () => {
  await browser.url(
    'data:text/html,<html><body>' +
    '<button>Top button, has a name</button>' +
    '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cimg src=x.png%3E%3C/body%3E%3C/html%3E"></iframe>' +
    '</body></html>'
  );
  await waitForFrames(1);

  const results = await new A11yCoreBuilder({ browser }).frames(true).reportOnly(['fail']).analyze();

  assert.ok(results.topFrame.checksResults.every((r) => r.outcome === 'fail'));
  assert.ok(results.frames[0].checksResults.every((r) => r.outcome === 'fail'));
  assert.ok(results.frames[0].checksResults.some((r) => r.ruleId === 'img-alt-present'));
});

test('A11yCoreBuilder: elementRef(true) attaches a live, usable WebdriverIO.Element to each fail/cantTell occurrence', async () => {
  await browser.url('data:text/html,<html><body><img id="pic" src="x.png"></body></html>');

  const results = await new A11yCoreBuilder({ browser }).elementRef(true).analyze();

  const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
  assert.strictEqual(rule.outcome, 'fail');
  const [occurrence] = rule.occurrences;
  assert.ok(occurrence.element, 'occurrence should carry a live WebdriverIO.Element');
  // Prove it's a real, usable element into the page -- not just a truthy
  // placeholder -- by reading a live DOM property through it. WebdriverIO's
  // element API is .getProperty('id'), not Puppeteer's .evaluate(el => el.id).
  const id = await occurrence.element.getProperty('id');
  assert.strictEqual(id, 'pic');
});

test('A11yCoreBuilder: reportOnly() and elementRef(true) combined -- surviving occurrences still carry a usable element', async () => {
  await browser.url('data:text/html,<html><body><img id="pic" src="x.png"><button></button></body></html>');

  const results = await new A11yCoreBuilder({ browser }).reportOnly(['fail']).elementRef(true).analyze();

  assert.ok(results.checksResults.every((r) => r.outcome === 'fail'));
  const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
  const id = await rule.occurrences[0].element.getProperty('id');
  assert.strictEqual(id, 'pic');
});

test('A11yCoreBuilder: elementRef(true) leaves element null for an occurrence with no resolvable selector, instead of throwing', async () => {
  await browser.url('data:text/html,<html><body><button>x</button></body></html>');

  // contrast-enhanced can report a page-wide occurrence with
  // selector: "" (no single target element) -- confirms .elementRef(true)
  // doesn't crash calling browser.$("") on it. Unlike Puppeteer/Playwright's
  // .$("") (which resolves to null), WebdriverIO's browser.$("") THROWS
  // ("invalid selector: No selector specified") -- verified with a real run
  // -- so the empty-selector guard matters even more here; the occurrence's
  // `element` is left null rather than either throwing or holding a bogus ref.
  const results = await new A11yCoreBuilder({ browser }).elementRef(true).analyze();
  const rule = results.checksResults.find((r) => r.ruleId === 'contrast-enhanced');
  const occurrence = rule.occurrences.find((o) => o.selector === '');
  assert.ok(occurrence, 'expected an occurrence with an empty selector on this page');
  assert.strictEqual(occurrence.element, null);
});

test('A11yCoreBuilder: elementRef(true) resolves against each frame\'s own document when combined with frames(true)', async () => {
  await browser.url(
    'data:text/html,<html><body>' +
    '<button>Top button, has a name</button>' +
    '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cimg id=inner src=x.png%3E%3C/body%3E%3C/html%3E"></iframe>' +
    '</body></html>'
  );
  await waitForFrames(1);

  const results = await new A11yCoreBuilder({ browser }).frames(true).elementRef(true).analyze();

  const rule = results.frames[0].checksResults.find((r) => r.ruleId === 'img-alt-present');
  assert.strictEqual(rule.outcome, 'fail');
  // The sub-frame element was resolved against that frame's own document.
  // WebdriverIO caveat (see A11yCoreBuilder#elementRef): a sub-frame element
  // is only usable while switched into its frame, so re-enter it before
  // reading a live property back through the element.
  await browser.switchFrame((await browser.$$('iframe'))[0]);
  try {
    const id = await rule.occurrences[0].element.getProperty('id');
    assert.strictEqual(id, 'inner');
  } finally {
    await browser.switchFrame(null);
  }
});

test('A11yCoreBuilder: frames(true) scans a genuinely cross-origin iframe (no surea11y engine support needed for this)', async () => {
  // example.org is IANA-reserved specifically for use in documentation/
  // testing and is about as stable a real external dependency as exists --
  // this is the exact page used to empirically verify that cross-origin
  // frame scanning needs no engine work, the same claim the sibling bindings
  // already verified for themselves. WebdriverIO's automation layer
  // (WebDriver/BiDi) switches into a cross-origin frame the same as CDP does
  // for Puppeteer/Playwright -- confirmed here with a real run, not assumed.
  await browser.url('data:text/html,<html><body><iframe src="https://example.org/"></iframe></body></html>');
  await waitForFrames(1, 800);

  const results = await new A11yCoreBuilder({ browser }).frames(true).analyze();

  assert.strictEqual(results.frames.length, 1);
  assert.ok(!results.frames[0].error, `Cross-origin frame scan should not error: ${results.frames[0].error}`);
  assert.ok(Array.isArray(results.frames[0].checksResults));
  assert.ok(results.frames[0].checksResults.length > 0);
});

// ---- @surea11y/core 1.10.0: engine errors, scan gaps, shadow DOM, version ----

const CORE_VERSION = require('@surea11y/core/package.json').version;

function dataUrl(html) {
  return 'data:text/html,' + encodeURIComponent(html);
}

// Runs fn with console.warn captured, returning what it printed.
async function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test('A11yCoreBuilder: the result names the @surea11y/core release that produced it (engine.version)', async () => {
  await browser.url('data:text/html,<html><body><button></button></body></html>');

  const results = await new A11yCoreBuilder({ browser }).analyze();

  assert.strictEqual(results.engine.version, CORE_VERSION);
});

test('A11yCoreBuilder: a rule list that names no known rule rejects with an EngineError whose code is INVALID_RUN_ONLY', async () => {
  await browser.url('data:text/html,<html><body><button></button></body></html>');

  await assert.rejects(
    new A11yCoreBuilder({ browser }).withRules(['no-such-rule']).analyze(),
    (e) => {
      assert.ok(e instanceof EngineError);
      assert.strictEqual(e.name, 'EngineError');
      assert.strictEqual(e.code, 'INVALID_RUN_ONLY');
      assert.strictEqual(e.selector, null);
      return true;
    }
  );
});

test('A11yCoreBuilder: a tag list that names no known tag rejects with INVALID_RUN_ONLY, also under frames(true)', async () => {
  await browser.url('data:text/html,<html><body><button></button></body></html>');

  await assert.rejects(
    new A11yCoreBuilder({ browser }).withTags(['wcag2.2aa']).frames(true).analyze(),
    (e) => e instanceof EngineError && e.code === 'INVALID_RUN_ONLY'
  );
});

test('A11yCoreBuilder: withTags()/withRules() throw at the call for a missing value, with code INVALID_RUN_ONLY', () => {
  const builder = new A11yCoreBuilder({ browser: { execute() {} } });
  for (const call of [() => builder.withTags(undefined), () => builder.withRules(''), () => builder.disableTags(null)]) {
    assert.throws(call, (e) => e instanceof TypeError && e.code === 'INVALID_RUN_ONLY');
  }
});

test('A11yCoreBuilder: an include() selector the browser cannot parse rejects with INVALID_CONTEXT_SELECTOR and names it', async () => {
  await browser.url('data:text/html,<html><body><button></button></body></html>');

  await assert.rejects(
    new A11yCoreBuilder({ browser }).include('main[[').analyze(),
    (e) => e instanceof EngineError && e.code === 'INVALID_CONTEXT_SELECTOR' && e.selector === 'main[['
  );
});

test('A11yCoreBuilder: an include() scope that matches nothing scans nothing, says so in contextMatch, and warns', async () => {
  await browser.url('data:text/html,<html><body><img src="x.png"></body></html>');

  let results;
  const warnings = await captureWarnings(async () => {
    results = await new A11yCoreBuilder({ browser }).include('.no-such-region').analyze();
  });

  assert.deepStrictEqual(results.contextMatch, { elementCount: 0, unmatchedSelectors: ['.no-such-region'] });
  assert.ok(results.checksResults.every((r) => r.outcome === 'notApplicable'));
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /^@surea11y\/webdriverio .*Nothing was scanned: the scan scope matched no element \("\.no-such-region"\)\./);
});

test('A11yCoreBuilder: a custom rule that did not run is reported in skippedCustomRules and warned about', async () => {
  await browser.url('data:text/html,<html><body><button>Ok</button></body></html>');

  let results;
  const warnings = await captureWarnings(async () => {
    results = await new A11yCoreBuilder({ browser })
      .options({ customRules: [{ id: 'broken-custom-rule', meta: { title: 'Broken' }, runInPage: 'not a function' }] })
      .analyze();
  });

  assert.strictEqual(results.skippedCustomRules.length, 1);
  assert.strictEqual(results.skippedCustomRules[0].id, 'broken-custom-rule');
  assert.ok(!results.checksResults.some((r) => r.ruleId === 'broken-custom-rule'));
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /Custom rule "broken-custom-rule" did not run: /);
});

test('A11yCoreBuilder: a clean scan prints no warning', async () => {
  await browser.url('data:text/html,<html><body><main><button>Ok</button></main></body></html>');

  const warnings = await captureWarnings(async () => {
    await new A11yCoreBuilder({ browser }).include('main').analyze();
  });

  assert.deepStrictEqual(warnings, []);
});

test('A11yCoreBuilder: logger() receives each scan gap with the result, instead of console.warn', async () => {
  await browser.url('data:text/html,<html><body><button>Ok</button></body></html>');

  const seen = [];
  let results;
  const warnings = await captureWarnings(async () => {
    results = await new A11yCoreBuilder({ browser })
      .include('.no-such-region')
      .options({ customRules: [{ id: 'broken-custom-rule', meta: { title: 'Broken' }, runInPage: 'not a function' }] })
      .logger((gap, frame) => seen.push([gap.kind, frame]))
      .analyze();
  });

  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(seen.map(([kind]) => kind), ['context-not-found', 'custom-rule-skipped']);
  assert.ok(seen.every(([, frame]) => frame.url === results.url && Array.isArray(frame.checksResults)));
});

test('A11yCoreBuilder: logger(() => {}) silences the scan-gap warnings, and logger(null) brings them back', async () => {
  await browser.url('data:text/html,<html><body><img src="x.png"></body></html>');

  const builder = new A11yCoreBuilder({ browser }).include('.no-such-region').logger(() => {});
  assert.deepStrictEqual(await captureWarnings(() => builder.analyze()), []);
  const warnings = await captureWarnings(() => builder.logger(null).analyze());
  assert.strictEqual(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /^@surea11y\/webdriverio .*Nothing was scanned/);
});

test('A11yCoreBuilder: frames(true) with include() scopes the top frame only and scans each sub-frame whole', async () => {
  // The scope exists only in the top document. Passing it down would leave
  // the frame unscanned since core 1.10.0 (a selector that matches nothing
  // scans nothing), so sub-frames get no contextSelector, as
  // runa11yCoreAcrossFrames does.
  await browser.url(
    'data:text/html,<html><body>' +
    '<main><img src="top.png"></main><img src="outside.png" alt="">' +
    '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cimg src=x.png%3E%3C/body%3E%3C/html%3E"></iframe>' +
    '</body></html>'
  );
  await waitForFrames(1);

  const warnings = await captureWarnings(async () => {
    const results = await new A11yCoreBuilder({ browser }).include('main').frames(true).analyze();

    assert.deepStrictEqual(results.topFrame.contextMatch, { elementCount: 1, unmatchedSelectors: [] });
    const topImg = results.topFrame.checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(topImg.outcome, 'fail');
    assert.strictEqual(topImg.occurrences.length, 1);

    assert.strictEqual(results.frames.length, 1);
    assert.strictEqual(results.frames[0].contextSelector, null);
    assert.strictEqual(results.frames[0].contextMatch, null);
    const frameImg = results.frames[0].checksResults.find((r) => r.ruleId === 'img-alt-present');
    assert.strictEqual(frameImg.outcome, 'fail');
  });
  assert.deepStrictEqual(warnings, []);
});

test('A11yCoreBuilder: elementRef(true) resolves an occurrence inside a shadow tree through its shadow hosts', async () => {
  // Both images sit at "p > img" in their own tree. core gives the shadow
  // one that selector, which holds only inside the shadow root:
  // browser.$('p > img') finds the light-DOM image instead.
  await browser.url(dataUrl(
    '<html><body><p><img src="light.png" alt="Fine"></p>' +
    '<div id="host"></div>' +
    '<script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = ' +
    '\'<p><img src="shadow.png"></p>\';</script>' +
    '</body></html>'
  ));

  const results = await new A11yCoreBuilder({ browser }).withRules(['img-alt-present']).elementRef(true).analyze();

  const rule = results.checksResults.find((r) => r.ruleId === 'img-alt-present');
  assert.strictEqual(rule.outcome, 'fail');
  assert.strictEqual(rule.occurrences.length, 1);
  const [occurrence] = rule.occurrences;
  assert.strictEqual(occurrence.selector, 'p > img');
  assert.deepStrictEqual(occurrence.shadowHostSelectors, ['#host']);
  assert.strictEqual(occurrence.structuralPath, null);
  assert.ok(occurrence.element, 'occurrence should carry a live WebdriverIO.Element');
  assert.strictEqual(await occurrence.element.getAttribute('src'), 'shadow.png');
});

// A pack (@surea11y/core/pack, plain object form): a rule, a 7:1 variant of
// contrast-minimum, and a checklist profile with one item.
const ACME_PACK = {
  name: '@acme/a11y-rules',
  version: '1.0.0',
  namespace: 'acme',
  core: '*',
  title: 'Acme policy',
  rules: [
    {
      id: 'acme-no-widget',
      meta: { title: 'No widget', tags: ['house-rules'] },
      runInPage(ctx) {
        const el = ctx.document.querySelector('.my-widget');
        return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'pass' };
      }
    }
  ],
  variants: [
    {
      id: 'acme-contrast-enhanced',
      from: 'contrast-minimum',
      config: { normalTextRatio: 7, largeTextRatio: 4.5 },
      meta: {
        title: 'Text contrast is at least 7:1',
        tags: ['house-rules'],
        i18n: { titleKey: 'acmeContrastEnhanced_title', descriptionKey: 'acmeContrastEnhanced_description' }
      }
    }
  ],
  dictionaries: {
    en: {
      acmeContrastEnhanced_title: 'Text contrast is at least 7:1',
      acmeContrastEnhanced_description: 'Checks text contrast at 7:1.'
    }
  },
  profiles: { 'acme-1': { tags: ['wcag2a', 'wcag2aa', 'house-rules'] } },
  rollups: [{ id: 'acme-text', title: 'Text', checksIds: ['contrast-minimum', 'acme-contrast-enhanced'] }]
};

test('A11yCoreBuilder: withPacks() runs a pack in the page, its profile and variant included', async () => {
  await browser.url(
    'data:text/html,<html lang="en"><head><title>t</title></head><body><main>' +
    '<div class="my-widget">W</div><p style="color:%23767676;background:%23fff">Grey</p></main></body></html>'
  );
  const result = await new A11yCoreBuilder({ browser })
    .withPacks(ACME_PACK)
    .options({ profile: 'acme-1' })
    .analyze();
  assert.deepStrictEqual(result.engine.packs, ['@acme/a11y-rules@1.0.0']);
  assert.strictEqual(result.engine.profile, 'acme-1');
  const outcome = (id) => result.checksResults.find((r) => r.ruleId === id).outcome;
  assert.strictEqual(outcome('acme-no-widget'), 'fail');
  // #767676 on white is 4.54:1: core's rule passes, the 7:1 variant fails.
  assert.strictEqual(outcome('contrast-minimum'), 'pass');
  assert.strictEqual(outcome('acme-contrast-enhanced'), 'fail');
  assert.strictEqual(result.rulesResults.find((r) => r.ruleId === 'acme-text').outcome, 'fail');
});

test('A11yCoreBuilder: withPacks() runs the pack in every frame when combined with frames(true)', async () => {
  await browser.url(
    'data:text/html,<html><body>' +
    '<div class="my-widget"></div>' +
    '<iframe srcdoc="%3Chtml%3E%3Cbody%3E%3Cdiv class=my-widget%3E%3C/div%3E%3C/body%3E%3C/html%3E"></iframe>' +
    '</body></html>'
  );
  await waitForFrames(1);
  const results = await new A11yCoreBuilder({ browser }).frames(true).withPacks(ACME_PACK).analyze();
  for (const r of [results.topFrame, results.frames[0]]) {
    assert.deepStrictEqual(r.engine.packs, ['@acme/a11y-rules@1.0.0']);
    assert.strictEqual(r.checksResults.find((c) => c.ruleId === 'acme-no-widget').outcome, 'fail');
  }
});

test('A11yCoreBuilder: withPacks() can scan the same page twice', async () => {
  await browser.url(dataUrl('<html lang="en"><head><title>t</title></head><body><div class="my-widget">W</div></body></html>'));
  for (let i = 0; i < 2; i++) {
    const result = await new A11yCoreBuilder({ browser }).withPacks(ACME_PACK).withRules('acme-no-widget').analyze();
    assert.deepStrictEqual(result.checksResults.map((r) => [r.ruleId, r.outcome]), [['acme-no-widget', 'fail']]);
  }
});

test('A11yCoreBuilder: a pack the page does not run is a pack-skipped gap, and analyze() warns about it', async () => {
  await browser.url(dataUrl('<html lang="en"><head><title>t</title></head><body><img src="a.png"></body></html>'));
  let result;
  const warnings = await captureWarnings(async () => {
    result = await new A11yCoreBuilder({ browser }).options({ packs: ['@acme/not-registered@1.0.0'] }).withRules('img-alt-present').analyze();
  });
  const gaps = getScanGaps(result);
  assert.deepStrictEqual(gaps.map((g) => [g.kind, g.pack.name]), [['pack-skipped', '@acme/not-registered@1.0.0']]);
  assert.ok(warnings.some((w) => w.includes('Pack "@acme/not-registered@1.0.0" did not run')), warnings.join('\n'));
});

test('A11yCoreBuilder: withWcag() runs a WCAG target, and withBestPractices() adds the best practices', async () => {
  await browser.url(dataUrl('<html lang="en"><head><title>t</title></head><body><img src="a.png"></body></html>'));
  const target = await new A11yCoreBuilder({ browser }).withWcag('2.2', 'AA').analyze();
  const ids = target.checksResults.map((r) => r.ruleId);
  assert.strictEqual(target.engine.wcagVersion, '2.2');
  assert.ok(ids.includes('img-alt-present'));
  assert.ok(!ids.includes('duplicate-id'), '4.1.1 is no part of a WCAG 2.2 target');
  assert.ok(!ids.includes('region'));
  const withBest = await new A11yCoreBuilder({ browser }).withWcag('2.2', 'AA').withBestPractices().analyze();
  assert.ok(withBest.checksResults.some((r) => r.ruleId === 'region'));
});

test('A11yCoreBuilder: strictOptions rejects a misspelt option with an EngineError carrying INVALID_ENGINE_OPTIONS', async () => {
  await browser.url(dataUrl('<html lang="en"><head><title>t</title></head><body></body></html>'));
  await assert.rejects(
    () => new A11yCoreBuilder({ browser }).options({ strictOptions: true, lcoale: 'fr' }).analyze(),
    (err) => err instanceof EngineError && err.code === 'INVALID_ENGINE_OPTIONS' && /lcoale/.test(err.message)
  );
});

test("A11yCoreBuilder: a frames(true) result goes to @surea11y/core's SARIF report with every frame's findings", async () => {
  const { renderSarifReport } = require('@surea11y/core/sarif');
  await browser.url(dataUrl(
    '<html lang="en"><head><title>t</title></head><body><img src="top.png">' +
    '<iframe title="Ad" srcdoc="<html lang=en><head><title>f</title></head><body><img src=ad.png></body></html>"></iframe></body></html>'
  ));
  await waitForFrames(1);
  const results = await new A11yCoreBuilder({ browser }).frames(true).withRules('img-alt-present').analyze();
  assert.strictEqual(results.frames.length, 1);
  const run = JSON.parse(renderSarifReport(results)).runs[0];
  const failures = run.results.filter((r) => r.ruleId === 'img-alt-present' && r.level === 'error');
  assert.strictEqual(failures.length, 2, JSON.stringify(failures.map((r) => r.locations)));
  const notices = (run.invocations || []).flatMap((i) => i.toolExecutionNotifications || []);
  assert.deepStrictEqual(notices.map((n) => n.message.text), [], 'no frame reported as not scanned');
});

// --- @surea11y/core 1.12 -------------------------------------------------------------

// Web components that keep their ElementInternals in a private field, where
// no script but the internals hook can read them: one names itself and sets
// its state, one is a switch only through its internals, with no name, and
// one is the same switch named through its internals.
const COMPONENTS_SCRIPT = `<script>
customElements.define('x-check', class extends HTMLElement {
  #i; constructor() { super(); this.#i = this.attachInternals(); this.#i.ariaLabel = 'Subscribe'; this.#i.ariaChecked = 'false'; }
});
customElements.define('x-toggle', class extends HTMLElement {
  #i; constructor() { super(); this.#i = this.attachInternals(); this.#i.role = 'switch'; }
});
customElements.define('x-named-toggle', class extends HTMLElement {
  #i; constructor() { super(); this.#i = this.attachInternals(); this.#i.role = 'switch'; this.#i.ariaLabel = 'Dark mode'; }
});
</script>`;

function componentPage(body) {
  return 'data:text/html,' + encodeURIComponent(
    `<!doctype html><html lang="en"><head><title>t</title>${COMPONENTS_SCRIPT}</head><body><main><h1>Hi</h1>${body}</main></body></html>`
  );
}

function srcdoc(html) {
  return html.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function outcomeOf(result, ruleId) {
  const check = result.checksResults.find((r) => r.ruleId === ruleId);
  return check ? check.outcome : undefined;
}

// The hook stays installed for the rest of a session, so these tests open
// sessions of their own rather than use the shared one.
async function ownSession({ bidi }) {
  const capabilities = { ...CAPS.capabilities };
  if (bidi) delete capabilities['wdio:enforceWebDriverClassic'];
  return remote({ ...CAPS, capabilities });
}

test('A11yCoreBuilder: wcagLevel() reaches the engine: a contrast check at AA reports 1.4.3 and no 1.4.6', async () => {
  await browser.url('data:text/html,<html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1><p>Text</p></main></body></html>');
  const results = await new A11yCoreBuilder({ browser }).withRules('contrast-computable').wcagLevel('aa').analyze();
  assert.strictEqual(results.engine.wcagLevel, 'AA');
  assert.deepStrictEqual(results.rulesResults.map((r) => r.ruleId), ['wcag-1.4.3-contrast-minimum']);
  assert.deepStrictEqual(results.checksResults.map((r) => r.ruleId), ['contrast-computable']);
});

test('A11yCoreBuilder: a scan under forced colors emulated through the DevTools protocol records engine.environment.forcedColors', async () => {
  await browser.url('data:text/html,<html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1></main></body></html>');
  try {
    await browser.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
    const results = await new A11yCoreBuilder({ browser }).withRules('contrast-minimum').analyze();
    assert.strictEqual(results.engine.environment.forcedColors, 'active');
  } finally {
    await browser.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  }
  const plain = await new A11yCoreBuilder({ browser }).withRules('contrast-minimum').analyze();
  assert.strictEqual(plain.engine.environment.forcedColors, 'none');
});

test('A11yCoreBuilder.installInternalsHook(): in a BiDi session, a component named through private internals passes, in every frame', async () => {
  const session = await ownSession({ bidi: true });
  try {
    assert.strictEqual(await A11yCoreBuilder.installInternalsHook(session), 'bidi');
    const inner = `<!doctype html><html lang="en"><head><title>f</title>${COMPONENTS_SCRIPT}</head><body><x-check role="checkbox"></x-check></body></html>`;
    await session.url(componentPage(`<x-check role="checkbox"></x-check><iframe title="Form" srcdoc="${srcdoc(inner)}"></iframe>`));
    await session.pause(800);
    const results = await new A11yCoreBuilder({ browser: session }).frames(true).analyze();
    assert.strictEqual(results.frames.length, 1);
    for (const frame of [results.topFrame, ...results.frames]) {
      assert.strictEqual(frame.engine.environment.internalsHook, 'early', frame.url);
      assert.strictEqual(outcomeOf(frame, 'binary-control-name-present'), 'pass', frame.url);
    }
    assert.strictEqual(outcomeOf(results.topFrame, 'aria-required-attr'), 'pass');
  } finally {
    await session.deleteSession();
  }
});

test('A11yCoreBuilder.installInternalsHook(): in a classic session, Chrome gets it through the DevTools protocol, and a switch set only through internals is checked as one', async () => {
  await browser.url(componentPage('<x-toggle></x-toggle>'));
  const before = await new A11yCoreBuilder({ browser }).withRules('binary-control-name-present').analyze();
  assert.strictEqual(outcomeOf(before, 'binary-control-name-present'), 'notApplicable', 'without the hook the role is not seen');
  assert.strictEqual(before.engine.environment.internalsHook, undefined);

  const session = await ownSession({ bidi: false });
  try {
    assert.strictEqual(await A11yCoreBuilder.installInternalsHook(session), 'cdp');
    await session.url(componentPage('<x-toggle></x-toggle>'));
    const unnamed = await new A11yCoreBuilder({ browser: session }).withRules('binary-control-name-present').analyze();
    assert.strictEqual(unnamed.engine.environment.internalsHook, 'early');
    assert.strictEqual(outcomeOf(unnamed, 'binary-control-name-present'), 'fail');

    await session.url(componentPage('<x-named-toggle></x-named-toggle><x-check role="checkbox"></x-check>'));
    const named = await new A11yCoreBuilder({ browser: session }).withRules('binary-control-name-present').analyze();
    assert.strictEqual(outcomeOf(named, 'binary-control-name-present'), 'pass');
  } finally {
    await session.deleteSession();
  }
});

test('A11yCoreBuilder.installInternalsHook() rejects a session with no before-load script', async () => {
  // A classic session on a browser with no DevTools protocol.
  const classic = { isBidi: false, execute() {} };
  await assert.rejects(() => A11yCoreBuilder.installInternalsHook(classic), /no way to run a script before the page loads/);
  for (const bad of [undefined, null, {}]) {
    await assert.rejects(() => A11yCoreBuilder.installInternalsHook(bad), TypeError);
  }
});

test('A11yCoreBuilder: without the hook, analyze() says once per scan that it would let the engine read those components', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (msg) => { warnings.push(String(msg)); });
  const inner = `<!doctype html><html lang="en"><head><title>f</title>${COMPONENTS_SCRIPT}</head><body><x-check role="checkbox"></x-check></body></html>`;
  await browser.url(componentPage(`<x-check role="checkbox"></x-check><iframe title="Form" srcdoc="${srcdoc(inner)}"></iframe>`));
  await waitForFrames(1, 500);
  await new A11yCoreBuilder({ browser }).frames(true).analyze();
  const notes = warnings.filter((w) => /custom element was asked about/.test(w));
  assert.strictEqual(notes.length, 1, JSON.stringify(warnings));
  assert.match(notes[0], /^@surea11y\/webdriverio \(data:text\/html,.*installInternalsHook\(\)/);
});

test('A11yCoreBuilder: plannedChecks() and plannedCriteria() list what analyze() then reports', async () => {
  await browser.url('data:text/html,<html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1><img src="a.png"></main></body></html>');
  const builder = new A11yCoreBuilder({ browser }).withWcag('2.2', 'AA');
  const results = await builder.analyze();
  const ids = (list, key) => list.map((e) => e[key]).sort();
  assert.deepStrictEqual(ids(builder.plannedChecks(), 'ruleId'), ids(results.checksResults, 'ruleId'));
  assert.deepStrictEqual(ids(builder.plannedCriteria(), 'id'), ids(results.rulesResults, 'ruleId'));
});

// --- @surea11y/core 1.14 -------------------------------------------------------------

// The listener hook needs @surea11y/core 1.14.0, and its note
// @surea11y/binding-base 1.6.0; these tests are skipped with older ones.
const HAS_LISTENER_HOOK = typeof require('@surea11y/core').listenerHookScript === 'function';
const HAS_LISTENER_NOTE = require('@surea11y/binding-base').getScanNotes({
  checksResults: [{ outcome: 'cantTell', occurrences: [{ selector: 'div', data: { details: { reasonCode: 'CLICK_HANDLER_NO_KEY_HANDLER' } } }] }]
}).some((n) => n.kind === 'listener-hook');
const NEEDS_HOOK = !HAS_LISTENER_HOOK && 'needs @surea11y/core 1.14.0';
const NEEDS_NOTE = !(HAS_LISTENER_HOOK && HAS_LISTENER_NOTE) && 'needs @surea11y/core 1.14.0 and @surea11y/binding-base 1.6.0';

// A custom button given its click listener from script, with no key listener
// anywhere: Enter and Space do nothing. Without the listener hook the scan
// can't see the listener; with it, the button fails.
const SCRIPTED_BUTTON = 'data:text/html,' + encodeURIComponent(
  '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1>' +
  '<div id="save" role="button" tabindex="0">Save</div>' +
  "<script>document.getElementById('save').addEventListener('click', () => {});</script>" +
  '</main></body></html>'
);

function listenerFinding(result) {
  const check = result.checksResults.find((r) => r.ruleId === 'click-handler-keyboard-operable');
  return [check.outcome, check.occurrences.map((o) => o.data.details.reasonCode)];
}

test('A11yCoreBuilder.installListenerHook(): a button given its click listener from script is unseen without it, and fails with it, through BiDi or the DevTools protocol', { skip: NEEDS_HOOK }, async () => {
  await browser.url(SCRIPTED_BUTTON);
  const before = await new A11yCoreBuilder({ browser }).withRules('click-handler-keyboard-operable').analyze();
  assert.strictEqual(outcomeOf(before, 'click-handler-keyboard-operable'), 'notApplicable');
  assert.strictEqual(before.engine.environment.listenerHook, undefined);

  for (const [bidi, how] of [[true, 'bidi'], [false, 'cdp']]) {
    const session = await ownSession({ bidi });
    try {
      assert.strictEqual(await A11yCoreBuilder.installListenerHook(session), how);
      assert.strictEqual(await A11yCoreBuilder.installInternalsHook(session), how);
      await session.url(SCRIPTED_BUTTON);
      const after = await new A11yCoreBuilder({ browser: session }).withRules('click-handler-keyboard-operable').analyze();
      assert.strictEqual(after.engine.environment.listenerHook, 'early', how);
      assert.strictEqual(after.engine.environment.internalsHook, 'early', how);
      assert.deepStrictEqual(listenerFinding(after), ['fail', ['CLICK_HANDLER_NO_KEY_LISTENER']], how);
    } finally {
      await session.deleteSession();
    }
  }
});

test('A11yCoreBuilder.installListenerHook() rejects a session with no before-load script, and anything but a browser', async () => {
  const classic = { isBidi: false, execute() {} };
  // With a core too old to have the hook, that is what the call says first.
  await assert.rejects(
    () => A11yCoreBuilder.installListenerHook(classic),
    HAS_LISTENER_HOOK
      ? /installListenerHook\(\): this session has no way to run a script before the page loads/
      : /needs @surea11y\/core 1\.14\.0 or later/
  );
  for (const bad of [undefined, null, {}]) {
    await assert.rejects(() => A11yCoreBuilder.installListenerHook(bad), TypeError);
  }
});

test('A11yCoreBuilder: without the listener hook, analyze() says once per scan that it would let the engine judge those handlers', { skip: NEEDS_NOTE }, async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (msg) => { warnings.push(String(msg)); });
  await browser.url('data:text/html,' + encodeURIComponent(
    '<!doctype html><html lang="en"><head><title>t</title></head><body><main><h1>Hi</h1>' +
    '<div role="button" tabindex="0" onclick="void save()">Save</div></main></body></html>'
  ));
  await new A11yCoreBuilder({ browser }).withRules('click-handler-keyboard-operable').analyze();
  const notes = warnings.filter((w) => /element was asked about because the scan could not see/.test(w));
  assert.strictEqual(notes.length, 1, JSON.stringify(warnings));
  assert.match(notes[0], /installListenerHook\(\)/);
});
