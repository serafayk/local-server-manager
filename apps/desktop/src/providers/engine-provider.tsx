import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Server } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button, Input, Spinner } from '../components/ui';
import { useAppStore } from '../stores/app-store';
import { EngineClient, type EngineEndpoint } from '../lib/api';
import { resolveEngineEndpoint } from '../lib/engine-endpoint';
import { applyEngineEvent } from '../lib/event-handler';
import { queryKeys } from '../lib/queries';
import { EngineSocket, type ConnectionStatus } from '../lib/socket';
import { isTauriRuntime } from '../lib/tauri';
interface EngineContextValue {
  client: EngineClient;
  endpoint: EngineEndpoint;
  isTauri: boolean;
  /** Reexecuta a descoberta (usado após reiniciar o Engine). */
  reload: () => void;
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
  const setProjectMetrics = useAppStore((state) => state.setProjectMetrics);
  const setSystemMetrics = useAppStore((state) => state.setSystemMetrics);
  const setHealthNote = useAppStore((state) => state.setHealthNote);
  const connection = useAppStore((state) => state.connection);

  const [endpoint, setEndpoint] = useState<EngineEndpoint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const isTauri = isTauriRuntime();
  const reload = (): void => setAttempt((value) => value + 1);

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
      onEvent: (event) =>
        applyEngineEvent(event, {
          queryClient,
          appendLog,
          setProjectMetrics,
          setSystemMetrics,
          setHealthNote,
        }),
    });
    socket.connect();
    return () => socket.close();
  }, [
    endpoint,
    queryClient,
    appendLog,
    setConnection,
    setProjectMetrics,
    setSystemMetrics,
    setHealthNote,
  ]);

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

  return (
    <EngineContext.Provider value={{ client, endpoint, isTauri, reload }}>
      {isTauri ? children : <WebAuthGate client={client}>{children}</WebAuthGate>}
    </EngineContext.Provider>
  );
}

type AuthStage = 'loading' | 'setup' | 'login' | 'ready' | 'error';

/**
 * Gate da UI web: o Engine exige senha (sessão por cookie) quando aberto pelo
 * navegador. No desktop (Tauri) o token do shell continua sendo usado.
 */
function WebAuthGate({ client, children }: { client: EngineClient; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [stage, setStage] = useState<AuthStage>('loading');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setStage('loading');
    client
      .getAuthStatus()
      .then((status) => {
        if (cancelled) {
          return;
        }
        setStage(!status.configured ? 'setup' : status.authenticated ? 'ready' : 'login');
      })
      .catch((reason: unknown) => {
        if (cancelled) {
          return;
        }
        setError(reason instanceof Error ? reason.message : String(reason));
        setStage('error');
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      if (stage === 'setup') {
        if (password !== confirm) {
          throw new Error('As senhas não coincidem.');
        }
        await client.setupWebAuth(password);
      } else {
        await client.loginWeb(password);
      }
      setPassword('');
      setConfirm('');
      queryClient.clear();
      setStage('ready');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  if (stage === 'ready') {
    return <>{children}</>;
  }

  if (stage === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center gap-3 text-sm text-zinc-400">
        <Spinner className="h-4 w-4" />
        Verificando acesso...
      </div>
    );
  }

  const isSetup = stage === 'setup';
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-900/60 p-6">
        <div className="flex items-center gap-2 text-zinc-100">
          <Server className="h-5 w-5 text-emerald-400" />
          <h1 className="text-lg font-semibold">
            {isSetup ? 'Definir senha do painel' : 'Entrar no painel'}
          </h1>
        </div>
        <p className="mt-2 text-sm text-zinc-400">
          {isSetup
            ? 'Primeiro acesso pela web. Defina uma senha (mínimo 8 caracteres). Ela será pedida sempre que você abrir este endereço no navegador.'
            : 'Informe a senha definida para acessar o Local Server Manager.'}
        </p>

        {error ? (
          <p className="mt-3 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">
            {error}
          </p>
        ) : null}

        <div className="mt-4 space-y-3">
          <label className="block text-xs text-zinc-400" htmlFor="web-password">
            Senha
            <Input
              id="web-password"
              type="password"
              className="mt-1"
              value={password}
              autoFocus
              autoComplete={isSetup ? 'new-password' : 'current-password'}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !busy) {
                  void submit();
                }
              }}
            />
          </label>
          {isSetup ? (
            <label className="block text-xs text-zinc-400" htmlFor="web-confirm">
              Confirmar senha
              <Input
                id="web-confirm"
                type="password"
                className="mt-1"
                value={confirm}
                autoComplete="new-password"
                onChange={(event) => setConfirm(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !busy) {
                    void submit();
                  }
                }}
              />
            </label>
          ) : null}
        </div>

        <div className="mt-5 flex justify-end">
          <Button
            variant="primary"
            loading={busy}
            disabled={password.length < (isSetup ? 8 : 1)}
            onClick={() => void submit()}
          >
            {isSetup ? 'Definir senha e entrar' : 'Entrar'}
          </Button>
        </div>

        {stage === 'error' ? (
          <div className="mt-3 flex justify-end">
            <Button size="sm" onClick={() => setStage('login')}>
              Tentar novamente
            </Button>
          </div>
        ) : null}

        <p className="mt-4 text-[11px] text-zinc-600">
          Acesso restrito a 127.0.0.1. A sessão expira em 12 horas.
        </p>
      </div>
    </div>
  );
}
