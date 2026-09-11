export type ReadinessStatus = 'pass' | 'fail' | 'skipped';

export interface ReadinessCheck {
  name: string;
  status: ReadinessStatus;
  detail?: string;
}

export interface ReadinessReport {
  overall: ReadinessStatus;
  checks: ReadinessCheck[];
}

/** @id CODE-EXAMPLE-001
 * @implements REQ-EXAMPLE-001
 * @design DES-EXAMPLE-001
 * Aggregates explicit readiness evidence without inventing success: any
 * failing check makes the overall result fail; missing (empty) evidence
 * is reported as skipped, never as a passing result.
 */
export function reportReadiness(checks: ReadinessCheck[]): ReadinessReport {
  if (checks.length === 0) {
    return { overall: 'skipped', checks };
  }
  const overall: ReadinessStatus = checks.some((check) => check.status === 'fail')
    ? 'fail'
    : checks.every((check) => check.status === 'pass')
      ? 'pass'
      : 'skipped';
  return { overall, checks };
}
