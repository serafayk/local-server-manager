import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useConnectionStatus, useEngine } from '../providers/engine-provider';
import type { ImportConfigResult } from '@lsm/contracts';
import type { BackupInfo } from '../lib/api';
import { formatBytes, formatDateTime } from '../lib/format';
import { invokeTauri, openExternal } from '../lib/tauri';
import { useEngineSettings } from '../lib/hooks';
import { queryKeys } from '../lib/queries';
import { PageHeader } from '../components/page';
import { ConnectionBadge } from '../components/layout';
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  ErrorBanner,
  Field,
  Input,
  Select,
} from '../components/ui';

export function SettingsPage() {
  const { client, endpoint, isTauri, reload } = useEngine();
  const queryClient = useQueryClient();
  const connection = useConnectionStatus();
  const settingsQuery = useEngineSettings();
  const infoQuery = useQuery({
    queryKey: queryKeys.engineInfo,
    queryFn: () => client.getInfo(),
    refetchInterval: 15_000,
  });

  const [batchConcurrency, setBatchConcurrency] = useState('4');
  const [logLevel, setLogLevel] = useState<'debug' | 'info' | 'warn' | 'error'>('info');
  const [metricsIntervalMs, setMetricsIntervalMs] = useState('5000');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (settingsQuery.data) {
      setBatchConcurrency(String(settingsQuery.data.batchConcurrency));
      setLogLevel(settingsQuery.data.logLevel);
      setMetricsIntervalMs(String(settingsQuery.data.metricsIntervalMs));
    }
  }, [settingsQuery.data]);

  const save = useMutation({
    mutationFn: () =>
      client.updateSettings({
        batchConcurrency: Number.parseInt(batchConcurrency, 10),
        logLevel,
        metricsIntervalMs: Number.parseInt(metricsIntervalMs, 10),
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(queryKeys.settings, data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2_500);
    },
  });

  const info = infoQuery.data;

  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupInfo | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [configNotice, setConfigNotice] = useState<string | null>(null);
  const [importResults, setImportResults] = useState<ImportConfigResult[]>([]);
  const [stopEngineOpen, setStopEngineOpen] = useState(false);
  const [engineNotice, setEngineNotice] = useState<string | null>(null);
  const [engineError, setEngineError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isTauri) {
      return;
    }
    let cancelled = false;
    invokeTauri<boolean>('autostart_status')
      .then((value) => {
        if (!cancelled) {
          setAutostart(value);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setAutostartError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isTauri]);

  async function toggleAutostart(enabled: boolean): Promise<void> {
    setAutostartBusy(true);
    setAutostartError(null);
    try {
      const value = await invokeTauri<boolean>('set_autostart', { enabled });
      setAutostart(value);
    } catch (error) {
      setAutostartError(error instanceof Error ? error.message : String(error));
    } finally {
      setAutostartBusy(false);
    }
  }

  const backupsQuery = useQuery({
    queryKey: ['backups'],
    queryFn: () => client.listBackups(),
  });

  const createBackup = useMutation({
    mutationFn: () => client.createBackup(),
    onSuccess: () => {
      setBackupNotice('Backup criado.');
      void queryClient.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (error) => setBackupError(error.message),
  });

  const restore = useMutation({
    mutationFn: async (file: string) => {
      const projects = await client.listProjects();
      const active = projects
        .filter((project) =>
          ['STARTING', 'RUNNING', 'STOPPING', 'RESTARTING'].includes(project.runtime.status),
        )
        .map((project) => project.config.id);
      if (active.length > 0) {
        await client.bulkStop(active);
      }
      const result = await client.requestRestore(file);
      if (isTauri) {
        await invokeTauri('restart_engine');
        reload();
      }
      return result;
    },
    onSuccess: () => {
      setRestoreTarget(null);
      setBackupNotice(
        isTauri
          ? 'Backup restaurado; Engine reiniciado.'
          : 'Backup agendado. Reinicie o Engine (pnpm engine) para aplicar.',
      );
      void queryClient.invalidateQueries();
    },
    onError: (error) => setBackupError(error.message),
  });

  const exportConfigs = useMutation({
    mutationFn: () => client.exportProjects(),
    onSuccess: (bundle) => {
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `local-server-manager-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setConfigNotice(`${bundle.projects.length} projeto(s) exportado(s).`);
      setConfigError(null);
      setImportResults([]);
    },
    onError: (error) => setConfigError(error.message),
  });

  const importConfigs = useMutation({
    mutationFn: (bundle: unknown) => client.importProjects(bundle),
    onSuccess: (result) => {
      setImportResults(result.results);
      const ok = result.results.filter((item) => item.success).length;
      setConfigNotice(`${ok} de ${result.results.length} projeto(s) importado(s).`);
      setConfigError(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
    },
    onError: (error) => setConfigError(error.message),
  });

  async function handleImportFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      setImportResults([]);
      importConfigs.mutate(parsed);
    } catch {
      setConfigError('Arquivo JSON inválido.');
    }
  }

  return (
    <div>
      <PageHeader
        title="Configurações"
        description="Parâmetros do Engine e informações de conexão. Projeto-específicos ficam em cada projeto."
      />

      {settingsQuery.error ? <ErrorBanner message={settingsQuery.error.message} /> : null}
      {save.error ? <ErrorBanner message={save.error.message} /> : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Conexão">
          <dl className="grid gap-3 text-sm">
            <div className="flex items-center justify-between gap-3">
              <dt className="text-xs uppercase tracking-wide text-zinc-500">WebSocket</dt>
              <dd>
                <ConnectionBadge status={connection} />
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Endpoint</dt>
              <dd className="mono mt-0.5 break-all text-xs text-zinc-200">{endpoint.baseUrl}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Painel web</dt>
              <dd className="mt-1 flex flex-wrap items-center gap-2">
                <span className="mono text-xs text-zinc-300">{endpoint.baseUrl}/</span>
                <Button
                  size="sm"
                  title="Abrir a mesma interface no navegador (pede senha no primeiro acesso)"
                  onClick={() => {
                    void openExternal(`${endpoint.baseUrl}/`);
                  }}
                >
                  Abrir no navegador
                </Button>
              </dd>
            </div>
            {!isTauri ? (
              <div>
                <dt className="text-xs uppercase tracking-wide text-zinc-500">Sessão web</dt>
                <dd className="mt-1">
                  <Button
                    size="sm"
                    onClick={() => {
                      void client.logoutWeb().finally(() => {
                        window.location.reload();
                      });
                    }}
                  >
                    Sair
                  </Button>
                </dd>
              </div>
            ) : null}
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">WebSocket path</dt>
              <dd className="mono mt-0.5 text-xs text-zinc-200">{endpoint.websocketPath}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Token</dt>
              <dd className="mt-0.5 text-xs text-zinc-400">
                •••••••• (por execução, em engine.json)
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-zinc-500">Protocolo</dt>
              <dd className="mt-0.5 text-xs text-zinc-200">v{info?.protocolVersion ?? 1}</dd>
            </div>
          </dl>
        </Card>

        <Card title="Engine">
          {infoQuery.isLoading ? (
            <p className="text-sm text-zinc-500">Carregando...</p>
          ) : infoQuery.error ? (
            <ErrorBanner message={infoQuery.error.message} />
          ) : info ? (
            <>
              <dl className="grid gap-3 text-sm">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-zinc-500">PID</dt>
                  <dd className="mono mt-0.5 text-xs text-zinc-200">{info.pid}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-zinc-500">
                    Diretório de dados
                  </dt>
                  <dd className="mono mt-0.5 break-all text-xs text-zinc-200">{info.dataDir}</dd>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-zinc-500">Iniciado em</dt>
                    <dd className="mt-0.5 text-xs text-zinc-200">
                      {formatDateTime(info.startedAt)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-zinc-500">Projetos</dt>
                    <dd className="mt-0.5 text-xs text-zinc-200">{info.projects}</dd>
                  </div>
                </div>
                {settingsQuery.data ? (
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-zinc-500">Encerramento</dt>
                    <dd className="mt-0.5 text-xs text-zinc-300">
                      {settingsQuery.data.shutdownBehavior === 'stop-all'
                        ? 'Para todos os projetos ao encerrar o Engine'
                        : 'Mantém projetos rodando'}
                    </dd>
                  </div>
                ) : null}
              </dl>
              {isTauri ? (
                <div className="mt-3 space-y-2">
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => {
                      setEngineError(null);
                      setEngineNotice(null);
                      setStopEngineOpen(true);
                    }}
                  >
                    Encerrar Engine
                  </Button>
                  <p className="text-[11px] text-zinc-500">
                    Libera os arquivos para instalar uma atualização. Os projetos em execução são
                    parados.
                  </p>
                  {engineNotice ? <p className="text-xs text-emerald-300">{engineNotice}</p> : null}
                  {engineError ? <ErrorBanner message={engineError} /> : null}
                </div>
              ) : null}
            </>
          ) : null}
        </Card>

        <Card title="Inicialização com o Windows">
          {!isTauri ? (
            <p className="text-sm text-zinc-500">
              Disponível no aplicativo desktop. No modo navegador o autostart não pode ser alterado.
            </p>
          ) : (
            <div className="space-y-3">
              <Checkbox
                label="Iniciar o Engine no login"
                description="Cria uma tarefa no Agendador de Tarefas do Windows."
                checked={autostart === true}
                disabled={autostart === null || autostartBusy}
                onChange={(checked) => {
                  void toggleAutostart(checked);
                }}
              />
              <p className="text-xs text-zinc-500">
                Status:{' '}
                {autostart === null ? 'consultando…' : autostart ? 'habilitado' : 'desabilitado'}
              </p>
              {autostartError ? <ErrorBanner message={autostartError} /> : null}
            </div>
          )}
        </Card>
      </div>

      <Card
        className="mt-4"
        title="Backup e restauração"
        description="Cópias do SQLite em backups/. A restauração é aplicada quando o Engine reinicia."
        actions={
          <Button
            variant="primary"
            size="sm"
            loading={createBackup.isPending}
            onClick={() => {
              setBackupError(null);
              setBackupNotice(null);
              createBackup.mutate();
            }}
          >
            Criar backup
          </Button>
        }
        bodyClassName="p-0"
      >
        {backupError ? (
          <div className="p-3">
            <ErrorBanner message={backupError} onDismiss={() => setBackupError(null)} />
          </div>
        ) : null}
        {backupNotice ? (
          <div className="p-3">
            <div className="rounded-lg border border-emerald-800/60 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-200">
              {backupNotice}
            </div>
          </div>
        ) : null}
        {backupsQuery.isLoading ? (
          <p className="p-4 text-sm text-zinc-500">Carregando backups...</p>
        ) : (backupsQuery.data ?? []).length === 0 ? (
          <p className="p-4 text-sm text-zinc-500">Nenhum backup criado.</p>
        ) : (
          <ul className="divide-y divide-zinc-800/70">
            {(backupsQuery.data ?? []).map((backup) => (
              <li
                key={backup.file}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-xs"
              >
                <div className="min-w-0">
                  <p className="mono truncate text-zinc-200">{backup.file}</p>
                  <p className="text-zinc-500">
                    {formatDateTime(backup.createdAt)} · {formatBytes(backup.sizeBytes)}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    setBackupError(null);
                    setBackupNotice(null);
                    setRestoreTarget(backup);
                  }}
                >
                  Restaurar
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        className="mt-4"
        title="Configurações de projetos"
        description="Exporta/importa definições em JSON. Segredos de ambiente não são exportados."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={exportConfigs.isPending}
              onClick={() => exportConfigs.mutate()}
            >
              Exportar
            </Button>
            <Button
              size="sm"
              loading={importConfigs.isPending}
              onClick={() => fileInputRef.current?.click()}
            >
              Importar
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) {
                  void handleImportFile(file);
                }
                event.target.value = '';
              }}
            />
          </div>
        }
      >
        {configError ? (
          <ErrorBanner message={configError} onDismiss={() => setConfigError(null)} />
        ) : null}
        {configNotice ? <p className="text-xs text-emerald-300">{configNotice}</p> : null}
        {importResults.some((item) => !item.success) ? (
          <ul className="mt-2 space-y-1 text-xs text-amber-200">
            {importResults
              .filter((item) => !item.success)
              .map((item) => (
                <li key={item.name}>
                  {item.name}: {item.errorCode} — {item.message}
                </li>
              ))}
          </ul>
        ) : null}
      </Card>

      <Card className="mt-4" title="Configuração do Engine">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Concorrência em lote"
            htmlFor="settings-concurrency"
            hint="Entre 1 e 32 operações simultâneas."
          >
            <Input
              id="settings-concurrency"
              value={batchConcurrency}
              onChange={(event) => setBatchConcurrency(event.target.value)}
              inputMode="numeric"
            />
          </Field>
          <Field
            label="Nível de log"
            htmlFor="settings-loglevel"
            hint="Aplica no próximo start do Engine."
          >
            <Select
              id="settings-loglevel"
              value={logLevel}
              onChange={(event) => setLogLevel(event.target.value as typeof logLevel)}
            >
              <option value="debug">debug</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </Select>
          </Field>
          <Field
            label="Intervalo de métricas (ms)"
            htmlFor="settings-metrics"
            hint="Aplica em runtime; mínimo de 1 segundo."
          >
            <Input
              id="settings-metrics"
              value={metricsIntervalMs}
              onChange={(event) => setMetricsIntervalMs(event.target.value)}
              inputMode="numeric"
            />
          </Field>
          <Field
            label="Comportamento no shutdown"
            htmlFor="settings-shutdown"
            hint="ADR-008: parar todos é o único modo suportado com logging acoplado."
          >
            <Select id="settings-shutdown" value="stop-all" disabled>
              <option value="stop-all">Parar todos os projetos</option>
            </Select>
          </Field>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Salvar configuração
          </Button>
          {saved ? <span className="text-xs text-emerald-300">Salvo.</span> : null}
        </div>
      </Card>

      <Dialog
        open={restoreTarget !== null}
        onClose={() => setRestoreTarget(null)}
        title="Restaurar backup"
        description="Os projetos em execução serão parados e o banco atual será substituído."
        size="md"
        footer={
          <>
            <Button onClick={() => setRestoreTarget(null)}>Cancelar</Button>
            <Button
              variant="danger"
              loading={restore.isPending}
              onClick={() => {
                if (restoreTarget) {
                  setBackupError(null);
                  restore.mutate(restoreTarget.file);
                }
              }}
            >
              Restaurar
            </Button>
          </>
        }
      >
        <p className="text-sm text-zinc-300">
          Restaurar <span className="mono">{restoreTarget?.file}</span>?
        </p>
        <p className="mt-2 text-xs text-zinc-500">
          O banco atual é copiado para <span className="mono">backups/</span> antes da substituição.
          {isTauri
            ? ' O Engine será reiniciado automaticamente.'
            : ' Reinicie o Engine (pnpm engine) para aplicar.'}
        </p>
      </Dialog>

      <Dialog
        open={stopEngineOpen}
        onClose={() => setStopEngineOpen(false)}
        title="Encerrar o Engine"
        description="O aplicativo continuará aberto, mas sem Engine até ser reaberto."
        size="md"
        footer={
          <>
            <Button onClick={() => setStopEngineOpen(false)}>Cancelar</Button>
            <Button
              variant="danger"
              onClick={() => {
                void (async () => {
                  try {
                    await invokeTauri<boolean>('stop_engine');
                    setStopEngineOpen(false);
                    setEngineNotice(
                      'Engine encerrado. Reabra o aplicativo para iniciá-lo novamente.',
                    );
                  } catch (error) {
                    setStopEngineOpen(false);
                    setEngineError(error instanceof Error ? error.message : String(error));
                  }
                })();
              }}
            >
              Encerrar
            </Button>
          </>
        }
      >
        <p className="text-sm text-zinc-300">
          Encerrar o Engine e <span className="font-semibold">parar todos os projetos</span> em
          execução? Use isto antes de instalar uma atualização.
        </p>
      </Dialog>
    </div>
  );
}
