import { useState } from 'react';
import { api } from '../api/client';
import { useStore } from '../store';
import type { Provider } from '../api/types';
import { maskExternal } from '../lib/markdown';

export function Settings() {
  const providers = useStore((s) => s.providers);
  const refresh = useStore((s) => s.refresh);
  const [editing, setEditing] = useState<Partial<Provider & { editingId?: string; apiKey?: string; baseUrl?: string; keyEnv?: string }>>({});

  const save = async (): Promise<Provider | null> => {
    try {
      let saved: Provider | undefined;
      if (editing.editingId) {
        saved = await api.updateProvider(editing.editingId, {
          name: editing.name,
          baseUrl: editing.baseUrl,
          apiKey: editing.apiKey,
          keyEnv: editing.keyEnv,
        });
      } else {
        saved = await api.createProvider({
          name: editing.name || 'New Provider',
          baseUrl: editing.baseUrl,
          apiKey: editing.apiKey,
          keyEnv: editing.keyEnv,
        });
      }
      setEditing({});
      await refresh();
      return saved ?? null;
    } catch (e) {
      alert((e as Error).message);
      return null;
    }
  };

  const saveAndTest = async () => {
    const saved = await save();
    if (!saved) return;
    const r = await api
      .testProvider(saved.id)
      .catch((e: Error) => ({ ok: false, error: e.message, models: [] as string[] }));
    alert(
      r.ok
        ? `Connected — ${r.models?.length ?? 0} models discovered`
        : `Test failed: ${r.error}`,
    );
    await refresh();
  };

  const del = async (id: string) => {
    if (!confirm('Delete this provider and its key?')) return;
    await api.deleteProvider(id);
    await refresh();
  };

  return (
    <div className="panel">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Providers &amp; Keys</h2>
        <div className="spacer" />
        <button className="primary" onClick={() => setEditing({ name: '', baseUrl: 'https://api.openai.com/v1' })}>
          + Add provider
        </button>
      </div>

      <div className="notice">
        Keys are encrypted at rest in the service vault and are <b>never shown or sent back to the
        UI as plaintext</b>. You only ever see a masked form like <code>sk-••••••abcd</code>.
      </div>

      {(editing.name !== undefined || providers.length === 0 || (providers.length > 0 && Object.keys(editing).length === 0) || providers.length > 0) && (
        <div className="card">
          <div className="row" style={{ marginBottom: 14 }}>
            <h3 style={{ margin: 0 }}>{editing.editingId ? 'Edit provider' : 'Add provider'}</h3>
            <div className="spacer" />
            {editing.editingId && (
              <button onClick={() => setEditing({})}>Cancel</button>
            )}
          </div>
          <div className="field-row">
            <div className="field">
              <label>Name</label>
              <input
                value={editing.name ?? ''}
                placeholder="e.g. DeepSeek"
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </div>
            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label>Base URL (OpenAI-compatible)</label>
              <input
                value={editing.baseUrl ?? ''}
                placeholder="https://api.deepseek.com/v1"
                onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
              />
            </div>
            <div className="field">
              <label>API key</label>
              <input
                type="password"
                placeholder={
                  editing.editingId && providers.find((p) => p.id === editing.editingId)?.has_key
                    ? `already set (${maskExternal(providers.find((p) => p.id === editing.editingId)!.key_masked || '')}) — leave blank to keep`
                    : 'sk-…'
                }
                value={editing.apiKey ?? ''}
                onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
              />
            </div>
            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label>Env var alias (optional)</label>
              <input
                value={editing.keyEnv ?? ''}
                placeholder="DEEPSEEK_API_KEY"
                onChange={(e) => setEditing({ ...editing, keyEnv: e.target.value })}
              />
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <button className="primary" onClick={save} disabled={!editing.name}>
              {editing.editingId ? 'Save changes' : 'Add'}
            </button>{' '}
            <button className="primary" onClick={saveAndTest} disabled={!editing.name}>
              Add + Test now
            </button>
          </div>
        </div>
      )}

      {providers.length === 0 ? (
        <div className="empty">
          <div className="glow">🔑</div>
          <p>No providers configured. Add your first provider key above.</p>
        </div>
      ) : (
        <div className="card">
          <h3 style={{ marginTop: 0 }}>Configured providers</h3>
          {providers.map((p) => (
            <ProviderRow key={p.id} p={p} onEdit={(data) => setEditing({ ...data, editingId: p.id })} onDelete={() => del(p.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderRow({
  p,
  onEdit,
  onDelete,
}: {
  p: Provider;
  onEdit: (d: { name: string; baseUrl: string; keyEnv: string }) => void;
  onDelete: () => void;
}) {
  const refresh = useStore((s) => s.refresh);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const r = await api.testProvider(p.id);
      setResult(
        r.ok
          ? { ok: true, msg: `Connected — ${r.models?.length ?? 0} models discovered` }
          : { ok: false, msg: r.error || 'test failed' },
      );
      await refresh();
    } catch (e) {
      setResult({ ok: false, msg: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="provider-row">
      <div style={{ minWidth: 0 }}>
        <div className="row">
          <strong>{p.name}</strong>
          {p.active && <span className="badge purple">active</span>}
          <span className="badge green">{p.has_key ? 'key set' : 'no key'}</span>
        </div>
        <div className="mono muted" style={{ marginTop: 4 }}>
          {p.base_url}
        </div>
        <div className="mono small muted" style={{ marginTop: 2 }}>
          key: {p.key_masked ? maskExternal(p.key_masked) : '—'}
          {p.key_env ? `  ·  env: ${p.key_env}` : ''}
        </div>
        {result && (
          <div className={result.ok ? 'notice' : 'error-banner'} style={{ marginTop: 8, padding: '6px 10px', fontSize: 12, borderRadius: 8 }}>
            {result.ok ? '✓' : '✗'} {result.msg}
          </div>
        )}
      </div>
      <div className="row">
        <button onClick={test} disabled={testing}>
          {testing ? <span className="spinner" /> : 'Test'}
        </button>
        <button
          onClick={() =>
            onEdit({ name: p.name, baseUrl: p.base_url, keyEnv: p.key_env ?? '' })
          }
        >
          Edit
        </button>
        <button className="ghost-danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}