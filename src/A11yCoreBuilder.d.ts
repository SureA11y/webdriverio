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
  /** Merge arbitrary engineOptions (locale, contrast.mode, policyContract, ...). */
  options(partialEngineOptions: Record<string, unknown>): this;
  /** Register one or more custom rules for just this scan. Call multiple times to accumulate. */
  withCustomRules(rules: CustomRuleDescriptor | CustomRuleDescriptor[]): this;
  /** Post-filter checksResults down to only the given outcomes. */
  reportOnly(outcomes: Outcome | Outcome[]): this;
  /** Opt in to also scanning every sub-frame on the page (including cross-origin and nested iframes). */
  frames(enabled?: boolean): this;
  /** Opt in to resolving each fail/cantTell occurrence's selector to a live WebdriverIO.Element. */
  elementRef(enabled?: boolean): this;

  /**
   * Runs the scan. Returns { topFrame, frames } instead of a single result
   * when .frames(true) was used. Rejects with an `EngineError` (from
   * `@surea11y/binding-base`, re-exported here) whose `code` is
   * `INVALID_RUN_ONLY` when a rule or tag list names nothing @surea11y/core
   * knows, or `INVALID_CONTEXT_SELECTOR` (with `selector`) when an include()
   * selector does not parse.
   */
  analyze(): Promise<A11yCoreResult | A11yCoreMultiFrameResult>;
}

/**
 * Formats a result, or its checksResults array, into a short, human-readable
 * block -- one entry per fail/cantTell occurrence, not per rule. Given the
 * whole result, it also lists what the scan left out (an include() scope
 * that matched nothing, a custom rule that did not run) and the
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
