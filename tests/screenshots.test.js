'use strict';

// .screenshots() in a real headless Chrome. WebdriverIO reaches a frame by
// switching into it, and takes a screenshot of the whole viewport, which
// binding-base cuts down; each picture is checked by its pixels: the
// element's own colour where the element is. The page and its cross-origin
// frame are served from two local ports, so nothing here depends on the
// network. One session for the file, on the classic protocol as in
// builder.test.js, and one test on WebDriver BiDi, WebdriverIO's default.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { remote } = require('webdriverio');
const { decodePng } = require('@surea11y/binding-base/src/png.js');
const { A11yCoreBuilder, formatFailures } = require('../src/index.js');

const CHROME_ARGS = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=900,800', '--force-device-scale-factor=2'];
const CAPS = {
  logLevel: 'error',
  capabilities: {
    browserName: 'chrome',
    'wdio:enforceWebDriverClassic': true,
    'goog:chromeOptions': { args: CHROME_ARGS }
  }
};

// A transparent image, so each <img> shows its own background colour.
const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const PAGE = (child) => `<!doctype html><html lang="en"><head><title>Shots</title><style>
  body { margin: 0; font: 16px sans-serif }
  header { position: sticky; top: 0; background: #036; color: #fff; padding: 20px; z-index: 5 }
  #scroller { height: 120px; overflow: auto; border: 1px solid }
</style></head><body>
<header>Header</header>
<main>
  <h1>Shots</h1>
  <img id="top" src="${GIF}" width="80" height="40" style="background:rgb(255,165,0)">
  <p style="height:1200px">spacer</p>
  <div id="scroller"><p style="height:400px">inner</p><img id="inner" src="${GIF}" width="50" height="30" style="background:rgb(0,128,0)"></div>
  <x-card></x-card>
  <img id="hidden" src="${GIF}" style="display:none">
  <div style="position:absolute;left:-9999px"><img id="away" src="${GIF}" width="10" height="10"></div>
  <iframe id="child" title="Child" src="${child}" width="400" height="300" style="border:10px solid #ccc;padding:5px"></iframe>
  <p style="height:800px">after</p>
</main>
<script>
  customElements.define('x-card', class extends HTMLElement {
    constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<img src="${GIF}" width="60" height="60" style="background:rgb(128,0,128)">'; }
  });
</script>
</body></html>`;

const CHILD = `<!doctype html><html lang="en"><head><title>Child</title></head><body style="margin:0">
<main><h1>Child</h1><p style="height:500px">child spacer</p>
<img id="framed" src="${GIF}" width="70" height="35" style="background:rgb(0,128,128)"></main>
</body></html>`;

// The colour each flagged image is, by where core says it is.
const COLOURS = {
  '#top': [255, 165, 0],
  '#inner': [0, 128, 0],
  'html > body > main > x-card >>> img:not(* > *)': [128, 0, 128],
  '#framed': [0, 128, 128]
};

// Core reports no finding on what CSS hides, so a rule of the test's own
// flags #hidden, to be pictured as not-rendered.
const FLAGS_HIDDEN = {
  id: 'test-flags-hidden',
  meta: { title: 'Flags #hidden', tags: ['test'] },
  runInPage(ctx) {
    const el = ctx.document.getElementById('hidden');
    return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
  }
};

function serve(body) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(body());
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let browser;
let pageUrl;
let servers = [];

test.before(async () => {
  // The page on localhost, its frame on 127.0.0.1: two origins.
  const child = await serve(() => CHILD);
  const page = await serve(() => PAGE(`http://127.0.0.1:${child.address().port}/`));
  servers = [child, page];
  pageUrl = `http://localhost:${page.address().port}/`;
  browser = await remote(CAPS);
});
test.after(async () => {
  if (browser) await browser.deleteSession();
  for (const s of servers) s.close();
});

