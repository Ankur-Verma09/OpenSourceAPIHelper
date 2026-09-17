import { useStore } from '../store';
import { api } from '../api/client';
import type { DiscoveredModel } from '../api/types';

export function Dashboard() {
  const status = useStore((s) => s.status);
  const providers = useStore((s) => s.providers);
  const models = useStore((s) => s.models);
  const refresh = useStore((s) => s.refresh);

  const activate = async (model: string) => {
    try {
      await api.activateModel(model);
      await refresh();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Dashboard</h2>

      <div className="stat-grid">
        <div className="stat">
          <div className="num">{status?.providers ?? 0}</div>
          <div className="lbl">providers</div>
        </div>
        <div className="stat">
          <div className="num">{status?.models ?? 0}</div>
          <div className="lbl">models</div>
        </div>
        <div className="stat">
          <div className="num">{status?.chats ?? 0}</div>
          <div className="lbl">chats</div>
        </div>
        <div className="stat">
          <div className="num">{status?.memory_indexed ?? 0}</div>
          <div className="lbl">memory indexed</div>
        </div>
        <div className="stat">
          <div className="num">{status?.ok ? '✓' : '✗'}</div>
          <div className="lbl">db integrity</div>
        </div>
        <div className="stat">
          <div className="num">{status?.version ?? '—'}</div>
          <div className="lbl">service version</div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Active provider</h3>
        {providers.filter((p) => p.active).map((p) => (
          <div key={p.id} className="row">
            <span className="badge purple">active</span>
            <strong>{p.name}</strong>
            <div className="spacer" />
            <a
              href="#chat"
              style={{ color: 'var(--cyan)' }}
              onClick={(e) => { e.preventDefault(); document.querySelector('.tab')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); }}
            >
              Open Chat →
            </a>
          </div>
        ))}
        {!providers.some((p) => p.active) && (
          <div className="muted">No active provider — Test a provider in Settings to set it active.</div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Discovered models ({models.length})</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 10 }}>
          {models.map((m: DiscoveredModel) => (
            <div key={m.id} className="row glass" style={{ padding: '10px 12px', borderRadius: varRadius() }}>
              <div style={{ minWidth: 0 }}>
                <div className="mono">{m.model}</div>
                <div className="small muted">{m.provider_name}</div>
              </div>
              <div className="spacer" />
              {m.provider_active ? (
                <span className="badge green">active</span>
              ) : (
                <button className="small" onClick={() => activate(m.model)}>
                  Set active
                </button>
              )}
            </div>
          ))}
          {models.length === 0 && (
            <div className="muted">No models yet. Add a key in Settings and hit Test.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function varRadius(): number | string {
  return 'var(--radius-sm)';
}