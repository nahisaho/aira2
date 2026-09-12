import { describe, expect, it } from 'vitest';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { GraphDbSupervisor } from './graphdb.js';

/** @id TEST-AIRA2-GRAPHRAG-006
 * @verifies REQ-GRAPHRAG-006
 */
describe('supervised aira-graphdb lifecycle', () => {
  it('TEST-AIRA2-GRAPHRAG-006 automatically restarts a crashed project db, preserving its indexed state and staying isolated from other projects', () => {
    const supervisor = new GraphDbSupervisor();
    const dbA = supervisor.ensureRunning('project-a');
    dbA.indexDocument({ documentId: 'doc-1', content: 'Alpha protocol content about Kinase enzymes.' }, 'model-1');
    const dbB = supervisor.ensureRunning('project-b');
    dbB.indexDocument({ documentId: 'doc-2', content: 'Beta protocol content.' }, 'model-1');

    expect(supervisor.restartCount('project-a')).toBe(0);
    supervisor.simulateCrash('project-a');
    expect(supervisor.isAlive('project-a')).toBe(false);
    expect(supervisor.isAlive('project-b')).toBe(true);

    const restarted = supervisor.ensureRunning('project-a');
    expect(supervisor.isAlive('project-a')).toBe(true);
    expect(supervisor.restartCount('project-a')).toBe(1);
    expect(restarted.stats().nodeCount).toBeGreaterThan(0);
    expect(restarted.getContent('doc-1')).toContain('Kinase');

    // project-b was never touched.
    expect(supervisor.restartCount('project-b')).toBe(0);
    expect(dbB.getContent('doc-1')).toBeUndefined();
  });
});

/** @id TEST-AIRA2-GRAPHRAG-007
 * @verifies REQ-RUNTIME-002
 */
describe('graphdb persistence across restarts', () => {
  it('TEST-AIRA2-GRAPHRAG-007 reloads a project graphdb from durable storage after constructing a new supervisor', () => {
    const baseDir = resolve('data/test-artifacts/graphdb-persistence');
    mkdirSync(dirname(baseDir), { recursive: true });
    rmSync(baseDir, { recursive: true, force: true });

    const first = new GraphDbSupervisor(baseDir);
    const db = first.ensureRunning('project-a');
    db.indexDocument({ documentId: 'doc-1', content: 'Persisted Kinase assay evidence.' }, 'model-1');

    const second = new GraphDbSupervisor(baseDir);
    const reopened = second.ensureRunning('project-a');
    expect(reopened.getContent('doc-1')).toContain('Persisted Kinase');
    expect(reopened.searchBm25('Kinase').map((candidate) => candidate.documentId)).toContain('doc-1');

    rmSync(baseDir, { recursive: true, force: true });
  });
});
