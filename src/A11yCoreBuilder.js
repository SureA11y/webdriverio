'use strict';

const {
  runa11yCoreInPage,
  internalsHookScript,
  listenerHookScript,
  liveRegionHookScript,
  getAnnouncements
} = require('@surea11y/core');
const {
  A11yCoreBuilderBase,
  createInPageScan,
  rethrowEngineError,
  queryOccurrenceElement,
  planScreenshots,
  cropViewportScreenshot,
  createInPageAnnouncements
} = require('@surea11y/binding-base');

// core's runa11yCoreInPage, wrapped so an engine error (INVALID_RUN_ONLY,
// INVALID_CONTEXT_SELECTOR) keeps its `code` across browser.execute(),
// which carries only an error's message. Self-contained, so WebdriverIO
// serializes it exactly as it serialized runa11yCoreInPage.
const inPageScan = createInPageScan(runa11yCoreInPage);

// Runs `getSource()`'s script in every frame of the browser's pages, before
// their own scripts and after each navigation: browser.addInitScript() when
// the session speaks WebDriver BiDi (WebdriverIO 9's default), else the
// DevTools protocol's Page.addScriptToEvaluateOnNewDocument through
// chromedriver on Chrome and Edge. Any other session is rejected. `method`
// names the static method in its errors. Resolves to 'bidi' or 'cdp'.
async function installBeforeLoad(browser, method, getSource) {
  if (!browser || typeof browser.execute !== 'function') {
    throw new TypeError(`A11yCoreBuilder.${method}() requires a WebdriverIO browser.`);
  }
  const source = getSource();
  if (browser.isBidi && typeof browser.addInitScript === 'function') {
    // addInitScript() takes a function, and sends its source as a BiDi
    // preload script.
    await browser.addInitScript(new Function(source));
    return 'bidi';
  }
  if (typeof browser.sendCommandAndGetResult === 'function') {
    await browser.sendCommandAndGetResult('Page.addScriptToEvaluateOnNewDocument', { source });
    return 'cdp';
  }
  throw new Error(
    `A11yCoreBuilder.${method}(): this session has no way to run a script before the page loads. ` +
    'Use a WebDriver BiDi session (WebdriverIO 9\'s default, in Chrome, Edge or Firefox), or Chrome or Edge, ' +
    'whose DevTools protocol can.'
  );
}

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
 * Or let the scan take a picture of each element it flags, with
 * `.screenshots()` (@surea11y/binding-base's, see its README): each
 * occurrence gets a `screenshot` field, the picture (a Buffer, or a file in
 * `dir`) or why there is none. The element is scrolled into view and marked
 * with a box drawn over the page, and the page is put back afterwards; in
 * every frame with `.frames(true)`, including cross-origin ones:
 *
 * const results = await new A11yCoreBuilder({ browser })
 *   .screenshots({ dir: 'a11y-shots', padding: 16 })
 *   .analyze();
 * // results.checksResults[i].occurrences[j].screenshot
 * //   -> { path: 'a11y-shots/element-3f9a1c07.png', box: { x, y, width, height } }
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
 * withTags()/disableTags()/options()/withCustomRules()/withPacks() all push onto or
 * merge into internal state that persists for the instance's lifetime, so
 * calling one of them again before a second analyze() call accumulates on
 * top of the first scan's scope rather than replacing it (intentional for
 * "call include() several times for one scan" -- see above -- but a footgun
 * if you hold one instance across multiple assertions).
 * reportOnly()/frames()/elementRef()/screenshots()/withWcag()/withBestPractices()
 * are the exception: each call replaces the previous value rather than
 * merging with it.
 */
class A11yCoreBuilder extends A11yCoreBuilderBase {
  /**
   * Installs @surea11y/core's opt-in internals hook, so a scan can read the
   * names, states and roles web components set through a private
   * ElementInternals. Call it before browser.url(). It uses:
   *
   * - browser.addInitScript() when the session speaks WebDriver BiDi
   *   (WebdriverIO 9's default);
   * - otherwise, on Chrome and Edge, the DevTools protocol through
   *   chromedriver (Page.addScriptToEvaluateOnNewDocument, sent with
   *   browser.sendCommandAndGetResult()), as in a WebdriverIO 8 or
   *   classic session.
   *
   * Both run the script in every frame of the page, before its scripts, and
   * after each navigation. Any other session gets an error saying it has no
   * way to run a script before the page loads. Resolves to the way it was
   * installed, 'bidi' or 'cdp'.
   * @param {WebdriverIO.Browser} browser
   * @returns {Promise<'bidi' | 'cdp'>}
   */
  static async installInternalsHook(browser) {
    return installBeforeLoad(browser, 'installInternalsHook', () => internalsHookScript());
  }

