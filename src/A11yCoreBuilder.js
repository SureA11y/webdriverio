'use strict';

const { runa11yCoreInPage } = require('a11y-core');

// See a11y-core's docs/OUTPUT_SCHEMA.md -- the only valid `outcome` values a
// checksResults entry can carry.
const VALID_OUTCOMES = ['pass', 'fail', 'cantTell', 'notApplicable'];

// a11y-core revives a customRules runInPage/applicability STRING back into a
// function via `new Function('return (' + value + ')')()` (see its
// src/core/dom-runner.js) -- the exact same mechanism used here, in Node,
// purely to verify a candidate string will actually reconstruct before it
// ever crosses the browser.execute() boundary.
function canReconstructAsFunction(src) {
  try {
    // eslint-disable-next-line no-new-func
    return typeof new Function('return (' + src + ')')() === 'function';
  } catch (e) {
    return false;
  }
}

// Converts a live function to a source string a11y-core can revive on the
// page side. Function.prototype.toString() on an ES6 method-shorthand
// property (e.g. `{ runInPage(ctx) { ... } }`, the idiomatic way to write
// one of these descriptors, including `async`/generator variants) omits the
// `function` keyword entirely -- so the *exact same* revival mechanism
// a11y-core uses can't parse it back as a standalone expression. Verified
// with `canReconstructAsFunction` above (real check, not a regex guess at
// the syntax) and patched by re-adding `function ` when needed.
function toReconstructableSource(fn) {
  const direct = fn.toString();
  if (canReconstructAsFunction(direct)) return direct;
  const patched = direct.replace(/^(async\s+)?(\*\s*)?/, '$1function ');
  if (canReconstructAsFunction(patched)) return patched;
  // Some other shape neither form can reconstruct (e.g. a computed method
  // name) -- hand back the plain toString() anyway; a11y-core's own revival
  // will skip it the same way it always has for an unreconstructable
  // descriptor, rather than this method inventing a different failure mode.
  return direct;
}

