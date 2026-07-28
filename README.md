# surea11y-webdriverio

A WebdriverIO binding for [`surea11y`](../surea11y) — scans a real, already-rendered page for accessibility issues using surea11y's DOM-rules engine.

This is a **separate project/package** from `surea11y` itself and from its siblings [`surea11y-playwright`](../surea11y-playwright) and [`surea11y-puppeteer`](../surea11y-puppeteer), kept as its own sibling directory rather than a monorepo subfolder — see `ROADMAP.md` §1 for the reasoning (the same reasoning the two sibling bindings already used).

## Install (local development)

`surea11y` isn't published to npm yet, so this package depends on it via a relative `file:` path (see `package.json`):

```json
"dependencies": { "surea11y": "file:../core" }
```

That means this project must stay a sibling of `surea11y` (or you update the path) for `npm install` to resolve it.

```bash
npm install
npm test
```

`webdriverio` is a `devDependency` here. WebdriverIO v9 auto-manages a local `chromedriver` for you the first time it launches Chrome (no separate Selenium server, and no `npx playwright install`-style step needed for `npm test` to work) — so a fresh clone's `npm install && npm test` launches a real headless Chrome on its own.

## Usage

```js
const { remote } = require('webdriverio');
const { A11yCoreBuilder } = require('surea11y-webdriverio');

const browser = await remote({
  capabilities: {
    browserName: 'chrome',
    'wdio:enforceWebDriverClassic': true,               // recommended -- see below
    'goog:chromeOptions': { args: ['--headless=new'] }
  }
});
await browser.url('https://example.com/');

const results = await new A11yCoreBuilder({ browser })
  .include('#main')            // optional -- call multiple times for multi-region scans
  .exclude('.cookie-banner')    // optional
  .withTags(['wcag2a', 'wcag2aa'])
  .disableRules(['meta-refresh-no-exceptions'])
  .options({ contrast: { mode: 'auditorAssist' } })
  .analyze();

console.log(results.checksResults.filter(r => r.outcome === 'fail'));
await browser.deleteSession();
```

The builder takes `{ browser }` — the object WebdriverIO's `remote()` returns (standalone mode), or the global `browser` the WDIO testrunner injects (see the E2E section). It must already be navigated to and settled at the URL to scan; the class does not navigate for you.

`results` is surea11y's own native result shape — see [`../surea11y/docs/OUTPUT_SCHEMA.md`](../surea11y/docs/OUTPUT_SCHEMA.md) — not the `violations`/`passes`/`incomplete`/`inapplicable` shape used by other popular accessibility testing tools. The builder's *method names* are modeled on common conventions in this space for migration familiarity; the richer result schema is kept as-is.

Also see `examples/basic-scan.js` for a runnable script (`npm run example -- <url>`).

### A note on the protocol: prefer classic WebDriver for this workload

WebdriverIO v9 defaults to the WebDriver **BiDi** protocol. A long-lived session that issues many `browser.execute()` calls — exactly what an accessibility scan does — degraded badly over BiDi in testing here: per-scan latency climbed from ~2s into the *minutes* and eventually the session started dropping commands (`Couldn't resolve command with id N`). Forcing the **classic** WebDriver protocol with `'wdio:enforceWebDriverClassic': true` in the capabilities gave a steady ~150ms per scan with no degradation, and every operation this binding needs (`execute`, `$`, `$$`, `switchFrame`) is fully supported on it. This project's own tests and examples all set that flag, and it's recommended for yours. The binding itself works under either protocol (it never depends on a BiDi-only feature) — see `ROADMAP.md` §2c/§4 for the full write-up.

### Composing the rule filters

