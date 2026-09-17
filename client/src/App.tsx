import { useEffect, useState } from 'react';
import { useStore } from './store';
import { Dashboard } from './pages/Dashboard';
import { Chat } from './pages/Chat';
import { Settings } from './pages/Settings';
import { History } from './pages/History';

type Tab = 'chat' | 'settings' | 'history' | 'dashboard';

const TABS: { id: Tab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'settings', label: 'Settings' },
  { id: 'history', label: 'Memory' },
  { id: 'dashboard', label: 'Dashboard' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('chat');
  const refresh = useStore((s) => s.refresh);
  const online = useStore((s) => s.online);
  const loading = useStore((s) => s.loading);

  useEffect(() => {
    refresh();
    const t = setInterval(() => refresh(), 8000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <div className="app">
      <header className="topbar glass hairline">
        <div className="brand">
          <div className="logo">AI</div>
          <span>OpenSourceAPIHelper</span>
        </div>
        <div className="spacer" />
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <span className={`badge dot ${online ? 'green' : 'red'}`}>
          {loading ? <span className="spinner" /> : online ? 'service online' : 'service offline'}
        </span>
      </header>

      <main className="layout">
        <div className="sidebar glass">
          <ChatList onOpen={() => setTab('chat')} activeTab={tab} />
        </div>
        <section className="pane glass">
          {tab === 'chat' && <Chat />}
          {tab === 'settings' && <Settings />}
          {tab === 'history' && <History />}
          {tab === 'dashboard' && <Dashboard />}
        </section>
      </main>
    </div>
  );
}

function ChatList({ onOpen, activeTab }: { onOpen: () => void; activeTab: Tab }) {
  const chats = useStore((s) => s.chats);
  const refresh = useStore((s) => s.refresh);
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const newChat = async () => {
    const { api } = await import('./api/client');
    setBusy(true);
    try {
      const c = await api.createChat({});
      await refresh();
      setActive(c.id);
      onOpen();
      window.dispatchEvent(new CustomEvent('osah:open-chat', { detail: c.id }));
    } finally {
      setBusy(false);
    }
  };

  const del = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Delete this chat and its history?')) return;
    const { api } = await import('./api/client');
    await api.deleteChat(id);
    if (active === id) setActive(null);
    await refresh();
  };

  useEffect(() => {
    const handler = (ev: Event) => {
      const id = (ev as CustomEvent<string>).detail;
      if (id) setActive(id);
    };
    window.addEventListener('osah:open-chat', handler);
    return () => window.removeEventListener('osah:open-chat', handler);
  }, []);

  const isChatTab = activeTab === 'chat';

  return (
    <>
      <div className="row">
        <h3 style={{ margin: 0 }}>Chats</h3>
        <div className="spacer" />
        <button className="primary" onClick={newChat} disabled={busy}>
          {busy ? <span className="spinner" /> : '+ New'}
        </button>
      </div>
      {chats.length === 0 && <div className="note">No chats yet — start one.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {chats.map((c) => (
          <div
            key={c.id}
            className={`chat-item ${isChatTab && active === c.id ? 'active' : ''}`}
            onClick={() => {
              setActive(c.id);
              window.dispatchEvent(new CustomEvent('osah:open-chat', { detail: c.id }));
              onOpen();
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div className="title">{c.title}</div>
              <div className="sub">
                {c.msg_count} msgs · {c.model || 'no model'}
              </div>
            </div>
            <div className="spacer" />
            <button
              className="del ghost-danger"
              style={{ padding: '2px 6px', fontSize: 12 }}
              onClick={(e) => del(e, c.id)}
              title="Delete chat"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </>
  );
}