/**
 * WebdriverIO binding for a11y-core -- scans a real, already-rendered page.
 *
 * const results = await new A11yCoreBuilder({ browser })
 *   .include('#main')
 *   .exclude('.cookie-banner')
 *   .withTags(['wcag2a', 'wcag2aa'])
 *   .disableRules(['a11ycore-meta-refresh-no-exceptions'])
 *   .options({ contrast: { mode: 'auditorAssist' } })
 *   .analyze();
 *
 * `results` is a11y-core's own native result shape (checksResults /
 * rulesResults -- see a11y-core's docs/OUTPUT_SCHEMA.md), not axe-core's
 * violations/passes/incomplete/inapplicable shape. Method names are modeled
 * on axe-core's AxeBuilder for migration ease, but the richer native schema
 * (severity, confidence, occurrences, policy contract, WCAG SC mappings) is
 * kept as-is rather than reshaped to match axe.
 *
 * `browser` is the object returned by WebdriverIO's `remote()` (standalone
 * mode) or the global `browser` inside the WDIO testrunner -- it must already
 * be navigated to and settled at the URL to scan; this class does not
 * navigate for you.
 *
 * Opt in to scanning every frame on the page (including cross-origin
 * iframes -- and nested iframes-within-iframes, recursively) via
 * .frames(true):
 *
 * const results = await new A11yCoreBuilder({ browser }).frames(true).analyze();
 * // results.topFrame        -- same shape as the single-frame case above
 * // results.frames          -- flat array of the same native result shape, one per sub-frame
 *
 * WebdriverIO's frame model is fundamentally different from Puppeteer's and
 * Playwright's. Those expose `page.frames()` -- an array of independent Frame
 * objects, each with its own `.evaluate()`/`.$()` -- so a binding can iterate
 * them freely. WebdriverIO instead has a single *stateful current context*:
 * `browser.switchFrame(iframeElement)` changes which document
 * `browser.execute()`/`browser.$()` run against, and `browser.switchFrame(null)`
 * returns to the top-level frame. There is no array of frame objects. So
 * `.frames(true)` here works by enumerating each context's direct-child
 * `<iframe>` elements with `browser.$$('iframe')`, switching into each with
 * `browser.switchFrame(el)`, scanning the now-current document, then
 * recursing into that frame's own children before returning to the parent
 * context (re-entered by the context id `switchFrame()` handed back on the
 * way in). Cross-origin iframes are reached with no extra work -- the
 * WebDriver/BiDi automation layer switches into them the same as same-origin
 * ones, exactly like Puppeteer/Playwright's CDP does; verified against a
 * real cross-origin frame (`https://example.org/`). See ../ROADMAP.md §2c.
 * Default off, so plain .analyze() keeps returning the single native result
 * object it always has.
 *
 * By default `analyze()` returns every rule's outcome, including
 * `pass`/`notApplicable` -- a11y-core's own deliberate "not a
 * violations-only list" design (see a11y-core's docs/OUTPUT_SCHEMA.md).
 * Opt in to a lighter payload with `.reportOnly(['fail', 'cantTell'])`,
 * which post-filters `checksResults` by `outcome` (applied per-frame when
 * combined with `.frames(true)`, since `checksResults` lives at
 * `results.topFrame` / each `results.frames[i]` in that shape, not at the
 * top level):
 *
 * const results = await new A11yCoreBuilder({ browser })
 *   .reportOnly(['fail', 'cantTell'])
 *   .analyze();
 *
 * Opt in to a live `WebdriverIO.Element` per occurrence (instead of just a
 * CSS selector string) with `.elementRef(true)`, attached as
 * `occurrence.element`, so you can act on the flagged element directly
 * (`.click()`, `.saveScreenshot()`, `.getProperty()`, ...) rather than
 * re-resolving its selector yourself:
 *
 * const results = await new A11yCoreBuilder({ browser }).elementRef(true).analyze();
 * const [firstFail] = results.checksResults.filter(r => r.outcome === 'fail');
 * await firstFail.occurrences[0].element.saveScreenshot('./flagged.png');
 *
 * NOTE the field is `occurrence.element` (a `WebdriverIO.Element`), not
 * Puppeteer/Playwright's `occurrence.elementHandle` -- WebdriverIO has no
 * "handle" concept, and its element API differs (`.getProperty('id')` rather
 * than `.evaluate(el => el.id)`, `.saveScreenshot(path)` rather than
 * `.screenshot({ path })`). See ../ROADMAP.md §2d and the README.
 *
 * Register your own rule(s) for just this scan with
 * `.withCustomRules([...])` (a11y-core's `engineOptions.customRules`
 * escape hatch, axe's `configure({ rules })` equivalent -- see
 * a11y-core's docs/ENGINE_OPTIONS.md). Pass a real, live `runInPage`/
 * `applicability` function -- unlike the raw `.options({ customRules })`
 * passthrough, this method converts them to the function-source string
 * a11y-core needs on this side of the browser.execute() serialization
 * boundary for you, so you don't have to remember to call .toString()
 * yourself:
 *
 * const results = await new A11yCoreBuilder({ browser })
 *   .withCustomRules({
 *     id: 'my-org-custom-rule',
 *     meta: { title: 'My custom rule', tags: ['custom'] },
 *     runInPage(ctx) {
 *       const el = ctx.document.querySelector('.my-widget');
 *       return el ? { outcome: 'fail', occurrences: [{ __node: el }] } : { outcome: 'notApplicable', occurrences: [] };
 *     }
 *   })
 *   .analyze();
 *
 * Create one builder per scan. This is a mutable object with no reset
 * between analyze() calls: include()/exclude()/withRules()/disableRules()/
 * withTags()/disableTags()/options()/withCustomRules() all push onto or
 * merge into internal state that persists for the instance's lifetime, so
 * calling one of them again before a second analyze() call accumulates on
 * top of the first scan's scope rather than replacing it (intentional for
 * "call include() several times for one scan" -- see above -- but a footgun
 * if you hold one instance across multiple assertions).
 * reportOnly()/frames()/elementRef() are the exception: each call replaces
 * the previous value rather than merging with it.
 */
