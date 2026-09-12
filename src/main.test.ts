// @vitest-environment jsdom

import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Aira2App } from './main.js';

type FetchResponse = { ok?: boolean; body: unknown; status?: number };

function jsonResponse({ ok = true, body, status = 200 }: FetchResponse): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const fetchCalls: Array<[string, string]> = [];

function installFetchMock() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method ?? 'GET';
      fetchCalls.push([method, url]);

      if (method === 'GET' && url === '/auth/methods') {
        return jsonResponse({ body: ['github-oauth', 'password', 'oidc'] });
      }
      if (method === 'POST' && url === '/auth/login/password') {
        return jsonResponse({ body: { id: 'session-1', accountId: 'member-1', issuedAt: 1, expiresAt: 2 } });
      }
      if (method === 'GET' && url === '/auth/session') {
        return jsonResponse({ body: { id: 'session-1', accountId: 'member-1', issuedAt: 1, expiresAt: 2 } });
      }
      if (method === 'GET' && url === '/credentials/self') {
        return jsonResponse({ body: [{ provider: 'openai', masked: '••••demo' }] });
      }
      if (method === 'GET' && url === '/projects/project-1/llm/backend') {
        return jsonResponse({ body: { providerId: 'openai', model: 'gpt-4o' } });
      }
      if (method === 'POST' && url === '/credentials/self/openai') {
        return jsonResponse({ body: { id: 'cred-1' } });
      }
      if (method === 'POST' && url === '/llm/default-backend') {
        return jsonResponse({ body: { status: 'ok' } });
      }
      if (method === 'POST' && url === '/projects/project-1/eln/protocols') {
        return jsonResponse({ body: { protocolId: 'protocol-1', protocolVersionId: 'version-1' } });
      }
      if (method === 'POST' && url === '/projects/project-1/eln/records') {
        return jsonResponse({ body: { recordId: 'record-1' } });
      }
      if (method === 'GET' && url === '/projects/project-1/eln/records/record-1') {
        return jsonResponse({ body: { recordId: 'record-1', versions: [{ recordVersionId: 'rv-1' }] } });
      }
      if (method === 'POST' && url === '/projects/project-1/graphrag/index') {
        return jsonResponse({ body: { status: 'ok' } });
      }
      if (method === 'GET' && url === '/projects/project-1/graphrag/stats') {
        return jsonResponse({ body: { documents: 1 } });
      }
      if (method === 'POST' && url === '/graphrag/query') {
        return jsonResponse({ body: { answer: 'Graph answer', citations: [{ sourceDocumentId: 'doc-1' }] } });
      }
      if (method === 'GET' && url === '/projects/project-1/authz-matrix') {
        return jsonResponse({ body: { 'eln.view': { owner: true } } });
      }
      if (method === 'POST' && url === '/projects/project-1/shares') {
        return jsonResponse({ body: { status: 'ok' } });
      }
      if (method === 'DELETE' && url === '/projects/project-1/shares/viewer-1') {
        return jsonResponse({ body: { status: 'ok' } });
      }
      if (method === 'POST' && url === '/projects/project-1/chat') {
        return jsonResponse({ body: { content: 'Chat reply' } });
      }

      return jsonResponse({ ok: false, status: 404, body: { error: `${method} ${url}` } });
    }),
  );
}

afterEach(() => {
  fetchCalls.length = 0;
  vi.unstubAllGlobals();
});

/** @id TEST-AIRA2-RUNTIME-006
 * @verifies REQ-RUNTIME-004
 */
describe('AIRA2 SPA', () => {
  it('TEST-AIRA2-RUNTIME-006 renders all six areas with live REST-backed data instead of placeholders', async () => {
    installFetchMock();
    render(React.createElement(Aira2App));

    expect(await screen.findByText('github-oauth')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'member-1' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));
    expect(await screen.findByText('Logged in as member-1')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'settings' }));
    expect(await screen.findByLabelText('Credential entries')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save credential' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set default backend' }));

    fireEvent.click(screen.getByRole('button', { name: 'eln' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create protocol' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create record' }));
    expect(await screen.findByLabelText('Record history')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'graphrag' }));
    fireEvent.click(screen.getByRole('button', { name: 'Index documents' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run query' }));
    expect((await screen.findByLabelText('Graph query result')).textContent).toContain('Graph answer');

    fireEvent.click(screen.getByRole('button', { name: 'projects' }));
    expect(await screen.findByLabelText('Authorization matrix')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Grant share' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke share' }));
    expect(await screen.findByText('Share status: ok')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect((await screen.findByLabelText('Chat response')).textContent).toContain('Chat reply');

    await waitFor(() => {
      expect(fetchCalls).toEqual(
        expect.arrayContaining([
          ['GET', '/auth/methods'],
          ['POST', '/auth/login/password'],
          ['GET', '/auth/session'],
          ['GET', '/credentials/self'],
          ['GET', '/projects/project-1/llm/backend'],
          ['POST', '/credentials/self/openai'],
          ['POST', '/llm/default-backend'],
          ['POST', '/projects/project-1/eln/protocols'],
          ['POST', '/projects/project-1/eln/records'],
          ['GET', '/projects/project-1/eln/records/record-1'],
          ['POST', '/projects/project-1/graphrag/index'],
          ['GET', '/projects/project-1/graphrag/stats'],
          ['POST', '/graphrag/query'],
          ['GET', '/projects/project-1/authz-matrix'],
          ['POST', '/projects/project-1/shares'],
          ['DELETE', '/projects/project-1/shares/viewer-1'],
          ['POST', '/projects/project-1/chat'],
        ]),
      );
    });
  });
});
