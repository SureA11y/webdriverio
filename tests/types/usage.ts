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
  ScanGap
} from '../../src/index.js';
import type { ScanResult } from '@surea11y/core';

declare const browser: WebdriverIO.Browser;

async function single(): Promise<void> {
  const result = (await new A11yCoreBuilder({ browser })
    .include('main')
    .withTags(['wcag2a', 'wcag2aa'])
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
  void codes;
}

void single; void frames; void errors;
