import { create } from 'zustand';
import { api } from './api/client';
import type { ChatSummary, DiscoveredModel, Provider, Status, MachineInfo, LicenseValidationResult } from './api/types';

interface AppState {
  providers: Provider[];
  models: DiscoveredModel[];
  chats: ChatSummary[];
  status: Status | null;
  online: boolean;
  loading: boolean;
  license: LicenseValidationResult | null;
  machine: MachineInfo | null;
  licensedEmail: string | null;

  refresh: () => Promise<void>;
  setLicense: (license: LicenseValidationResult, email?: string) => void;
  clearLicense: () => void;
  setMachine: (machine: MachineInfo) => void;
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
  license: null,
  machine: null,
  licensedEmail: null,

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

  setLicense: (license, email) => set({ license, licensedEmail: email ?? null }),
  clearLicense: () => set({ license: null, licensedEmail: null }),
  setMachine: (machine) => set({ machine }),
}));

export function activeProviderId(providers?: Provider[]): string | null {
  return providers?.find((p) => p.active)?.id ?? null;
}