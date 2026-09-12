// @vitest-environment jsdom

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
        return jsonResponse({ body: { id: 'session-1', accountId: 'owner-1', issuedAt: 1, expiresAt: 2 } });
      }
      if (method === 'GET' && url === '/auth/session') {
        return jsonResponse({ body: { id: 'session-1', accountId: 'owner-1', issuedAt: 1, expiresAt: 2 } });
      }
      if (method === 'GET' && url === '/users/me/profile') {
        return jsonResponse({ body: { accountId: 'owner-1', displayName: 'Owner One', verifiedEmail: null } });
      }
      if (method === 'PATCH' && url === '/users/me/profile') {
        return jsonResponse({ body: { accountId: 'owner-1', displayName: 'Owner Renamed', verifiedEmail: null } });
      }
      if (method === 'POST' && url === '/users/me/email/confirm/confirm-token') {
        return jsonResponse({ body: { status: 'ok' } });
      }
      if (method === 'POST' && url === '/users/me/password') {
        return jsonResponse({ body: { status: 'ok' } });
      }
      if (method === 'POST' && url === '/users/me/mfa/totp/enroll') {
        return jsonResponse({ body: { secret: 'JBSWY3DPEHPK3PXP', otpauthUri: 'otpauth://totp/aira2' } });
      }
      if (method === 'POST' && url === '/users/me/mfa/totp/confirm') {
        return jsonResponse({ body: { status: 'ok' } });
      }
      if (method === 'GET' && url === '/users/me/sessions') {
        return jsonResponse({ body: [{ displayId: 'display-1', issuedAt: 1, expiresAt: 2 }] });
      }
      if (method === 'DELETE' && url === '/users/me/sessions/display-1') {
        return jsonResponse({ body: { status: 'ok' } });
      }
      if (method === 'GET' && url === '/projects/project-1/members') {
        return jsonResponse({
          body: {
            members: [{ userId: 'owner-1', role: 'owner' }],
            pendingInvitations: [{ id: 'invitation-1', email: 'invitee@example.com', role: 'viewer' }],
          },
        });
      }
      if (method === 'POST' && url === '/projects/project-1/invitations') {
        return jsonResponse({ body: { id: 'invitation-2', token: 'token-2' } });
      }
      if (method === 'DELETE' && url === '/projects/project-1/invitations/invitation-1') {
        return jsonResponse({ body: { status: 'ok' } });
      }
      if (method === 'PATCH' && url === '/projects/project-1/members/member-2') {
        return jsonResponse({ body: { status: 'ok' } });
      }
      if (method === 'DELETE' && url === '/projects/project-1/members/owner-1') {
        return jsonResponse({ body: { status: 'ok' } });
      }
      if (method === 'POST' && url === '/teams') {
        return jsonResponse({ body: { id: 'team-1', name: 'Team A', adminUserId: 'owner-1', memberIds: [] } });
      }
      if (method === 'POST' && url === '/teams/team-1/members') {
        return jsonResponse({ body: { status: 'ok' } });
      }
      if (method === 'DELETE' && url === '/teams/team-1/members/member-2') {
        return jsonResponse({ body: { status: 'ok' } });
      }
      if (method === 'POST' && url === '/projects/project-1/team-shares') {
        return jsonResponse({ body: { status: 'ok' } });
      }
      if (method === 'DELETE' && url === '/projects/project-1/team-shares/team-1') {
        return jsonResponse({ body: { status: 'ok' } });
      }

      return jsonResponse({ ok: false, status: 404, body: { error: `${method} ${url}` } });
    }),
  );
}

afterEach(() => {
  cleanup();
  fetchCalls.length = 0;
  vi.unstubAllGlobals();
});

/** @id TEST-AIRA2-GUI-010
 * @verifies REQ-MULTIUSER-018 REQ-MULTIUSER-023
 */
