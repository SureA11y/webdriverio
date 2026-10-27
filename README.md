# @surea11y/webdriverio

A WebdriverIO binding for [`@surea11y/core`](https://github.com/SureA11y/core) — scans a real, already-rendered page for accessibility issues using surea11y's DOM-rules engine.

## Install

```bash
npm install @surea11y/core @surea11y/webdriverio webdriverio
```

`@surea11y/core` 1.12.0 or later, the engine, comes with the binding as a regular dependency, so a project that doesn't list it still works. List it in your own `package.json` too, as the line above does: your project and the binding then share one copy, so whatever you do with core directly, writing a SARIF log or an HTML report (`@surea11y/core/sarif`, `/report`), reading the rule catalogue or keeping a baseline, reads results with the same core that produced them. When your core can't match the binding's range, as with a linked checkout (`file:../core`) or a fork, add `"overrides": { "@surea11y/core": "$@surea11y/core" }` beside it.

**Coming in 2.0:** core becomes a peer dependency, so the binding will no longer install it for you, and the `overrides` entry is no longer needed. Add `@surea11y/core` to your `package.json` now and 2.0 needs no change.

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
console.log(results.engine.version); // the @surea11y/core release that scanned, e.g. "1.12.0"
await browser.deleteSession();
```

The builder takes `{ browser }` — the object WebdriverIO's `remote()` returns (standalone mode), or the global `browser` the WDIO testrunner injects (see the E2E section). It must already be navigated to and settled at the URL to scan; the class does not navigate for you.

`results` is `@surea11y/core`'s own native result shape — see its [`OUTPUT_SCHEMA.md`](https://github.com/SureA11y/core/blob/main/docs/OUTPUT_SCHEMA.md) — not the `violations`/`passes`/`incomplete`/`inapplicable` shape used by other popular accessibility testing tools. The builder's *method names* are modeled on common conventions in this space for migration familiarity; the richer result schema is kept as-is.

From 1.4.0 this package needs `@surea11y/core` 1.12.0 or later; see [What changes with `@surea11y/core` 1.12](#what-changes-with-surea11ycore-112).

Also see `examples/basic-scan.js` for a runnable script (`npm run example -- <url>`).

### A note on the protocol: prefer classic WebDriver for this workload

WebdriverIO v9 defaults to the WebDriver **BiDi** protocol. A long-lived session that issues many `browser.execute()` calls — exactly what an accessibility scan does — degraded badly over BiDi in testing here: per-scan latency climbed from ~2s into the *minutes* and eventually the session started dropping commands (`Couldn't resolve command with id N`). Forcing the **classic** WebDriver protocol with `'wdio:enforceWebDriverClassic': true` in the capabilities gave a steady ~150ms per scan with no degradation, and every operation this binding needs (`execute`, `$`, `$$`, `switchFrame`) is fully supported on it. This project's own tests and examples all set that flag, and it's recommended for yours. The binding itself works under either protocol (it never depends on a BiDi-only feature).

### Composing the rule filters

`.withWcag(version, level)` selects by conformance target: `.withWcag('2.2', 'AA')` runs the rules for WCAG 2.2's Level A and AA criteria, by the level each criterion has in that version (4.1.1 Parsing, which 2.2 removed, is part of a `'2.1'` target and not of a `'2.2'` one). `.withBestPractices()` adds the rules that name no WCAG criterion, such as `region` and `heading-order`; on its own it runs only those. `.withRules()` and `.withTags()` add to a target's rules, and the disable methods apply after. The level is read in any case (`'aa'` is `'AA'`). A version other than `'2.0'`, `'2.1'` or `'2.2'`, or a level other than A, AA or AAA, throws a `TypeError` with `code: 'INVALID_RUN_ONLY'` at the call. Both need `@surea11y/core` 1.11 or later.

`withTags()`/`disableRules()` have counterparts: `.withRules([...])` (only run these specific rule IDs) and `.disableTags([...])` (never run rules carrying any of these tags). All four compose the same way similar allow/deny-list options do in other accessibility testing tools, with one non-obvious rule worth knowing: a "disable" always wins over a "with" on the same ID/tag (e.g. `.withRules(['a']).disableRules(['a'])` drops `'a'` entirely), and combining `.withRules()` **and** `.withTags()` together requires a rule to satisfy *both* (`@surea11y/core`'s default `includeMode: 'and'`), not either one, unless you ask for that with `.includeMode('or')` (below).

`.includeMode(mode)` decides how `.withRules()` and `.withTags()` combine when both are given: `'and'`, the default, runs only the rules that match both, and `'or'` runs those that match either. That's what lets a scan say "this area, plus these checks". A team that owns a design system's form components, say, can run every rule about forms and the contrast check too, in one scan:

```js
const results = await new A11yCoreBuilder({ browser })
  .withTags('forms')
  .withRules('contrast-computable')
  .includeMode('or')             // every forms rule, plus the contrast check
  .analyze();
```

Without `.includeMode('or')`, the same lines run no rule at all, since `contrast-computable` isn't tagged `forms`, and a scan of no rules looks clean. The same goes for a WCAG level tag beside a best practice: `.withTags('wcag2a').withRules('region')` runs nothing, and with `'or'` runs the `wcag2a` rules plus `region`. On its own, with no other selection, it changes nothing. A value other than `'and'` or `'or'` throws a `TypeError` with `code: 'INVALID_RUN_ONLY'` at the call. A `.withWcag()` target doesn't need it: its rules are always added to what tags and rules select.

`.wcagLevel(level)` sets the WCAG level of the criteria a scan reports, without changing which rules run: criteria above it are left out of `results.rulesResults`, while every selected rule still runs and reports in `results.checksResults`. It's what lets a scan that names a few checks say it is meant as WCAG AA. A team that gates each pull request on colour contrast alone, say, runs one check, which covers both 1.4.3 (AA) and 1.4.6 (AAA):

```js
const results = await new A11yCoreBuilder({ browser })
  .withRules('contrast-computable')
  .wcagLevel('AA')               // report 1.4.3, not the AAA 1.4.6
  .analyze();
```

Without `.wcagLevel('AA')`, that scan reports 1.4.6 as well, so a site that meets AA can show a failing AAA criterion it never aimed for. With it, the scan reports 1.4.3 alone, and `results.engine.wcagLevel` says `'AA'`. A `.withWcag()` target already implies its level; `.wcagLevel()` is for selections that don't, and wins when both are given, as it does over a level given through `.options()`. `'A'`, `'AA'` or `'AAA'` in any case is accepted. Anything else throws a `TypeError` with `code: 'INVALID_ENGINE_OPTIONS'` at the call, and `null` clears it. Needs `@surea11y/core` 1.12.0 or later.

`.plannedChecks()` and `.plannedCriteria()` say what a scan *will* check before you run it: the rules it runs (entries with `ruleId`) and the criteria it reports in `rulesResults` (entries with `id`), worked out in Node from the same selection and options, with no browser. Use them to record what a run covered next to its result, or to catch a selection that runs nothing, which would otherwise look like a clean scan:

```js
const builder = new A11yCoreBuilder({ browser }).withTags('forms').withRules('contrast-computable');
if (builder.plannedChecks().length === 0) {
  throw new Error('This selection runs no rule. Did you mean .includeMode("or")?');
}
const results = await builder.analyze();
```

A rule or tag list that names nothing `@surea11y/core` knows makes `analyze()` reject with `code: 'INVALID_RUN_ONLY'` (see [When a scan can't run as asked](#when-a-scan-cant-run-as-asked)), so a typo such as `.withTags(['wcag2.2aa'])` can't run no rule at all and pass. An unknown name beside known ones is ignored, with a warning in the page's console. The four methods also throw a `TypeError` with the same `code` straight away for anything but a string or an array of strings, such as `undefined` from a missing config value.

Rule IDs change rarely, but core 1.10.0 changed two: `label-title-only` is deprecated (it reports `notApplicable`; every field it flagged, `form-control-programmatic-label-quality` flags too) and keeps resolving until 2.0.0, so a `.disableRules(['label-title-only'])` still works but no longer does anything; and `landmark-role-name-present` is new, a `best-practice` rule that asks about an element with `role="region"` or `role="form"` and no accessible name.

`.exclude(selector)` above excludes globally. Pass a second argument to scope it to specific rule IDs instead: `.exclude('.mat-select', { rules: ['aria-required-children'] })` skips `.mat-select` for that rule only — every other rule still sees it. Global and rule-scoped `.exclude()` calls compose freely.

**Create one builder per scan.** `A11yCoreBuilder` is a mutable object with no reset between `.analyze()` calls — `include()`/`exclude()`/`withRules()`/`disableRules()`/`withTags()`/`disableTags()`/`options()`/`withCustomRules()`/`withPacks()` all push onto or merge into internal state that persists for the instance's lifetime. Calling one of them again before a second `.analyze()` call *accumulates* on top of the first scan's scope rather than replacing it (this is exactly what makes "call `.include()` several times for one scan," above, work — the same accumulation just also applies across separate scans if you reuse an instance). `.reportOnly()`/`.frames()`/`.elementRef()`/`.screenshots()`/`.withWcag()`/`.withBestPractices()`/`.includeMode()`/`.wcagLevel()`/`.logger()` are the exception: each call replaces the previous value instead of merging with it.

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

### Failing only on serious problems

Every rule result has a severity: `critical`, `serious`, `moderate` or `minor` (a profile can set its own). To start by blocking on serious problems while the rest are still reported, gate on `getGatingFailures(results, { failOnSeverity })` (`@surea11y/binding-base` 1.6.0 and later): the failing rules at that level or above, the same ones `surea11y scan --fail-on-severity` counts for the page. `formatFailures()` takes the same option and still lists the failures below the level, marked as ones that don't fail the test.

```js
const { A11yCoreBuilder, formatFailures, getGatingFailures } = require('@surea11y/webdriverio');

const results = await new A11yCoreBuilder({ browser }).analyze();
const gate = { failOnSeverity: 'serious' };
assert.deepStrictEqual(getGatingFailures(results, gate), [], formatFailures(results, gate));
```

`fail` keeps its meaning, a definite violation; the level only picks which failures stop the test, and every failure stays in `results`. A level that isn't one of the four throws a `TypeError`. `SEVERITIES` lists them, least to most severe.

### Readable console/CI output on failure

A bare length/equality assertion alone gets you a *working* gate, but the failure message is a raw, deeply-nested object diff — hundreds of lines for a handful of violations. `formatFailures(results)` turns that into a short, scannable block (one entry per occurrence, numbered, with rule ID/severity/location/hint) that you hand to your assertion library's own failure-message parameter, as above. Given the whole result, it also says what the scan left out and which `@surea11y/core` release ran it. Each occurrence is read by its own outcome, and the list follows the order a review takes: failures first, then the [questions](#findings-that-need-review-leans-and-how-to-check) that likely fail, those that likely pass, and those only a person can answer. A real failure then prints:

```
1) button-name-present (serious): This button has no accessible name.
   at html > body > button
   Give the button visible text, or name it with aria-label, so screen reader users know what it does.
2) img-alt-present (serious): This <img> has no alt attribute.
   at #host >>> p > img
   Add an alt attribute that says what the image shows, or alt="" if the image is purely decorative.

Scanned with @surea11y/core 1.12.0.
```

Before the version line, it also prints the result's notes (`getScanNotes()`, below), such as `The page was shown in forced colors (high contrast); contrast findings may differ with forced colors off.`

An element inside a shadow tree is located as `host >>> selector` (the second entry above); `formatOccurrenceLocation(occurrence)` gives the same text if you print occurrences yourself. `formatFailures(results.checksResults)` still works and prints only the entries. A `.frames(true)` result is not one result, so `formatFailures()` throws a `TypeError` for it: format `results.topFrame` and each entry of `results.frames` on its own.

Deliberately a plain function, not a custom matcher — no dependency on any particular assertion library, so it works the same with `node:assert`, WebdriverIO's `expect`, Jest, Vitest, or a hand-rolled `if`/`throw`. Defaults to `fail`/`cantTell` outcomes (the only two whose occurrences are findings: a `notApplicable` rule may carry one occurrence saying why it had nothing to judge); pass `{ outcomes: [...] }` to narrow further, by outcome or by review group (`'leanFail'`, `'leanPass'`, `'open'`), and `{ howToCheck: true }` to list each question's steps (see [below](#findings-that-need-review-leans-and-how-to-check)). An outcome it doesn't know throws a `TypeError`. A thrown rule (`occurrences: []`, `error` set) is still surfaced using its `error` message rather than silently dropped.

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

### A picture of each failing element

Opt in with `.screenshots()`, and each occurrence the scan flags gets a `screenshot` field: a picture of the element, with a box drawn around it, or the reason there is none.

```js
const results = await new A11yCoreBuilder({ browser })
  .screenshots({ dir: 'a11y-shots', padding: 16 })
  .analyze();

const [first] = results.checksResults.filter((r) => r.outcome === 'fail');
first.occurrences[0].screenshot;
// { path: 'a11y-shots/element-3f9a1c07.png', box: { x: 20, y: 20, width: 120, height: 40 } }
```

| Option | Default | |
|---|---|---|
| `dir` | none | Write each picture there. Without it, each comes back as `{ buffer, box }`, a PNG for you to store your own way. |
| `outcomes` | `['fail']` | Which occurrences to picture. For contrast, `['fail', 'cantTell']` shows the background the engine couldn't judge. |
| `padding` | `0` | CSS pixels of context around the element. |
| `highlight` | `true` | Draw a box around the element, over the page; the element itself is never restyled. |
| `max` | `50` | At most this many pictures per scan, frames included. |

- **One picture per element.** Several rules can flag the same element; it's pictured once, and each of their occurrences carries the same `screenshot`. A file is named after where the element is, so it keeps its name from run to run, and `formatFailures()` names it under each finding (`   screenshot: a11y-shots/element-3f9a1c07.png`).
- **`box`** is where the element shows in the picture, in CSS pixels; the PNG is larger by the device pixel ratio. `cropped: true` says only part of it shows, as for an element taller than the viewport, which is pictured from its top-left corner.
- **No picture, and why**: `{ skipped }` with `'no-element'` (no selector, or nothing matches it any more), `'page-level'` (a finding about the whole page, on `<html>`, `<head>` or `<body>`), `'not-rendered'` (such as `display: none`), `'zero-size'`, `'off-screen'` (such as `left: -9999px`), `'max-reached'`, or `'capture-failed'` with the reason. A failed picture never fails the scan.
- **The page is put back.** Each element is scrolled into view for its picture, and afterwards every scroll position is restored and the box removed, also when a picture fails. Something drawn over the element, such as a sticky header, shows as it does on screen.
- **Frames.** With `.frames(true)`, an element in an `<iframe>`, cross-origin ones included, is pictured on the page as it shows there, and the browser ends at the top-level page as before. Without it, the scan runs in whatever frame the browser is switched into; pictures are placed from the top-level page, so a scan started inside a frame gives its occurrences `capture-failed` and says why. Scan from the top-level page with `.frames(true)` to picture a frame's elements.
- **Off by default.** Pictures of real pages can hold personal data, and they end up as CI artifacts.

The pictures are cut out of WebDriver's screenshot of the viewport (`browser.takeScreenshot()`), right after each frame's scan, before `.reportOnly()` trims the result, and combine with `.elementRef(true)`. Focus, hover, animations or content that loads late can still differ from what the scan saw. An option it can't use throws a `TypeError` with `code: 'INVALID_ENGINE_OPTIONS'` at the call, and so does `.analyze()` with `options({ output: { includeSelector: false } })`, since each element is found by its selector. Works over WebDriver classic and BiDi.

### Findings that need review: leans and how to check

A `cantTell` is a question for a person: the engine couldn't prove the answer from the page. With `@surea11y/core` 1.14, a question says more:

- **Which way it leans.** Where the page's evidence points one way, the occurrence has a `lean`: `toward` (`'fail'` or `'pass'`), `why`, and sometimes a `caution` saying what could make it wrong. A skipped heading level leans fail; `aria-checked` on a native checkbox leans pass. A lean counted against the W3C ACT test cases on five cases or more also says how often it was right (`measured`). The outcome stays `cantTell` either way. See core's [`LEANS.md`](https://github.com/SureA11y/core/blob/main/docs/LEANS.md).
- **How to check it.** Each question of a core rule carries `howToCheck`: `steps` starting from the element it names, and what a person sees if it passes (`passWhen`) or fails (`failWhen`), in the scan's locale. The engine in the page leaves them out; `analyze()` adds them in Node, with the steps of your packs' rules too.

`formatFailures()` shows both: each question says beside its severity whether it likely fails, likely passes or needs review, then why, the caution, and with `{ howToCheck: true }` the steps:

```
2) heading-order (minor, likely fails): This heading jumps from level 1 to level 3, skipping a level.
   at html > body > main > h3
   Go down one level at a time, so an <h2> is followed by an <h3> rather than an <h4>, and the outline of the page stays easy to follow.
   Why it likely fails: The heading skips a level after the one before it.
   How to check:
     1. Find the heading the report names and note its level and the previous heading's level (from the report or the Accessibility pane).
     ...
```

To gate a spec on the questions that likely fail as well as the failures, use `@surea11y/core`'s `leaningFailures(results)`, which works on this binding's results (a `.frames(true)` tree included). It leaves out the rules whose criteria are outside the scan's target, and with `{ wcagOnly: true }` the best-practice rules too:

```js
const assert = require('node:assert');
const { leaningFailures } = require('@surea11y/core');

const results = await new A11yCoreBuilder({ browser }).analyze();
const failures = results.checksResults.filter((r) => r.outcome === 'fail');
assert.ok(
  failures.length === 0 && leaningFailures(results).length === 0,
  formatFailures(results, { outcomes: ['fail', 'leanFail'] })
);
```

Don't trim such a result with `.reportOnly(['fail'])` first: it drops the `cantTell` rules, and their leans with them. `.reportOnly()` filters whole rules by their outcome, while a rule's occurrences can sit in different tiers (`occurrenceOutcome`), which `formatFailures()` reads one by one. For CI reports, core's `renderJunitReport(results, { leanFailAs: 'failure' })` and `renderSarifReport(results, { leanFailAs: 'error' })` gate on the same findings, and both carry the steps.

### Web components: the internals hook

Many web components keep their `ElementInternals` in a private field and name themselves, set their states or give themselves a role through it:

```js
class SubscribeCheckbox extends HTMLElement {
  #internals = this.attachInternals();
  constructor() {
    super();
    this.#internals.ariaLabel = 'Subscribe';
    this.#internals.ariaChecked = 'false';
  }
}
```

The browser exposes that name, but no page script can read it back, so by default the scan asks about such a component (`cantTell`) instead of judging it. A component that's a `switch` only through `this.#internals.role` isn't even asked about: the scan doesn't see its role, so it isn't checked at all.

`A11yCoreBuilder.installInternalsHook(browser)` installs `@surea11y/core`'s opt-in hook, which records each component's internals for the scan to read. It has to run before the page's own scripts, so it uses:

- **`browser.addInitScript()`** when the session speaks WebDriver BiDi (WebdriverIO 9's default): Chrome, Edge and Firefox;
- otherwise, on **Chrome and Edge**, the DevTools protocol through chromedriver (`Page.addScriptToEvaluateOnNewDocument`). That covers the classic sessions this README [recommends for scanning](#a-note-on-the-protocol-prefer-classic-webdriver-for-this-workload), and WebdriverIO 8.

Either way it runs in every frame and after each navigation. Call it **before** `browser.url()`:

```js
await A11yCoreBuilder.installInternalsHook(browser); // 'bidi' or 'cdp'
await browser.url('https://example.com/');

const results = await new A11yCoreBuilder({ browser }).analyze();
results.engine.environment.internalsHook; // 'early': the hook ran before the page's scripts
```

In the WDIO testrunner, call it in a `before` hook. With it, the checkbox above passes, an unnamed component that attaches internals fails like any unnamed control, and the switch is checked as a switch, so it fails without a name. It resolves to `'bidi'` or `'cdp'`, the way it was installed.

- **A classic session on Firefox or Safari** has no way to run a script before the page loads: the call rejects. There, such components stay questions, and roles set through internals aren't checked. A BiDi session reaches Firefox.
- **Before the page loads.** On a page that's already loaded, the call has no effect until the next navigation (a refresh will do), and the result has no `internalsHook`.
- **For test and audit runs.** The hook wraps `HTMLElement.prototype.attachInternals` (components get the same internals back), adds a stack frame to errors thrown through it, and keeps its record under a global symbol, where any script on the page can read every component's internals. That's why it's opt-in.
- **Without it**, `analyze()` says so once per scan when it asked about such components (`1 custom element was asked about because the scan could not read...`), and `getScanNotes()` gives that note as `kind: 'internals-hook'`.

### Click handlers added from script: the listener hook

Most pages add their click handlers from script, where no page script can list them afterwards:

```html
<div class="save" role="button" tabindex="0">Save</div>
<script>
  document.querySelector('.save').addEventListener('click', save);
</script>
```

Enter and Space don't fire `click` on a `<div>`, so this button does nothing from the keyboard. Without help the scan can't see the listener, so `click-handler-keyboard-operable` doesn't report the element at all. `A11yCoreBuilder.installListenerHook(browser)` installs `@surea11y/core`'s opt-in listener hook (core 1.14.0 and later), which records the click, key, focus and mouse listeners a page adds, so the keyboard rules judge them. It installs as [the internals hook](#web-components-the-internals-hook) does, in the same sessions: through `browser.addInitScript()` in a BiDi session, through the DevTools protocol on Chrome and Edge in a classic one, and it rejects a classic session on Firefox or Safari. It resolves to `'bidi'` or `'cdp'`. Call it **before** `browser.url()` (in the WDIO testrunner, in a `before` hook):

```js
await A11yCoreBuilder.installListenerHook(browser); // before browser.url()
await browser.url('https://example.com/');

const results = await new A11yCoreBuilder({ browser }).analyze();
results.engine.environment.listenerHook; // 'early'
```

With it, the button above fails (`CLICK_HANDLER_NO_KEY_LISTENER`: no key listener anywhere a key event from it goes), and `mouse-only-event-handlers` and `widget-keyboard-focusable` count the listeners too. Only a hook installed before the page's scripts (`'early'`) proves a listener is missing; one installed later is `'late'`, and the rules then only ask. On a page that's already loaded, the call has no effect until the next navigation. It wraps `addEventListener`, `removeEventListener` and the `on…` setters, with the page getting the same results and errors, and keeps its record under a global symbol: install it for test and audit runs. Without it, `getScanNotes()` gives a `'listener-hook'` note when findings it would have decided were judged without it. Core's [`INTEGRATION.md`](https://github.com/SureA11y/core/blob/main/docs/INTEGRATION.md#seeing-listeners-added-from-script-the-listener-hook) has the details, and its binding authors' guide the reason codes each hook decides.

### Live regions: the live-region hook and announcements()

`A11yCoreBuilder.installLiveRegionHook(browser)` installs `@surea11y/core`'s opt-in live-region hook (core 1.14.0 and later), which records what the page's live regions are given while it runs. The scan then asks about a region added with its text already in it, and one shown and filled at once, which screen readers commonly don't announce. It installs as the internals hook does, in the same sessions, and resolves to `'bidi'` or `'cdp'`. And `A11yCoreBuilder.announcements(browser)` returns what the page made available to announce, so a spec can check that an action told the user something:

```js
await A11yCoreBuilder.installLiveRegionHook(browser); // before browser.url()
await browser.url('https://example.com/settings');

await $('#save').click();
const said = await A11yCoreBuilder.announcements(browser);
// [{ text: 'Saved', politeness: 'polite', time: 1234.5, order: 7, behindModal: false, selector: '#status' }]
assert.ok(said.some((a) => a.text === 'Saved'));
```

Each entry names its region by `selector` (and `shadowHostSelectors` inside a shadow root; `null` for a region that has since left the page, such as a toast). It's `null` without the hook. `announcements()` reads the top-level page: called while the browser is switched into a frame, it switches back to the top-level page first and leaves the browser there, as `.frames(true)` does. A text given to a region behind an open modal dialog, which assistive technology did not get, is left out unless you pass `{ includeBehindModal: true }`, and comes marked `behindModal: true`. This is what the page made available to announce, not what a screen reader said. The hook only observes, with one `MutationObserver`; see core's [`INTEGRATION.md`](https://github.com/SureA11y/core/blob/main/docs/INTEGRATION.md#seeing-what-live-regions-are-given-the-live-region-hook).

### Forced colors

A page shown in forced colors (Windows high contrast) draws in the user's colors, not its own. `results.engine.environment.forcedColors` says which it was: `'active'` or `'none'`. To check a page under forced colors on purpose in Chrome or Edge, emulate it through chromedriver's DevTools commands before scanning, in a classic or a BiDi session:

```js
await browser.sendCommand('Emulation.setEmulatedMedia', {
  features: [{ name: 'forced-colors', value: 'active' }]
});
const results = await new A11yCoreBuilder({ browser }).analyze();
results.engine.environment.forcedColors; // 'active'
await browser.sendCommand('Emulation.setEmulatedMedia', { features: [] }); // back to normal
```

`browser.sendCommand()` is one of WebdriverIO's Chromium commands, so there's no equivalent for Firefox or Safari. The contrast rules still measure the page's own colors under forced colors, since WCAG judges contrast in those, so results match a scan with forced colors off; a contrast finding the engine couldn't measure that way carries `details.forcedColors: true`. When forced colors were active, `formatFailures()` adds a line saying so, since it's easy to miss on a CI agent with high contrast turned on.

### Dark mode and phone width: scans under conditions

A page can fail differently in dark mode or at phone width: text that reads well on white fails contrast on a dark background, and a target big enough at 1280 pixels shrinks at 320. `.conditions()` scans the page as it is, then under each condition, and returns one result:

```js
const results = await new A11yCoreBuilder({ browser })
  .conditions([{ colorScheme: 'dark' }, { width: 320 }, { colorScheme: 'dark', width: 320 }])
  .analyze();
```

A condition sets a color scheme (`'light'` or `'dark'`), a viewport width in CSS pixels, or both. On Chrome and Edge both go through the DevTools protocol (`browser.sendCommandAndGetResult()` with `Emulation.setEmulatedMedia` and `Emulation.setDeviceMetricsOverride`, keeping the height), in classic and BiDi sessions. `browser.emulate('colorScheme')` isn't used: it changes what `matchMedia()` answers, not the page's CSS. In other browsers a width resizes the window by as much, and a color scheme can't be set: `.analyze()` rejects before any scan. The viewport, window and color scheme are put back after the last scan, even when one throws: the scheme is set to the one the page was in (`'light'` or `'dark'`), so a page scanned light stays light on a machine set to dark mode.

- A rule's outcome is its worst across the scans, so a contrast failure only in dark mode fails the rule.
- An occurrence is listed once per element, rule and reason code, with the `conditions` it appeared under (`['default', 'dark']`); `formatFailures()` prints them as `seen in: default, dark`.
- `results.conditionRuns` lists each scan's condition and `engine.environment`.

Each condition is a full scan, so three conditions take about four times as long as one scan. `.frames(true)` can't be combined with `.conditions()` yet. A picture taken with `.screenshots()` under a condition has the condition in its file name.

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

A custom rule you turn off for one scan (`.withCustomRules(rules).disableRules('org-banner-text')`) is listed in `skippedCustomRules` with `excluded: true` and isn't a scan gap, so it isn't warned about (core 1.12.0 and later).

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
- **A custom rule that did not run**, listed with its reason in `results.skippedCustomRules`. One you excluded yourself with `.disableRules()` is listed too, with `excluded: true`, and isn't a gap.
- **A pack that did not run**, listed with its reason in `results.skippedPacks` (see [Scanning with packs](#scanning-with-packs-standards-checklists-and-your-own-rules)).

`analyze()` prints each of these with `console.warn`, and `getScanGaps(results)` returns them as `[{ kind, message, ... }]` (`kind` is `context-not-found`, `context-partly-not-found`, `custom-rule-skipped` or `pack-skipped`), so a gate can fail on them, as the E2E example above does. `formatFailures(results)` lists them too.

That warning is the right default for a test run. A project that already handles gaps itself can take them over with `.logger(fn)`: `fn(gap, result)` is called once per gap, with the gap as `getScanGaps()` gives it and the result of the frame it came from, instead of `console.warn`. A scanning service that shows gaps to its users, say, can send them once to its own structured log, rather than also printing a loose line on the server's console for every scan:

```js
const results = await new A11yCoreBuilder({ browser })
  .include('#checkout')
  .logger((gap, frame) => log.warn({ url: frame.url, kind: gap.kind }, gap.message))
  .analyze();
```

A batch job that writes `getScanGaps(results)` into its own report can pass `.logger(() => {})` to keep its output to the report, and `.logger(null)` brings `console.warn` back. Anything other than a function or `null` throws a `TypeError` at the call, and a later call replaces the logger. Either way, `getScanGaps(results)` still lists every gap.

`getScanNotes(results)` says how the page was scanned, which a gap doesn't cover, and nothing was left out: `'forced-colors'` when the page was shown in [forced colors](#forced-colors), `'internals-hook'` when the scan asked about web components it could have read with the [internals hook](#web-components-the-internals-hook), and `'listener-hook'` or `'live-region-hook'` when findings that the [listener hook](#click-handlers-added-from-script-the-listener-hook) or the [live-region hook](#live-regions-the-live-region-hook-and-announcements) would have decided were judged without it (with `findingCount` and the `rules`). `analyze()` also prints each hook note, once per scan, and a `.logger()` receives it (check `kind` to tell a note from a gap).

### Checking against EN 301 549

EN 301 549, the standard the European Accessibility Act refers to, restates WCAG's Level A and AA criteria in its chapter 9. `.options({ profile })` runs the rules for its version, and each finding carries its EN 301 549 clause beside its WCAG criterion, in `meta.normativeMappings` (WCAG 1.1.1 is clause 9.1.1.1):

```js
// EN 301 549 V4.1.1 (WCAG 2.2 A and AA); 'en301549-v3.2.1' for V3.2.1 (WCAG 2.1 A and AA)
const results = await new A11yCoreBuilder({ browser })
  .options({ profile: 'en301549-v4.1.1' })
  .analyze();

results.engine.profile; // 'en301549-v4.1.1'
```

`.withWcag()`, `.withRules()` and `.withTags()` select rules instead of a profile, so leave them out when scanning with one. As with any target, a scan with no failures means no rule found a violation, not that the page conforms: most criteria need a person to check them. A profile name core doesn't know is not an error: the scan runs without it, core warns in the page's console, and `results.engine.profile` is left out.

### Scanning with packs: standards, checklists and your own rules

A pack brings rules, variants of core's rules, a standard or a checklist, and their profiles and messages, from a package of its own: a national standard such as RGAA, or your organisation's accessibility policy. `@surea11y/core` runs a pack as it runs its own rules and standards, so its results, rollups and report entries look like core's. Packs need `@surea11y/core` 1.11.1 or later.

Install a published pack in your project, beside core and this package:

```bash
npm install @surea11y/core @surea11y/webdriverio webdriverio @acme/a11y-policy
```

Your project, this package and the pack then share one copy of core, so the core that checks the pack is the one that runs it. With two copies, a scan can skip the pack (see "When a pack doesn't run" below).

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

**When a pack doesn't run.** `.withPacks()` builds the page's script with the `@surea11y/core` this binding loads, and checks each pack as it does: `.analyze()` throws before scanning for a pack that core can't run, such as one whose `core` range leaves out the installed core, or whose profile names a rule that doesn't exist. A pack the page then doesn't run (one named with a raw `.options({ packs })` and never registered, or a page running another core version, when two copies of core are installed) is listed in `results.skippedPacks` with the reason. `getScanGaps()` reports that as `'pack-skipped'`, and `.analyze()` warns about it, so a test gate that asserts on `getScanGaps(results)` fails rather than passing with the pack's checks never run.

### Style sheets from another origin

A page's script can't read the rules of a style sheet served from another origin (a CDN, a fonts service), so a check that reads the CSS, such as `css-orientation-lock`, can't tell whether it holds an orientation lock and asks about it. With `@surea11y/core` 1.14.0 or later, `.analyze()` asks the page which sheets it can't read, fetches them from Node (without the browser's cookies), and gives core their text, which it then checks. It's on by default; each request is given up after five seconds, and a sheet that can't be fetched leaves the check asking as before. To send no request but the page's own:

```js
await new A11yCoreBuilder({ browser }).fetchStyleSheets(false).analyze();
```

### Element addressing beyond a CSS selector

Every occurrence already carries `selector` and (with `.elementRef(true)`, above) a live `element`. It also carries `structuralPath` — a sibling-index path from the document root down to the flagged element (e.g. `[1, 0, 2]`) — a more robust identity than a selector string alone, since it survives some DOM changes a selector wouldn't (an id/class rename, for instance). No opt-in needed; it's already on every `fail`/`cantTell` occurrence today.

An element inside a shadow tree is different: its `selector` holds only inside its shadow root, its `shadowHostSelectors` lists the shadow hosts that lead to it (outermost first), and its `structuralPath` is `null`. `formatOccurrenceLocation(occurrence)` joins them as `host >>> selector` for display. See [`OUTPUT_SCHEMA.md`](https://github.com/SureA11y/core/blob/main/docs/OUTPUT_SCHEMA.md) for the full field description.

## TypeScript

`src/A11yCoreBuilder.d.ts` (re-exported from `src/index.d.ts`, wired up via `package.json`'s `types` field) ships types for the whole builder API plus `@surea11y/core`'s native result shapes (`A11yCoreResult`, `CheckResult`, `Occurrence`, `CompositeResult`, etc.). The result shapes are built on the types `@surea11y/core` ships itself, so fields such as `engine.version`, `engine.environment`, `contextMatch`, `skippedCustomRules`, `margin` and `shadowHostSelectors` follow the engine; this package adds `occurrence.element` and the `.frames(true)` shape. `EngineError`, `EngineErrorCode`, `ScanGap` and `ScanNote` come from `@surea11y/binding-base`, and so do the types of `withWcag()` and `wcagLevel()` (`WcagVersion`, `WcagLevelInput`), `plannedChecks()`/`plannedCriteria()` (`PlannedCheck`, `PlannedCriterion`), `withPacks()`, which takes a pack made with `definePack` (`PackLike`), and `.screenshots()` (`ScreenshotOptions`, and `OccurrenceScreenshot` for an occurrence's `screenshot`). The static `installInternalsHook()`, `installListenerHook()` and `installLiveRegionHook()` (each resolving to `'bidi' | 'cdp'`), the static `announcements()`, resolving to `LocatedAnnouncement[] | null`, and `getScanNotes()` are typed too, and `formatFailures()` takes the review groups (`ReviewGroup`), `howToCheck` and `failOnSeverity`; `LocatedAnnouncement` and `ReviewGroup` come from `@surea11y/binding-base`. `getGatingFailures()`, `SEVERITIES`, `.conditions()` (`ScanCondition`) and a merged result's `conditionRuns` and `occurrence.conditions` are typed as well. Code that handles every `ScanGap` kind it knows and treats the rest in an `else` branch needs a branch for `'pack-skipped'`, which carries `pack` rather than `selectors`. `analyze()` is typed `Promise<A11yCoreResult | A11yCoreMultiFrameResult>` — narrow on `'topFrame' in results` (or cast, if you already know which mode you called) to get the specific shape back, since a fluent builder can't statically track that `.frames(true)` was called earlier in the chain. `occurrence.element` is typed `WebdriverIO.Element | null`. `webdriverio` is a `peerDependencies` entry (not just `devDependencies`) since the class's `browser` argument and `Occurrence#element` both come from its global `WebdriverIO` type namespace — consumers need their own `webdriverio` install for the types to resolve, same as they already do to construct a `browser` in the first place.

## What changes with `@surea11y/core` 1.14

With `@surea11y/core` 1.14.0, what a scan through this binding shows differently (core's [`CHANGELOG.md`](https://github.com/SureA11y/core/blob/main/CHANGELOG.md) has the full list):

- **Roles that depend on context.** `aria-allowed-attr` no longer fails `aria-expanded` on a text input whose `list` names a `<datalist>` (a combobox), and now judges `<td>`: `cell` in a table, `gridcell` in a grid. `label-in-name` checks a `<td>` in a grid. `heading-order` and `page-has-heading-one` count a heading marked `role="none"` that can take focus or has a global ARIA attribute, as browsers do.
- **Style sheets from another origin are checked.** `.analyze()` fetches, from Node, the style sheets the page can't read and core checks them, so `css-orientation-lock` finds a lock in a CDN's CSS instead of asking (`.fetchStyleSheets(false)` turns it off). [More](#style-sheets-from-another-origin).
- **Criteria are `notApplicable` only where the rules see every case.** A WCAG rollup whose rules all found nothing is now `cantTell` (`reasonCode` `composite.rollup.cantTell.partialCoverage`), except for 1.3.5, 2.4.3, 2.4.4, 2.4.7, 2.4.9, 2.5.3, 2.5.8, 3.3.2 and 4.1.1, whose rules find every link, field, focusable element, target or id. A gate that asserted a criterion `notApplicable` now sees `cantTell`.
- **New checks.** `click-handler-keyboard-operable` (2.1.1, 2.1.3) fails an inline `onclick` on an element the keyboard can't reach, and asks about one that has no key handler. `widget-keyboard-focusable` (2.1.1) asks about a widget Tab never reaches; `focus-not-removed-by-script` (2.1.1, 2.4.7) fails an element whose `onfocus` only blurs it; `invalid-field-error-message` (3.3.1) asks about a field marked `aria-invalid` whose error message can't be reached; `live-region-announcements` (4.1.3) asks about a live region hidden with `aria-hidden` or `inert`, or left `aria-busy`; `aria-owns-valid` fails an element owned twice. `moving-content-pausable` (2.2.2) asks about content that moves by itself for more than five seconds. The messages of `click-handler-keyboard-operable` and `mouse-only-event-handlers` now say "click handler" rather than "onclick handler".
- **Placeholders below the contrast ratio fail** when the page chose their colours; in the browser's own colours they pass. They used to be questions.
- **More questions in some places**, fewer in others: `css-hidden-focus` asks about a link in a closed off-canvas menu or a container clipped to nothing; contrast is measured over solid backgrounds, empty background layers, `::before` strips and drop shadows it used to ask about; `link-name-quality` knows more French generic phrases.
- **Questions lean, and say how to answer them.** A `cantTell` occurrence can carry a `lean` (which way the evidence points, and why) and carries `howToCheck` (the steps to answer it), which `analyze()` adds. `formatFailures()` lists findings in the order a review takes and shows both. [More](#findings-that-need-review-leans-and-how-to-check).
- **Two more opt-in hooks.** With [`installListenerHook(browser)`](#click-handlers-added-from-script-the-listener-hook), `click-handler-keyboard-operable` judges a click listener added with `addEventListener` as an inline `onclick`, and fails a focusable control that no key listener can reach (`CLICK_HANDLER_NO_KEY_LISTENER`); `mouse-only-event-handlers` asks about pointer listeners added from script. With [`installLiveRegionHook(browser)`](#live-regions-the-live-region-hook-and-announcements), `live-region-announcements` (4.1.3) also asks about a region added with its text or shown and filled at once, and `A11yCoreBuilder.announcements(browser)` returns what the page's live regions were given. Both install where the internals hook does. Without either, a scan note says which findings it would have decided.
- **Some reason codes are split by cause** (`LIST_ITEM_ROLE_OVERRIDDEN`, `LIST_ROLE_OVERRIDDEN`, `DUPLICATE_ID_IN_SHADOW_TREE`, `DEFAULT_LANG_INVALID`, `IMAGE_ONLY_CONTROL_CONTENT`, `HEADING_LIKE_NUMBER`, `HEADING_LIKE_LINK`). Core's baselines still match a 1.13 entry to its finding under the new code, and `migrateBaselineEntries()` rewrites a baseline; see core's [`BASELINE.md`](https://github.com/SureA11y/core/blob/main/docs/BASELINE.md#upgrading).

## What changes with `@surea11y/core` 1.12

This release needs `@surea11y/core` 1.12.0. What a scan through this binding shows differently (core's [`CHANGELOG.md`](https://github.com/SureA11y/core/blob/main/CHANGELOG.md) has the full list):

- **An empty heading now fails an unscoped scan.** `empty-heading` used to ask about a heading with no accessible name; it now fails it. It's a best practice, so it runs in a scan that selects nothing and with `.withBestPractices()`, not under `.withWcag()`, tags or a profile. A gate on a page with `<h2></h2>` that asserted no failures now fails: fix the heading, or scan a WCAG target.
- **Scans that pick rules report their criteria.** `.withRules('img-alt-present')`, a non-WCAG tag or `.withBestPractices()` now fill `rulesResults` with the WCAG criteria those rules belong to, where it was empty. A criterion whose other rules weren't selected is `cantTell` (`reasonCode` `composite.rollup.cantTell.notSelectedChild`), and each check's `rollupIds` names the criteria it was added for. `.wcagLevel()` keeps those criteria to a level.
- **Four rules count towards more criteria**, as W3C's ACT rules map them: `input-image-alt-present` adds 4.1.2, `aria-roles-valid` 1.3.1, `link-name-present` 2.4.9 (AAA), and `meta-refresh-timing-absent` 2.2.4 and 3.2.5 (AAA). The findings don't change; the 1.3.1 and 4.1.2 rollups can now fail where they passed.
- **Unnamed custom elements are questions.** A defined custom element with no visible name may name itself through `ElementInternals`, so it's `cantTell` (`name_internals`) where it used to fail. [`installInternalsHook()`](#web-components-the-internals-hook) lets the engine decide, where the session allows it.
- **`engine.wcagLevel`** records the level a scan was gated by, and [`.wcagLevel()`](#composing-the-rule-filters) sets it.
- **`engine.environment.forcedColors`** records whether the page was in [forced colors](#forced-colors).
- **A custom rule you exclude** isn't a scan gap any more, so `.disableRules()` of one prints no warning.
- **Rule IDs in another case select their rule**: `.withRules('IMG-ALT-PRESENT')` used to throw `INVALID_RUN_ONLY` or be ignored.
- **`runOnly.optInTags` on its own throws** `INVALID_RUN_ONLY`; it was accepted and did nothing. Opt-in rules are unlocked with `.options({ optInRules })`.
- **A finding in a shadow tree is located through its hosts**, as `#card >>> img`, in core's HTML report, SARIF, JUnit and baselines, as `formatFailures()` already did.
- **An inline `policyContract`** with an unknown value in `allowedOutcomes` or `allowedConfidence` drops that value with a warning, where it turned every check into `cantTell`.

## What changes with `@surea11y/core` 1.11

The binding passes rule IDs, tags and options through to the engine, so these show in results without a change here (see core's [`CHANGELOG.md`](https://github.com/SureA11y/core/blob/main/CHANGELOG.md) for the full list):

- **Messages are reworded** in all five languages to say plainly what is wrong and what to do (`This <img> has no alt attribute.`). Message keys, rule IDs, reason codes and baselines are unchanged; a test that matches message text needs the new wording.
- **Contrast and target size measure what is on screen.** In a browser, the contrast rules check only text a reader can see, measure it against what is painted under it, and measure form field values and placeholders. `target-size-minimum` measures the area a pointer can hit, and exempts only links in a sentence. Expect new findings, and some old ones gone.
- **`aria-hidden-focus` maps to 4.1.2 only**, no longer to 2.4.7 Focus Visible, so `.withTags('wcag2aa')` alone no longer selects it.
- **A custom rule counts toward its WCAG criterion.** A `.withCustomRules()` rule with `meta.wcagSc` (or a WCAG `normativeMappings` entry) fails that criterion's rollup when it fails, and custom rules run after core's.
- **On/off options read as meant**: `.options({ perfStats: 'false' })` is off, where it was on. `.options({ strictOptions: true })` rejects any option the engine doesn't read (see [When a scan can't run as asked](#when-a-scan-cant-run-as-asked)).

## Relationship to `@surea11y/playwright` and `@surea11y/puppeteer`

This binding's builder API is deliberately the same shape as [`@surea11y/playwright`](https://github.com/SureA11y/playwright)'s and `@surea11y/puppeteer`'s — same method names, same mutability contract, same result shapes — so the accessibility-gate logic reads almost identically across all three. The state-accumulation half of the builder (`include`/`exclude`/`withTags`/`disableTags`/`withRules`/`disableRules`/`withWcag`/`withBestPractices`/`includeMode`/`wcagLevel`/`logger`/`options`/`withCustomRules`/`withPacks`/`reportOnly`) is not copied across bindings — `A11yCoreBuilder` here extends `A11yCoreBuilderBase` from [`@surea11y/binding-base`](https://github.com/SureA11y/binding-base), the single shared implementation every sibling binding depends on.

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