class A11yCoreBuilder {
  /**
   * @param {{ browser: import('webdriverio').Browser, url?: string }} opts
   *   `browser` must already be navigated to and settled at the URL to scan --
   *   this class does not navigate for you.
   */
  constructor({ browser, url } = {}) {
    if (!browser || typeof browser.execute !== 'function') {
      throw new Error('A11yCoreBuilder requires { browser } (a WebdriverIO Browser, with an .execute() method).');
    }
    this._browser = browser;
    this._url = url || null;
    this._scanFrames = false;
    this._includeSelectors = [];
    this._excludeSelectors = [];
    this._includeRuleIds = [];
    this._excludeRuleIds = [];
    this._tags = [];
    this._excludeTags = [];
    this._engineOptions = {};
    this._reportOutcomes = null;
    this._elementRef = false;
    this._customRules = [];
  }

  /**
   * Scope the scan to one region. Call multiple times to scan several,
   * possibly disjoint regions in one run (a11y-core's contextSelector
   * accepts an array of selectors for exactly this -- see a11y-core's
   * docs/ENGINE_OPTIONS.md).
   */
  include(selector) {
    if (selector) this._includeSelectors.push(selector);
    return this;
  }

  /** Skip elements matching this selector anywhere in the scanned scope. */
  exclude(selector) {
    if (selector) this._excludeSelectors.push(selector);
    return this;
  }

  /** Only run rules carrying at least one of these tags. */
  withTags(tags) {
    this._tags = this._tags.concat(Array.isArray(tags) ? tags : [tags]);
    return this;
  }

  /** Never run rules carrying any of these tags (applied after withTags). */
  disableTags(tags) {
    this._excludeTags = this._excludeTags.concat(Array.isArray(tags) ? tags : [tags]);
    return this;
  }

  /** Only run these specific rule IDs (accepts with or without the a11ycore- prefix). */
  withRules(ruleIds) {
    this._includeRuleIds = this._includeRuleIds.concat(Array.isArray(ruleIds) ? ruleIds : [ruleIds]);
    return this;
  }

  /** Never run these specific rule IDs (applied after withRules). */
  disableRules(ruleIds) {
    this._excludeRuleIds = this._excludeRuleIds.concat(Array.isArray(ruleIds) ? ruleIds : [ruleIds]);
    return this;
  }

  /** Merge arbitrary engineOptions (locale, contrast.mode, policyContract, ...) -- see a11y-core's docs/ENGINE_OPTIONS.md. */
  options(partialEngineOptions) {
    this._engineOptions = { ...this._engineOptions, ...(partialEngineOptions || {}) };
    return this;
  }

