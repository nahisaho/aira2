import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

type Screen = 'auth' | 'settings' | 'eln' | 'graphrag' | 'projects' | 'chat' | 'profile' | 'teams';
type AuthMethod = 'github-oauth' | 'password' | 'oidc';

interface Session {
  id: string;
  accountId: string;
  issuedAt: number;
  expiresAt: number;
}

interface JsonState<T> {
  loading: boolean;
  data: T | null;
  error: string | null;
}

const cardStyle: React.CSSProperties = {
  border: '1px solid #d0d7de',
  borderRadius: '12px',
  padding: '16px',
  marginBottom: '16px',
  background: '#ffffff',
  boxShadow: '0 2px 6px rgba(0,0,0,0.06)',
};

const layoutStyle: React.CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  background: '#f6f8fa',
  minHeight: '100vh',
  color: '#24292f',
  padding: '24px',
};

const sharedFieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  marginBottom: '12px',
};

function authHeaders(sessionId: string | null): HeadersInit | undefined {
  if (!sessionId) return undefined;
  return { authorization: `Bearer ${sessionId}` };
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.json() as Promise<T>;
}

function Panel({ title, children }: React.PropsWithChildren<{ title: string }>) {
  return (
    <section style={cardStyle}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function JsonPreview({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <strong>{label}</strong>
      <pre aria-label={label}>{JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

/** @id CODE-AIRA2-GUI-007
 * @implements REQ-GUI-001 REQ-GUI-002 REQ-GUI-003 REQ-GUI-004 REQ-RUNTIME-004 REQ-RUNTIME-011
 * @design DES-AIRA2-010 DES-AIRA2-012
 */
export function AuthScreen({
  session,
  onSession,
}: {
  session: Session | null;
  onSession: (value: Session | null) => void;
}) {
  const [methods, setMethods] = useState<JsonState<AuthMethod[]>>({ loading: true, data: null, error: null });
  const [username, setUsername] = useState('owner-1');
  const [password, setPassword] = useState('password');
  const [totpCode, setTotpCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [resetEmail, setResetEmail] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [resetPassword, setResetPassword] = useState('');
  const [resetMessage, setResetMessage] = useState<string | null>(null);

  useEffect(() => {
    readJson<AuthMethod[]>('/auth/methods')
      .then((data) => setMethods({ loading: false, data, error: null }))
      .catch((error: unknown) =>
        setMethods({ loading: false, data: null, error: error instanceof Error ? error.message : String(error) }),
      );
  }, []);

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const nextSession = await readJson<Session>('/auth/login/password', {
        method: 'POST',
        body: JSON.stringify({ username, password, ...(totpCode ? { totpCode } : {}) }),
      });
      const activeSession = await readJson<Session>('/auth/session', {
        headers: authHeaders(nextSession.id),
      });
      onSession(activeSession);
      setMessage(`Logged in as ${activeSession.accountId}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function requestPasswordReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await readJson('/password-reset/request', { method: 'POST', body: JSON.stringify({ email: resetEmail }) });
      setResetMessage('If that email is registered, a reset link has been sent.');
    } catch (error) {
      setResetMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function completePasswordReset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      const result = await readJson<{ status: string }>(`/password-reset/${resetToken}/complete`, {
        method: 'POST',
        body: JSON.stringify({ newPassword: resetPassword }),
      });
      setResetMessage(`Password reset: ${result.status}`);
    } catch (error) {
      setResetMessage(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <Panel title="Authentication">
      {methods.loading && <p>Loading methods…</p>}
      {methods.error && <p>{methods.error}</p>}
      <ul>
        {methods.data?.map((method) => (
          <li key={method}>{method}</li>
        ))}
      </ul>
      <form onSubmit={login}>
        <label style={sharedFieldStyle}>
          Username
          <input aria-label="Username" value={username} onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label style={sharedFieldStyle}>
          Password
          <input
            aria-label="Password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        <label style={sharedFieldStyle}>
          TOTP code (if enrolled)
          <input aria-label="TOTP code" value={totpCode} onChange={(event) => setTotpCode(event.target.value)} />
        </label>
        <button type="submit">Login</button>
      </form>
      {message && <p>{message}</p>}
      {session && <JsonPreview label="Current session" value={session} />}
      <hr />
      <h3>Forgot password?</h3>
      <form onSubmit={requestPasswordReset}>
        <label style={sharedFieldStyle}>
          Account email
          <input aria-label="Reset email" value={resetEmail} onChange={(event) => setResetEmail(event.target.value)} />
        </label>
        <button type="submit">Request password reset</button>
      </form>
      <form onSubmit={completePasswordReset}>
        <label style={sharedFieldStyle}>
          Reset token
          <input aria-label="Reset token" value={resetToken} onChange={(event) => setResetToken(event.target.value)} />
        </label>
        <label style={sharedFieldStyle}>
          New password
          <input
            aria-label="Reset new password"
            type="password"
            value={resetPassword}
            onChange={(event) => setResetPassword(event.target.value)}
          />
        </label>
        <button type="submit">Complete password reset</button>
      </form>
      {resetMessage && <p>{resetMessage}</p>}
    </Panel>
  );
}

export function SettingsScreen({ sessionId, projectId }: { sessionId: string | null; projectId: string }) {
  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState('gpt-4o');
  const [secret, setSecret] = useState('sk-demo');
  const [credentials, setCredentials] = useState<JsonState<unknown[]>>({ loading: false, data: null, error: null });
  const [backend, setBackend] = useState<unknown | null>(null);

  const headers = useMemo(() => authHeaders(sessionId), [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    readJson<unknown[]>('/credentials/self', { headers })
      .then((data) => setCredentials({ loading: false, data, error: null }))
      .catch((error: unknown) =>
        setCredentials({ loading: false, data: null, error: error instanceof Error ? error.message : String(error) }),
      );
    readJson(`/projects/${projectId}/llm/backend`, { headers })
      .then((data) => setBackend(data))
      .catch(() => setBackend(null));
  }, [headers, projectId, sessionId]);

  async function saveCredential() {
    if (!sessionId) return;
    await readJson(`/credentials/self/${provider}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ secret }),
    });
    const refreshed = await readJson<unknown[]>('/credentials/self', { headers });
    setCredentials({ loading: false, data: refreshed, error: null });
  }

  async function saveBackend() {
    if (!sessionId) return;
    const selection = await readJson(`/llm/default-backend`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ providerId: provider, model }),
    });
    setBackend(selection);
  }

  return (
    <Panel title="LLM Settings">
      {!sessionId && <p>Log in to load credential and backend settings.</p>}
      <label style={sharedFieldStyle}>
        Provider
        <input aria-label="Provider" value={provider} onChange={(event) => setProvider(event.target.value)} />
      </label>
      <label style={sharedFieldStyle}>
        Model
        <input aria-label="Model" value={model} onChange={(event) => setModel(event.target.value)} />
      </label>
      <label style={sharedFieldStyle}>
        Credential secret
        <input aria-label="Credential secret" value={secret} onChange={(event) => setSecret(event.target.value)} />
      </label>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="button" onClick={() => void saveCredential()}>
          Save credential
        </button>
        <button type="button" onClick={() => void saveBackend()}>
          Set default backend
        </button>
      </div>
      {credentials.data && <JsonPreview label="Credential entries" value={credentials.data} />}
      {backend !== null && <JsonPreview label="Effective backend" value={backend} />}
    </Panel>
  );
}

