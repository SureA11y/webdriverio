'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { remote } = require('webdriverio');
const { A11yCoreBuilder, formatFailures } = require('../src/index.js');

test('formatFailures(): returns a fixed message when there are no violations', () => {
  assert.strictEqual(formatFailures([]), 'No accessibility violations found.');
  assert.strictEqual(
    formatFailures([{ ruleId: 'img-alt-present', outcome: 'pass', occurrences: [] }]),
    'No accessibility violations found.'
  );
});

test('formatFailures(): formats one line block per occurrence, numbered, with rule/severity/selector/hint', () => {
  const checksResults = [
    {
      ruleId: 'img-alt-present',
      outcome: 'fail',
      severity: 'serious',
      occurrences: [
        { selector: 'html > body > img', summary: 'Missing alt attribute on <img>.', hint: 'Add an alt attribute.' }
      ]
    }
  ];

  assert.strictEqual(
    formatFailures(checksResults),
    '1) img-alt-present (serious): Missing alt attribute on <img>.\n' +
    '   at html > body > img\n' +
    '   Add an alt attribute.'
  );
});

test('formatFailures(): numbers occurrences across multiple rules and multiple occurrences of the same rule', () => {
  const checksResults = [
    {
      ruleId: 'img-alt-present',
      outcome: 'fail',
      severity: 'serious',
      occurrences: [
        { selector: '#a img', summary: 'Missing alt.', hint: 'Add alt.' },
        { selector: '#b img', summary: 'Missing alt.', hint: 'Add alt.' }
      ]
    },
    {
      ruleId: 'button-name-present',
      outcome: 'fail',
      severity: 'serious',
      occurrences: [{ selector: 'html > body > button', summary: 'No accessible name.', hint: 'Add a label.' }]
    }
  ];

  const output = formatFailures(checksResults);
  assert.ok(output.startsWith('1) img-alt-present'));
  assert.ok(output.includes('2) img-alt-present'));
  assert.ok(output.includes('3) button-name-present'));
});

test('formatFailures(): ignores pass/notApplicable entries and respects a custom outcomes filter', () => {
  const checksResults = [
    { ruleId: 'a', outcome: 'pass', occurrences: [] },
    { ruleId: 'b', outcome: 'notApplicable', occurrences: [] },
    {
      ruleId: 'c',
      outcome: 'cantTell',
      severity: 'moderate',
      occurrences: [{ selector: 'html > body', summary: 'Needs human review.', hint: 'Check manually.' }]
    }
  ];

  // Default outcomes (['fail', 'cantTell']) picks up the cantTell entry.
  assert.ok(formatFailures(checksResults).includes('c'));

  // Narrowing to just 'fail' drops it, since there's no fail entry here.
  assert.strictEqual(formatFailures(checksResults, { outcomes: ['fail'] }), 'No accessibility violations found.');
});

test('formatFailures(): surfaces a thrown rule (occurrences: [], error set) instead of silently dropping it', () => {
  const checksResults = [
    {
      ruleId: 'broken-rule',
      outcome: 'cantTell',
      severity: 'serious',
      title: 'A rule that threw',
      occurrences: [],
      error: 'TypeError: something exploded'
    }
  ];

  const output = formatFailures(checksResults);
  assert.strictEqual(output, '1) broken-rule (serious): TypeError: something exploded');
});

test('formatFailures(): works end-to-end against a real scan\'s checksResults', async () => {
  const browser = await remote({
    logLevel: 'error',
    capabilities: {
      browserName: 'chrome',
      'wdio:enforceWebDriverClassic': true, // classic WebDriver protocol is steadier than v9's default BiDi here
      'goog:chromeOptions': { args: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] }
    }
  });
  try {
    await browser.url('data:text/html,<html><body><img src="x.png"><button></button></body></html>');

    const results = await new A11yCoreBuilder({ browser }).reportOnly(['fail']).analyze();
    const output = formatFailures(results.checksResults);

    assert.ok(output.includes('img-alt-present'));
    assert.ok(output.includes('button-name-present'));
    assert.ok(output.includes('html > body > img'));
  } finally {
    await browser.deleteSession();
  }
});

test('formatFailures(): given a whole result, adds its scan gaps and the core release; a frames(true) tree is formatted per frame', async () => {
  const browser = await remote({
    logLevel: 'error',
    capabilities: {
      browserName: 'chrome',
      'wdio:enforceWebDriverClassic': true,
      'goog:chromeOptions': { args: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] }
    }
  });
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await browser.url(
      'data:text/html,<html><body><main><img src="x.png"></main>' +
      '<iframe srcdoc="%3Cbutton%3E%3C/button%3E"></iframe></body></html>'
    );
    await browser.waitUntil(async () => (await browser.$$('iframe')).length === 1, { timeout: 8000 });

    const results = await new A11yCoreBuilder({ browser })
      .include('main')
      .include('.sidebar')
      .frames(true)
      .analyze();

    // The tree itself is not one result.
    assert.throws(() => formatFailures(results), TypeError);

    const top = formatFailures(results.topFrame, { outcomes: ['fail'] });
    const version = require('@surea11y/core/package.json').version;
    assert.match(top, /img-alt-present \(serious\)/);
    assert.match(top, /Part of the scan scope was not scanned: no element matched "\.sidebar"\./);
    assert.ok(top.endsWith(`Scanned with @surea11y/core ${version}.`), top);

    const frame = formatFailures(results.frames[0], { outcomes: ['fail'] });
    assert.match(frame, /button-name-present/);
    assert.doesNotMatch(frame, /scan scope/);
  } finally {
    console.warn = originalWarn;
    await browser.deleteSession();
  }
});

test('index re-exports the scan-gap, location and engine-error helpers from @surea11y/binding-base', () => {
  const index = require('../src/index.js');
  const base = require('@surea11y/binding-base');
  for (const name of ['getScanGaps', 'formatOccurrenceLocation', 'EngineError', 'ENGINE_ERROR_CODES']) {
    assert.strictEqual(index[name], base[name], name);
  }
  assert.strictEqual(
    index.formatOccurrenceLocation({ selector: 'p > img', shadowHostSelectors: ['my-gallery'] }),
    'my-gallery >>> p > img'
  );
});