describe('AIRA2 SPA multi-user screens', () => {
  it('TEST-AIRA2-GUI-010 wires the profile/security screen to profile, password, MFA, and session routes', async () => {
    installFetchMock();
    render(React.createElement(Aira2App));

    await screen.findByText('github-oauth');
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'owner-1' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));
    await screen.findByText('Logged in as owner-1');

    fireEvent.click(screen.getByRole('button', { name: 'profile' }));
    expect((await screen.findByLabelText('Current profile')).textContent).toContain('Owner One');

    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Owner Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile updated');

    fireEvent.change(screen.getByLabelText('Email confirmation token'), { target: { value: 'confirm-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm email' }));
    await screen.findByText('Email confirmed');

    fireEvent.change(screen.getByLabelText('Current password'), { target: { value: 'password-1' } });
    fireEvent.change(screen.getByLabelText('New password'), { target: { value: 'password-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    await screen.findByText('Password change: ok');

    fireEvent.click(screen.getByRole('button', { name: 'Enroll TOTP' }));
    expect(await screen.findByLabelText('TOTP enrollment')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('TOTP confirmation code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm TOTP enrollment' }));
    await screen.findByText('MFA enrollment: ok');

    expect(await screen.findByText(/display-1/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));

    await waitFor(() => {
      expect(fetchCalls).toEqual(
        expect.arrayContaining([
          ['GET', '/users/me/profile'],
          ['PATCH', '/users/me/profile'],
          ['POST', '/users/me/email/confirm/confirm-token'],
          ['POST', '/users/me/password'],
          ['POST', '/users/me/mfa/totp/enroll'],
          ['POST', '/users/me/mfa/totp/confirm'],
          ['GET', '/users/me/sessions'],
          ['DELETE', '/users/me/sessions/display-1'],
        ]),
      );
    });
  });
});

/** @id TEST-AIRA2-GUI-011
 * @verifies REQ-MULTIUSER-015
 */
describe('AIRA2 SPA team management screen', () => {
  it('TEST-AIRA2-GUI-011 wires the members/teams screen to invitation, member, and team routes', async () => {
    installFetchMock();
    render(React.createElement(Aira2App));

    await screen.findByText('github-oauth');
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'owner-1' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Login' }));
    await screen.findByText('Logged in as owner-1');

    fireEvent.click(screen.getByRole('button', { name: 'teams' }));
    expect(await screen.findByLabelText('Project members')).toBeTruthy();
    expect(await screen.findByLabelText('Pending invitations')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Invite email'), { target: { value: 'invitee2@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitation' }));
    await screen.findByText('Invitation sent');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.change(screen.getByLabelText('Role change user id'), { target: { value: 'member-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change role' }));
    await screen.findByText('Member role changed');

    fireEvent.change(screen.getByLabelText('Team name'), { target: { value: 'Team A' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    await screen.findByText('Team created: team-1');

    fireEvent.change(screen.getByLabelText('Team member user id'), { target: { value: 'member-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add team member' }));
    await screen.findByText('Team member added');
    fireEvent.click(screen.getByRole('button', { name: 'Remove team member' }));
    await screen.findByText('Team member removed');

    fireEvent.click(screen.getByRole('button', { name: 'Grant team project access' }));
    await screen.findByText('Team project access granted');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke team project access' }));
    await screen.findByText('Team project access revoked');

    await waitFor(() => {
      expect(fetchCalls).toEqual(
        expect.arrayContaining([
          ['GET', '/projects/project-1/members'],
          ['POST', '/projects/project-1/invitations'],
          ['DELETE', '/projects/project-1/invitations/invitation-1'],
          ['PATCH', '/projects/project-1/members/member-2'],
          ['POST', '/teams'],
          ['POST', '/teams/team-1/members'],
          ['DELETE', '/teams/team-1/members/member-2'],
          ['POST', '/projects/project-1/team-shares'],
          ['DELETE', '/projects/project-1/team-shares/team-1'],
        ]),
      );
    });
  });
});
