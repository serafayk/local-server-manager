import type { LogRecord, ProjectMetricsPayload, SystemMetricsPayload } from '@lsm/contracts';
import { create } from 'zustand';
import type { ConnectionStatus } from '../lib/socket';

const MAX_LIVE_LOGS = 2_000;

interface AppState {
  connection: ConnectionStatus;
  logsByProject: Record<string, LogRecord[]>;
  metricsByProject: Record<string, ProjectMetricsPayload>;
  systemMetrics: SystemMetricsPayload | null;
  healthNotes: Record<string, string>;
  setConnection: (status: ConnectionStatus) => void;
  appendLog: (record: LogRecord) => void;
  clearLogs: (projectId: string) => void;
  setProjectMetrics: (metrics: ProjectMetricsPayload) => void;
  setSystemMetrics: (metrics: SystemMetricsPayload) => void;
  setHealthNote: (projectId: string, note: string) => void;
}

/**
 * Estados voláteis alimentados pelo WebSocket. O histórico completo continua
 * no arquivo/HTTP, por isso os buffers têm limite.
 */
export const useAppStore = create<AppState>((set) => ({
  connection: 'idle',
  logsByProject: {},
  metricsByProject: {},
  systemMetrics: null,
  healthNotes: {},

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

  setProjectMetrics: (metrics) =>
    set((state) => ({
      metricsByProject: { ...state.metricsByProject, [metrics.projectId]: metrics },
    })),

  setSystemMetrics: (metrics) => set({ systemMetrics: metrics }),

  setHealthNote: (projectId, note) =>
    set((state) => ({ healthNotes: { ...state.healthNotes, [projectId]: note } })),
}));

export { MAX_LIVE_LOGS };
