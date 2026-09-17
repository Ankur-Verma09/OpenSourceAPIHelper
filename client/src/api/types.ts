// Typed contract with the OpenSourceAPIHelper service API (matches server/src/api.js).
// Keys are NEVER typed as plaintext on the wire — only masked views.

export type ProviderTransport = 'openai';

/** Redacted provider view returned by the service. Never includes a raw key. */
export interface Provider {
  id: string;
  name: string;
  base_url: string;
  key_masked: string; // e.g. "sk-••••••abcd" or ""
  has_key: boolean;
  key_env: string;
  type: ProviderTransport;
  active: boolean;
  created_at: number;
  updated_at: number;
}

export type Role = 'user' | 'assistant';

export interface ChatMessage {
  id: string;
  chat_id: string;
  role: Role;
  content: string;
  model: string;
  created_at: number;
}

export interface ChatSummary {
  id: string;
  title: string;
  model: string;
  created_at: number;
  updated_at: number;
  msg_count: number;
}

export interface ChatDetail {
  id: string;
  title: string;
  model: string;
  messages: ChatMessage[];
}

export interface DiscoveredModel {
  id: string;
  model: string;
  provider_id: string;
  provider_name?: string;
  provider_active?: boolean;
}

export interface ProviderTestResult {
  ok: boolean;
  error?: string;
  models?: string[];
}

export interface Status {
  ok: boolean;
  providers: number;
  models: number;
  chats: number;
  memory_indexed: number;
  schema_version: number;
  version: string;
}

/** A provider payload sent to the wire — apiKey is accepted but never echoed back as plaintext. */
export interface ProviderDraft {
  name: string;
  baseUrl?: string;
  apiKey?: string;
  keyEnv?: string;
}

export interface MemoryHit {
  msg_id: string;
  chat_id: string;
  chat_title: string;
  content: string;
  snippet: string;
  rank: number;
}

/** Stream events emitted by POST /api/chats/:id/stream (SSE). */
export type StreamEvent =
  | { event: 'start'; model: string }
  | { event: 'reasoning'; text: string }
  | { event: 'delta'; text: string }
  | { event: 'finish' }
  | { event: 'done'; message_id: string | null; full: string }
  | { event: 'error'; error: string };