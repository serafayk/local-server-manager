import type { LogRecord } from '@lsm/contracts';
import { create } from 'zustand';
import type { ConnectionStatus } from '../lib/socket';

const MAX_LIVE_LOGS = 2_000;

interface AppState {
  connection: ConnectionStatus;
  logsByProject: Record<string, LogRecord[]>;
  setConnection: (status: ConnectionStatus) => void;
  appendLog: (record: LogRecord) => void;
  clearLogs: (projectId: string) => void;
}

/**
 * Buffer apenas da visualização ao vivo. O histórico completo continua no
 * arquivo e na API (`/logs`), por isso o limite é pequeno.
 */
export const useAppStore = create<AppState>((set) => ({
  connection: 'idle',
  logsByProject: {},

  setConnection: (status) => set({ connection: status }),

  appendLog: (record) =>
    set((state) => {
      const current = state.logsByProject[record.projectId] ?? [];
      const next =
        current.length >= MAX_LIVE_LOGS ? current.slice(-MAX_LIVE_LOGS + 1) : [...current];
      next.push(record);
      return { logsByProject: { ...state.logsByProject, [record.projectId]: next } };
    }),

  clearLogs: (projectId) =>
    set((state) => {
      const logsByProject = { ...state.logsByProject };
      delete logsByProject[projectId];
      return { logsByProject };
    }),
}));

export { MAX_LIVE_LOGS };
