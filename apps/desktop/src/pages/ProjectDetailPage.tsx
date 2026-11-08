import type { LogRecord } from '@lsm/contracts';
import type { ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Copy, Pencil, Play, RotateCw, Square, Trash2 } from 'lucide-react';
import { useProjectActions } from '../lib/actions';
import {
  useProjectEvents,
  useProjectInstances,
  useProjectLogs,
  useProjectQuery,
} from '../lib/hooks';
import {
  formatBytes,
  formatCommand,
  formatDateTime,
  formatDuration,
  formatUptime,
  isNumber,
  shortId,
} from '../lib/format';
import { mergeLogRecords } from '../lib/logs';
import { useAppStore } from '../stores/app-store';
import { LogViewer } from '../components/LogViewer';
import { ProjectForm } from '../components/ProjectForm';
import { HealthBadge, StatusBadge, isActiveStatus } from '../components/status';
import { PageHeader, StatCard } from '../components/page';
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorBanner,
  Select,
  Tabs,
} from '../components/ui';

const EMPTY_LOGS: LogRecord[] = [];
const SENSITIVE_KEY =
  /(pass(word|phrase)?|secret|token|api[_-]?key|authorization|credential|session)/i;

const TABS = [
  { id: 'overview', label: 'Visão geral' },
  { id: 'logs', label: 'Logs' },
  { id: 'config', label: 'Configuração' },
  { id: 'history', label: 'Histórico' },
  { id: 'metrics', label: 'Métricas' },
];

