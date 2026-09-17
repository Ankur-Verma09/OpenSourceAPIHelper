import { useState } from 'react';
import { api } from '../api/client';
import { useStore } from '../store';
import type { MemoryHit } from '../api/types';
import { Markdown } from '../lib/markdown';

export function History() {
  const chats = useStore((s) => s.chats);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<MemoryHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [touched, setTouched] = useState(false);

  const search = async () => {
    const query = q.trim();
    if (!query) {
      setHits([]);
      setTouched(true);
      return;
    }
    setSearching(true);
    try {
      setHits(await api.searchMemory(query));
    } catch (e) {
      setHits([]);
    } finally {
      setSearching(false);
      setTouched(true);
    }
  };

  const openChat = (id: string) => {
    window.dispatchEvent(new CustomEvent('osah:open-chat', { detail: id }));
  };

  return (
    <div className="panel">
      <h2 style={{ margin: 0 }}>Memory / Reference</h2>
      <div className="notice">
        Full-text search across every past chat message, ranked by relevance. Useful to take
        reference from earlier conversations.
      </div>

      <div className="row">
        <input
          value={q}
          placeholder="Search past conversations… e.g. proxy routing"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
        />
        <button className="primary" onClick={search} disabled={searching}>
          {searching ? <span className="spinner" /> : 'Search'}
        </button>
      </div>

      {touched && hits === null && <div className="muted">Type a query and press Search.</div>}
      {touched && hits && hits.length === 0 && <div className="muted">No matches.</div>}

      {hits?.map((h) => (
        <div key={h.msg_id} className="card" style={{ padding: 16 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <button
              className="small primary"
              style={{ padding: '4px 10px' }}
              onClick={() => openChat(h.chat_id)}
            >
              Open chat
            </button>
            <span className="small muted">{h.chat_title}</span>
            <div className="spacer" />
            <span className="badge amber">score {h.rank}</span>
          </div>
          <div className="md" style={{ fontSize: 13 }}>
            <Markdown source={h.snippet} />
          </div>
        </div>
      ))}

      <div className="border-t" style={{ paddingTop: 16 }}>
        <h3 style={{ marginTop: 0 }}>All conversations ({chats.length})</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
          {chats.map((c) => (
            <button key={c.id} className="glass small" style={{ justifyContent: 'flex-start', padding: '10px 12px' }} onClick={() => openChat(c.id)}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
              <span className="muted" style={{ marginLeft: 'auto' }}>{c.msg_count}</span>
            </button>
          ))}
          {chats.length === 0 && <div className="muted">No conversations yet.</div>}
        </div>
      </div>
    </div>
  );
}