  /**
   * Register one or more custom rules for just this scan (a11y-core's
   * engineOptions.customRules escape hatch -- see a11y-core's
   * docs/ENGINE_OPTIONS.md -- axe's configure({ rules }) equivalent). A
   * descriptor is { id, meta?, runInPage, applicability?, data? }, the same
   * shape as an internal a11y-core rule module's own export. Call multiple
   * times to register several rules across one scan (accumulates, same as
   * withRules()/withTags(), rather than replacing -- see this class's own
   * header comment on mutability).
   *
   * Unlike the raw `.options({ customRules })` passthrough, `runInPage`/
   * `applicability` may be passed as real, live functions here -- this
   * method converts each to a function-source string itself, since a
   * WebdriverIO browser.execute() argument crosses a serialization boundary
   * that cannot carry a live Function reference (a11y-core reconstructs the
   * string back into a function via `new Function` on the page side). A
   * string is still accepted as-is for callers who already have one. Plain
   * Function.prototype.toString() isn't quite enough on its own: an ES6
   * method-shorthand property (`{ runInPage(ctx) { ... } }` -- the idiomatic
   * way to write one of these, and what every example in this file's own
   * docs/tests uses) stringifies *without* the `function` keyword, which
   * a11y-core's own `new Function('return (' + value + ')')()` revival
   * can't parse back as a standalone expression. This method verifies
   * reconstructability the same way a11y-core will and patches that specific
   * case automatically, so you don't need to know about it.
   *
   * A descriptor whose `id` collides with a built-in rule overrides it for
   * that scan only (a11y-core's own semantics, matching axe's configure()
   * override behavior) -- nothing here persists past this one analyze() call
   * or mutates a11y-core's static rule catalog.
   */
  withCustomRules(rules) {
    const list = Array.isArray(rules) ? rules : [rules];

    // Validate the whole batch before normalizing/pushing any of it, so one
    // invalid descriptor later in the array can't leave an earlier valid one
    // partially registered -- same all-or-nothing spirit as reportOnly()'s
    // own validate-then-assign shape below.
    for (const rule of list) {
      if (!rule || typeof rule.id !== 'string' || !rule.id) {
        throw new Error('A11yCoreBuilder.withCustomRules(): each custom rule descriptor requires a non-empty string `id`.');
      }
      if (typeof rule.runInPage !== 'function' && (typeof rule.runInPage !== 'string' || !rule.runInPage)) {
        throw new Error(`A11yCoreBuilder.withCustomRules(): custom rule "${rule.id}" requires a \`runInPage\` function or function-source string.`);
      }
      if (rule.applicability !== undefined && typeof rule.applicability !== 'function' && (typeof rule.applicability !== 'string' || !rule.applicability)) {
        throw new Error(`A11yCoreBuilder.withCustomRules(): custom rule "${rule.id}"'s \`applicability\` must be a function or function-source string when provided.`);
      }
    }

    for (const rule of list) {
      const normalized = {
        ...rule,
        runInPage: typeof rule.runInPage === 'function' ? toReconstructableSource(rule.runInPage) : rule.runInPage
      };
      if (typeof rule.applicability === 'function') normalized.applicability = toReconstructableSource(rule.applicability);
      this._customRules.push(normalized);
    }
    return this;
  }

  /**
   * Post-filter `checksResults` down to only the given outcomes (e.g.
   * .reportOnly(['fail', 'cantTell']) to drop pass/notApplicable noise).
   * Binding-layer only -- a11y-core itself always computes every rule's
   * outcome; this just trims what analyze() hands back. Applied per-frame
   * when combined with .frames(true).
   */
  reportOnly(outcomes) {
    const list = Array.isArray(outcomes) ? outcomes : [outcomes];
    for (const outcome of list) {
      if (!VALID_OUTCOMES.includes(outcome)) {
        throw new Error(`A11yCoreBuilder.reportOnly(): invalid outcome "${outcome}" -- must be one of ${VALID_OUTCOMES.join(', ')}.`);
      }
    }
    this._reportOutcomes = list;
    return this;
  }

  /**
   * Opt in to resolving each fail/cantTell occurrence's `selector` to a live
   * `WebdriverIO.Element` (attached as `occurrence.element`), so callers can
   * `.click()`/`.saveScreenshot()`/`.getProperty()` the flagged element
   * directly instead of re-resolving `occurrence.selector` themselves
   * (fragile if the DOM shifted between the scan and when you act on it).
   * Default off -- resolving an element per occurrence costs a real page
   * query, so this stays opt-in. Uses `browser.$(selector)` against the
   * current context. Combines with `.frames(true)`: each frame's occurrences
   * are resolved against that frame's own document while the browser is
   * switched into it.
   *
   * WebdriverIO caveat (does NOT apply to Puppeteer/Playwright): because
   * WebdriverIO's element references are bound to whichever frame was the
   * current context when they were resolved, a *sub-frame* occurrence's
   * `element` is only usable while the browser is switched into that same
   * frame. After analyze() returns the browser is back at the top-level
   * frame, so to act on a sub-frame element you must `browser.switchFrame()`
   * back into its frame first. Top-frame occurrences have no such caveat.
   * See ../ROADMAP.md §2d.
   */
  elementRef(enabled = true) {
    this._elementRef = !!enabled;
    return this;
  }

  // Note: not every occurrence resolves to one element -- a page-wide
  // finding (e.g. some manual/cantTell rules) can carry `selector: ""`, in
  // which case `occurrence.element` is `null` rather than an element.