`withTags()`/`disableRules()` above have counterparts: `.withRules([...])` (only run these specific rule IDs) and `.disableTags([...])` (never run rules carrying any of these tags). All four compose the same way similar allow/deny-list options do in other accessibility testing tools, with one non-obvious rule worth knowing: a "disable" always wins over a "with" on the same ID/tag (e.g. `.withRules(['a']).disableRules(['a'])` drops `'a'` entirely), and combining `.withRules()` **and** `.withTags()` together requires a rule to satisfy *both* (surea11y's default `includeMode: 'and'` — see `../surea11y/docs/ENGINE_OPTIONS.md`), not either one.

`.exclude(selector)` above excludes globally. Pass a second argument to scope it to specific rule IDs instead: `.exclude('.mat-select', { rules: ['aria-required-children'] })` skips `.mat-select` for that rule only — every other rule still sees it. Global and rule-scoped `.exclude()` calls compose freely.

**Create one builder per scan.** `A11yCoreBuilder` is a mutable object with no reset between `.analyze()` calls — `include()`/`exclude()`/`withRules()`/`disableRules()`/`withTags()`/`disableTags()`/`options()`/`withCustomRules()` all push onto or merge into internal state that persists for the instance's lifetime. Calling one of them again before a second `.analyze()` call *accumulates* on top of the first scan's scope rather than replacing it (this is exactly what makes "call `.include()` several times for one scan," above, work — the same accumulation just also applies across separate scans if you reuse an instance). `.reportOnly()`/`.frames()`/`.elementRef()` are the exception: each call replaces the previous value instead of merging with it.

This binding works against any browser WebdriverIO can drive; the tests and examples use headless Chrome via `chromedriver`, which WebdriverIO manages automatically.

### Using it as an E2E accessibility gate

The pattern above works unchanged inside a real WebdriverIO testrunner spec, which is the pattern that actually matters for a CI/E2E suite (not just an ad hoc script). Inside the testrunner, `browser` is a global you don't construct yourself:

```js
const assert = require('node:assert');
const { A11yCoreBuilder, formatFailures } = require('surea11y-webdriverio');

describe('accessibility gate', () => {
  it('has no accessibility violations', async () => {
    await browser.url('https://example.com/');

    const results = await new A11yCoreBuilder({ browser }).reportOnly(['fail']).analyze();

    assert.strictEqual(results.checksResults.length, 0, formatFailures(results.checksResults));
  });
});
```

See `examples/e2e-test-example.test.js` for a fuller, runnable version (`npm run example:e2e`), driven by `examples/wdio.conf.js` — one test proving real violations get caught (unlabeled button, missing `alt`), one proving a well-formed page passes cleanly. It uses the **WebdriverIO testrunner** (`@wdio/cli` + mocha), which is how real WebdriverIO suites are written — unlike the sibling Puppeteer project, which used `node:test` because Puppeteer ships no first-party runner (`ROADMAP.md` §6 has the full reasoning). This project's own *unit* suite (`tests/*.test.js`) still uses `node:test` + `remote()`, the right tool for exercising the builder API in isolation.

Note the gate above uses `node:assert`, not WebdriverIO's bundled `expect`: WebdriverIO's `expect` takes **at most one argument** — there's no `expect(value, message)` custom-failure-message overload the way Playwright's `expect` has — so `node:assert`'s message parameter is what carries `formatFailures()`' readable block onto a failed assertion.

### Readable console/CI output on failure

A bare length/equality assertion alone gets you a *working* gate, but the failure message is a raw, deeply-nested object diff — hundreds of lines for a handful of violations. `formatFailures(checksResults)` turns that into a short, scannable block (one entry per occurrence, numbered, with rule ID/severity/selector/hint) that you hand to your assertion library's own failure-message parameter, as above. A real failure then prints:

```
1) button-name-present (serious): This button has no accessible name.
   at html > body > button
   Provide visible button text or a programmatic accessible-name mechanism (for example aria-label) so assistive technologies can identify the button.
2) img-alt-present (serious): Missing alt attribute on <img>.
   at html > body > img
   Add an alt attribute (use alt="" only for decorative images).
```

Deliberately a plain function, not a custom matcher — no dependency on any particular assertion library, so it works the same with `node:assert`, WebdriverIO's `expect`, Jest, Vitest, or a hand-rolled `if`/`throw`. Defaults to `fail`/`cantTell` outcomes (the only two that ever carry occurrences); pass `{ outcomes: [...] }` to narrow further. A thrown rule (`occurrences: []`, `error` set — see `../surea11y/docs/OUTPUT_SCHEMA.md`) is still surfaced using its `error` message rather than silently dropped.

### Scanning every frame, including cross-origin and nested iframes

```js
const results = await new A11yCoreBuilder({ browser }).frames(true).analyze();

console.log(results.topFrame.checksResults.filter(r => r.outcome === 'fail'));   // the top-level page
for (const frame of results.frames) {
  console.log(frame.checksResults.filter(r => r.outcome === 'fail'));            // each sub-frame, same result shape
}
```

`results.frames` is a **flat array**, one entry per sub-frame at any depth (nested iframes-within-iframes included), matching the shape the Puppeteer/Playwright bindings return.

The mechanics here are genuinely different from those bindings, though, because WebdriverIO's frame model is different. Puppeteer/Playwright expose `page.frames()` — an array of independent `Frame` objects, each with its own `.evaluate()`/`.$()` — so a binding can iterate them freely. WebdriverIO instead has a single **stateful current context**: `browser.switchFrame(iframeElement)` changes which document `browser.execute()`/`browser.$()` run against, and `browser.switchFrame(null)` returns to the top-level frame. There is no array of frame objects. So `.frames(true)` enumerates each context's direct-child `<iframe>` elements with `browser.$$('iframe')`, switches into each, scans the now-current document, and recurses into that frame's own children (re-navigating from the top each time, since element references and BiDi context ids don't reliably survive a context switch). Cross-origin iframes are reached with no extra work — WebdriverIO's automation layer switches into them the same as same-origin ones, exactly like Puppeteer/Playwright's CDP does.

