import { useState } from 'react';
import { History } from 'lucide-react';
import { formatDateTime, shortId } from '../lib/format';
import { useGlobalEvents, useProjectsQuery } from '../lib/hooks';
import { PageHeader } from '../components/page';
import { Badge, Card, EmptyState, Select, type Tone } from '../components/ui';

const LEVEL_TONE: Record<string, Tone> = {
  debug: 'zinc',
  info: 'sky',
  warn: 'amber',
  error: 'red',
};

export function EventsPage() {
  const projectsQuery = useProjectsQuery();
  const projects = projectsQuery.data ?? [];
  const [projectId, setProjectId] = useState('');
  const [level, setLevel] = useState<'all' | 'debug' | 'info' | 'warn' | 'error'>('all');
  const [limit, setLimit] = useState(100);

  const eventsQuery = useGlobalEvents(projectId === '' ? null : projectId, limit);
  const events = (eventsQuery.data ?? []).filter(
    (event) => level === 'all' || event.level === level,
  );

  return (
    <div>
      <PageHeader
        title="Eventos"
        description="Auditoria operacional persistida em SQLite (system_events)."
      />

      <Card bodyClassName="p-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-[220px] flex-1">
            <label
              htmlFor="events-project"
              className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500"
            >
              Projeto
            </label>
            <Select
              id="events-project"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">Todos</option>
              {projects.map((project) => (
                <option key={project.config.id} value={project.config.id}>
                  {project.config.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="w-40">
            <label
              htmlFor="events-level"
              className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500"
            >
              Nível
            </label>
            <Select
              id="events-level"
              value={level}
              onChange={(event) => setLevel(event.target.value as typeof level)}
            >
              <option value="all">Todos</option>
              <option value="debug">debug</option>
              <option value="info">info</option>
              <option value="warn">warn</option>
              <option value="error">error</option>
            </Select>
          </div>
          <div className="w-32">
            <label
              htmlFor="events-limit"
              className="mb-1 block text-[11px] uppercase tracking-wide text-zinc-500"
            >
              Limite
            </label>
            <Select
              id="events-limit"
              value={limit}
              onChange={(event) => setLimit(Number.parseInt(event.target.value, 10))}
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
              <option value={500}>500</option>
            </Select>
          </div>
        </div>
      </Card>

      <div className="mt-4">
        {eventsQuery.isLoading ? (
          <p className="text-sm text-zinc-500">Carregando eventos...</p>
        ) : events.length === 0 ? (
          <EmptyState
            icon={<History className="h-8 w-8" />}
            title="Nenhum evento"
            description="Eventos de start, stop, crash e recuperação aparecem aqui."
          />
        ) : (
          <Card bodyClassName="p-0">
            <ul className="divide-y divide-zinc-800/70">
              {events.map((event) => (
                <li
                  key={event.id}
                  className="flex flex-wrap items-baseline gap-2 px-4 py-2 text-xs"
                >
                  <span className="mono w-40 shrink-0 text-zinc-500">
                    {formatDateTime(event.createdAt)}
                  </span>
                  <Badge tone={LEVEL_TONE[event.level] ?? 'zinc'}>{event.level}</Badge>
                  <span className="mono w-20 shrink-0 text-zinc-500">
                    {shortId(event.projectId, 8)}
                  </span>
                  <span className="text-zinc-300">{event.eventType}</span>
                  <span className="min-w-0 flex-1 text-zinc-500">{event.message}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
