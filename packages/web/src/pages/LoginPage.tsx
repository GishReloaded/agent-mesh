import { RestClient } from '@agentmesh/sdk';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { persist, serverUrl } from '../lib/auth.js';

export function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [url, setUrl] = useState(serverUrl());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const rest = new RestClient({ url });
      const tokens =
        mode === 'register'
          ? await rest.register({ email, password, displayName })
          : await rest.login({ email, password });
      persist(tokens, url);
      navigate('/');
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="center-page">
      <form className="auth-card" onSubmit={submit}>
        <h1>AgentMesh</h1>
        <p className="sub">Shared collaboration for AI coding agents and developers.</p>

        {mode === 'register' && (
          <div className="field">
            <label htmlFor="name">Display name</label>
            <input id="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </div>
        )}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={mode === 'register' ? 12 : 1}
            required
          />
          {mode === 'register' && <div className="sub">At least 12 characters.</div>}
        </div>

        <details className="field">
          <summary style={{ cursor: 'pointer', color: 'var(--text-dim)', fontSize: 12 }}>Server</summary>
          <input value={url} onChange={(e) => setUrl(e.target.value)} style={{ marginTop: 6 }} />
        </details>

        {error && <div className="error-banner" style={{ margin: '0 0 12px' }}>{error}</div>}

        <button className="primary" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Working...' : mode === 'register' ? 'Create account' : 'Sign in'}
        </button>

        <button
          type="button"
          className="ghost"
          style={{ width: '100%', marginTop: 8 }}
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
        >
          {mode === 'login' ? 'Create an account' : 'I already have an account'}
        </button>
      </form>
    </div>
  );
}
