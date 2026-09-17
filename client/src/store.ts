import { create } from 'zustand';
import { api } from './api/client';
import type { ChatSummary, DiscoveredModel, Provider, Status } from './api/types';

interface AppState {
  providers: Provider[];
  models: DiscoveredModel[];
  chats: ChatSummary[];
  status: Status | null;
  online: boolean;
  loading: boolean;

  refresh: () => Promise<void>;
}

async function safe<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

export const useStore = create<AppState>((set) => ({
  providers: [],
  models: [],
  chats: [],
  status: null,
  online: false,
  loading: false,

  refresh: async () => {
    set({ loading: true });
    const [providers, models, chats, status] = await Promise.all([
      safe(api.listProviders),
      safe(api.listModels),
      safe(api.listChats),
      safe(api.status),
    ]);
    set({
      providers: providers ?? [],
      models: models ?? [],
      chats: chats ?? [],
      status: status ?? null,
      online: !!(providers || models || chats || status),
      loading: false,
    });
  },
}));

export function activeProviderId(providers?: Provider[]): string | null {
  return providers?.find((p) => p.active)?.id ?? null;
}