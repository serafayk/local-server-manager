import type { ProjectStatus, ProjectSummary } from '@lsm/contracts';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Search } from 'lucide-react';
import { useProjectActions } from '../lib/actions';
import { useProjectsQuery } from '../lib/hooks';
import { ProjectForm } from '../components/ProjectForm';
import { ProjectTable } from '../components/ProjectTable';
import { PageHeader } from '../components/page';
import { Button, Card, Dialog, EmptyState, ErrorBanner, Input, Select } from '../components/ui';

const STATUS_OPTIONS: Array<{ value: 'all' | ProjectStatus; label: string }> = [
  { value: 'all', label: 'Todos os estados' },
  { value: 'RUNNING', label: 'Executando' },
  { value: 'STOPPED', label: 'Parados' },
  { value: 'STARTING', label: 'Iniciando' },
  { value: 'STOPPING', label: 'Parando' },
  { value: 'RESTARTING', label: 'Reiniciando' },
  { value: 'CRASHED', label: 'Caiu' },
  { value: 'FAILED', label: 'Falhou' },
];

export function ProjectsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectsQuery = useProjectsQuery();
  const actions = useProjectActions();

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ProjectStatus>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [formOpen, setFormOpen] = useState(searchParams.get('new') === '1');
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);

  useEffect(() => {
    if (searchParams.get('new') === '1') {
      setFormOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('new');
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const projects = useMemo(() => {
    const query = search.trim().toLowerCase();
    return (projectsQuery.data ?? []).filter((project) => {
      const matchesQuery =
        query === '' ||
        project.config.name.toLowerCase().includes(query) ||
        project.config.workingDirectory.toLowerCase().includes(query);
      const matchesStatus = statusFilter === 'all' || project.runtime.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [projectsQuery.data, search, statusFilter]);

  function toggle(id: string): void {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function toggleAll(): void {
    setSelected((previous) => {
      const allSelected =
        projects.length > 0 && projects.every((project) => previous.has(project.config.id));
      return allSelected ? new Set() : new Set(projects.map((project) => project.config.id));
    });
  }

  const actionError =
    actions.start.error ??
    actions.stop.error ??
    actions.restart.error ??
    actions.remove.error ??
    projectsQuery.error;

  const bulkResult = actions.startMany.data ?? actions.stopMany.data;
  const bulkFailures = bulkResult?.results.filter((result) => !result.success) ?? [];

  const busyId = actions.start.isPending
    ? (actions.start.variables as string)
    : actions.stop.isPending
      ? (actions.stop.variables as string)
      : actions.restart.isPending
        ? (actions.restart.variables as string)
        : null;

  return (
    <div>
      <PageHeader
        title="Projetos"
        description="Cadastro, execução e controle em lote."
        actions={
          <Button variant="primary" onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4" />
            Novo projeto
          </Button>
        }
      />

      {actionError ? <ErrorBanner message={actionError.message} /> : null}
      {bulkFailures.length > 0 ? (
        <div className="mt-2 rounded-lg border border-amber-800/70 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
          {bulkFailures.length} operação(ões) em lote falharam:{' '}
          {bulkFailures
            .map((failure) => `${failure.projectId.slice(0, 8)} (${failure.errorCode ?? 'ERRO'})`)
            .join(', ')}
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500" />
          <Input
            aria-label="Buscar projetos"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar por nome ou caminho"
            className="pl-9"
          />
        </div>
        <Select
          aria-label="Filtrar por estado"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as 'all' | ProjectStatus)}
          className="w-48"
        >
          {STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {selected.size > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-400">{selected.size} selecionado(s)</span>
            <Button
              size="sm"
              onClick={() =>
                actions.startMany.mutate([...selected], {
                  onSuccess: () => setSelected(new Set()),
                })
              }
              disabled={actions.startMany.isPending}
            >
              Iniciar selecionados
            </Button>
            <Button
              size="sm"
              onClick={() =>
                actions.stopMany.mutate([...selected], {
                  onSuccess: () => setSelected(new Set()),
                })
              }
              disabled={actions.stopMany.isPending}
            >
              Parar selecionados
            </Button>
          </div>
        ) : null}
      </div>

      <Card className="mt-4" bodyClassName="p-0">
        {projectsQuery.isLoading ? (
          <p className="p-6 text-sm text-zinc-500">Carregando projetos...</p>
        ) : projects.length === 0 ? (
          <div className="p-4">
            <EmptyState
              title={
                (projectsQuery.data ?? []).length === 0
                  ? 'Nenhum projeto cadastrado'
                  : 'Nenhum projeto encontrado'
              }
              description={
                (projectsQuery.data ?? []).length === 0
                  ? 'Cadastre a primeira pasta de projeto para começar.'
                  : 'Ajuste a busca ou o filtro de estado.'
              }
              action={
                (projectsQuery.data ?? []).length === 0 ? (
                  <Button variant="primary" onClick={() => setFormOpen(true)}>
                    <Plus className="h-4 w-4" />
                    Cadastrar projeto
                  </Button>
                ) : null
              }
            />
          </div>
        ) : (
          <ProjectTable
            projects={projects}
            busyId={busyId}
            selected={selected}
            onToggle={toggle}
            onToggleAll={toggleAll}
            onStart={(id) => actions.start.mutate(id)}
            onStop={(id) => actions.stop.mutate(id)}
            onRestart={(id) => actions.restart.mutate(id)}
            onDelete={(id) => {
              const target = projects.find((project) => project.config.id === id) ?? null;
              setDeleteTarget(target);
            }}
          />
        )}
      </Card>

      <p className="mt-3 text-xs text-zinc-600">
        Abra um projeto para logs, configuração e histórico.{' '}
        <Link to="/logs" className="text-emerald-400 hover:underline">
          Ir para logs
        </Link>
      </p>

      <ProjectForm open={formOpen} onClose={() => setFormOpen(false)} />

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Remover projeto"
        description="O cadastro é removido do Engine. A pasta original não é alterada."
        size="md"
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>Cancelar</Button>
            <Button
              variant="danger"
              loading={actions.remove.isPending}
              onClick={() => {
                if (!deleteTarget) {
                  return;
                }
                actions.remove.mutate(deleteTarget.config.id, {
                  onSuccess: () => {
                    setSelected((previous) => {
                      const next = new Set(previous);
                      next.delete(deleteTarget.config.id);
                      return next;
                    });
                    setDeleteTarget(null);
                    navigate('/projects');
                  },
                });
              }}
            >
              Remover
            </Button>
          </>
        }
      >
        <p className="text-sm text-zinc-300">
          Remover <span className="font-semibold">{deleteTarget?.config.name}</span> do cadastro?
        </p>
        <p className="mono mt-2 break-all text-xs text-zinc-500">
          {deleteTarget?.config.workingDirectory}
        </p>
      </Dialog>
    </div>
  );
}
