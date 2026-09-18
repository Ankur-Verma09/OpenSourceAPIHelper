import { useState, useEffect } from 'react';

export function Login() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [machineInfo, setMachineInfo] = useState<any>(null);
  const [showMachineInfo, setShowMachineInfo] = useState(false);

  useEffect(() => {
    // Fetch machine info on mount
    window.electronAPI?.invoke('license:machine').then(setMachineInfo).catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await window.electronAPI?.invoke('license:validate', email.trim());
      if (result?.ok) {
        // Success - electron will close login window and open main
        return;
      }
      setError(result?.message || 'Validation failed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-card glass">
        <div className="login-header">
          <div className="login-logo">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="2" y="9" width="20" height="12" rx="2" />
              <path d="M6 9V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v5" />
              <line x1="6" y1="14" x2="6.01" y2="14" />
              <line x1="10" y1="14" x2="10.01" y2="14" />
              <line x1="14" y1="14" x2="14.01" y2="14" />
              <line x1="18" y1="14" x2="18.01" y2="14" />
            </svg>
          </div>
          <h1>OpenSourceAPIHelper</h1>
          <p className="subtitle">Sign in to continue</p>
        </div>

        {showMachineInfo && machineInfo && (
          <details className="machine-info">
            <summary>Machine Fingerprint</summary>
            <pre>{JSON.stringify(machineInfo, null, 2)}</pre>
          </details>
        )}

        <form onSubmit={handleSubmit} className="login-form">
          <div className="field">
            <label htmlFor="email">Email Address</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          {error && <div className="error-banner">{error}</div>}

          <button type="submit" className="primary" disabled={loading || !email.trim()}>
            {loading ? (
              <>
                <span className="spinner" /> Signing in...
              </>
            ) : (
              'Sign In'
            )}
          </button>
        </form>

        <div className="login-footer">
          <button type="button" className="ghost" onClick={() => setShowMachineInfo(!showMachineInfo)}>
            {showMachineInfo ? 'Hide' : 'Show'} Machine ID
          </button>
          <p className="hint">
            Your email must be whitelisted by an administrator.
            This machine will be permanently linked to your email.
          </p>
        </div>
      </div>
    </div>
  );
}

// Electron API types
declare global {
  interface Window {
    electronAPI?: {
      invoke: (channel: string, ...args: any[]) => Promise<any>;
      on: (channel: string, listener: (...args: any[]) => void) => void;
    };
  }
}