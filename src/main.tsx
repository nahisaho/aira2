import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

type Screen = 'auth' | 'settings' | 'eln' | 'graphrag' | 'projects' | 'chat';
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
  const [message, setMessage] = useState<string | null>(null);

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
        body: JSON.stringify({ username, password }),
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
        <button type="submit">Login</button>
      </form>
      {message && <p>{message}</p>}
      {session && <JsonPreview label="Current session" value={session} />}
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

export function Aira2App() {
  const [screen, setScreen] = useState<Screen>('auth');
  const [session, setSession] = useState<Session | null>(null);
  const projectId = 'project-1';

  return (
    <main style={layoutStyle}>
      <h1>AIRA2</h1>
      <p>Active project: {projectId}</p>
      <nav style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {(['auth', 'settings', 'eln', 'graphrag', 'projects', 'chat'] as Screen[]).map((entry) => (
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
