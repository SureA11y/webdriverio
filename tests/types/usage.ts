// Compiled by tests/types.test.js, never run: a typical use of this
// package's types beside @surea11y/core's own.
import {
  A11yCoreBuilder,
  formatFailures,
  getScanGaps,
  formatOccurrenceLocation,
  EngineError,
  ENGINE_ERROR_CODES
} from '../../src/index.js';
import type {
  A11yCoreResult,
  A11yCoreMultiFrameResult,
  CheckResult,
  EngineErrorCode,
  Occurrence,
  PackLike,
  ScanGap,
  WcagLevel,
  WcagVersion
} from '../../src/index.js';
import type { ScanResult } from '@surea11y/core';
import { definePack } from '@surea11y/core/pack';

declare const browser: WebdriverIO.Browser;

async function single(): Promise<void> {
  const result = (await new A11yCoreBuilder({ browser })
    .include('main')
    .withWcag('2.2', 'AA')
    .withBestPractices()
    .includeMode('or')
    .logger((gap, frame) => { void `${frame.url}: ${gap.kind} ${gap.message}`; })
    .withTags(['best-practice'])
    .withPacks(definePack({ name: '@acme/a11y-rules', version: '1.0.0', namespace: 'acme', core: '^1.11.1' }))
    .elementRef(true)
    .analyze()) as A11yCoreResult;

  const version: string = result.engine.version;
  const layout: boolean = result.engine.environment.layout;
  const scanned: boolean = result.contextMatch === null || result.contextMatch.elementCount > 0;
  const skipped: Array<{ id: string | null; reason: string }> = result.skippedCustomRules;

  const fails: CheckResult[] = result.checksResults.filter((r) => r.outcome === 'fail');
  for (const check of fails) {
    if (check.margin) {
      const headroom: number = check.margin.headroom;
      void headroom;
    }
    for (const occurrence of check.occurrences) {
      const path: number[] | null = occurrence.structuralPath;
      const hosts: string[] | undefined = occurrence.shadowHostSelectors;
      const element: WebdriverIO.Element | null | undefined = occurrence.element;
      const where: string = formatOccurrenceLocation(occurrence);
      void path; void hosts; void element; void where;
    }
  }

  // The binding's result is still core's result.
  const asCore: ScanResult = result;
  const gaps: ScanGap[] = getScanGaps(result);
  for (const gap of gaps) {
    if (gap.kind === 'custom-rule-skipped') {
      const id: string | null = gap.rule.id;
      void id;
    } else if (gap.kind === 'pack-skipped') {
      const name: string | null = gap.pack.name;
      void name;
    } else {
      const selectors: string[] = gap.selectors;
      void selectors;
    }
  }
  const message: string = formatFailures(result, { outcomes: ['fail'] });
  const fromChecks: string = formatFailures(result.checksResults);
  void version; void layout; void scanned; void skipped; void asCore; void gaps; void message; void fromChecks;
}

async function frames(): Promise<void> {
  const tree = (await new A11yCoreBuilder({ browser }).frames(true).analyze()) as A11yCoreMultiFrameResult;
  // @ts-expect-error a frames(true) tree is not one result
  formatFailures(tree);
  formatFailures(tree.topFrame);
  for (const frame of tree.frames) {
    if ('error' in frame) continue;
    const occurrences: Occurrence[] = frame.checksResults.flatMap((r) => r.occurrences);
    void occurrences;
  }
}

async function errors(): Promise<void> {
  try {
    await new A11yCoreBuilder({ browser }).withRules(['no-such-rule']).analyze();
  } catch (e) {
    if (e instanceof EngineError) {
      const code: EngineErrorCode | (string & {}) = e.code;
      const selector: string | null = e.selector;
      void code; void selector;
    }
  }
  const codes: EngineErrorCode[] = ENGINE_ERROR_CODES;
  const newer: EngineErrorCode[] = ['INVALID_ENGINE_OPTIONS', 'PAGE_BUILTINS_BROKEN'];
  const target: [WcagVersion, WcagLevel] = ['2.1', 'AAA'];
  const pack: PackLike = { name: '@acme/a11y-rules', version: '1.0.0' };
  await new A11yCoreBuilder({ browser }).withWcag(...target).withPacks([pack]).options({ strictOptions: true }).analyze();
  void codes; void newer;
}

void single; void frames; void errors;
