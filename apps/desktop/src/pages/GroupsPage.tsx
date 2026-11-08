import type { ProjectGroup } from '@lsm/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { FolderTree, Pencil, Plus, Trash2 } from 'lucide-react';
import { useGroupsQuery, useProjectsQuery } from '../lib/hooks';
import { queryKeys } from '../lib/queries';
import { useEngine } from '../providers/engine-provider';
import { PageHeader } from '../components/page';
import { Button, Card, Dialog, EmptyState, ErrorBanner, Field, Input } from '../components/ui';

export function GroupsPage() {
  const { client } = useEngine();
  const queryClient = useQueryClient();
  const groupsQuery = useGroupsQuery();
  const projectsQuery = useProjectsQuery();

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [sortOrder, setSortOrder] = useState('0');
  const [editTarget, setEditTarget] = useState<ProjectGroup | null>(null);
  const [editName, setEditName] = useState('');
  const [editSort, setEditSort] = useState('0');
  const [deleteTarget, setDeleteTarget] = useState<ProjectGroup | null>(null);
  const [stackNotice, setStackNotice] = useState<string | null>(null);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
  };

  const create = useMutation({
    mutationFn: () =>
      client.createGroup({
        name: name.trim(),
        sortOrder: Number.parseInt(sortOrder, 10) || 0,
      }),
    onSuccess: () => {
      setCreateOpen(false);
      setName('');
      setSortOrder('0');
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: () => {
      if (!editTarget) {
        return Promise.reject(new Error('sem grupo selecionado'));
      }
      return client.updateGroup(editTarget.id, {
        name: editName.trim(),
        sortOrder: Number.parseInt(editSort, 10) || 0,
      });
    },
    onSuccess: () => {
      setEditTarget(null);
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => client.deleteGroup(id),
    onSuccess: () => {
      setDeleteTarget(null);
      invalidate();
    },
  });

  const groups = groupsQuery.data ?? [];
  const projects = projectsQuery.data ?? [];
  const nameOf = (projectId: string): string =>
    projects.find((project) => project.config.id === projectId)?.config.name ?? projectId;

  const summarize = (result: {
    results: Array<{ projectId: string; success: boolean; message?: string; errorCode?: string }>;
  }): string => {
    const failures = result.results.filter((item) => !item.success);
    if (failures.length === 0) {
      return `Stack pronta (${result.results.length} projeto(s)).`;
    }
    return `Falha em ${failures
      .map((item) => `${nameOf(item.projectId)}: ${item.message ?? item.errorCode ?? 'erro'}`)
      .join(' · ')}`;
  };

  const stackAction = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'stop' | 'restart' }) =>
      action === 'start'
        ? client.startGroup(id)
        : action === 'stop'
          ? client.stopGroup(id)
          : client.restartGroup(id),
    onSuccess: (result) => {
      setStackNotice(summarize(result));
      invalidate();
    },
    onError: (error) => setStackNotice(error.message),
  });

  const projectIdsOf = (groupId: string): string[] =>
    projects
      .filter((project) => project.config.groupId === groupId)
      .map((project) => project.config.id);

  const error = create.error ?? update.error ?? remove.error ?? groupsQuery.error;

  return (
    <div>
      <PageHeader
        title="Grupos"
        description="Organização visual e stacks. Subir um grupo respeita dependências e health checks."
        actions={
          <Button
            variant="primary"
            onClick={() => {
              create.reset();
              setCreateOpen(true);
            }}
          >
            <Plus className="h-4 w-4" />
            Novo grupo
          </Button>
        }
      />

      {error ? <ErrorBanner message={error.message} /> : null}

      {stackNotice ? (
        <div className="mt-3 rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-200">
          {stackNotice}
        </div>
      ) : null}

      <Card className="mt-4" bodyClassName="p-0">
        {groupsQuery.isLoading ? (
          <p className="p-6 text-sm text-zinc-500">Carregando grupos...</p>
        ) : groups.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<FolderTree className="h-8 w-8" />}
              title="Nenhum grupo"
              description="Crie um grupo e atribua projetos pelo campo Grupo no cadastro."
              action={
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" />
                  Criar grupo
                </Button>
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800/70">
            {groups.map((group) => {
              const ids = projectIdsOf(group.id);
              return (
                <li
                  key={group.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium text-zinc-100">
                      <FolderTree className="h-4 w-4 text-zinc-500" />
                      {group.name}
                    </p>
                    <p className="text-xs text-zinc-500">
                      {ids.length} projeto(s) · ordem {group.sortOrder}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={ids.length === 0}
                      loading={stackAction.isPending && stackAction.variables?.id === group.id}
                      title="Sobe o grupo respeitando dependências e health checks"
                      onClick={() => {
                        setStackNotice(null);
                        stackAction.mutate({ id: group.id, action: 'start' });
                      }}
                    >
                      Subir stack
                    </Button>
                    <Button
                      size="sm"
                      disabled={ids.length === 0}
                      loading={stackAction.isPending && stackAction.variables?.id === group.id}
                      title="Para dependentes antes das dependências"
                      onClick={() => {
                        setStackNotice(null);
                        stackAction.mutate({ id: group.id, action: 'stop' });
                      }}
                    >
                      Parar
                    </Button>
                    <Button
                      size="sm"
                      disabled={ids.length === 0}
                      loading={stackAction.isPending && stackAction.variables?.id === group.id}
                      title="Reinicia o grupo na ordem correta"
                      onClick={() => {
                        setStackNotice(null);
                        stackAction.mutate({ id: group.id, action: 'restart' });
                      }}
                    >
                      Reiniciar
                    </Button>
                    <Button
                      size="sm"
                      aria-label={`Renomear ${group.name}`}
                      onClick={() => {
                        update.reset();
                        setEditTarget(group);
                        setEditName(group.name);
                        setEditSort(String(group.sortOrder));
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      aria-label={`Remover ${group.name}`}
                      onClick={() => {
                        remove.reset();
                        setDeleteTarget(group);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Dialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Novo grupo"
        size="md"
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)}>Cancelar</Button>
            <Button
              variant="primary"
              loading={create.isPending}
              disabled={name.trim() === ''}
              onClick={() => create.mutate()}
            >
              Criar
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {create.error ? <ErrorBanner message={create.error.message} /> : null}
          <Field label="Nome" htmlFor="group-name">
            <Input
              id="group-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Backend"
              autoFocus
            />
          </Field>
          <Field label="Ordem" htmlFor="group-order" hint="Menor aparece primeiro.">
            <Input
              id="group-order"
              value={sortOrder}
              onChange={(event) => setSortOrder(event.target.value)}
              inputMode="numeric"
            />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title="Editar grupo"
        size="md"
        footer={
          <>
            <Button onClick={() => setEditTarget(null)}>Cancelar</Button>
            <Button
              variant="primary"
              loading={update.isPending}
              disabled={editName.trim() === ''}
              onClick={() => update.mutate()}
            >
              Salvar
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {update.error ? <ErrorBanner message={update.error.message} /> : null}
          <Field label="Nome" htmlFor="group-edit-name">
            <Input
              id="group-edit-name"
              value={editName}
              onChange={(event) => setEditName(event.target.value)}
            />
          </Field>
          <Field label="Ordem" htmlFor="group-edit-order">
            <Input
              id="group-edit-order"
              value={editSort}
              onChange={(event) => setEditSort(event.target.value)}
              inputMode="numeric"
            />
          </Field>
        </div>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Remover grupo"
        size="md"
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>Cancelar</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                if (deleteTarget) {
                  remove.mutate(deleteTarget.id);
                }
              }}
            >
              Remover
            </Button>
          </>
        }
      >
        <p className="text-sm text-zinc-300">
          Remover <span className="font-semibold">{deleteTarget?.name}</span>? Os projetos continuam
          cadastrados, apenas sem grupo.
        </p>
      </Dialog>
    </div>
  );
}
