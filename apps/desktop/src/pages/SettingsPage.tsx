import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useConnectionStatus, useEngine } from '../providers/engine-provider';
import { formatDateTime } from '../lib/format';
import { useEngineSettings } from '../lib/hooks';
import { queryKeys } from '../lib/queries';
import { PageHeader } from '../components/page';
import { ConnectionBadge } from '../components/layout';
import { Button, Card, ErrorBanner, Field, Input, Select } from '../components/ui';

export function SettingsPage() {
  const { client, endpoint } = useEngine();
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
                  <dd className="mt-0.5 text-xs text-zinc-200">{formatDateTime(info.startedAt)}</dd>
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
          ) : null}
        </Card>
      </div>

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
            hint="Reservado para a Fase 5."
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
    </div>
  );
}