async function openPage(b = browser) {
  await b.url(pageUrl);
  await b.waitUntil(async () => (await b.$$('iframe')).length >= 1, { timeout: 8000, interval: 50 });
  await b.waitUntil(
    async () => {
      try {
        await b.switchFrame((await b.$$('iframe'))[0]);
        const ready = await b.execute(() => !!document.getElementById('framed'));
        await b.switchFrame(null);
        return ready;
      } catch (e) {
        await b.switchFrame(null).catch(() => {});
        return false;
      }
    },
    { timeout: 8000, interval: 100 }
  );
  await b.execute(() => { window.scrollTo(0, 37); document.getElementById('scroller').scrollTop = 11; });
}

function where(occurrence) {
  return (occurrence.shadowHostSelectors || []).concat(occurrence.selector).join(' >>> ');
}

// The colour at the middle of the element in its picture.
function assertColour(shot, scale, want, label) {
  assert.ok(shot && shot.buffer, `${label}: ${JSON.stringify(shot)}`);
  const png = decodePng(shot.buffer);
  const x = Math.floor((shot.box.x + shot.box.width / 2) * scale);
  const y = Math.floor((shot.box.y + shot.box.height / 2) * scale);
  const got = Array.from(png.rows.subarray(y * png.stride + x * png.bpp, y * png.stride + x * png.bpp + 3));
  assert.ok(want.every((v, i) => Math.abs(v - got[i]) <= 3), `${label}: ${got} at the element, wanted ${want}`);
}