function Definition({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-zinc-200">{value}</dd>
    </div>
  );
}

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const query = useProjectQuery(id);
  const instances = useProjectInstances(id);
  const events = useProjectEvents(id);
  const actions = useProjectActions();

  const [tab, setTab] = useState('overview');
  const [editOpen, setEditOpen] = useState(false);
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [stopForEditOpen, setStopForEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const live = useAppStore((state) => (id ? (state.logsByProject[id] ?? EMPTY_LOGS) : EMPTY_LOGS));
  const projectMetrics = useAppStore((state) => (id ? state.metricsByProject[id] : undefined));
  const healthNote = useAppStore((state) => (id ? state.healthNotes[id] : undefined));
  const history = useProjectLogs(id, instanceId, 500);

  const project = query.data;
  const runtime = project?.runtime;

  useEffect(() => {
    if (runtime?.instanceId) {
      setInstanceId(runtime.instanceId);
    }
  }, [runtime?.instanceId]);

  const records = useMemo(
    () => mergeLogRecords(history.data?.records ?? [], live, instanceId),
    [history.data, live, instanceId],
  );

  const active = runtime ? isActiveStatus(runtime.status) : false;
  const actionError = actions.start.error ?? actions.stop.error ?? actions.restart.error;

  if (query.isLoading) {
    return <p className="text-sm text-zinc-500">Carregando projeto...</p>;
  }

  if (query.error) {
    return <ErrorBanner message={query.error.message} />;
  }

  if (!project || !runtime) {
    return <EmptyState title="Projeto não encontrado" />;
  }

  const config = project.config;

  return (
    <div>
      <button
        type="button"
        onClick={() => navigate('/projects')}
        className="mb-3 inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Voltar para projetos
      </button>

      <PageHeader
        title={config.name}
        description={config.description ?? config.workingDirectory}
        actions={
          <>
            <StatusBadge status={runtime.status} />
            <HealthBadge health={runtime.health} />
            <Button
              size="sm"
              disabled={active}
              title={active ? 'Projeto já está ativo' : 'Iniciar'}
              onClick={() => actions.start.mutate(config.id)}
            >
              <Play className="h-3.5 w-3.5" />
              Iniciar
            </Button>
            <Button
              size="sm"
              disabled={!active}
              title={active ? 'Parar' : 'Projeto não está em execução'}
              onClick={() => actions.stop.mutate(config.id)}
            >
              <Square className="h-3.5 w-3.5" />
              Parar
            </Button>
            <Button size="sm" onClick={() => actions.restart.mutate(config.id)}>
              <RotateCw className="h-3.5 w-3.5" />
              Reiniciar
            </Button>
            <Button
              size="sm"
              title={active ? 'Parar e editar' : 'Editar'}
              onClick={() => {
                if (active) {
                  setStopForEditOpen(true);
                } else {
                  setEditOpen(true);
                }
              }}
            >
              <Pencil className="h-3.5 w-3.5" />
              Editar
            </Button>
            <Button
              size="sm"
              title="Criar outro projeto com a mesma configuração"
              onClick={() => setDuplicateOpen(true)}
            >
              <Copy className="h-3.5 w-3.5" />
              Duplicar
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={active}
              title={active ? 'Pare antes de remover' : 'Remover'}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </>
        }
      />

      {actionError ? <ErrorBanner message={actionError.message} /> : null}

      {runtime.lastFailureHint ? (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-800/70 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
          <span className="mt-0.5 shrink-0">⚠</span>
          <div>
            <p className="font-medium">Última falha</p>
            <p className="mt-0.5 text-amber-200/90">{runtime.lastFailureHint}</p>
            <p className="mt-1 text-amber-200/70">
              O reinício automático foi interrompido para evitar um ciclo. Corrija a causa e inicie
              manualmente.
            </p>
          </div>
        </div>
      ) : null}

      <div className="mt-4">
        <Tabs items={TABS} value={tab} onChange={setTab} />
      </div>

      {tab === 'overview' ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card title="Execução">
            <dl className="grid grid-cols-2 gap-3">
              <Definition label="Estado" value={<StatusBadge status={runtime.status} />} />
              <Definition label="PID" value={runtime.pid ?? '—'} />
              <Definition
                label="Instância"
                value={<span className="mono text-xs">{shortId(runtime.instanceId, 12)}</span>}
              />
              <Definition label="Uptime" value={formatUptime(runtime.startedAt)} />
              <Definition
                label="Saúde"
                value={
                  <span className="flex flex-wrap items-center gap-1">
                    <HealthBadge health={runtime.health} />
                    {healthNote ? (
                      <span className="text-[11px] text-zinc-500">{healthNote}</span>
                    ) : null}
                  </span>
                }
              />
              <Definition label="Iniciado em" value={formatDateTime(runtime.startedAt)} />
              <Definition label="Tentativas" value={runtime.restartAttempt} />
            </dl>
          </Card>

          <Card title="Comando">
            <p className="mono break-all rounded-lg border border-zinc-800 bg-black/40 p-2 text-xs text-zinc-200">
              {formatCommand(config.runtime.executable, config.runtime.args)}
            </p>
            <dl className="mt-3 grid gap-3">
              <Definition
                label="Diretório"
                value={<span className="mono text-xs">{config.workingDirectory}</span>}
              />
              <Definition label="Porta" value={config.port ?? '—'} />
              <Definition
                label="Ambiente"
                value={
                  Object.keys(config.environment).length === 0 ? (
                    '—'
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {Object.entries(config.environment).map(([key, value]) => (
                        <span
                          key={key}
                          className="mono rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[11px]"
                          title={SENSITIVE_KEY.test(key) ? 'valor mascarado' : value}
                        >
                          {key}={SENSITIVE_KEY.test(key) ? '•••' : value}
                        </span>
                      ))}
                    </span>
                  )
                }
              />
            </dl>
          </Card>

          <Card title="Política de reinício">
            <dl className="grid grid-cols-2 gap-3">
              <Definition
                label="Auto-restart"
                value={config.restartPolicy.enabled ? 'habilitado' : 'desabilitado'}
              />
              <Definition label="maxRetries" value={config.restartPolicy.maxRetries} />
              <Definition label="baseDelayMs" value={config.restartPolicy.baseDelayMs} />
              <Definition label="maxDelayMs" value={config.restartPolicy.maxDelayMs} />
              <Definition label="stableAfterMs" value={config.restartPolicy.stableAfterMs} />
              <Definition label="No boot" value={config.startOnBoot ? 'sim' : 'não'} />
            </dl>
          </Card>

          <Card title="Última saída">
            {runtime.lastExit ? (
              <dl className="grid grid-cols-2 gap-3">
                <Definition label="Motivo" value={runtime.lastExit.reason} />
                <Definition label="Exit code" value={runtime.lastExit.code ?? '—'} />
                <Definition label="Sinal" value={runtime.lastExit.signal ?? '—'} />
                <Definition label="Quando" value={formatDateTime(runtime.lastExit.at)} />
              </dl>
            ) : (
              <p className="text-sm text-zinc-500">Nenhuma saída registrada nesta sessão.</p>
            )}
          </Card>
        </div>
      ) : null}

      {tab === 'logs' ? (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <Select
              aria-label="Instância"
              value={instanceId ?? ''}
              onChange={(event) =>
                setInstanceId(event.target.value === '' ? null : event.target.value)
              }
              className="w-64"
            >
              <option value="">Mais recente</option>
              {(instances.data ?? []).map((instance) => (
                <option key={instance.id} value={instance.id}>
                  {shortId(instance.id, 12)} · {instance.status} ·{' '}
                  {formatDateTime(instance.startedAt)}
                </option>
              ))}
            </Select>
            <Checkbox label="Rolar automaticamente" checked={autoScroll} onChange={setAutoScroll} />
            <Button size="sm" onClick={() => useAppStore.getState().clearLogs(config.id)}>
              Limpar visualização
            </Button>
            <span className="text-xs text-zinc-500">
              {records.length} linha(s) · histórico via HTTP + fluxo ao vivo
            </span>
          </div>
          <LogViewer records={records} autoScroll={autoScroll} />
        </div>
      ) : null}

      {tab === 'config' ? (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <Card title="Identificação">
            <dl className="grid gap-3">
              <Definition label="ID" value={<span className="mono text-xs">{config.id}</span>} />
              <Definition label="Nome" value={config.name} />
              <Definition label="Descrição" value={config.description ?? '—'} />
              <Definition
                label="Diretório"
                value={<span className="mono text-xs">{config.workingDirectory}</span>}
              />
              <Definition label="Criado em" value={formatDateTime(config.createdAt)} />
              <Definition label="Atualizado em" value={formatDateTime(config.updatedAt)} />
            </dl>
          </Card>
          <Card title="Runtime e políticas">
            <dl className="grid gap-3">
              <Definition
                label="Executável"
                value={<span className="mono text-xs">{config.runtime.executable}</span>}
              />
              <Definition
                label="Argumentos"
                value={<span className="mono text-xs">{config.runtime.args.join(' ') || '—'}</span>}
              />
              <Definition
                label="Health check"
                value={
                  config.healthCheck.enabled
                    ? `${config.healthCheck.type} ${config.healthCheck.target}`
                    : 'desabilitado'
                }
              />
              <Definition
                label="Logger"
                value={`${config.logging.maxFileSizeMb} MB · ${config.logging.retentionDays} dias`}
              />
              <Definition label="Shutdown" value={`${config.shutdown.gracefulTimeoutMs} ms`} />
            </dl>
            <div className="mt-3">
              <Button
                size="sm"
                onClick={() => {
                  if (active) {
                    setStopForEditOpen(true);
                  } else {
                    setEditOpen(true);
                  }
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
                Editar configuração
              </Button>
            </div>
          </Card>
        </div>
      ) : null}

      {tab === 'history' ? (
        <Card className="mt-4" bodyClassName="p-0">
          {events.isLoading ? (
            <p className="p-4 text-sm text-zinc-500">Carregando eventos...</p>
          ) : (events.data ?? []).length === 0 ? (
            <p className="p-4 text-sm text-zinc-500">Nenhum evento registrado.</p>
          ) : (
            <ul className="divide-y divide-zinc-800/70">
              {(events.data ?? []).map((event) => (
                <li
                  key={event.id}
                  className="flex flex-wrap items-baseline gap-2 px-4 py-2 text-xs"
                >
                  <span className="mono text-zinc-500">{formatDateTime(event.createdAt)}</span>
                  <span
                    className={
                      event.level === 'error'
                        ? 'text-red-300'
                        : event.level === 'warn'
                          ? 'text-amber-300'
                          : 'text-zinc-400'
                    }
                  >
                    {event.level}
                  </span>
                  <span className="text-zinc-300">{event.eventType}</span>
                  <span className="text-zinc-500">{event.message}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      {tab === 'metrics' ? (
        <div className="mt-4 space-y-4">
          {projectMetrics ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard
                  label="CPU"
                  value={
                    isNumber(projectMetrics.cpuPercent)
                      ? `${projectMetrics.cpuPercent.toFixed(1)}%`
                      : '—'
                  }
                  hint="Primeira amostra não tem delta"
                />
                <StatCard
                  label="RAM (working set)"
                  value={formatBytes(projectMetrics.memoryBytes)}
                  hint="Árvore completa (raiz + filhos)"
                />
                <StatCard
                  label="Memória privada"
                  value={formatBytes(projectMetrics.privateBytes ?? null)}
                  hint="PrivatePageCount"
                />
                <StatCard
                  label="Processos"
                  value={projectMetrics.processCount ?? 1}
                  hint="pnpm + servidor"
                />
                <StatCard label="Uptime" value={formatDuration(projectMetrics.uptimeMs)} />
                <StatCard label="PID" value={projectMetrics.pid} />
              </div>

              {(projectMetrics.processes ?? []).length > 0 ? (
                <Card title="Processos da árvore" bodyClassName="p-0">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                        <th className="px-3 py-2">PID</th>
                        <th className="px-3 py-2">Processo</th>
                        <th className="px-3 py-2 text-right">Memória</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/70">
                      {(projectMetrics.processes ?? []).map((process) => (
                        <tr key={process.pid}>
                          <td className="mono px-3 py-1.5 text-zinc-400">{process.pid}</td>
                          <td className="px-3 py-1.5 text-zinc-300">{process.name || '—'}</td>
                          <td className="px-3 py-1.5 text-right text-zinc-300">
                            {formatBytes(process.memoryBytes)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              ) : null}
              <p className="text-xs text-zinc-600">
                Amostragem periódica do Engine; CPU normalizada pelo total de núcleos.
              </p>
            </>
          ) : (
            <EmptyState
              title="Aguardando a primeira amostra"
              description="Métricas são coletadas a cada poucos segundos apenas para projetos em execução."
            />
          )}
        </div>
      ) : null}

      <ProjectForm open={editOpen} onClose={() => setEditOpen(false)} project={config} />
      <ProjectForm open={duplicateOpen} onClose={() => setDuplicateOpen(false)} template={config} />

      <Dialog
        open={stopForEditOpen}
        onClose={() => setStopForEditOpen(false)}
        title="Parar para editar"
        description="A configuração só pode ser alterada com o projeto parado."
        size="md"
        footer={
          <>
            <Button onClick={() => setStopForEditOpen(false)}>Cancelar</Button>
            <Button
              variant="primary"
              loading={actions.stop.isPending}
              onClick={() =>
                actions.stop.mutate(config.id, {
                  onSuccess: () => {
                    setStopForEditOpen(false);
                    setEditOpen(true);
                  },
                })
              }
            >
              Parar e editar
            </Button>
          </>
        }
      >
        <p className="text-sm text-zinc-300">
          Parar <span className="font-semibold">{config.name}</span> para abrir a configuração?
        </p>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title="Remover projeto"
        size="md"
        footer={
          <>
            <Button onClick={() => setDeleteOpen(false)}>Cancelar</Button>
            <Button
              variant="danger"
              loading={actions.remove.isPending}
              onClick={() =>
                actions.remove.mutate(config.id, {
                  onSuccess: () => navigate('/projects'),
                })
              }
            >
              Remover
            </Button>
          </>
        }
      >
        <p className="text-sm text-zinc-300">
          Remover <span className="font-semibold">{config.name}</span> do cadastro? A pasta original
          não é alterada.
        </p>
      </Dialog>
    </div>
  );
}