export function ElnScreen({ sessionId, projectId }: { sessionId: string | null; projectId: string }) {
  const headers = useMemo(() => authHeaders(sessionId), [sessionId]);
  const [protocol, setProtocol] = useState<unknown | null>(null);
  const [record, setRecord] = useState<unknown | null>(null);

  async function createProtocol() {
    if (!sessionId) return;
    const created = await readJson(`/projects/${projectId}/eln/protocols`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ content: 'SOP content' }),
    });
    setProtocol(created);
  }

  async function createRecord() {
    if (!sessionId) return;
    const created = await readJson<{ recordId: string }>(`/projects/${projectId}/eln/records`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        objective: 'Live ELN objective',
        method: 'Live ELN method',
        rawData: 'raw.csv',
        results: 'Live ELN result',
        conclusion: 'Live ELN conclusion',
      }),
    });
    const history = await readJson(`/projects/${projectId}/eln/records/${created.recordId}`, { headers });
    setRecord(history);
  }

  return (
    <Panel title="ELN">
      {!sessionId && <p>Log in to create and read ELN records.</p>}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="button" onClick={() => void createProtocol()}>
          Create protocol
        </button>
        <button type="button" onClick={() => void createRecord()}>
          Create record
        </button>
      </div>
      {protocol !== null && <JsonPreview label="Latest protocol" value={protocol} />}
      {record !== null && <JsonPreview label="Record history" value={record} />}
    </Panel>
  );
}