// What the page looks like from outside: scroll positions and markup. The
// attribute chromedriver puts on an <iframe> it switches into is the
// driver's own, and changes with each switch.
async function pageState(b = browser) {
  const [x, y, inner, html] = await b.execute(() => [window.scrollX, window.scrollY, document.getElementById('scroller').scrollTop, document.documentElement.outerHTML]);
  return [x, y, inner, html.replace(/ cd_frame_id_="[^"]*"/g, '')];
}

async function checkFullScan(b) {
  await openPage(b);
  const before = await pageState(b);

  const results = await new A11yCoreBuilder({ browser: b })
    .withCustomRules(FLAGS_HIDDEN)
    .withRules(['img-alt-present', 'test-flags-hidden'])
    .screenshots({ padding: 8 })
    .frames(true)
    .analyze();

  const top = results.topFrame.checksResults.find((c) => c.ruleId === 'img-alt-present');
  const found = new Map(top.occurrences.map((o) => [where(o), o]));
  const get = (name) => found.get(name) || assert.fail(`${name} is not among the findings: ${[...found.keys()].join(', ')}`);
  for (const name of ['#top', '#inner', 'html > body > main > x-card >>> img:not(* > *)']) assertColour(get(name).screenshot, 2, COLOURS[name], name);
  assert.deepStrictEqual(get('#away').screenshot, { skipped: 'off-screen' });
  const hidden = results.topFrame.checksResults.find((c) => c.ruleId === 'test-flags-hidden').occurrences[0];
  assert.deepStrictEqual(hidden.screenshot, { skipped: 'not-rendered' });

  // The image in the cross-origin frame, placed on the top-level page.
  assert.strictEqual(results.frames.length, 1);
  assert.ok(!results.frames[0].error, results.frames[0].error);
  const framed = results.frames[0].checksResults.find((c) => c.ruleId === 'img-alt-present').occurrences[0];
  assertColour(framed.screenshot, 2, COLOURS['#framed'], '#framed');

  // The browser is back at the top-level page, which is as it was.
  assert.strictEqual(await b.execute(() => window === window.top), true);
  assert.deepStrictEqual(await pageState(b), before);
  assert.deepStrictEqual(await b.execute(() => Object.getOwnPropertySymbols(window).map(String)), []);
}

test('screenshots(): pictures each flagged element in its own colour, frames included, says why for the rest, and leaves the page as it was', async () => {
  await checkFullScan(browser);
});

test('screenshots(): without frames(true), the top-level page is pictured; from inside a frame, each occurrence says why it has none', async () => {
  await openPage();
  const results = await new A11yCoreBuilder({ browser }).withRules('img-alt-present').screenshots().analyze();
  const top = results.checksResults[0].occurrences.find((o) => o.selector === '#top');
  assertColour(top.screenshot, 2, COLOURS['#top'], '#top');

  await browser.switchFrame((await browser.$$('iframe'))[0]);
  try {
    const inFrame = await new A11yCoreBuilder({ browser }).withRules('img-alt-present').screenshots().analyze();
    const [occurrence] = inFrame.checksResults[0].occurrences;
    assert.strictEqual(occurrence.screenshot.skipped, 'capture-failed');
    assert.match(occurrence.screenshot.error, /switched into a frame/);
    // The scan itself is as before, and the browser stays in the frame.
    assert.strictEqual(occurrence.selector, '#framed');
    assert.strictEqual(await browser.execute(() => window === window.top), false);
  } finally {
    await browser.switchFrame(null);
  }
});

test('screenshots({ dir }): one file per element, named after it, which formatFailures() points to; reportOnly() and elementRef() still apply', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'surea11y-wdio-shots-'));
  try {
    await openPage();
    const run = () => new A11yCoreBuilder({ browser })
      .withRules(['img-alt-present', 'image-alt-not-filename'])
      .screenshots({ dir })
      .reportOnly(['fail'])
      .elementRef(true)
      .analyze();
    const results = await run();

    const occurrence = results.checksResults[0].occurrences.find((o) => o.selector === '#top');
    assert.ok(occurrence.element, 'elementRef() still attaches its element');
    assert.strictEqual(await occurrence.element.getProperty('id'), 'top');
    assert.match(occurrence.screenshot.path, /element-[0-9a-f]{8}\.png$/);
    assert.strictEqual(path.dirname(occurrence.screenshot.path), dir);
    assert.ok(decodePng(fs.readFileSync(occurrence.screenshot.path)));
    assert.ok(formatFailures(results).includes(`   screenshot: ${occurrence.screenshot.path}`));
    const files = fs.readdirSync(dir).sort();

    // The same elements get the same files on the next run.
    const again = await run();
    assert.strictEqual(again.checksResults[0].occurrences.find((o) => o.selector === '#top').screenshot.path, occurrence.screenshot.path);
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), files);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('screenshots(): max caps the pictures a scan takes, frames included', async () => {
  await openPage();
  const results = await new A11yCoreBuilder({ browser }).withRules('img-alt-present').screenshots({ max: 2 }).frames(true).analyze();
  const shots = [results.topFrame, ...results.frames]
    .flatMap((r) => r.checksResults[0].occurrences)
    .map((o) => o.screenshot);
  assert.strictEqual(shots.filter((s) => s.buffer).length, 2);
  assert.ok(shots.some((s) => s.skipped === 'max-reached'));
});

test('screenshots(): off unless asked; with selectors turned off, analyze() rejects before scanning', async () => {
  await openPage();
  const plain = await new A11yCoreBuilder({ browser }).withRules('img-alt-present').analyze();
  assert.ok(!('screenshot' in plain.checksResults[0].occurrences[0]));

  await assert.rejects(
    new A11yCoreBuilder({ browser }).options({ output: { includeSelector: false } }).screenshots().analyze(),
    (e) => e instanceof TypeError && e.code === 'INVALID_ENGINE_OPTIONS'
  );
  assert.throws(() => new A11yCoreBuilder({ browser }).screenshots({ padding: -1 }), (e) => e.code === 'INVALID_ENGINE_OPTIONS');
});

test('screenshots(): the same over WebDriver BiDi, WebdriverIO\'s default protocol', async () => {
  const bidi = await remote({
    logLevel: 'error',
    capabilities: { browserName: 'chrome', 'goog:chromeOptions': { args: CHROME_ARGS } }
  });
  try {
    await checkFullScan(bidi);
  } finally {
    await bidi.deleteSession();
  }
});
