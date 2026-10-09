'use strict';

const { runa11yCoreInPage } = require('@surea11y/core');
const {
  A11yCoreBuilderBase,
  createInPageScan,
  rethrowEngineError,
  queryOccurrenceElement,
  getScanGaps
} = require('@surea11y/binding-base');

// core's runa11yCoreInPage, wrapped so an engine error (INVALID_RUN_ONLY,
// INVALID_CONTEXT_SELECTOR) keeps its `code` across browser.execute(),
// which carries only an error's message. Self-contained, so WebdriverIO
// serializes it exactly as it serialized runa11yCoreInPage.
const inPageScan = createInPageScan(runa11yCoreInPage);

/**
 * WebdriverIO binding for surea11y -- scans a real, already-rendered page.
 *
 * const results = await new A11yCoreBuilder({ browser })
 *   .include('#main')
 *   .exclude('.cookie-banner')
 *   .withTags(['wcag2a', 'wcag2aa'])
 *   .disableRules(['meta-refresh-no-exceptions'])
 *   .options({ contrast: { mode: 'auditorAssist' } })
 *   .analyze();
 *
 * `results` is @surea11y/core's own native result shape (checksResults /
 * rulesResults -- see ../core/docs/OUTPUT_SCHEMA.md), not the
 * violations/passes/incomplete/inapplicable shape used by other tools in
 * this space. Method names are modeled on common conventions in this space
 * for migration ease, but the richer native schema (severity, confidence,
 * occurrences, policy contract, WCAG SC mappings) is kept as-is rather than
 * reshaped to match.
 *
 * `browser` is the object returned by WebdriverIO's `remote()` (standalone
 * mode) or the global `browser` inside the WDIO testrunner -- it must already
 * be navigated to and settled at the URL to scan; this class does not
 * navigate for you.
 *
 * Extends `A11yCoreBuilderBase` (from `@surea11y/binding-base`), which owns
 * every method with no driver-specific work at all -- `include()`/
 * `exclude()`/`withTags()`/`disableTags()`/`withRules()`/`disableRules()`/
 * `options()`/`reportOnly()`/`elementRef()`/`frames()`/`withCustomRules()`'s
 * validation (including the default customRules stringification, correct
 * here since WebdriverIO's `browser.execute()` crosses a real serialization
 * boundary), and `_buildEngineArgs()`. This class adds exactly the parts
 * that are genuinely WebdriverIO-specific: `analyze()`'s injection
 * mechanics, the stateful index-path frame-traversal design below, and
 * `_attachElementRefs()`. See `../binding-base/README.md` for
 * what's shared and why.
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
 * real cross-origin frame (`https://example.org/`).
 * Default off, so plain .analyze() keeps returning the single native result
 * object it always has.
 *
 * An include() scope applies to the top frame only: each sub-frame is
 * scanned whole (contextSelector null), as @surea11y/core's own
 * runa11yCoreAcrossFrames does. Since core 1.10.0 a selector that matches
 * nothing scans nothing, so passing the top frame's scope down would leave
 * every frame that lacks it unscanned.
 *
 * By default `analyze()` returns every rule's outcome, including
 * `pass`/`notApplicable` -- @surea11y/core's own deliberate "not a
 * violations-only list" design (see ../core/docs/OUTPUT_SCHEMA.md).
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
 * `.screenshot({ path })`). See the README.
 *
 * Register your own rule(s) for just this scan with
 * `.withCustomRules([...])` (@surea11y/core's `engineOptions.customRules`
 * escape hatch -- see ../core/docs/ENGINE_OPTIONS.md). Pass a real,
 * live `runInPage`/
 * `applicability` function -- unlike the raw `.options({ customRules })`
 * passthrough, this method converts them to the function-source string
 * @surea11y/core needs on this side of the browser.execute() serialization
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
class A11yCoreBuilder extends A11yCoreBuilderBase {
  /**
   * @param {{ browser: import('webdriverio').Browser, url?: string }} opts
   *   `browser` must already be navigated to and settled at the URL to scan --
   *   this class does not navigate for you.
   */
  constructor({ browser, url } = {}) {
    super({ url });
    if (!browser || typeof browser.execute !== 'function') {
      throw new Error('A11yCoreBuilder requires { browser } (a WebdriverIO Browser, with an .execute() method).');
    }
    this._browser = browser;
  }

  /**
   * Runs the scan and returns @surea11y/core's native result object.
   * @returns {Promise<object>} see ../core/docs/OUTPUT_SCHEMA.md
   */
  async analyze() {
    const { contextSelector, engineOptions, runOnly } = this._buildEngineArgs();
    if (this._scanFrames) {
      // Make sure we start from the top-level frame, whatever context the
      // caller happened to leave the browser in.
      await this._browser.switchFrame(null);
    }

    // Unlike Playwright's page.evaluate(fn, arg), which only accepts a
    // SINGLE argument (forcing a hand-built single-arg wrapper there),
    // WebdriverIO's browser.execute() is genuinely variadic:
    // execute<ReturnValue, InnerArguments extends unknown[]>(script, ...args)
    // (confirmed against a real webdriverio 9.x install's own
    // build/commands/browser/execute.d.ts). Like Puppeteer, that means
    // the scan's 4 positional args can be passed straight through with no
    // single-arg wrapper -- WebdriverIO serializes the function itself.
    // Verified empirically against a real headless Chrome session before
    // trusting it (this project's whole ethos, inherited
    // from surea11y and its sibling bindings, is "verified against a real
    // run," not "reasoned about").
    //
    // Runs against whatever frame the browser is CURRENTLY switched into --
    // WebdriverIO's execute()/$ target the current context, a stateful model
    // unlike Puppeteer/Playwright's per-frame-object one. `.frames(true)`
    // orchestrates the switching (see _scanChildFrames).
    //
    // inPageScan takes the same four arguments as runa11yCoreInPage; an
    // engine error comes back as a plain object, which rethrowEngineError()
    // throws again here as an EngineError with its `code`.
    // The script that registers withPacks()'s packs in a frame, which the
    // scan names in engineOptions.packs; null without packs. execute() runs
    // a string as a function body, so the script runs as written.
    const packScript = this._packScript();
    const scanCurrent = async (scope) => {
      const frameUrl = this._url || (await this._browser.execute(() => document.location.href));
      if (packScript) await this._browser.execute(packScript);
      const result = rethrowEngineError(
        await this._browser.execute(inPageScan, frameUrl, scope, engineOptions, runOnly)
      );
      this._warnScanGaps(result);
      return this._elementRef ? this._attachElementRefs(result) : result;
    };

    if (!this._scanFrames) {
      return this._applyReportOnly(await scanCurrent(contextSelector));
    }

    // The top frame is scanned first, so an INVALID_RUN_ONLY or
    // INVALID_CONTEXT_SELECTOR error is thrown from it, before any sub-frame.
    const topFrame = this._applyReportOnly(await scanCurrent(contextSelector));

    // Sub-frames are scanned whole: the include() scope belongs to the top
    // frame's document (see the class comment).
    const frames = [];
    await this._scanChildFrames([], () => scanCurrent(null), frames);

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
   * which this project's own tests/examples use),
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

  /**
   * Prints what the scan left out (getScanGaps(): an include() scope that
   * matched nothing, a custom rule that did not run) with console.warn.
   * @surea11y/core warns about these too, but in the page's console, which a
   * WebdriverIO run does not show; a result whose checksResults alone look
   * clean would otherwise pass without a word.
   */
  _warnScanGaps(result) {
    let gaps;
    try {
      gaps = getScanGaps(result);
    } catch (e) {
      return; // not a scan result; the caller sees it as it is
    }
    const where = result.url ? ` (${result.url})` : '';
    for (const gap of gaps) {
      console.warn(`@surea11y/webdriverio${where}: ${gap.message}`);
    }
  }

  /**
   * Resolves each occurrence to a live WebdriverIO.Element, scoped to
   * whatever frame the browser is currently switched into (execute() is
   * stateful on the current context). Mutates and returns the same result
   * object -- it's a fresh object from this scan, not shared external state.
   *
   * The lookup runs in the page through binding-base's
   * queryOccurrenceElement(), which follows `shadowHostSelectors` (core
   * 1.10.0 and later): an occurrence inside a shadow tree has a `selector`
   * that holds only inside its shadow root, so browser.$(selector) found
   * another element or none. The element reference execute() returns is
   * wrapped with browser.$(), which makes no further WebDriver call.
   * `element` is null when the occurrence has no selector (a page-wide
   * finding can carry "") or nothing matches it any more.
   */
  async _attachElementRefs(result) {
    if (!Array.isArray(result.checksResults)) return result;
    for (const check of result.checksResults) {
      if (!Array.isArray(check.occurrences) || !check.occurrences.length) continue;
      for (const occurrence of check.occurrences) {
        if (!occurrence.selector) {
          occurrence.element = null;
          continue;
        }
        const ref = await this._browser.execute(
          queryOccurrenceElement,
          occurrence.selector,
          occurrence.shadowHostSelectors || null
        );
        occurrence.element = ref ? await this._browser.$(ref) : null;
      }
    }
    return result;
  }
}

module.exports = { A11yCoreBuilder };
