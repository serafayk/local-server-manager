import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Server } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Spinner } from '../components/ui';
import { useAppStore } from '../stores/app-store';
import { EngineClient, type EngineEndpoint } from '../lib/api';
import { resolveEngineEndpoint } from '../lib/engine-endpoint';
import { applyEngineEvent } from '../lib/event-handler';
import { queryKeys } from '../lib/queries';
import { EngineSocket, type ConnectionStatus } from '../lib/socket';

interface EngineContextValue {
  client: EngineClient;
  endpoint: EngineEndpoint;
}

const EngineContext = createContext<EngineContextValue | null>(null);

export function useEngine(): EngineContextValue {
  const context = useContext(EngineContext);
  if (!context) {
    throw new Error('useEngine precisa estar dentro de <EngineProvider>');
  }
  return context;
}

export function useConnectionStatus(): ConnectionStatus {
  return useAppStore((state) => state.connection);
}

export function EngineProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const appendLog = useAppStore((state) => state.appendLog);
  const setConnection = useAppStore((state) => state.setConnection);
  const connection = useAppStore((state) => state.connection);

  const [endpoint, setEndpoint] = useState<EngineEndpoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setResolving(true);
    setError(null);

    resolveEngineEndpoint()
      .then((resolved) => {
        if (!cancelled) {
          setEndpoint(resolved);
          setResolving(false);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : String(reason));
          setResolving(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const client = useMemo(() => (endpoint ? new EngineClient(endpoint) : null), [endpoint]);

  useEffect(() => {
    if (!endpoint) {
      return;
    }
    const socket = new EngineSocket(endpoint, {
      onStatus: setConnection,
      onEvent: (event) => applyEngineEvent(event, { queryClient, appendLog }),
    });
    socket.connect();
    return () => socket.close();
  }, [endpoint, queryClient, appendLog, setConnection]);

  useEffect(() => {
    if (connection === 'open') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      void queryClient.invalidateQueries({ queryKey: ['project'] });
      void queryClient.invalidateQueries({ queryKey: ['events'] });
    }
  }, [connection, queryClient]);

  if (resolving) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-3 text-sm text-zinc-400">
        <Spinner className="h-4 w-4" />
        Conectando ao Engine...
      </div>
    );
  }

  if (error || !client || !endpoint) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="w-full max-w-xl rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
          <div className="flex items-center gap-2 text-zinc-100">
            <Server className="h-5 w-5 text-red-400" />
            <h1 className="text-lg font-semibold">Engine não encontrado</h1>
          </div>
          <p className="mt-2 text-sm text-zinc-400">{error ?? 'Falha na descoberta do Engine.'}</p>
          <ol className="mt-4 space-y-1 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-400">
            <li>
              1. Inicie o Engine: <code className="mono text-zinc-200">pnpm engine</code>
            </li>
            <li>
              2. Confirme que <code className="mono text-zinc-200">engine.json</code> existe em
              <code className="mono text-zinc-200"> %LOCALAPPDATA%\LocalServerManager\engine</code>
            </li>
            <li>3. Clique em "Tentar novamente".</li>
          </ol>
          <div className="mt-5 flex justify-end">
            <Button
              variant="primary"
              onClick={() => {
                setAttempt((value) => value + 1);
              }}
            >
              <RefreshCw className="h-4 w-4" />
              Tentar novamente
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return <EngineContext.Provider value={{ client, endpoint }}>{children}</EngineContext.Provider>;
}
