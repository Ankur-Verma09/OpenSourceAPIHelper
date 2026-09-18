import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, streamChat } from '../api/client';
import { useStore } from '../store';
import type { ChatDetail, ChatMessage, StreamEvent } from '../api/types';
import { Markdown } from '../lib/markdown';

interface LiveMsg {
  role: 'assistant';
  content: string;
  reasoning: string;
  streaming: boolean;
  model: string;
}

export function Chat() {
  const models = useStore((s) => s.models);
  const chats = useStore((s) => s.chats);
  const refresh = useStore((s) => s.refresh);

  const [chatId, setChatId] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatDetail | null>(null);
  const [live, setLive] = useState<LiveMsg | null>(null);
  const [input, setInput] = useState('');
  const [model, setModel] = useState(() => models[0]?.model ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-select first chat on mount
  useEffect(() => {
    if (!chatId && chats.length > 0) {
      setChatId(chats[0].id);
    }
  }, []); // Run once on mount

  // open chat on click from the sidebar
  useEffect(() => {
    const handler = (ev: Event) => {
      const id = (ev as CustomEvent<string>).detail;
      if (id) setChatId(id);
    };
    window.addEventListener('osah:open-chat', handler);
    return () => window.removeEventListener('osah:open-chat', handler);
  }, []);

  // load messages when the active chat changes
  useEffect(() => {
    setError(null);
    setLive(null);
    if (!chatId) {
      setChat(null);
      return;
    }
    let cancelled = false;
    api
      .getChat(chatId)
      .then((c) => {
        if (!cancelled) setChat(c);
      })
      .catch((e) => setError(e.message));
    return () => {
      cancelled = true;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [chatId]);

  // keep chat list summaries fresh after each message
  useEffect(() => {
    refresh();
  }, [chat?.messages.length, live, refresh]);

  const scrollDown = useCallback(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, []);
  useEffect(scrollDown, [chat, live?.content]);

  // model default: if the chat has one, use it; else first discovered model
  useEffect(() => {
    if (chat?.model) setModel(chat.model);
    else if (!model && models.length) setModel(models[0].model);
  }, [chat?.model, models, model]);

  const defaultModel = useMemo(
    () => chat?.model || models.find((m) => m.provider_active)?.model || models[0]?.model || '',
    [chat?.model, models],
  );
  const selectedModel = model || defaultModel;

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;
    if (!chatId) return;
    if (!selectedModel) {
      setError('No model available — add a provider key in Settings and Test it first.');
      return;
    }

    setBusy(true);
    setError(null);
    // optimistic user message; the service also persists it
    setChat((c) =>
      c
        ? {
            ...c,
            messages: [
              ...c.messages,
              { id: `local-${Date.now()}`, chat_id: c.id, role: 'user', content: text, model: selectedModel, created_at: Date.now() },
            ],
          }
        : c,
    );
    setInput('');

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      await streamChat(
        chatId,
        text,
        selectedModel,
        (ev: StreamEvent) => {
          switch (ev.event) {
            case 'reasoning':
              setLive((l) => (l ? { ...l, reasoning: l.reasoning + ev.text } : l));
              break;
            case 'delta':
              setLive((l) => (l ? { ...l, content: l.content + ev.text } : l));
              break;
            case 'done':
              setLive(null);
              setChat((c) =>
                c
                  ? {
                      ...c,
                      model: selectedModel,
                      messages: [
                        ...c.messages,
                        { id: ev.message_id || `assistant-${Date.now()}`, chat_id: c.id, role: 'assistant', content: ev.full, model: selectedModel, created_at: Date.now() },
                      ],
                    }
                  : c,
              );
              break;
            case 'error':
              setError(ev.error);
              setLive(null);
              break;
          }
        },
        ac.signal,
      );
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        setError((e as Error).message);
      }
      setLive(null);
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [input, busy, chatId, selectedModel, setChat]);

  const stop = () => abortRef.current?.abort();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && chatId) {
        e.preventDefault();
        send();
      }
    };
    const ta = textAreaRef.current;
    ta?.addEventListener('keydown', onKey);
    return () => ta?.removeEventListener('keydown', onKey);
  }, [send, chatId]);

  useEffect(() => {
    const ta = textAreaRef.current;
    if (ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 160) + 'px';
    }
  }, [input]);

  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="pane-head">
        <strong>{chat?.title ?? 'Chat'}</strong>
        <div className="spacer" />
        {error && <div className="error-banner" style={{ maxWidth: 400 }}>{error}</div>}
        <div className="spacer" />
        <span className="badge purple">model: {selectedModel || '—'}</span>
      </div>

      <div className="messages" ref={scrollRef}>
        {!chatId && (
          <div className="empty">
            <div className="glow">✨</div>
            <h3>No chat selected</h3>
            <p>Create a new chat from the sidebar, then pick a model and start typing.</p>
          </div>
        )}

        {(chat?.messages ?? []).map((m) =>
          m.role === 'user' ? (
            <UserBubble key={m.id} m={m} />
          ) : (
            <div key={m.id} className="msg assistant">
              <div className="msg-row">
                <Markdown source={m.content} />
              </div>
              {m.model && <div className="meta">{m.model}</div>}
            </div>
          ),
        )}

        {live?.streaming && (
          <div className="msg assistant">
            {live.reasoning && <div className="reasoning">⟡ {live.reasoning}</div>}
            <div className={`msg-row ${live.content ? '' : 'cursor'}`}>
              {live.content ? <Markdown source={live.content + '▌'} /> : <span className="muted">thinking…</span>}
            </div>
          </div>
        )}
      </div>

      {chatId && (
        <div className="composer">
          <select
            className="model"
            value={selectedModel}
            onChange={(e) => {
              setModel(e.target.value);
              api.updateChat(chatId, { model: e.target.value }).catch(() => undefined);
            }}
          >
            {models.length === 0 && <option value="">— no models discovered —</option>}
            {models.map((m) => (
              <option key={m.id} value={m.model}>
                {m.model} · {m.provider_name}
              </option>
            ))}
          </select>
          <textarea
            ref={textAreaRef}
            rows={1}
            placeholder="Ask anything…  (Enter to send, Shift+Enter for newline)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          {busy ? (
            <button onClick={stop}>■ Stop</button>
          ) : (
            <button className="primary" onClick={send} disabled={!input.trim()}>
              Send
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function UserBubble({ m }: { m: ChatMessage }) {
  return (
    <div className="msg user">
      <div className="msg-row">{m.content}</div>
      {m.model && <div className="meta">{m.model}</div>}
    </div>
  );
}