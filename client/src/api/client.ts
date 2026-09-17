// Thin typed fetch wrapper around the loopback service API.
// Base URL: VITE_OSAH_BASE at build time, else window override set by the
// Electron preload, else http://127.0.0.1:8787 (the server's default port).

import type {
  ChatDetail,
  ChatSummary,
  DiscoveredModel,
  MemoryHit,
  Provider,
  ProviderDraft,
  ProviderTestResult,
  Status,
} from './types';

function resolveBase(): string {
  const w = window as unknown as {
    OSAH_BASE?: string;
    osah?: { serviceHost?: () => string; servicePort?: () => number };
  };
  const host = w.osah?.serviceHost?.() || '127.0.0.1';
  const port = w.osah?.servicePort?.() ?? 8787;
  return import.meta.env.VITE_OSAH_BASE || w.OSAH_BASE || `http://${host}:${port}`;
}

export const API_BASE = resolveBase();

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method || 'GET').toUpperCase();
  const needsCsrf = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(needsCsrf ? { 'X-OSAH-CSRF': '1' } : {}),
        ...(init.headers as Record<string, string>),
      },
      ...init,
    });
  } catch (e) {
    throw new ApiError(`Cannot reach the service at ${API_BASE} — is it running?`, 0);
  }

  if (res.status === 204) return undefined as T;

  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const msg =
      (body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : String(body)) || res.statusText;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean; up: number }>('/api/health'),

  // providers
  listProviders: () => request<Provider[]>('/api/providers'),
  createProvider: (draft: ProviderDraft) =>
    request<Provider>('/api/providers', { method: 'POST', body: JSON.stringify(draft) }),
  updateProvider: (id: string, draft: Partial<ProviderDraft>) =>
    request<Provider>(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify(draft) }),
  deleteProvider: (id: string) => request<void>(`/api/providers/${id}`, { method: 'DELETE' }),
  testProvider: (id: string) =>
    request<ProviderTestResult>(`/api/providers/${id}/test`, { method: 'POST' }),
  rotateProviderKey: (id: string, apiKey: string) =>
    request<{ ok: boolean; provider: Provider }>(`/api/providers/${id}/rotate-key`, {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    }),

  // models
  listModels: () => request<DiscoveredModel[]>('/api/models'),
  activateModel: (model: string) =>
    request<{ ok: boolean; active_provider: string | null }>('/api/models/activate', {
      method: 'POST',
      body: JSON.stringify({ model }),
    }),

  // chats
  listChats: () => request<ChatSummary[]>('/api/chats'),
  createChat: (draft: { title?: string; model?: string }) =>
    request<ChatSummary>('/api/chats', { method: 'POST', body: JSON.stringify(draft) }),
  getChat: (id: string) => request<ChatDetail>(`/api/chats/${id}`),
  updateChat: (id: string, patch: { title?: string; model?: string }) =>
    request<{ ok: boolean }>(`/api/chats/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteChat: (id: string) => request<void>(`/api/chats/${id}`, { method: 'DELETE' }),

  // memory
  searchMemory: (q: string, limit = 10) =>
    request<MemoryHit[]>(`/api/memory/search?q=${encodeURIComponent(q)}&limit=${limit}`),

  // status
  status: () => request<Status>('/api/status'),
};

/**
 * Stream a chat completion via SSE. The service persists the user message and
 * streams `delta` frames; on completion it emits `done` with the persisted id.
 */
export async function streamChat(
  chatId: string,
  content: string,
  model: string,
  onEvent: (ev: StreamEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/chats/${chatId}/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, model }),
    signal,
  });

  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try {
      msg = JSON.parse(text).error || text;
    } catch {
      /* keep raw */
    }
    throw new ApiError(msg, res.status);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new ApiError('service returned an empty body', 0);

  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  while (!done) {
    const { value, done: streamDone } = await reader.read();
    done = streamDone;
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = frame
        .split('\n')
        .find((l) => l.startsWith('data:'))
        ?.slice(5)
        .trim();
      if (!line) continue;
      try {
        onEvent(JSON.parse(line) as StreamEvent);
      } catch {
        /* non-JSON frame — ignore */
      }
    }
  }
}

// Re-export for the components' convenience, keeping a single import surface.
import type { StreamEvent } from './types';
export type { StreamEvent };