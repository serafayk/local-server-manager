import type { LogRecord } from '@lsm/contracts';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ScrollText } from 'lucide-react';
import { useProjectInstances, useProjectLogs, useProjectsQuery } from '../lib/hooks';
import { shortId } from '../lib/format';
import { filterLogRecords, mergeLogRecords } from '../lib/logs';
import { useAppStore } from '../stores/app-store';
import { LogViewer } from '../components/LogViewer';
import { PageHeader } from '../components/page';
import { Button, Card, Checkbox, EmptyState, Input, Select } from '../components/ui';

const EMPTY_LOGS: LogRecord[] = [];

export function LogsPage() {
  const projectsQuery = useProjectsQuery();
  const projects = projectsQuery.data ?? [];

  const [projectId, setProjectId] = useState('');
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const [stream, setStream] = useState<'all' | LogRecord['stream']>('all');
  const [search, setSearch] = useState('');
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (projectId === '' && projects[0]) {
      setProjectId(projects[0].config.id);
    }
  }, [projects, projectId]);

  const instances = useProjectInstances(projectId || undefined);
  const project = projects.find((item) => item.config.id === projectId);
  const latestInstanceId = project?.runtime.instanceId ?? instances.data?.[0]?.id ?? null;

  useEffect(() => {
    setInstanceId(null);
    setFollowLatest(true);
  }, [projectId]);

  const history = useProjectLogs(projectId || undefined, instanceId, 500);
  const live = useAppStore((state) =>
    projectId ? (state.logsByProject[projectId] ?? EMPTY_LOGS) : EMPTY_LOGS,
  );

  useEffect(() => {
    if (followLatest && latestInstanceId) {
      setInstanceId(latestInstanceId);
    }
  }, [followLatest, latestInstanceId, instanceId]);

  const records = useMemo(
    () =>
      filterLogRecords(mergeLogRecords(history.data?.records ?? [], live, instanceId), {
        stream,
        search,
      }),
    [history.data, live, instanceId, stream, search],
  );

  return (
    <div>
      <PageHeader
        title="Logs"
        description="Histórico por instância com fluxo ao vivo via WebSocket."
        actions={
          projectId ? (
            <Button size="sm" onClick={() => useAppStore.getState().clearLogs(projectId)}>
              Limpar visualização
            </Button>
          ) : null
        }
      />

      {projects.length === 0 && !projectsQuery.isLoading ? (
        <EmptyState
          icon={<ScrollText className="h-8 w-8" />}
          title="Nenhum projeto para exibir"
          description="Cadastre um projeto e inicie-o para acompanhar os logs."
          action={
            <Link to="/projects?new=1" className="text-sm text-emerald-400 hover:underline">
              Cadastrar projeto
            </Link>
          }
        />
      ) : (
        <div className="space-y-3">
          <Card bodyClassName="p-3">
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[200px] flex-1">
                <label
                  htmlFor="logs-project"
                  className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500"
                >
                  Projeto
                </label>
                <Select
                  id="logs-project"
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  {projects.map((item) => (
                    <option key={item.config.id} value={item.config.id}>
                      {item.config.name} ({item.runtime.status})
                    </option>
                  ))}
                </Select>
              </div>
              <div className="min-w-[220px] flex-1">
                <label
                  htmlFor="logs-instance"
                  className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500"
                >
                  Instância
                </label>
                <Select
                  id="logs-instance"
                  value={instanceId ?? ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (value === '') {
                      setFollowLatest(true);
                      setInstanceId(latestInstanceId);
                    } else {
                      setFollowLatest(false);
                      setInstanceId(value);
                    }
                  }}
                >
                  <option value="">Mais recente</option>
                  {(instances.data ?? []).map((instance) => (
                    <option key={instance.id} value={instance.id}>
                      {shortId(instance.id, 12)} · {instance.status}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-40">
                <label
                  htmlFor="logs-stream"
                  className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500"
                >
                  Stream
                </label>
                <Select
                  id="logs-stream"
                  value={stream}
                  onChange={(event) => setStream(event.target.value as 'all' | LogRecord['stream'])}
                >
                  <option value="all">Todos</option>
                  <option value="stdout">stdout</option>
                  <option value="stderr">stderr</option>
                  <option value="system">system</option>
                </Select>
              </div>
              <div className="min-w-[180px] flex-1">
                <label
                  htmlFor="logs-search"
                  className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500"
                >
                  Buscar
                </label>
                <Input
                  id="logs-search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="texto na linha"
                />
              </div>
              <Checkbox label="Auto-scroll" checked={autoScroll} onChange={setAutoScroll} />
            </div>
            <p className="mt-2 text-xs text-zinc-500">
              {records.length} linha(s) ·{' '}
              {project?.runtime.pid ? `pid ${project.runtime.pid}` : 'processo parado'} · histórico
              + ao vivo
            </p>
          </Card>

          <LogViewer records={records} autoScroll={autoScroll} heightClass="h-[62vh]" />
        </div>
      )}
    </div>
  );
}