export function GraphRagScreen({ sessionId, projectId }: { sessionId: string | null; projectId: string }) {
  const headers = useMemo(() => authHeaders(sessionId), [sessionId]);
  const [stats, setStats] = useState<unknown | null>(null);
  const [queryResult, setQueryResult] = useState<unknown | null>(null);

  async function indexDocuments() {
    if (!sessionId) return;
    await readJson(`/projects/${projectId}/graphrag/index`, {
      method: 'POST',
      headers,
      body: JSON.stringify([{ documentId: 'doc-1', content: 'Graph RAG evidence' }]),
    });
    const latestStats = await readJson(`/projects/${projectId}/graphrag/stats`, { headers });
    setStats(latestStats);
  }

  async function query() {
    if (!sessionId) return;
    const answer = await readJson('/graphrag/query', {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectIds: [projectId], question: 'Graph RAG evidence?' }),
    });
    setQueryResult(answer);
  }

  return (
    <Panel title="Graph RAG">
      {!sessionId && <p>Log in to index and query Graph RAG documents.</p>}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="button" onClick={() => void indexDocuments()}>
          Index documents
        </button>
        <button type="button" onClick={() => void query()}>
          Run query
        </button>
      </div>
      {stats !== null && <JsonPreview label="Graph stats" value={stats} />}
      {queryResult !== null && <JsonPreview label="Graph query result" value={queryResult} />}
    </Panel>
  );
}

export function ProjectsScreen({ sessionId, projectId }: { sessionId: string | null; projectId: string }) {
  const headers = useMemo(() => authHeaders(sessionId), [sessionId]);
  const [matrix, setMatrix] = useState<unknown | null>(null);
  const [shareUserId, setShareUserId] = useState('viewer-1');
  const [shareRole, setShareRole] = useState('viewer');
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    readJson(`/projects/${projectId}/authz-matrix`, { headers })
      .then((data) => setMatrix(data))
      .catch(() => setMatrix(null));
  }, [headers, projectId, sessionId]);

  async function grantShare() {
    if (!sessionId) return;
    const response = await readJson<{ status: string }>(`/projects/${projectId}/shares`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: shareUserId, role: shareRole }),
    });
    setStatus(response.status);
  }

  async function revokeShare() {
    if (!sessionId) return;
    const response = await readJson<{ status: string }>(`/projects/${projectId}/shares/${shareUserId}`, {
      method: 'DELETE',
      headers,
    });
    setStatus(response.status);
  }

  return (
    <Panel title="Projects">
      {!sessionId && <p>Log in to manage project sharing.</p>}
      <label style={sharedFieldStyle}>
        Shared user
        <input aria-label="Shared user" value={shareUserId} onChange={(event) => setShareUserId(event.target.value)} />
      </label>
      <label style={sharedFieldStyle}>
        Share role
        <input aria-label="Share role" value={shareRole} onChange={(event) => setShareRole(event.target.value)} />
      </label>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="button" onClick={() => void grantShare()}>
          Grant share
        </button>
        <button type="button" onClick={() => void revokeShare()}>
          Revoke share
        </button>
      </div>
      {status && <p>Share status: {status}</p>}
      {matrix !== null && <JsonPreview label="Authorization matrix" value={matrix} />}
    </Panel>
  );
}