  /**
   * Installs @surea11y/core's opt-in listener hook (core 1.14.0 and later),
   * so the keyboard rules see the click, key, focus and mouse listeners a
   * page adds from script (addEventListener, or an onclick-style property),
   * not only inline handler attributes. Call it before browser.url(). It is
   * installed as installInternalsHook() is: browser.addInitScript() in a
   * BiDi session, else the DevTools protocol on Chrome and Edge, else it
   * rejects. Resolves to the way it was installed, 'bidi' or 'cdp'.
   * @param {WebdriverIO.Browser} browser
   * @returns {Promise<'bidi' | 'cdp'>}
   */
  static async installListenerHook(browser) {
    return installBeforeLoad(browser, 'installListenerHook', () => {
      if (typeof listenerHookScript !== 'function') {
        throw new TypeError('A11yCoreBuilder.installListenerHook() needs @surea11y/core 1.14.0 or later, which has listenerHookScript().');
      }
      return listenerHookScript();
    });
  }

  /**
   * Installs @surea11y/core's opt-in live-region hook (core 1.14.0 and
   * later), which records what the page's live regions are given from the
   * load event on: live-region-announcements then asks about a region added
   * with its text already in it, or shown and filled at once, and
   * getAnnouncements() reads what the page made available to announce. Call
   * it before browser.url(). It is installed as installInternalsHook() is.
   * Resolves to the way it was installed, 'bidi' or 'cdp'.
   * @param {WebdriverIO.Browser} browser
   * @returns {Promise<'bidi' | 'cdp'>}
   */
  static async installLiveRegionHook(browser) {
    return installBeforeLoad(browser, 'installLiveRegionHook', () => {
      if (typeof liveRegionHookScript !== 'function') {
        throw new TypeError('A11yCoreBuilder.installLiveRegionHook() needs @surea11y/core 1.14.0 or later, which has liveRegionHookScript().');
      }
      return liveRegionHookScript();
    });
  }

  /**
   * What the current page's live regions were given while shown and
   * reachable by assistive technology, as the live-region hook recorded it:
   * [{ text, politeness, time }] in the order the page did it, or null when
   * the page has no hook. What the page made available to announce, not what
   * a screen reader said. Reads the frame the browser is switched to.
   * @param {WebdriverIO.Browser} browser
   * @returns {Promise<Array<{ text: string, politeness: 'polite' | 'assertive', time: number }> | null>}
   */
  static async getAnnouncements(browser) {
    if (!browser || typeof browser.execute !== 'function') {
      throw new TypeError('A11yCoreBuilder.getAnnouncements() requires a WebdriverIO browser (with an .execute() method).');
    }
    if (typeof getAnnouncements !== 'function' || typeof createInPageAnnouncements !== 'function') {
      throw new TypeError('A11yCoreBuilder.getAnnouncements() needs @surea11y/core 1.14.0 and @surea11y/binding-base 1.6.0 or later.');
    }
    const read = createInPageAnnouncements(getAnnouncements);
    return browser.execute(`return (${read.toString()})();`);
  }

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
    // `path` is the frame being scanned, as _scanChildFrames addresses it
    // ([] for the top-level page); the screenshots step needs it to reach
    // the frame again, and its parents.
    const scanCurrent = async (scope, path) => {
      const frameUrl = this._url || (await this._browser.execute(() => document.location.href));
      if (packScript) await this._browser.execute(packScript);
      // The text of the style sheets the frame can't read, fetched from Node
      // (binding-base 1.6.0 and core 1.14.0; nothing with older ones), in the frame
      // the browser is in.
      const frameEngineOptions =
        typeof this._styleSheetEngineOptions === 'function'
          ? await this._styleSheetEngineOptions(null, engineOptions)
          : engineOptions;
      const result = rethrowEngineError(
        await this._browser.execute(inPageScan, frameUrl, scope, frameEngineOptions, runOnly)
      );
      this._warnScanGaps(result, '@surea11y/webdriverio');
      // Element references first: they are resolved in the current frame,
      // which the screenshots step switches away from.
      if (this._elementRef) await this._attachElementRefs(result);
      if (this._screenshots) await this._screenshotFrame(result, path);
      return result;
    };

    // .conditions() (binding-base 1.6.0): the page as it is, then under each
    // condition, merged into one result.
    if (this._conditions) {
      return this._applyReportOnly(
        await this._scanUnderConditions(() => scanCurrent(contextSelector, null), this._conditionDriver())
      );
    }

    if (!this._scanFrames) {
      // Whatever frame the caller left the browser in; the screenshots step
      // can place pictures only from the top-level page (see
      // _screenshotFrame), and null says so.
      return this._applyReportOnly(await scanCurrent(contextSelector, null));
    }

    // The top frame is scanned first, so an INVALID_RUN_ONLY or
    // INVALID_CONTEXT_SELECTOR error is thrown from it, before any sub-frame.
    const topFrame = this._applyReportOnly(await scanCurrent(contextSelector, []));

    // Sub-frames are scanned whole: the include() scope belongs to the top
    // frame's document (see the class comment).
    const frames = [];
    await this._scanChildFrames([], (childPath) => scanCurrent(null, childPath), frames);

    // Leave the browser back at the top-level frame regardless of how the
    // traversal ended, so a caller's next command isn't silently running in
    // some leftover sub-frame context.
    await this._browser.switchFrame(null).catch(() => {});

