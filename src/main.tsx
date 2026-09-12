import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

type Screen = 'auth' | 'settings' | 'eln' | 'graphrag' | 'projects' | 'chat';

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

function useJson<T>(url: string, init?: RequestInit) {
  const [state, setState] = useState<{ loading: boolean; data: T | null; error: string | null }>({
    loading: true,
    data: null,
    error: null,
  });

  useEffect(() => {
    let active = true;
    fetch(url, init)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(await response.text());
        }
        return response.json() as Promise<T>;
      })
      .then((data) => {
        if (active) {
          setState({ loading: false, data, error: null });
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setState({ loading: false, data: null, error: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      active = false;
    };
  }, [url]);

  return state;
}

function Panel({ title, children }: React.PropsWithChildren<{ title: string }>) {
  return (
    <section style={cardStyle}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function AuthScreen() {
  const methods = useJson<string[]>('/auth/methods');
  return (
    <Panel title="Authentication">
      {methods.loading && <p>Loading...</p>}
      {methods.error && <p>{methods.error}</p>}
      <ul>{methods.data?.map((method) => <li key={method}>{method}</li>)}</ul>
    </Panel>
  );
}

function SettingsScreen() {
  return (
    <Panel title="LLM Settings">
      <p>Configure backend preferences through the REST API-backed settings routes.</p>
    </Panel>
  );
}

function ElnScreen() {
  return (
    <Panel title="ELN">
      <p>Records, protocols, and audit history are loaded from project ELN endpoints.</p>
    </Panel>
  );
}

function GraphRagScreen() {
  return (
    <Panel title="Graph RAG">
      <p>Index documents and query cited answers through the Graph RAG REST endpoints.</p>
    </Panel>
  );
}

function ProjectsScreen() {
  return (
    <Panel title="Projects">
      <p>Project sharing, roles, and configuration are managed through project routes.</p>
    </Panel>
  );
}

function ChatScreen() {
  return (
    <Panel title="Chat">
      <p>Send authenticated project chat requests to the effective LLM backend.</p>
    </Panel>
  );
}

function App() {
  const [screen, setScreen] = useState<Screen>('auth');
  return (
    <main style={layoutStyle}>
      <h1>AIRA2</h1>
      <nav style={{ display: 'flex', gap: '8px', marginBottom: '16px', flexWrap: 'wrap' }}>
        {(['auth', 'settings', 'eln', 'graphrag', 'projects', 'chat'] as Screen[]).map((entry) => (
          <button key={entry} onClick={() => setScreen(entry)}>
            {entry}
          </button>
        ))}
      </nav>
      {screen === 'auth' && <AuthScreen />}
      {screen === 'settings' && <SettingsScreen />}
      {screen === 'eln' && <ElnScreen />}
      {screen === 'graphrag' && <GraphRagScreen />}
      {screen === 'projects' && <ProjectsScreen />}
      {screen === 'chat' && <ChatScreen />}
    </main>
  );
}

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