  /**
   * Opt in to also scanning every sub-frame on the page (including
   * cross-origin iframes and nested iframes-within-iframes -- see this
   * file's own header comment for how that maps onto WebdriverIO's stateful
   * switchFrame() context model). Default off; when off, analyze() returns
   * the same single native result object it always has. When on, analyze()
   * instead returns { topFrame, frames }.
   */
  frames(enabled = true) {
    this._scanFrames = !!enabled;
    return this;
  }

  /**
   * Runs the scan and returns a11y-core's native result object.
   * @returns {Promise<object>} see a11y-core's docs/OUTPUT_SCHEMA.md
   */
  async analyze() {
    const contextSelector = this._includeSelectors.length
      ? (this._includeSelectors.length === 1 ? this._includeSelectors[0] : this._includeSelectors)
      : null;

    const engineOptions = { ...this._engineOptions };
    if (this._customRules.length) {
      // Concatenated with, not replaced by, any customRules already present
      // via a raw .options({ customRules }) call, so the two ways of
      // registering a custom rule compose rather than one silently
      // clobbering the other.
      const existing = Array.isArray(this._engineOptions.customRules) ? this._engineOptions.customRules : [];
      engineOptions.customRules = existing.concat(this._customRules);
    }
    if (this._excludeSelectors.length) {
      engineOptions.excludeSelectors = this._excludeSelectors;
    }

    const hasRunOnly = this._includeRuleIds.length || this._excludeRuleIds.length || this._tags.length || this._excludeTags.length;
    const runOnly = hasRunOnly
      ? {
        includeRuleIds: this._includeRuleIds.length ? this._includeRuleIds : undefined,
        excludeRuleIds: this._excludeRuleIds.length ? this._excludeRuleIds : undefined,
        tags: this._tags.length ? this._tags : undefined,
        excludeTags: this._excludeTags.length ? this._excludeTags : undefined
      }
      : null;

    // Unlike Playwright's page.evaluate(fn, arg), which only accepts a
    // SINGLE argument (forcing a hand-built single-arg wrapper there),
    // WebdriverIO's browser.execute() is genuinely variadic:
    // execute<ReturnValue, InnerArguments extends unknown[]>(script, ...args)
    // (confirmed against a real webdriverio 9.x install's own
    // build/commands/browser/execute.d.ts). Like Puppeteer, that means
    // runa11yCoreInPage's own 4 positional args can be passed straight
    // through with no wrapper/eval() trick -- WebdriverIO serializes the
    // function itself. Verified empirically against a real headless Chrome
    // session before trusting it (this project's whole ethos, inherited
    // from a11y-core and its sibling bindings, is "verified against a real
    // run," not "reasoned about").
    //
    // Runs against whatever frame the browser is CURRENTLY switched into --
    // WebdriverIO's execute()/$ target the current context, a stateful model
    // unlike Puppeteer/Playwright's per-frame-object one. `.frames(true)`
    // orchestrates the switching (see _scanChildFrames).
    const scanCurrent = async () => {
      const frameUrl = this._url || (await this._browser.execute(() => document.location.href));
      const result = await this._browser.execute(runa11yCoreInPage, frameUrl, contextSelector, engineOptions, runOnly);
      return this._elementRef ? this._attachElementRefs(result) : result;
    };

    if (!this._scanFrames) {
      return this._applyReportOnly(await scanCurrent());
    }

    // Make sure we start from the top-level frame, whatever context the
    // caller happened to leave the browser in.
    await this._browser.switchFrame(null);
    const topFrame = this._applyReportOnly(await scanCurrent());

    const frames = [];
    await this._scanChildFrames([], scanCurrent, frames);

    // Leave the browser back at the top-level frame regardless of how the
    // traversal ended, so a caller's next command isn't silently running in
    // some leftover sub-frame context.
    await this._browser.switchFrame(null).catch(() => {});

    return { topFrame, frames };
  }

