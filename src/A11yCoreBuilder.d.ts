// Pull in WebdriverIO's global type augmentation (WebdriverIO.Browser /
// WebdriverIO.Element live on a `declare global { namespace WebdriverIO }`,
// not as named module exports) -- see webdriverio's own build/types.d.ts.
import type {} from 'webdriverio';

// The result shapes come from @surea11y/core's own types (shipped since
// 1.9.0 and checked there against real scan results), so they follow the
// engine instead of a copy here. This file adds what the binding puts on
// top: the `element` field .elementRef(true) attaches, and the
// { topFrame, frames } shape of .frames(true). The names below are the ones
// this file has always exported.
import type * as Core from '@surea11y/core';
import type { PackLike, WcagVersion, WcagLevelInput, ScanGap, ScanNote, PlannedCheck, PlannedCriterion, ScreenshotOptions, OccurrenceScreenshot } from '@surea11y/binding-base';
export type { PackLike, WcagVersion, WcagLevel, ScreenshotOptions, ScreenshotSkip, ScreenshotBox, OccurrenceScreenshot } from '@surea11y/binding-base';

export type Outcome = Core.Outcome;
export type OutcomeNormalized = Core.OutcomeNormalized;
export type Severity = Core.Severity;
export type Confidence = Core.Confidence;
export type RuleType = Core.RuleType;
export type Category = Core.RuleMeta['category'];
/** An open set: core can add a value in a minor release. */
export type LocaleResolutionReason = Core.LocaleResolution['reason'];
export type LocaleResolution = Core.LocaleResolution;
/** `engine.version` is the @surea11y/core release that produced the result (1.10.0 and later). */
export type EngineInfo = Core.EngineInfo;
export type RenderingEnvironment = Core.RenderingEnvironment;
export type NormativeMapping = Core.NormativeMapping;
export type CheckResultMeta = Core.RuleMeta;
export type VisibilityFilter = Core.VisibilityFilter;
/** How close a rule's closest passing measurement came to its threshold (`CheckResult.margin`). */
export type Margin = Core.Margin;
/** How the include() scope resolved; `elementCount: 0` means nothing was scanned. */
export type ContextMatch = Core.ContextMatch;
export type CompositeResult = Core.CompositeResult;
export type CompositeResultDetails = Core.CompositeResult['data']['details'];
export type EngineOptions = Core.EngineOptions;

/**
 * An occurrence as @surea11y/core reports it. One inside a shadow tree
 * carries `shadowHostSelectors` and a `structuralPath` of null; its
 * `selector` holds only inside the last host's shadow root.
 */
export interface Occurrence extends Core.Occurrence {
  /**
   * Only present when `.elementRef(true)` was used. `null` when this
   * occurrence has no single target element (`selector` is `""`) or no
   * element matches it any more -- see A11yCoreBuilder#elementRef. Found
   * through `shadowHostSelectors` for an element in a shadow tree. Named
   * `element` (a `WebdriverIO.Element`), not `elementHandle` as in the
   * Puppeteer/Playwright bindings -- WebdriverIO has no "handle" concept. A
   * sub-frame occurrence's element is only usable while the browser is
   * switched into that frame.
   */
  element?: WebdriverIO.Element | null;
  /**
   * Only present when `.screenshots()` was used and this occurrence's own
   * outcome is one it pictures: the picture, or why there is none. The
   * occurrences about the same element share one object.
   */
  screenshot?: OccurrenceScreenshot;
}

export interface CheckResult extends Omit<Core.CheckResult, 'occurrences'> {
  occurrences: Occurrence[];
}

/**
 * @surea11y/core's native top-level result shape -- see its
 * docs/OUTPUT_SCHEMA.md. Since 1.10.0 it also says how the include() scope
 * resolved (`contextMatch`) and which custom rules did not run
 * (`skippedCustomRules`).
 */
export interface A11yCoreResult extends Omit<Core.ScanResult, 'checksResults'> {
  checksResults: CheckResult[];
}

/** A sub-frame that couldn't be scanned (detached, navigated away, or sandboxed). */
export interface A11yCoreFrameError {
  url: string | null;
  error: string;
}

/** Returned by analyze() when .frames(true) is enabled, instead of a single A11yCoreResult. */
export interface A11yCoreMultiFrameResult {
  topFrame: A11yCoreResult;
  frames: Array<A11yCoreResult | A11yCoreFrameError>;
}

