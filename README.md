# @surea11y/webdriverio

A WebdriverIO binding for [`@surea11y/core`](https://github.com/SureA11y/core) — scans a real, already-rendered page for accessibility issues using surea11y's DOM-rules engine.

## Install

```bash
npm install @surea11y/webdriverio webdriverio
```

`webdriverio` v9 auto-manages a local `chromedriver` for you the first time it launches Chrome (no separate Selenium server, and no extra browser-download step needed) — so a fresh `npm install` is enough for `npm test` to launch a real headless Chrome on its own.

## Usage

```js
const { remote } = require('webdriverio');
const { A11yCoreBuilder } = require('@surea11y/webdriverio');

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
  .withWcag('2.2', 'AA')         // the rules for WCAG 2.2's A and AA criteria
  .disableRules(['meta-refresh-no-exceptions'])
  .options({ contrast: { mode: 'auditorAssist' } })
  .analyze();

console.log(results.checksResults.filter(r => r.outcome === 'fail'));
console.log(results.engine.version); // the @surea11y/core release that scanned, e.g. "1.11.1"
await browser.deleteSession();
```

The builder takes `{ browser }` — the object WebdriverIO's `remote()` returns (standalone mode), or the global `browser` the WDIO testrunner injects (see the E2E section). It must already be navigated to and settled at the URL to scan; the class does not navigate for you.

`results` is `@surea11y/core`'s own native result shape — see its [`OUTPUT_SCHEMA.md`](https://github.com/SureA11y/core/blob/main/docs/OUTPUT_SCHEMA.md) — not the `violations`/`passes`/`incomplete`/`inapplicable` shape used by other popular accessibility testing tools. The builder's *method names* are modeled on common conventions in this space for migration familiarity; the richer result schema is kept as-is.

Also see `examples/basic-scan.js` for a runnable script (`npm run example -- <url>`).

### A note on the protocol: prefer classic WebDriver for this workload

WebdriverIO v9 defaults to the WebDriver **BiDi** protocol. A long-lived session that issues many `browser.execute()` calls — exactly what an accessibility scan does — degraded badly over BiDi in testing here: per-scan latency climbed from ~2s into the *minutes* and eventually the session started dropping commands (`Couldn't resolve command with id N`). Forcing the **classic** WebDriver protocol with `'wdio:enforceWebDriverClassic': true` in the capabilities gave a steady ~150ms per scan with no degradation, and every operation this binding needs (`execute`, `$`, `$$`, `switchFrame`) is fully supported on it. This project's own tests and examples all set that flag, and it's recommended for yours. The binding itself works under either protocol (it never depends on a BiDi-only feature).

### Composing the rule filters

`.withWcag(version, level)` selects by conformance target: `.withWcag('2.2', 'AA')` runs the rules for WCAG 2.2's Level A and AA criteria, by the level each criterion has in that version (4.1.1 Parsing, which 2.2 removed, is part of a `'2.1'` target and not of a `'2.2'` one). `.withBestPractices()` adds the rules that name no WCAG criterion, such as `region` and `heading-order`; on its own it runs only those. `.withRules()` and `.withTags()` add to a target's rules, and the disable methods apply after. A version other than `'2.0'`, `'2.1'` or `'2.2'`, or a level other than `'A'`, `'AA'` or `'AAA'`, throws a `TypeError` with `code: 'INVALID_RUN_ONLY'` at the call. Both need `@surea11y/core` 1.11 or later.

`withTags()`/`disableRules()` have counterparts: `.withRules([...])` (only run these specific rule IDs) and `.disableTags([...])` (never run rules carrying any of these tags). All four compose the same way similar allow/deny-list options do in other accessibility testing tools, with one non-obvious rule worth knowing: a "disable" always wins over a "with" on the same ID/tag (e.g. `.withRules(['a']).disableRules(['a'])` drops `'a'` entirely), and combining `.withRules()` **and** `.withTags()` together requires a rule to satisfy *both* (`@surea11y/core`'s default `includeMode: 'and'`), not either one.

A rule or tag list that names nothing `@surea11y/core` knows makes `analyze()` reject with `code: 'INVALID_RUN_ONLY'` (see [When a scan can't run as asked](#when-a-scan-cant-run-as-asked)), so a typo such as `.withTags(['wcag2.2aa'])` can't run no rule at all and pass. An unknown name beside known ones is ignored, with a warning in the page's console. The four methods also throw a `TypeError` with the same `code` straight away for anything but a string or an array of strings, such as `undefined` from a missing config value.

Rule IDs change rarely, but core 1.10.0 changed two: `label-title-only` is deprecated (it reports `notApplicable`; every field it flagged, `form-control-programmatic-label-quality` flags too) and keeps resolving until 2.0.0, so a `.disableRules(['label-title-only'])` still works but no longer does anything; and `landmark-role-name-present` is new, a `best-practice` rule that asks about an element with `role="region"` or `role="form"` and no accessible name.

`.exclude(selector)` above excludes globally. Pass a second argument to scope it to specific rule IDs instead: `.exclude('.mat-select', { rules: ['aria-required-children'] })` skips `.mat-select` for that rule only — every other rule still sees it. Global and rule-scoped `.exclude()` calls compose freely.

**Create one builder per scan.** `A11yCoreBuilder` is a mutable object with no reset between `.analyze()` calls — `include()`/`exclude()`/`withRules()`/`disableRules()`/`withTags()`/`disableTags()`/`options()`/`withCustomRules()`/`withPacks()` all push onto or merge into internal state that persists for the instance's lifetime. Calling one of them again before a second `.analyze()` call *accumulates* on top of the first scan's scope rather than replacing it (this is exactly what makes "call `.include()` several times for one scan," above, work — the same accumulation just also applies across separate scans if you reuse an instance). `.reportOnly()`/`.frames()`/`.elementRef()`/`.withWcag()`/`.withBestPractices()` are the exception: each call replaces the previous value instead of merging with it.

This binding works against any browser WebdriverIO can drive; the tests and examples use headless Chrome via `chromedriver`, which WebdriverIO manages automatically.

### Using it as an E2E accessibility gate

The pattern above works unchanged inside a real WebdriverIO testrunner spec, which is the pattern that actually matters for a CI/E2E suite (not just an ad hoc script). Inside the testrunner, `browser` is a global you don't construct yourself:

```js
const assert = require('node:assert');
const { A11yCoreBuilder, formatFailures, getScanGaps } = require('@surea11y/webdriverio');

describe('accessibility gate', () => {
  it('has no accessibility violations', async () => {
    await browser.url('https://example.com/');

    const results = await new A11yCoreBuilder({ browser }).reportOnly(['fail']).analyze();

    assert.strictEqual(results.checksResults.length, 0, formatFailures(results));
    // An include() scope that matched nothing, or a custom rule or a pack
    // that did not run, leaves no failure behind: check for them too.
    assert.deepStrictEqual(getScanGaps(results), [], formatFailures(results));
  });
});
```

See `examples/e2e-test-example.test.js` for a fuller, runnable version (`npm run example:e2e`), driven by `examples/wdio.conf.js` — one test proving real violations get caught (unlabeled button, missing `alt`), one proving a well-formed page passes cleanly, and one gating a page on a pack's checklist (see [Scanning with packs](#scanning-with-packs-standards-checklists-and-your-own-rules)). It uses the **WebdriverIO testrunner** (`@wdio/cli` + mocha), which is how real WebdriverIO suites are written. This project's own *unit* suite (`tests/*.test.js`) uses `node:test` + `remote()`, the right tool for exercising the builder API in isolation.

Note the gate above uses `node:assert`, not WebdriverIO's bundled `expect`: WebdriverIO's `expect` takes **at most one argument** — there's no `expect(value, message)` custom-failure-message overload the way Playwright's `expect` has — so `node:assert`'s message parameter is what carries `formatFailures()`' readable block onto a failed assertion.

### Readable console/CI output on failure

A bare length/equality assertion alone gets you a *working* gate, but the failure message is a raw, deeply-nested object diff — hundreds of lines for a handful of violations. `formatFailures(results)` turns that into a short, scannable block (one entry per occurrence, numbered, with rule ID/severity/location/hint) that you hand to your assertion library's own failure-message parameter, as above. Given the whole result, it also says what the scan left out and which `@surea11y/core` release ran it. A real failure then prints:

```
1) button-name-present (serious): This button has no accessible name.
   at html > body > button
   Give the button visible text, or name it with aria-label, so screen reader users know what it does.
2) img-alt-present (serious): This <img> has no alt attribute.
   at #host >>> p > img
   Add an alt attribute that says what the image shows, or alt="" if the image is purely decorative.

Scanned with @surea11y/core 1.11.1.
```

An element inside a shadow tree is located as `host >>> selector` (the second entry above); `formatOccurrenceLocation(occurrence)` gives the same text if you print occurrences yourself. `formatFailures(results.checksResults)` still works and prints only the entries. A `.frames(true)` result is not one result, so `formatFailures()` throws a `TypeError` for it: format `results.topFrame` and each entry of `results.frames` on its own.

Deliberately a plain function, not a custom matcher — no dependency on any particular assertion library, so it works the same with `node:assert`, WebdriverIO's `expect`, Jest, Vitest, or a hand-rolled `if`/`throw`. Defaults to `fail`/`cantTell` outcomes (the only two whose occurrences are findings: a `notApplicable` rule may carry one occurrence saying why it had nothing to judge); pass `{ outcomes: [...] }` to narrow further. A thrown rule (`occurrences: []`, `error` set) is still surfaced using its `error` message rather than silently dropped.

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

**`.include()` scopes the top frame only.** Each sub-frame is scanned whole, as `@surea11y/core`'s own `runa11yCoreAcrossFrames` does: the selectors belong to the top document, and since core 1.10.0 a selector that matches nothing scans nothing, so passing them down would leave every frame without them unscanned. `.exclude()` and the rule filters apply in every frame. An `EngineError` (see [When a scan can't run as asked](#when-a-scan-cant-run-as-asked)) rejects `analyze()` from the top frame, before any sub-frame is scanned; a sub-frame that fails for another reason is listed in `results.frames` as `{ url, error }`.

`@surea11y/core`'s reporters take this result as it is (core 1.11.1 and later): `renderSarifReport(results)`, `renderJunitReport(results)`, `renderHtmlReport(results)` and the baseline functions report every frame's findings, and a frame that couldn't be scanned as not scanned, so it never reads as a pass.

```js
const fs = require('node:fs');
const { renderSarifReport } = require('@surea11y/core/sarif');

const results = await new A11yCoreBuilder({ browser }).frames(true).analyze();
fs.writeFileSync('a11y.sarif', renderSarifReport(results));
```

Verified against a real cross-origin page (`https://example.org/` embedded in an unrelated origin) and against a real nested-iframe page (top → child → grandchild) — see `tests/builder.test.js`. Default off, so plain `.analyze()` is unaffected unless you opt in. Unlike script-injection-based accessibility tools (which need a `postMessage`-based protocol to reach cross-origin iframes, since they're injected as a plain `<script>` subject to the same-origin policy), this needs no extra `@surea11y/core` engine support at all.

### Trimming the result to just violations

By default `analyze()` returns every rule's outcome, including `pass`/`notApplicable` — `@surea11y/core`'s own deliberate "not a violations-only list" design. Use `.reportOnly()` to post-filter down to only the outcomes you care about:

```js
const results = await new A11yCoreBuilder({ browser })
  .reportOnly(['fail', 'cantTell'])
  .analyze();

console.log(results.checksResults); // only fail/cantTell entries, pass/notApplicable dropped
```

Valid outcome values are `'pass'`, `'fail'`, `'cantTell'`, `'notApplicable'`. This is pure binding-layer filtering — the engine itself still computes every rule; nothing about the scan itself changes. Combines with `.frames(true)`: the filter is applied to `results.topFrame` and each entry of `results.frames` independently.

A result trimmed this way is no longer the whole scan to `@surea11y/core`'s reporters: JUnit counts one test per rule it finds, and EARL makes one assertion per rule. To keep a result small and still hand it to them, ask the engine for a compact one instead, with `.options({ output: { detail: 'findings' } })`: a rule that passed or did not apply keeps only its outcome, and every reporter reads it as the full result. An empty page's result goes from about 238 KB to 82 KB.

### Getting a live element, not just a selector string

By default each occurrence carries a CSS selector + HTML snippet, not a live reference to the element. Opt in to a real `WebdriverIO.Element` with `.elementRef(true)`:

```js
const results = await new A11yCoreBuilder({ browser }).elementRef(true).analyze();

const [failing] = results.checksResults.filter(r => r.outcome === 'fail');
await failing.occurrences[0].element.saveScreenshot('./flagged.png');
await failing.occurrences[0].element.click();
```

This finds each occurrence's element in the page and attaches it as **`occurrence.element`** — instead of leaving you to re-resolve a possibly-stale selector string yourself. An element inside a shadow tree is found through its `shadowHostSelectors` (see below), where `browser.$(occurrence.selector)` would find another element or none. `element` is `null` when nothing matches any more. Default off — resolving an element per occurrence is a real page query per occurrence, so it costs more than a plain `.analyze()`.

Two WebdriverIO-specific differences from the sibling bindings' `.elementRef(true)`, both real and worth knowing:

- **The field is `occurrence.element`, not `occurrence.elementHandle`.** WebdriverIO has no "handle" concept — `browser.$()` returns a `WebdriverIO.Element`. Its API differs too: read a property with `.getProperty('id')` (not Puppeteer's `.evaluate(el => el.id)`), screenshot with `.saveScreenshot(path)` (not `.screenshot({ path })`). See the [WebdriverIO element API](https://webdriver.io/docs/api/element).
- **A sub-frame element is only usable while switched into its frame.** WebdriverIO element references are bound to whichever frame was the current context when they were resolved. When you combine `.frames(true).elementRef(true)`, a *sub-frame* occurrence's `element` is resolved against that frame's own document (correct), but after `analyze()` returns the browser is back at the top-level frame — so to act on a sub-frame element you must `browser.switchFrame()` back into its frame first (`browser.switchFrame((await browser.$$('iframe'))[i])`). Top-frame occurrences have no such caveat. This is a direct consequence of WebdriverIO's stateful context model and has no analogue in Puppeteer/Playwright, whose handles are bound to an execution context, not a mutable "current frame."

Not every occurrence has one target element — a page-wide finding (some `manual`/`cantTell` rules) can carry `selector: ""`, in which case `occurrence.element` is `null` rather than an element.

### Registering a custom rule at runtime

`@surea11y/core` supports registering additional rules per-scan via `engineOptions.customRules`. Use `.withCustomRules()` to register one:

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

A custom rule descriptor is the same shape as one of `@surea11y/core`'s own internal rule modules (`{ id, meta, runInPage, applicability?, data? }`) — see its [`ENGINE_OPTIONS.md`](https://github.com/SureA11y/core/blob/main/docs/ENGINE_OPTIONS.md) for the full contract. Results appear in `checksResults` exactly like a built-in rule's, including automatic `selector`/`html`/`structuralPath` fill-in. Registered per-scan only (nothing persists between calls or shows up in any catalog listing), and a custom rule whose `id` collides with a built-in one overrides it for that scan.

Pass an array to register several at once, or call `.withCustomRules()` again to add more — like `.withRules()`/`.withTags()`, it accumulates rather than replacing what was already registered:

```js
const results = await new A11yCoreBuilder({ browser })
  .withCustomRules([firstRule, secondRule])
  .withCustomRules(thirdRule) // adds a third, doesn't replace the first two
  .analyze();
```

**Why `.withCustomRules()` instead of the raw `.options({ customRules })` passthrough** (still supported, and composes with this method if you use both): `runInPage`/`applicability` must reach the page as a function-source *string*, not a live `Function` — a WebdriverIO `browser.execute()` argument crosses a serialization boundary that can't carry a live function reference, only a string `@surea11y/core` can reconstruct with `new Function` on the page side. Passing a raw live function via `.options()` directly would silently fail to serialize; `.withCustomRules()` calls `.toString()` on a live function for you (patching the ES6 method-shorthand `.toString()` quirk automatically), so you can write a normal function and not have to remember that constraint yourself. A string is still accepted as-is if you already have one.

Invalid input (a missing/empty `id`, or a `runInPage`/`applicability` that's neither a function nor a non-empty string) throws immediately from `.withCustomRules()` itself, rather than surfacing later as a skipped rule deep inside the page — easier to catch during development. (Note: a *raw* `.options({ customRules })` call bypasses this check entirely and defers to `@surea11y/core`'s own engine-side behavior, which skips an invalid descriptor rather than throwing. The result lists each skipped rule in `skippedCustomRules`, and `analyze()` warns about it — see below.)

### When a scan can't run as asked

`analyze()` rejects with an `EngineError` (exported, along with `ENGINE_ERROR_CODES`) when `@surea11y/core` can't use what it was given. Its `code` says why:

- `INVALID_RUN_ONLY`: none of the rule IDs, or none of the tags, given to `.withRules()`/`.withTags()` is one the engine knows.
- `INVALID_CONTEXT_SELECTOR`: an `.include()` selector is not valid CSS; `error.selector` names it.
- `INVALID_ENGINE_OPTIONS`: with `.options({ strictOptions: true })`, an option the engine doesn't read or a value it can't use. The message names each, with the closest known option (`lcoale`: did you mean `locale`?). Without `strictOptions`, a likely typo is only warned about in the page's console.
- `PAGE_BUILTINS_BROKEN`: the page's own scripts broke a JavaScript built-in the engine relies on (`Array.prototype.filter`, `Map`, `JSON.stringify`, ...), so no result it gave could be trusted. The message names each one.

```js
const { A11yCoreBuilder, EngineError } = require('@surea11y/webdriverio');

try {
  await new A11yCoreBuilder({ browser }).withTags(['wcag2.2aa']).analyze();
} catch (e) {
  if (e instanceof EngineError && e.code === 'INVALID_RUN_ONLY') {
    // a typo in the tag list, not a broken page
  }
  throw e;
}
```

Two other cases don't throw but leave part of the page unchecked, so a result that reports nothing failing is not a clean page:

- **An `.include()` selector that matches nothing.** Since core 1.10.0 nothing is then scanned (it used to fall back to the whole page): every rule reports `notApplicable`, and `results.contextMatch` is `{ elementCount: 0, unmatchedSelectors: [...] }`. With several selectors, one that matches nothing is named there while the others are scanned.
- **A custom rule that did not run**, listed with its reason in `results.skippedCustomRules`.
- **A pack that did not run**, listed with its reason in `results.skippedPacks` (see [Scanning with packs](#scanning-with-packs-standards-checklists-and-your-own-rules)).

`analyze()` prints each of these with `console.warn`, and `getScanGaps(results)` returns them as `[{ kind, message, ... }]` (`kind` is `context-not-found`, `context-partly-not-found`, `custom-rule-skipped` or `pack-skipped`), so a gate can fail on them, as the E2E example above does. `formatFailures(results)` lists them too.

### Scanning with packs: standards, checklists and your own rules

A pack brings rules, variants of core's rules, a standard or a checklist, and their profiles and messages, from a package of its own: a national standard such as RGAA, or your organisation's accessibility policy. `@surea11y/core` runs a pack as it runs its own rules and standards, so its results, rollups and report entries look like core's. Packs need `@surea11y/core` 1.11.1 or later.

`.withPacks()` registers packs in the page with `browser.execute()`, and in every frame with `.frames(true)`, before the scan; a pack's profile is chosen with `.options({ profile })`:

```js
const acmePolicy = require('@acme/a11y-policy'); // a pack

const results = await new A11yCoreBuilder({ browser })
  .withPacks(acmePolicy)
  .options({ profile: 'acme-web-2026' })
  .analyze();

results.engine.packs;   // ['@acme/a11y-policy@1.0.0']
results.engine.profile; // 'acme-web-2026'

// A checklist's items, each one result, beside core's WCAG rollups:
results.rulesResults.filter((r) => r.meta && r.meta.standard === 'Acme web policy');
```

A pack's own rules appear in `checksResults` like core's, with ids that start with its namespace (`acme-no-autoplay`). Without its profile, a pack's rules run only when selected, with `.withRules()` or by a tag. `@surea11y/core`'s HTML, SARIF and JUnit reports show a standard's or a checklist's items in a section of their own. Pass an array, or call `.withPacks()` again, to scan with several packs.

**Writing a pack.** A pack is an object made with `definePack` from `@surea11y/core/pack`. [`examples/acme-policy-pack.js`](./examples/acme-policy-pack.js) is a small one: a house rule, a checklist profile (WCAG 2.2 A and AA, `region`, and the house rule) and two checklist items. `npm run example:pack` scans a page with it, and [`examples/e2e-test-example.test.js`](./examples/e2e-test-example.test.js) uses it as a test gate. For a pack of your own, `npx surea11y-pack new <folder>` (from `@surea11y/core`) writes a package that works as generated, with its tests, docs and lint; core's [`PACKS.md`](https://github.com/SureA11y/core/blob/main/docs/PACKS.md) is the guide.

**When a pack doesn't run.** `.withPacks()` builds the page's script with the `@surea11y/core` this binding loads, and checks each pack as it does: `.analyze()` throws before scanning for a pack that core can't run, such as one whose `core` range leaves out the installed core, or whose profile names a rule that doesn't exist. A pack the page then doesn't run (one named with a raw `.options({ packs })` and never registered, or a page running another core version, when two copies of core are installed) is listed in `results.skippedPacks` with the reason. `getScanGaps()` reports that as `'pack-skipped'`, and `.analyze()` warns about it, so a test gate that asserts on `getScanGaps(results)` fails rather than passing with the pack's checks never run. Install the pack beside the binding, so npm resolves one core for both.

### Element addressing beyond a CSS selector

Every occurrence already carries `selector` and (with `.elementRef(true)`, above) a live `element`. It also carries `structuralPath` — a sibling-index path from the document root down to the flagged element (e.g. `[1, 0, 2]`) — a more robust identity than a selector string alone, since it survives some DOM changes a selector wouldn't (an id/class rename, for instance). No opt-in needed; it's already on every `fail`/`cantTell` occurrence today.

An element inside a shadow tree is different: its `selector` holds only inside its shadow root, its `shadowHostSelectors` lists the shadow hosts that lead to it (outermost first), and its `structuralPath` is `null`. `formatOccurrenceLocation(occurrence)` joins them as `host >>> selector` for display. See [`OUTPUT_SCHEMA.md`](https://github.com/SureA11y/core/blob/main/docs/OUTPUT_SCHEMA.md) for the full field description.

## TypeScript

`src/A11yCoreBuilder.d.ts` (re-exported from `src/index.d.ts`, wired up via `package.json`'s `types` field) ships types for the whole builder API plus `@surea11y/core`'s native result shapes (`A11yCoreResult`, `CheckResult`, `Occurrence`, `CompositeResult`, etc.). The result shapes are built on the types `@surea11y/core` ships itself, so fields such as `engine.version`, `engine.environment`, `contextMatch`, `skippedCustomRules`, `margin` and `shadowHostSelectors` follow the engine; this package adds `occurrence.element` and the `.frames(true)` shape. `EngineError`, `EngineErrorCode` and `ScanGap` come from `@surea11y/binding-base`, and so do the types of `withWcag()` (`WcagVersion`, `WcagLevel`) and `withPacks()`, which takes a pack made with `definePack` (`PackLike`). Code that handles every `ScanGap` kind it knows and treats the rest in an `else` branch needs a branch for `'pack-skipped'`, which carries `pack` rather than `selectors`. `analyze()` is typed `Promise<A11yCoreResult | A11yCoreMultiFrameResult>` — narrow on `'topFrame' in results` (or cast, if you already know which mode you called) to get the specific shape back, since a fluent builder can't statically track that `.frames(true)` was called earlier in the chain. `occurrence.element` is typed `WebdriverIO.Element | null`. `webdriverio` is a `peerDependencies` entry (not just `devDependencies`) since the class's `browser` argument and `Occurrence#element` both come from its global `WebdriverIO` type namespace — consumers need their own `webdriverio` install for the types to resolve, same as they already do to construct a `browser` in the first place.

## What changes with `@surea11y/core` 1.11

The binding passes rule IDs, tags and options through to the engine, so these show in results without a change here (see core's [`CHANGELOG.md`](https://github.com/SureA11y/core/blob/main/CHANGELOG.md) for the full list):

- **Messages are reworded** in all five languages to say plainly what is wrong and what to do (`This <img> has no alt attribute.`). Message keys, rule IDs, reason codes and baselines are unchanged; a test that matches message text needs the new wording.
- **Contrast and target size measure what is on screen.** In a browser, the contrast rules check only text a reader can see, measure it against what is painted under it, and measure form field values and placeholders. `target-size-minimum` measures the area a pointer can hit, and exempts only links in a sentence. Expect new findings, and some old ones gone.
- **`aria-hidden-focus` maps to 4.1.2 only**, no longer to 2.4.7 Focus Visible, so `.withTags('wcag2aa')` alone no longer selects it.
- **A custom rule counts toward its WCAG criterion.** A `.withCustomRules()` rule with `meta.wcagSc` (or a WCAG `normativeMappings` entry) fails that criterion's rollup when it fails, and custom rules run after core's.
- **On/off options read as meant**: `.options({ perfStats: 'false' })` is off, where it was on. `.options({ strictOptions: true })` rejects any option the engine doesn't read (see [When a scan can't run as asked](#when-a-scan-cant-run-as-asked)).

## Relationship to `@surea11y/playwright` and `@surea11y/puppeteer`

This binding's builder API is deliberately the same shape as [`@surea11y/playwright`](https://github.com/SureA11y/playwright)'s and `@surea11y/puppeteer`'s — same method names, same mutability contract, same result shapes — so the accessibility-gate logic reads almost identically across all three. The state-accumulation half of the builder (`include`/`exclude`/`withTags`/`disableTags`/`withRules`/`disableRules`/`withWcag`/`withBestPractices`/`options`/`withCustomRules`/`withPacks`/`reportOnly`) is not copied across bindings — `A11yCoreBuilder` here extends `A11yCoreBuilderBase` from [`@surea11y/binding-base`](https://github.com/SureA11y/binding-base), the single shared implementation every sibling binding depends on.

Where it genuinely diverges is WebdriverIO's driver model, and those differences are real, not cosmetic:

- **`analyze()`'s injection call** is variadic like Puppeteer's (`browser.execute(inPageScan, url, ctx, opts, runOnly)`, where `inPageScan` is `@surea11y/core`'s `runa11yCoreInPage` wrapped by `@surea11y/binding-base` so an engine error keeps its `code`) — no single-arg wrapper the Playwright binding needs.
- **`.frames(true)`** can't iterate a `page.frames()` array (there isn't one) — it drives WebdriverIO's stateful `switchFrame()` context model instead, recursing to reach nested frames. See above.
- **`.elementRef(true)`** attaches `occurrence.element` (a `WebdriverIO.Element`), not `occurrence.elementHandle`, with the sub-frame-context caveat described above.
- **Protocol:** classic WebDriver is strongly preferred over WebdriverIO v9's default BiDi for this execute()-heavy workload (see above).

## Building another framework binding?

See `@surea11y/core`'s [`BINDING_AUTHORS_GUIDE.md`](https://github.com/SureA11y/core/blob/main/docs/BINDING_AUTHORS_GUIDE.md) — a reference for building a new binding, covering which parity features are engine-level (work through a generic `.options()`/`runOnly` passthrough with zero binding code, including WCAG-version tag filtering) vs. binding-layer (element refs, `reportOnly`-style verbosity filtering, the serialization-boundary caveat `.withCustomRules()` exists to paper over).

`A11yCoreBuilder` here extends `A11yCoreBuilderBase` from [`@surea11y/binding-base`](https://github.com/SureA11y/binding-base), a small shared package holding the scaffolding common to every framework binding. A new binding should depend on that package from the start.

## Maintainer

Maintained by [Jorge Rumoroso](https://github.com/rumoroso).

## License

MIT — see [`LICENSE`](./LICENSE).

This package depends on [`@surea11y/core`](https://github.com/SureA11y/core), which is MPL-2.0. MPL-2.0's copyleft is file-level and applies only to `@surea11y/core`'s own source files; consuming it as a normal package dependency doesn't affect this package's license.
