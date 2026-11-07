import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Plus, Server } from 'lucide-react';
import { useProjectActions } from '../lib/actions';
import { queryKeys } from '../lib/queries';
import { useProjectsQuery } from '../lib/hooks';
import { useEngine, useConnectionStatus } from '../providers/engine-provider';
import { ProjectTable } from '../components/ProjectTable';
import { PageHeader, StatCard } from '../components/page';
import { Button, Card, EmptyState, ErrorBanner } from '../components/ui';
import { formatDuration } from '../lib/format';

export function DashboardPage() {
  const navigate = useNavigate();
  const { client } = useEngine();
  const connection = useConnectionStatus();
  const projectsQuery = useProjectsQuery();
  const actions = useProjectActions();

  const health = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => client.health(),
    refetchInterval: 10_000,
  });

  const projects = projectsQuery.data ?? [];
  const running = projects.filter((project) => project.runtime.status === 'RUNNING').length;
  const stopped = projects.filter((project) => project.runtime.status === 'STOPPED').length;
  const problems = projects.filter(
    (project) => project.runtime.status === 'CRASHED' || project.runtime.status === 'FAILED',
  ).length;
  const unhealthy = projects.filter((project) => project.runtime.health === 'UNHEALTHY').length;

  const actionError =
    actions.start.error ?? actions.stop.error ?? actions.restart.error ?? projectsQuery.error;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        description="Visão operacional dos projetos supervisionados pelo Engine."
        actions={
          <Button variant="primary" onClick={() => navigate('/projects?new=1')}>
            <Plus className="h-4 w-4" />
            Novo projeto
          </Button>
        }
      />

      {actionError ? <ErrorBanner message={actionError.message} /> : null}

      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard label="Executando" value={running} tone="emerald" />
        <StatCard label="Parados" value={stopped} />
        <StatCard label="Com falha" value={problems} tone={problems > 0 ? 'red' : 'zinc'} />
        <StatCard
          label="Não saudáveis"
          value={unhealthy}
          tone={unhealthy > 0 ? 'amber' : 'zinc'}
          hint="Health check da Fase 5"
        />
        <StatCard
          label="Engine"
          value={connection === 'open' ? 'Online' : 'Offline'}
          tone={connection === 'open' ? 'emerald' : 'red'}
          hint={
            health.data
              ? `pid ${health.data.pid} · ${formatDuration(health.data.uptimeMs)}`
              : undefined
          }
        />
      </div>

      <div className="mt-5">
        <Card
          title="Projetos"
          description={
            projects.length > 0
              ? 'Ações rápidas. Abra o projeto para logs, configuração e histórico.'
              : undefined
          }
          bodyClassName="p-0"
        >
          {projectsQuery.isLoading ? (
            <p className="p-6 text-sm text-zinc-500">Carregando projetos...</p>
          ) : projects.length === 0 ? (
            <div className="p-4">
              <EmptyState
                icon={<Server className="h-8 w-8" />}
                title="Nenhum projeto cadastrado"
                description="Cadastre uma pasta com package.json ou informe um comando personalizado."
                action={
                  <Button variant="primary" onClick={() => navigate('/projects?new=1')}>
                    <Plus className="h-4 w-4" />
                    Cadastrar projeto
                  </Button>
                }
              />
            </div>
          ) : (
            <ProjectTable
              projects={projects}
              busyId={
                actions.start.isPending
                  ? (actions.start.variables as string)
                  : actions.stop.isPending
                    ? (actions.stop.variables as string)
                    : actions.restart.isPending
                      ? (actions.restart.variables as string)
                      : null
              }
              onStart={(id) => actions.start.mutate(id)}
              onStop={(id) => actions.stop.mutate(id)}
              onRestart={(id) => actions.restart.mutate(id)}
            />
          )}
        </Card>
      </div>

      <p className="mt-4 text-xs text-zinc-600">
        Precisa de detalhes?{' '}
        <Link to="/projects" className="text-emerald-400 hover:underline">
          Abra a lista de projetos
        </Link>
        .
      </p>
    </div>
  );
}