/**
 * A runtime-registered rule descriptor for `.withCustomRules()` -- the same
 * shape as an internal surea11y rule module's own export (see surea11y's
 * docs/ENGINE_OPTIONS.md). `runInPage`/`applicability` may be passed as
 * either a real function or a function-source string -- `.withCustomRules()`
 * converts a live function to its source string for you, since it must
 * cross a browser.execute() serialization boundary that cannot carry a live
 * Function reference.
 */
export interface CustomRuleDescriptor {
  id: string;
  meta?: {
    title?: string;
    description?: string;
    tags?: string[];
    defaultSeverity?: Severity;
    defaultConfidence?: Confidence;
    [key: string]: unknown;
  };
  runInPage: ((ctx: unknown) => unknown) | string;
  applicability?: ((ctx: unknown) => boolean) | string;
  data?: Record<string, unknown>;
}

export class A11yCoreBuilder {
  /**
   * @param opts.browser A WebdriverIO Browser (from `remote()` or the WDIO
   *   testrunner's global `browser`), already navigated to and settled at the
   *   URL to scan -- this class does not navigate for you.
   */
  constructor(opts: { browser: WebdriverIO.Browser; url?: string });

  /**
   * Installs @surea11y/core's opt-in internals hook, so a scan can read
   * names, states and roles web components set through a private
   * ElementInternals. Call it before browser.url(). Uses addInitScript()
   * in a BiDi session, else the DevTools protocol on Chrome and Edge, else
   * rejects. Resolves to the way it was installed.
   */
  static installInternalsHook(browser: WebdriverIO.Browser): Promise<'bidi' | 'cdp'>;

  /**
   * Installs @surea11y/core's opt-in listener hook (core 1.14.0 and later),
   * so the keyboard rules see the listeners a page adds from script. Call it
   * before browser.url(); installed as installInternalsHook() is. Resolves to
   * the way it was installed.
   */
  static installListenerHook(browser: WebdriverIO.Browser): Promise<'bidi' | 'cdp'>;

  /**
   * Installs @surea11y/core's opt-in live-region hook (core 1.14.0 and
   * later): live-region-announcements then also asks about a live region
   * added with its text already in it, or shown and filled at once, and
   * getAnnouncements() reads what the page made available to announce. Call
   * it before browser.url(); installed as installInternalsHook() is.
   */
  static installLiveRegionHook(browser: WebdriverIO.Browser): Promise<'bidi' | 'cdp'>;

  /**
   * What the current page's live regions were given while shown and
   * reachable, as the live-region hook recorded it, in order; null without
   * the hook. Not what a screen reader said. Needs core 1.14.0 and
   * binding-base 1.6.0.
   */
  static getAnnouncements(
    browser: WebdriverIO.Browser
  ): Promise<Array<{ text: string; politeness: 'polite' | 'assertive'; time: number }> | null>;