    return { topFrame, frames };
  }

  /**
   * The driver steps .conditions() scans need. On Chrome and Edge, the
   * DevTools protocol (browser.sendCommandAndGetResult(), chromedriver's
   * own endpoint, in classic and BiDi sessions) sets the viewport's width
   * (Emulation.setDeviceMetricsOverride, its height kept) and the color
   * scheme (Emulation.setEmulatedMedia); browser.emulate('colorScheme')
   * only answers matchMedia() and leaves the page's CSS as it was.
   * Elsewhere a width resizes the window by as much, and a color scheme
   * can't be set: that is refused before any scan. Each condition sets
   * both, from the page as it was; at the end the overrides are cleared,
   * the window size put back, and the page left dark if it was dark before
   * (a scheme emulated by the caller, or the system's).
   */
  _conditionDriver() {
    const browser = this._browser;
    const cdp = browser.isChromium !== false && typeof browser.sendCommandAndGetResult === 'function';
    const send = (cmd, params) => browser.sendCommandAndGetResult(cmd, params);
    let viewport = null;
    let size = null;
    let widthSet = false;
    let schemeSet = false;
    // The scheme a condition without one goes back to.
    let baseScheme = '';
    const scheme = (value) => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value }] });
    const resetWidth = () =>
      cdp ? send('Emulation.clearDeviceMetricsOverride', {}) : browser.setWindowSize(size.width, size.height);
    return {
      save: async () => {
        if (!cdp && this._conditions.some((c) => c.colorScheme)) {
          throw new Error(
            'A11yCoreBuilder.conditions(): a colorScheme needs Chrome or Edge, whose DevTools protocol can emulate it; ' +
            'this session has no browser.sendCommandAndGetResult().'
          );
        }
        const before = await browser.execute(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
          dark: window.matchMedia('(prefers-color-scheme: dark)').matches
        }));
        viewport = { width: before.width, height: before.height };
        baseScheme = before.dark ? 'dark' : '';
        if (!cdp) size = await browser.getWindowSize();
        return { viewport, size };
      },
      apply: async (condition) => {
        if (condition.width) {
          if (cdp) {
            await send('Emulation.setDeviceMetricsOverride', {
              width: condition.width,
              height: viewport.height,
              deviceScaleFactor: 0,
              mobile: false
            });
          } else {
            await browser.setWindowSize(size.width - viewport.width + condition.width, size.height);
          }
          widthSet = true;
        } else if (widthSet) {
          await resetWidth();
          widthSet = false;
        }
        if (condition.colorScheme) {
          await scheme(condition.colorScheme);
          schemeSet = true;
        } else if (schemeSet) {
          await scheme(baseScheme);
          schemeSet = false;
        }
      },
      restore: async (state) => {
        if (!state) return;
        if (widthSet) await resetWidth();
        if (schemeSet) await scheme(baseScheme);
      }
    };
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
        out.push(this._applyReportOnly(await scanCurrent(path.concat(i))));
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
   * binding-base's screenshots step for the frame at `path` (child <iframe>
   * indices from the top, as _scanChildFrames walks them), with the
   * <iframe>s leading to it given by index among `$$('iframe')`, the way
   * this binding counts frames: element references don't survive switching
   * away and back under BiDi. The step switches between frames as it goes,
   * so the browser is switched back into the scanned frame afterwards, where
   * the traversal goes on.
   *
   * `path` is null for a scan without .frames(true), which runs in whatever
   * frame the caller left the browser in. From the top-level page that is
   * `[]`; from inside a frame, nothing says how it sits on the page, so its
   * occurrences get `capture-failed` rather than misplaced pictures.
   */
  async _screenshotFrame(result, path) {
    if (path === null) {
      const atTop = await this._browser.execute(() => window === window.top).catch(() => false);
      if (!atTop) {
        const error = 'the browser was switched into a frame when analyze() ran; pictures are placed from the top-level page, so scan from there, with .frames(true) to include the frame';
        const { elements, unlocated } = planScreenshots(result, { outcomes: this._screenshots.outcomes });
        for (const element of elements) {
          const shot = { skipped: 'capture-failed', error };
          for (const occurrence of element.occurrences) occurrence.screenshot = shot;
        }
        for (const occurrence of unlocated) occurrence.screenshot = { skipped: 'no-element' };
        return;
      }
      path = [];
    }
    const framePath = path.map((index, depth) => ({ frame: path.slice(0, depth), iframe: { selector: 'iframe', index } }));
    try {
      await this._captureScreenshots(result, path, framePath);
    } finally {
      await this._switchToPath(path).catch(() => {});
    }
  }

  /** For binding-base's screenshots step: runs `fn(...args)` in the frame at `path`. */
  async _evaluateInFrame(path, fn, args) {
    // null: the frame the browser is in, as Selenium's binding reads it.
    if (path !== null) await this._switchToPath(path);
    return this._browser.execute(fn, ...args);
  }

  /**
   * For binding-base's screenshots step: a PNG of `box`, CSS pixels in the
   * top-level viewport, cut out of WebDriver's screenshot of that viewport,
   * which it takes whatever frame the browser is switched into.
   */
  async _captureBox(box, view) {
    return cropViewportScreenshot(await this._browser.takeScreenshot(), box, view);
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