  /**
   * Depth-first traversal of the frame tree rooted at the context addressed
   * by `path` -- an array of child <iframe> indices from the top frame (so
   * `[]` is the top frame, `[0]` its first child, `[0, 2]` that child's third
   * child, and so on). Each direct child is navigated into, scanned, and
   * recursed through; every scanned frame at any depth is pushed onto the same
   * flat `out` array, matching the flat `frames` list Puppeteer/Playwright's
   * page.frames()-based bindings return.
   *
   * The traversal deliberately re-navigates from the top frame down for each
   * child (via _switchToPath) rather than caching a "handle" to return to.
   * That's what makes it protocol-agnostic: WebdriverIO's switchFrame()
   * returns a reusable BiDi context id under the default BiDi protocol but
   * `null` under the classic WebDriver protocol (`wdio:enforceWebDriverClassic`,
   * which this project's own tests/examples use -- see ../ROADMAP.md §2c/§4),
   * and `$$('iframe')` element references don't survive a context switch away
   * and back either. The one thing that reliably re-addresses a nested context
   * on both protocols is replaying `switchFrame(null)` then the chain of
   * `switchFrame(childElement)` down the index path, re-querying the iframes
   * fresh at each hop.
   */
  async _scanChildFrames(path, scanCurrent, out) {
    let childCount;
    try {
      const iframes = await this._browser.$$('iframe');
      childCount = iframes.length;
    } catch (e) {
      return; // can't enumerate this context's children -- nothing to recurse into
    }

    for (let i = 0; i < childCount; i++) {
      let frameUrl = null;
      try {
        // Re-establish this context from the top, then step into child i with
        // a freshly re-queried element reference.
        await this._switchToPath(path);
        const iframes = await this._browser.$$('iframe');
        await this._browser.switchFrame(iframes[i]);
        frameUrl = await this._browser.execute(() => document.location.href);
      } catch (e) {
        // A frame can detach/navigate away mid-scan, or be a sandboxed frame
        // the browser blocks switching into -- record it and move on rather
        // than aborting the whole multi-frame scan.
        out.push({ url: frameUrl, error: (e && e.message) || String(e) });
        continue;
      }

      try {
        out.push(this._applyReportOnly(await scanCurrent()));
      } catch (e) {
        out.push({ url: frameUrl, error: (e && e.message) || String(e) });
      }

      // We're currently switched into child i -- recurse into ITS children.
      await this._scanChildFrames(path.concat(i), scanCurrent, out);
    }
  }

  /**
   * Switches the browser into the context addressed by `path` (array of child
   * <iframe> indices from the top frame) by replaying switchFrame(null) then
   * one switchFrame(childElement) per hop, re-querying $$('iframe') fresh at
   * each level. Protocol-agnostic -- see _scanChildFrames.
   */
  async _switchToPath(path) {
    await this._browser.switchFrame(null);
    for (const index of path) {
      const iframes = await this._browser.$$('iframe');
      await this._browser.switchFrame(iframes[index]);
    }
  }

  /** Filters a single native result object's checksResults per .reportOnly(), if set. */
  _applyReportOnly(result) {
    if (!this._reportOutcomes || !result || !Array.isArray(result.checksResults)) return result;
    return {
      ...result,
      checksResults: result.checksResults.filter((r) => this._reportOutcomes.includes(r.outcome))
    };
  }

  /**
   * Resolves occurrence.selector to a live WebdriverIO.Element for every
   * fail/cantTell occurrence, scoped to whatever frame the browser is
   * currently switched into (browser.$ is stateful on the current context).
   * Mutates and returns the same result object -- it's a fresh object from
   * this scan, not shared external state.
   */
  async _attachElementRefs(result) {
    if (!Array.isArray(result.checksResults)) return result;
    for (const check of result.checksResults) {
      if (!Array.isArray(check.occurrences) || !check.occurrences.length) continue;
      for (const occurrence of check.occurrences) {
        // Most occurrences carry a concrete element selector, but a page-wide
        // finding with no single target element (e.g. some `manual`/cantTell
        // rules) can carry "" -- leave `element` null rather than passing ""
        // to browser.$(), which throws ("invalid selector: No selector
        // specified") on WebdriverIO, unlike Puppeteer/Playwright's .$("")
        // which resolves to null. Verified against a real run.
        occurrence.element = occurrence.selector ? await this._browser.$(occurrence.selector) : null;
      }
    }
    return result;
  }
}

module.exports = { A11yCoreBuilder };