  /**
   * Scope the scan to one region. Call multiple times for a multi-region
   * union. A selector that matches nothing scans nothing (see
   * `contextMatch`); with .frames(true) the scope applies to the top frame
   * only and each sub-frame is scanned whole.
   */
  include(selector: string): this;
  /**
   * Skip elements matching this selector anywhere in the scanned scope.
   * With `opts.rules`, scopes the exclusion to just the named rule ID(s)
   * instead of globally -- on top of, not instead of, any global exclusions
   * from other `.exclude(selector)` calls.
   */
  exclude(selector: string, opts?: { rules?: string | string[] }): this;
  /**
   * Only run rules carrying at least one of these tags. Like the three
   * methods below, throws a TypeError with `code: 'INVALID_RUN_ONLY'` for
   * anything but a string or an array of strings.
   */
  withTags(tags: string | string[]): this;
  /** Never run rules carrying any of these tags (applied after withTags). */
  disableTags(tags: string | string[]): this;
  /** Only run these specific rule IDs (accepts with or without the  prefix). */
  withRules(ruleIds: string | string[]): this;
  /** Never run these specific rule IDs (applied after withRules). */
  disableRules(ruleIds: string | string[]): this;
  /**
   * Run the rules for a WCAG conformance target: `withWcag('2.2', 'AA')`
   * runs those of WCAG 2.2's A and AA criteria. withTags()/withRules() add
   * to them. A later call replaces the target.
   */
  withWcag(version: WcagVersion | 2.0 | 2.1 | 2.2, level?: WcagLevelInput): this;
  /** Also run the best-practice rules, those that name no WCAG criterion. */
  withBestPractices(enabled?: boolean): this;
  /**
   * How withRules() and withTags() combine when both are given: 'and' (the
   * default) runs the rules matching both, 'or' those matching either. A
   * later call replaces the mode.
   */
  includeMode(mode: 'and' | 'or'): this;
  /**
   * The WCAG level of the criteria the scan reports, without changing which
   * rules run: `.withRules('contrast-computable').wcagLevel('AA')` reports
   * 1.4.3 and not 1.4.6. Any case; null clears it. A later call replaces it.
   */
  wcagLevel(level: WcagLevelInput | null): this;
  /**
   * Where analyze() sends each scan gap instead of console.warn: called once
   * per gap, with the result of the frame it came from, and once per scan
   * for each of the internals-hook and listener-hook notes (tell them apart
   * by `kind`). `() => {}`
   * silences them, `null` goes back to console.warn. A later call replaces it.
   */
  logger(fn: ((entry: ScanGap | ScanNote, result: A11yCoreResult) => void) | null): this;
  /** Merge arbitrary engineOptions (locale, contrast.mode, policyContract, ...). */
  options(partialEngineOptions: Record<string, unknown>): this;
  /** Register one or more custom rules for just this scan. Call multiple times to accumulate. */
  withCustomRules(rules: CustomRuleDescriptor | CustomRuleDescriptor[]): this;
  /**
   * Packs from `@surea11y/core/pack` (core 1.11 or later): registered in each
   * frame before the scan, and named in `engineOptions.packs`.
   */
  withPacks(packs: PackLike | PackLike[]): this;
  /** Post-filter checksResults down to only the given outcomes. */
  reportOnly(outcomes: Outcome | Outcome[]): this;
  /** Opt in to also scanning every sub-frame on the page (including cross-origin and nested iframes). */
  frames(enabled?: boolean): this;
  /** Opt in to resolving each fail/cantTell occurrence's selector to a live WebdriverIO.Element. */
  elementRef(enabled?: boolean): this;
  /**
   * Opt in to a picture of each element the scan flags, on its occurrences'
   * `screenshot` field: a Buffer, or a file in `dir`. `false` turns them
   * off. Throws a TypeError with code 'INVALID_ENGINE_OPTIONS' for an option
   * it can't use.
   */
  screenshots(options?: ScreenshotOptions | boolean): this;
  /**
   * Fetch, from Node, the style sheets the page can't read (another origin's)
   * and give core their text, so checks that read the CSS can check them. On
   * by default; needs @surea11y/core 1.14.0 or later.
   */
  fetchStyleSheets(enabled?: boolean): this;
  /** The rules this scan will run, worked out in Node with no page (@surea11y/core 1.12.0 and later). */
  plannedChecks(): PlannedCheck[];
  /** The criteria this scan will report in rulesResults, worked out in Node with no page. */
  plannedCriteria(): PlannedCriterion[];

  /**
   * Runs the scan. Returns { topFrame, frames } instead of a single result
   * when .frames(true) was used. Rejects with an `EngineError` (from
   * `@surea11y/binding-base`, re-exported here) whose `code` is
   * `INVALID_RUN_ONLY` when a rule or tag list names nothing @surea11y/core
   * knows, `INVALID_CONTEXT_SELECTOR` (with `selector`) when an include()
   * selector does not parse, `INVALID_ENGINE_OPTIONS` for an option
   * `strictOptions: true` rejects, or `PAGE_BUILTINS_BROKEN` when the page's
   * scripts broke a JavaScript built-in the engine relies on.
   */
  analyze(): Promise<A11yCoreResult | A11yCoreMultiFrameResult>;
}

/**
 * Formats a result, or its checksResults array, into a short, human-readable
 * block -- one entry per fail/cantTell occurrence, not per rule. Given the
 * whole result, it also lists what the scan left out (an include() scope
 * that matched nothing, a custom rule or a pack that did not run) and the
 * @surea11y/core release that produced it. Meant for an assertion
 * library's failure-message parameter, e.g.
 * `assert.strictEqual(fails.length, 0, formatFailures(results))`.
 * Throws a TypeError for anything else, such as a .frames(true) result:
 * format `topFrame` and each entry of `frames` on its own.
 */
export function formatFailures(
  input: A11yCoreResult | ReadonlyArray<CheckResult>,
  opts?: { outcomes?: Outcome[] }
): string;
