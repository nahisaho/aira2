import { describe, expect, it } from 'vitest';
import { reportReadiness } from './readiness.js';

/** @id TEST-EXAMPLE-001
 * @verifies REQ-EXAMPLE-001
 */
describe('readiness reporting', () => {
  it('TEST-EXAMPLE-001 reports pass only when every configured check passes, fail if any check fails, and skipped when no evidence is configured', () => {
    expect(reportReadiness([]).overall).toBe('skipped');

    expect(
      reportReadiness([
        { name: 'typecheck', status: 'pass' },
        { name: 'test', status: 'pass' },
      ]).overall,
    ).toBe('pass');

    expect(
      reportReadiness([
        { name: 'typecheck', status: 'pass' },
        { name: 'test', status: 'fail', detail: 'assertion failed' },
      ]).overall,
    ).toBe('fail');

    expect(
      reportReadiness([
        { name: 'typecheck', status: 'pass' },
        { name: 'mutation', status: 'skipped' },
      ]).overall,
    ).toBe('skipped');
  });
});