Verified against a real cross-origin page (`https://example.org/` embedded in an unrelated origin) and against a real nested-iframe page (top → child → grandchild) — see `ROADMAP.md` §2c and `tests/builder.test.js`. Default off, so plain `.analyze()` is unaffected unless you opt in. Unlike script-injection-based accessibility tools (which need a `postMessage`-based protocol to reach cross-origin iframes, since they're injected as a plain `<script>` subject to the same-origin policy), this needs no `surea11y` engine support at all.

### Trimming the result to just violations

By default `analyze()` returns every rule's outcome, including `pass`/`notApplicable` — surea11y's own deliberate "not a violations-only list" design (see `../surea11y/docs/OUTPUT_SCHEMA.md`). Use `.reportOnly()` to post-filter down to only the outcomes you care about:

```js
const results = await new A11yCoreBuilder({ browser })
  .reportOnly(['fail', 'cantTell'])
  .analyze();

console.log(results.checksResults); // only fail/cantTell entries, pass/notApplicable dropped
```

Valid outcome values are `'pass'`, `'fail'`, `'cantTell'`, `'notApplicable'`. This is pure binding-layer filtering — surea11y itself still computes every rule; nothing about the scan itself changes. Combines with `.frames(true)`: the filter is applied to `results.topFrame` and each entry of `results.frames` independently.

### Getting a live element, not just a selector string

By default each occurrence carries a CSS selector + HTML snippet, not a live reference to the element. Opt in to a real `WebdriverIO.Element` with `.elementRef(true)`:

```js
const results = await new A11yCoreBuilder({ browser }).elementRef(true).analyze();

const [failing] = results.checksResults.filter(r => r.outcome === 'fail');
await failing.occurrences[0].element.saveScreenshot('./flagged.png');
await failing.occurrences[0].element.click();
```

This resolves `occurrence.selector` to a `WebdriverIO.Element` (via `browser.$()`) and attaches it as **`occurrence.element`** — instead of leaving you to re-resolve a possibly-stale selector string yourself. Default off — resolving an element per occurrence is a real page query per occurrence, so it costs more than a plain `.analyze()`.

Two WebdriverIO-specific differences from the sibling bindings' `.elementRef(true)`, both real and worth knowing:

- **The field is `occurrence.element`, not `occurrence.elementHandle`.** WebdriverIO has no "handle" concept — `browser.$()` returns a `WebdriverIO.Element`. Its API differs too: read a property with `.getProperty('id')` (not Puppeteer's `.evaluate(el => el.id)`), screenshot with `.saveScreenshot(path)` (not `.screenshot({ path })`). See the [WebdriverIO element API](https://webdriver.io/docs/api/element).
- **A sub-frame element is only usable while switched into its frame.** WebdriverIO element references are bound to whichever frame was the current context when they were resolved. When you combine `.frames(true).elementRef(true)`, a *sub-frame* occurrence's `element` is resolved against that frame's own document (correct), but after `analyze()` returns the browser is back at the top-level frame — so to act on a sub-frame element you must `browser.switchFrame()` back into its frame first (`browser.switchFrame((await browser.$$('iframe'))[i])`). Top-frame occurrences have no such caveat. This is a direct consequence of WebdriverIO's stateful context model and has no analogue in Puppeteer/Playwright, whose handles are bound to an execution context, not a mutable "current frame." See `ROADMAP.md` §2d.

Not every occurrence has one target element — a page-wide finding (some `manual`/`cantTell` rules) can carry `selector: ""`, in which case `occurrence.element` is `null` rather than an element. (WebdriverIO's `browser.$('')` actually *throws* `invalid selector: No selector specified`, unlike Puppeteer/Playwright's `.$('')` which resolves to `null` — so the empty-selector guard that produces this `null` matters even more here; verified with a real run.)

### Registering a custom rule at runtime

`surea11y` supports registering additional rules per-scan via `engineOptions.customRules`. Use `.withCustomRules()` to register one:

```js
const results = await new A11yCoreBuilder({ browser })
  .withCustomRules({
    id: 'my-org-custom-rule',
    meta: { title: 'My custom rule', tags: ['custom'], defaultSeverity: 'serious' },
    // A real, live function is fine here -- .withCustomRules() converts it
    // to a function-source string for you (see below for why that matters).
    runInPage(ctx) {
      const el = ctx.document.querySelector('.my-widget');
      return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
    }
  })
  .analyze();
```

A custom rule descriptor is the same shape as one of surea11y's own internal rule modules (`{ id, meta, runInPage, applicability?, data? }`) — see `../surea11y/docs/ENGINE_OPTIONS.md` for the full contract. Results appear in `checksResults` exactly like a built-in rule's, including automatic `selector`/`html`/`structuralPath` fill-in. Registered per-scan only (nothing persists between calls or shows up in any catalog listing), and a custom rule whose `id` collides with a built-in one overrides it for that scan.

Pass an array to register several at once, or call `.withCustomRules()` again to add more — like `.withRules()`/`.withTags()`, it accumulates rather than replacing what was already registered:

```js
const results = await new A11yCoreBuilder({ browser })
  .withCustomRules([firstRule, secondRule])
  .withCustomRules(thirdRule) // adds a third, doesn't replace the first two
  .analyze();
```

**Why `.withCustomRules()` instead of the raw `.options({ customRules })` passthrough** (still supported, and composes with this method if you use both): `runInPage`/`applicability` must reach the page as a function-source *string*, not a live `Function` — a WebdriverIO `browser.execute()` argument crosses a serialization boundary that can't carry a live function reference, only a string surea11y can reconstruct with `new Function` on the page side. Passing a raw live function via `.options()` directly would silently fail to serialize; `.withCustomRules()` calls `.toString()` on a live function for you (patching the ES6 method-shorthand `.toString()` quirk automatically — see `ROADMAP.md` §2a), so you can write a normal function and not have to remember that constraint yourself. A string is still accepted as-is if you already have one.

Invalid input (a missing/empty `id`, or a `runInPage`/`applicability` that's neither a function nor a non-empty string) throws immediately from `.withCustomRules()` itself, rather than surfacing later as a silently-skipped rule deep inside the page — easier to catch during development. (Note: a *raw* `.options({ customRules })` call bypasses this check entirely and defers to surea11y's own engine-side behavior, which silently skips an invalid descriptor rather than throwing — see `../surea11y/docs/ENGINE_OPTIONS.md`.)

### Element addressing beyond a CSS selector

Every occurrence already carries `selector` and (with `.elementRef(true)`, above) a live `element`. It also carries `structuralPath` — a sibling-index path from the document root down to the flagged element (e.g. `[1, 0, 2]`) — a more robust identity than a selector string alone, since it survives some DOM changes a selector wouldn't (an id/class rename, for instance). No opt-in needed; it's already on every `fail`/`cantTell` occurrence today. See `../surea11y/docs/OUTPUT_SCHEMA.md` for the full field description.

## TypeScript

`src/A11yCoreBuilder.d.ts` (re-exported from `src/index.d.ts`, wired up via `package.json`'s `types` field) ships hand-written types for the whole builder API plus surea11y's native result shapes (`A11yCoreResult`, `CheckResult`, `Occurrence`, `CompositeResult`, etc.), mirrored from `../surea11y/docs/OUTPUT_SCHEMA.md`. `analyze()` is typed `Promise<A11yCoreResult | A11yCoreMultiFrameResult>` — narrow on `'topFrame' in results` (or cast, if you already know which mode you called) to get the specific shape back, since a fluent builder can't statically track that `.frames(true)` was called earlier in the chain. `occurrence.element` is typed `WebdriverIO.Element | null`. `webdriverio` is a `peerDependencies` entry (not just `devDependencies`) since the class's `browser` argument and `Occurrence#element` both come from its global `WebdriverIO` type namespace — consumers need their own `webdriverio` install for the types to resolve, same as they already do to construct a `browser` in the first place. Verified with a real `tsc --strict` compile against a throwaway consumer script exercising every builder method and both `analyze()` return shapes (see `ROADMAP.md` §4).

## Relationship to `surea11y-playwright` and `surea11y-puppeteer`

This binding's builder API is deliberately the same shape as [`surea11y-playwright`](../surea11y-playwright)'s and [`surea11y-puppeteer`](../surea11y-puppeteer)'s — same method names, same mutability contract, same result shapes — so the accessibility-gate logic reads almost identically across all three. The state-accumulation half of the builder (`include`/`exclude`/`withTags`/`disableTags`/`withRules`/`disableRules`/`options`/`withCustomRules`/`reportOnly`) used to be copied near-verbatim across every binding; as of `ROADMAP.md` §8 it's no longer copied at all — `A11yCoreBuilder` here extends `A11yCoreBuilderBase` from [`../surea11y-binding-base`](../surea11y-binding-base), the single shared implementation every sibling binding now depends on.

Where it genuinely diverges is WebdriverIO's driver model, and those differences are real, not cosmetic:

- **`analyze()`'s injection call** is variadic like Puppeteer's (`browser.execute(runa11yCoreInPage, url, ctx, opts, runOnly)`) — no single-arg wrapper/`eval()` trick the Playwright binding needs.
- **`.frames(true)`** can't iterate a `page.frames()` array (there isn't one) — it drives WebdriverIO's stateful `switchFrame()` context model instead, recursing to reach nested frames. See above and `ROADMAP.md` §2c.
- **`.elementRef(true)`** attaches `occurrence.element` (a `WebdriverIO.Element`), not `occurrence.elementHandle`, with the sub-frame-context caveat described above.
- **Protocol:** classic WebDriver is strongly preferred over WebdriverIO v9's default BiDi for this execute()-heavy workload (see above and `ROADMAP.md` §4).

Also see [`../surea11y/docs/BINDING_AUTHORS_GUIDE.md`](../surea11y/docs/BINDING_AUTHORS_GUIDE.md) — `surea11y`'s own reference for building a binding like this one (it names WebdriverIO explicitly as a candidate next binding), distinguishing what's already engine-level (a generic `.options()`/`runOnly` passthrough, WCAG-version tag filtering, `structuralPath`) from what every binding has to build itself (element refs, `reportOnly`-style verbosity filtering, the serialization-boundary caveat `.withCustomRules()` exists to paper over).

## Status and what's next

See `ROADMAP.md` — it documents what's built, what's verified with a real passing run, and what's still open.