export function ChatScreen({ sessionId, projectId }: { sessionId: string | null; projectId: string }) {
  const headers = useMemo(() => authHeaders(sessionId), [sessionId]);
  const [message, setMessage] = useState('hello');
  const [response, setResponse] = useState<unknown | null>(null);

  async function sendMessage() {
    if (!sessionId) return;
    const chatResponse = await readJson(`/projects/${projectId}/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ messages: [{ role: 'user', content: message }] }),
    });
    setResponse(chatResponse);
  }

  return (
    <Panel title="Chat">
      {!sessionId && <p>Log in to chat with the active backend.</p>}
      <label style={sharedFieldStyle}>
        Message
        <input aria-label="Chat message" value={message} onChange={(event) => setMessage(event.target.value)} />
      </label>
      <button type="button" onClick={() => void sendMessage()}>
        Send message
      </button>
      {response !== null && <JsonPreview label="Chat response" value={response} />}
    </Panel>
  );
}

/** @id CODE-AIRA2-GUI-008
 * @implements REQ-MULTIUSER-018 REQ-MULTIUSER-019 REQ-MULTIUSER-020 REQ-MULTIUSER-021 REQ-MULTIUSER-023 REQ-MULTIUSER-024
 * @design DES-AIRA2-010
 */
export function ProfileScreen({ sessionId }: { sessionId: string | null }) {
  const headers = useMemo(() => authHeaders(sessionId), [sessionId]);
  const [profile, setProfile] = useState<{ accountId: string; displayName: string; verifiedEmail: string | null } | null>(
    null,
  );
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [emailConfirmToken, setEmailConfirmToken] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [totpEnrollment, setTotpEnrollment] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [totpConfirmCode, setTotpConfirmCode] = useState('');
  const [sessions, setSessions] = useState<{ displayId: string; issuedAt: number; expiresAt: number }[] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadProfile = useCallback(() => {
    if (!sessionId) return;
    readJson<{ accountId: string; displayName: string; verifiedEmail: string | null }>('/users/me/profile', { headers })
      .then((data) => {
        setProfile(data);
        setDisplayName(data.displayName);
        setEmail(data.verifiedEmail ?? '');
      })
      .catch(() => setProfile(null));
  }, [headers, sessionId]);

  const loadSessions = useCallback(() => {
    if (!sessionId) return;
    readJson<{ displayId: string; issuedAt: number; expiresAt: number }[]>('/users/me/sessions', { headers })
      .then((data) => setSessions(data))
      .catch(() => setSessions(null));
  }, [headers, sessionId]);

  useEffect(() => {
    loadProfile();
    loadSessions();
  }, [loadProfile, loadSessions]);

  async function saveProfile() {
    if (!sessionId) return;
    await readJson('/users/me/profile', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ displayName, email }),
    });
    loadProfile();
    setMessage('Profile updated');
  }

  async function confirmEmail() {
    await readJson(`/users/me/email/confirm/${emailConfirmToken}`, { method: 'POST' });
    loadProfile();
    setMessage('Email confirmed');
  }

  async function changePassword() {
    if (!sessionId) return;
    const result = await readJson<{ status: string }>('/users/me/password', {
      method: 'POST',
      headers,
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    setMessage(`Password change: ${result.status}`);
  }

  async function enrollTotp() {
    if (!sessionId) return;
    const enrollment = await readJson<{ secret: string; otpauthUri: string }>('/users/me/mfa/totp/enroll', {
      method: 'POST',
      headers,
    });
    setTotpEnrollment(enrollment);
  }

  async function confirmTotp() {
    if (!sessionId) return;
    const result = await readJson<{ status: string }>('/users/me/mfa/totp/confirm', {
      method: 'POST',
      headers,
      body: JSON.stringify({ code: totpConfirmCode }),
    });
    setMessage(`MFA enrollment: ${result.status}`);
  }

  async function revokeSession(displayId: string) {
    if (!sessionId) return;
    await readJson(`/users/me/sessions/${displayId}`, { method: 'DELETE', headers });
    loadSessions();
  }

  return (
    <Panel title="Profile & Security">
      {!sessionId && <p>Log in to manage your profile, password, MFA, and sessions.</p>}
      {profile && <JsonPreview label="Current profile" value={profile} />}
      <label style={sharedFieldStyle}>
        Display name
        <input aria-label="Display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
      </label>
      <label style={sharedFieldStyle}>
        Email
        <input aria-label="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
      </label>
      <button type="button" onClick={() => void saveProfile()}>
        Save profile
      </button>

      <h3>Email confirmation</h3>
      <label style={sharedFieldStyle}>
        Confirmation token
        <input
          aria-label="Email confirmation token"
          value={emailConfirmToken}
          onChange={(event) => setEmailConfirmToken(event.target.value)}
        />
      </label>
      <button type="button" onClick={() => void confirmEmail()}>
        Confirm email
      </button>

      <h3>Change password</h3>
      <label style={sharedFieldStyle}>
        Current password
        <input
          aria-label="Current password"
          type="password"
          value={currentPassword}
          onChange={(event) => setCurrentPassword(event.target.value)}
        />
      </label>
      <label style={sharedFieldStyle}>
        New password
        <input
          aria-label="New password"
          type="password"
          value={newPassword}
          onChange={(event) => setNewPassword(event.target.value)}
        />
      </label>
      <button type="button" onClick={() => void changePassword()}>
        Change password
      </button>

      <h3>Multi-factor authentication</h3>
      <button type="button" onClick={() => void enrollTotp()}>
        Enroll TOTP
      </button>
      {totpEnrollment && <JsonPreview label="TOTP enrollment" value={totpEnrollment} />}
      <label style={sharedFieldStyle}>
        TOTP confirmation code
        <input
          aria-label="TOTP confirmation code"
          value={totpConfirmCode}
          onChange={(event) => setTotpConfirmCode(event.target.value)}
        />
      </label>
      <button type="button" onClick={() => void confirmTotp()}>
        Confirm TOTP enrollment
      </button>

      <h3>Active sessions</h3>
      <ul aria-label="Active sessions">
        {sessions?.map((entry) => (
          <li key={entry.displayId}>
            {entry.displayId} (expires {new Date(entry.expiresAt).toISOString()})
            <button type="button" onClick={() => void revokeSession(entry.displayId)} style={{ marginLeft: '8px' }}>
              Revoke
            </button>
          </li>
        ))}
      </ul>
      {message && <p>{message}</p>}
    </Panel>
  );
}

/** @id CODE-AIRA2-GUI-009
 * @implements REQ-MULTIUSER-015 REQ-MULTIUSER-016 REQ-MULTIUSER-017 REQ-MULTIUSER-029 REQ-MULTIUSER-030
 * @design DES-AIRA2-010
 */
export function TeamsScreen({ sessionId, projectId }: { sessionId: string | null; projectId: string }) {
  const headers = useMemo(() => authHeaders(sessionId), [sessionId]);
  const [members, setMembers] = useState<{ userId: string; role: string }[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<{ id: string; email: string; role: string }[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'viewer' | 'editor'>('viewer');
  const [roleChangeUserId, setRoleChangeUserId] = useState('');
  const [roleChangeRole, setRoleChangeRole] = useState<'viewer' | 'editor'>('viewer');
  const [teamName, setTeamName] = useState('');
  const [teamId, setTeamId] = useState('');
  const [teamMemberUserId, setTeamMemberUserId] = useState('');
  const [teamShareRole, setTeamShareRole] = useState<'viewer' | 'editor'>('viewer');
  const [message, setMessage] = useState<string | null>(null);

  const loadMembers = useCallback(() => {
    if (!sessionId) return;
    readJson<{ members: { userId: string; role: string }[]; pendingInvitations: { id: string; email: string; role: string }[] }>(
      `/projects/${projectId}/members`,
      { headers },
    )
      .then((data) => {
        setMembers(data.members);
        setPendingInvitations(data.pendingInvitations);
      })
      .catch(() => {
        setMembers([]);
        setPendingInvitations([]);
      });
  }, [headers, projectId, sessionId]);

  useEffect(() => {
    loadMembers();
  }, [loadMembers]);

  async function invite() {
    if (!sessionId) return;
    await readJson(`/projects/${projectId}/invitations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
    });
    loadMembers();
    setMessage('Invitation sent');
  }

  async function cancelInvitation(invitationId: string) {
    if (!sessionId) return;
    await readJson(`/projects/${projectId}/invitations/${invitationId}`, { method: 'DELETE', headers });
    loadMembers();
  }

  async function changeRole() {
    if (!sessionId) return;
    await readJson(`/projects/${projectId}/members/${roleChangeUserId}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ role: roleChangeRole }),
    });
    loadMembers();
    setMessage('Member role changed');
  }

  async function removeMember(userId: string) {
    if (!sessionId) return;
    await readJson(`/projects/${projectId}/members/${userId}`, { method: 'DELETE', headers });
    loadMembers();
  }

  async function createTeam() {
    if (!sessionId) return;
    const team = await readJson<{ id: string; name: string }>('/teams', {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: teamName }),
    });
    setTeamId(team.id);
    setMessage(`Team created: ${team.id}`);
  }

  async function addTeamMember() {
    if (!sessionId || !teamId) return;
    await readJson(`/teams/${teamId}/members`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ userId: teamMemberUserId }),
    });
    setMessage('Team member added');
  }

  async function removeTeamMember() {
    if (!sessionId || !teamId) return;
    await readJson(`/teams/${teamId}/members/${teamMemberUserId}`, { method: 'DELETE', headers });
    setMessage('Team member removed');
  }

  async function grantTeamShare() {
    if (!sessionId || !teamId) return;
    await readJson(`/projects/${projectId}/team-shares`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ teamId, role: teamShareRole }),
    });
    setMessage('Team project access granted');
  }

  async function revokeTeamShare() {
    if (!sessionId || !teamId) return;
    await readJson(`/projects/${projectId}/team-shares/${teamId}`, { method: 'DELETE', headers });
    setMessage('Team project access revoked');
  }

  return (
    <Panel title="Members & Teams">
      {!sessionId && <p>Log in to manage project members and teams.</p>}
      <h3>Project members</h3>
      <ul aria-label="Project members">
        {members.map((member) => (
          <li key={member.userId}>
            {member.userId} — {member.role}
            <button type="button" onClick={() => void removeMember(member.userId)} style={{ marginLeft: '8px' }}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <h3>Pending invitations</h3>
      <ul aria-label="Pending invitations">
        {pendingInvitations.map((invitation) => (
          <li key={invitation.id}>
            {invitation.email} — {invitation.role}
            <button type="button" onClick={() => void cancelInvitation(invitation.id)} style={{ marginLeft: '8px' }}>
              Cancel
            </button>
          </li>
        ))}
      </ul>

      <h3>Invite by email</h3>
      <label style={sharedFieldStyle}>
        Email
        <input aria-label="Invite email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} />
      </label>
      <label style={sharedFieldStyle}>
        Role
        <input
          aria-label="Invite role"
          value={inviteRole}
          onChange={(event) => setInviteRole(event.target.value as 'viewer' | 'editor')}
        />
      </label>
      <button type="button" onClick={() => void invite()}>
        Send invitation
      </button>

      <h3>Change member role</h3>
      <label style={sharedFieldStyle}>
        User ID
        <input
          aria-label="Role change user id"
          value={roleChangeUserId}
          onChange={(event) => setRoleChangeUserId(event.target.value)}
        />
      </label>
      <label style={sharedFieldStyle}>
        New role
        <input
          aria-label="Role change role"
          value={roleChangeRole}
          onChange={(event) => setRoleChangeRole(event.target.value as 'viewer' | 'editor')}
        />
      </label>
      <button type="button" onClick={() => void changeRole()}>
        Change role
      </button>

      <h3>Teams</h3>
      <label style={sharedFieldStyle}>
        Team name
        <input aria-label="Team name" value={teamName} onChange={(event) => setTeamName(event.target.value)} />
      </label>
      <button type="button" onClick={() => void createTeam()}>
        Create team
      </button>
      <label style={sharedFieldStyle}>
        Team ID
        <input aria-label="Team id" value={teamId} onChange={(event) => setTeamId(event.target.value)} />
      </label>
      <label style={sharedFieldStyle}>
        Team member user ID
        <input
          aria-label="Team member user id"
          value={teamMemberUserId}
          onChange={(event) => setTeamMemberUserId(event.target.value)}
        />
      </label>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="button" onClick={() => void addTeamMember()}>
          Add team member
        </button>
        <button type="button" onClick={() => void removeTeamMember()}>
          Remove team member
        </button>
      </div>
      <label style={sharedFieldStyle}>
        Team share role
        <input
          aria-label="Team share role"
          value={teamShareRole}
          onChange={(event) => setTeamShareRole(event.target.value as 'viewer' | 'editor')}
        />
      </label>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="button" onClick={() => void grantTeamShare()}>
          Grant team project access
        </button>
        <button type="button" onClick={() => void revokeTeamShare()}>
          Revoke team project access
        </button>
      </div>
      {message && <p>{message}</p>}
    </Panel>
  );
}

export function Aira2App() {
  const [screen, setScreen] = useState<Screen>('auth');
  const [session, setSession] = useState<Session | null>(null);
  const projectId = 'project-1';

  return (
    <main style={layoutStyle}>
      <h1>AIRA2</h1>
      <p>Active project: {projectId}</p>
      <nav style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {(['auth', 'settings', 'eln', 'graphrag', 'projects', 'chat', 'profile', 'teams'] as Screen[]).map((entry) => (
          <button key={entry} onClick={() => setScreen(entry)}>
            {entry}
          </button>
        ))}
      </nav>
      {screen === 'auth' && <AuthScreen session={session} onSession={setSession} />}
      {screen === 'settings' && <SettingsScreen sessionId={session?.id ?? null} projectId={projectId} />}
      {screen === 'eln' && <ElnScreen sessionId={session?.id ?? null} projectId={projectId} />}
      {screen === 'graphrag' && <GraphRagScreen sessionId={session?.id ?? null} projectId={projectId} />}
      {screen === 'projects' && <ProjectsScreen sessionId={session?.id ?? null} projectId={projectId} />}
      {screen === 'chat' && <ChatScreen sessionId={session?.id ?? null} projectId={projectId} />}
      {screen === 'profile' && <ProfileScreen sessionId={session?.id ?? null} />}
      {screen === 'teams' && <TeamsScreen sessionId={session?.id ?? null} projectId={projectId} />}
    </main>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <Aira2App />
    </React.StrictMode>,
  );
}
