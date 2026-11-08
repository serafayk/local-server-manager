import type { DomainRoute } from '@lsm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Copy,
  ExternalLink,
  Globe,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { ApiError } from '../lib/api';
import { useProjectsQuery } from '../lib/hooks';
import { queryKeys } from '../lib/queries';
import { copyText, openExternal } from '../lib/tauri';
import { useEngine } from '../providers/engine-provider';
import { PageHeader } from '../components/page';
import { StatusBadge } from '../components/status';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Select,
} from '../components/ui';

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);
}

export function DomainsPage() {
  const { client } = useEngine();
  const queryClient = useQueryClient();
  const projectsQuery = useProjectsQuery();
  const domainsQuery = useQuery({
    queryKey: queryKeys.domains,
    queryFn: () => client.getDomains(),
    refetchInterval: 5_000,
  });

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<DomainRoute | null>(null);
  const [host, setHost] = useState('');
  const [projectId, setProjectId] = useState('');
  const [port, setPort] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<DomainRoute | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const projects = projectsQuery.data ?? [];
  const overview = domainsQuery.data;
  const routes = overview?.routes ?? [];
  const status = overview?.status;

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.domains });
  };

  function openCreate(): void {
    setEditing(null);
    setHost('');
    setProjectId(projects[0]?.config.id ?? '');
    setPort('');
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(route: DomainRoute): void {
    setEditing(route);
    setHost(route.host);
    setProjectId(route.projectId);
    setPort(route.port === null ? '' : String(route.port));
    setFormError(null);
    setFormOpen(true);
  }

  const save = useMutation({
    mutationFn: () => {
      const parsedPort = port.trim() === '' ? null : Number.parseInt(port, 10);
      if (
        parsedPort !== null &&
        (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535)
      ) {
        throw new Error('A porta deve estar entre 1 e 65535.');
      }
      if (editing) {
        return client.updateDomain(editing.id, { host: host.trim(), port: parsedPort });
      }
      return client.createDomain({
        host: host.trim(),
        projectId,
        port: parsedPort,
      });
    },
    onSuccess: (route) => {
      setFormOpen(false);
      setNotice(
        route.host.endsWith('.lsm')
          ? `Domínio ${route.host} criado. Use ${route.urls.localhost} agora ou sincronize o arquivo hosts para usar .lsm.`
          : `Domínio ${route.host} criado.`,
      );
      invalidate();
    },
    onError: (error) => setFormError(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => client.deleteDomain(id),
    onSuccess: (removed) => {
      setDeleteTarget(null);
      setNotice(`Domínio ${removed.host} removido.`);
      invalidate();
    },
  });

  const syncHosts = useMutation({
    mutationFn: () => client.syncDomainHosts(),
    onSuccess: (result) => {
      setNotice(
        result.error === null
          ? `Arquivo hosts sincronizado (${result.applied.length} domínio(s)).`
          : `Sincronização não concluída: ${result.error}`,
      );
      invalidate();
    },
    onError: (error) => setNotice(errorMessage(error)),
  });

  const trustCa = useMutation({
    mutationFn: () => client.trustDomainCa(),
    onSuccess: () => {
      setNotice('CA local confiada. Feche e reabra o navegador para o HTTPS valer.');
      invalidate();
    },
    onError: (error) => setNotice(errorMessage(error)),
  });

  const pendingSync = status?.pendingHosts ?? [];

  async function copy(url: string): Promise<void> {
    const ok = await copyText(url);
    setNotice(ok ? `Copiado: ${url}` : `Não foi possível copiar ${url}`);
  }

  async function open(url: string): Promise<void> {
    try {
      await openExternal(url);
    } catch (error) {
      setNotice(errorMessage(error));
    }
  }

  const queryError = domainsQuery.error;
  const error = formError ?? (queryError ? errorMessage(queryError) : null);

  return (
    <div>
      <PageHeader
        title="Domínios"
        description="Endereços locais por projeto. .localhost funciona sem configuração; .lsm exige o arquivo hosts."
        actions={
          <Button variant="primary" onClick={openCreate} disabled={projects.length === 0}>
            <Plus className="h-4 w-4" />
            Novo domínio
          </Button>
        }
      />

      {error ? <ErrorBanner message={error} /> : null}

      {notice ? (
        <div className="mt-3 flex items-start justify-between gap-3 rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-200">
          <span>{notice}</span>
          <button
            type="button"
            className="text-zinc-500 hover:text-zinc-300"
            onClick={() => setNotice(null)}
          >
            dispensar
          </button>
        </div>
      ) : null}

      <Card className="mt-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-zinc-500">Proxy local</p>
            {status ? (
              <>
                <p className="mono mt-1 text-sm text-zinc-200">
                  127.0.0.1:{status.httpPort} · :{status.httpsPort}
                </p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {status.httpListening ? 'HTTP ativo' : 'HTTP parado'} ·{' '}
                  {status.httpsListening ? 'HTTPS ativo' : 'HTTPS parado'}
                </p>
                {status.proxyError ? (
                  <p className="mt-1 text-xs text-red-400">{status.proxyError}</p>
                ) : null}
              </>
            ) : (
              <p className="mt-1 text-xs text-zinc-500">Carregando...</p>
            )}
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-wide text-zinc-500">HTTPS local</p>
            <div className="mt-1 flex items-center gap-2">
              {status?.certificate.trusted ? (
                <Badge tone="emerald">
                  <ShieldCheck className="mr-1 h-3 w-3" /> CA confiada
                </Badge>
              ) : (
                <Badge tone="amber">
                  <WifiOff className="mr-1 h-3 w-3" /> CA não confiada
                </Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-zinc-500">
              {status?.certificate.exists
                ? 'Certificados emitidos por uma CA local.'
                : 'A CA será criada no primeiro uso.'}
            </p>
            <Button
              size="sm"
              className="mt-2"
              loading={trustCa.isPending}
              disabled={status?.certificate.trusted === true}
              onClick={() => {
                setNotice(null);
                trustCa.mutate();
              }}
            >
              <ShieldCheck className="h-3.5 w-3.5" />
              {status?.certificate.trusted ? 'Já confiada' : 'Confiar na CA'}
            </Button>
          </div>

          <div>
            <p className="text-[11px] uppercase tracking-wide text-zinc-500">Arquivo hosts</p>
            <p className="mt-1 text-xs text-zinc-400">
              {pendingSync.length === 0
                ? 'Todos os domínios .lsm estão sincronizados.'
                : `${pendingSync.length} domínio(s) .lsm pendente(s).`}
            </p>
            <p className="mono mt-1 break-all text-[11px] text-zinc-600">
              {status?.hostsFile ?? 'C:\\Windows\\System32\\drivers\\etc\\hosts'}
            </p>
            <Button
              size="sm"
              className="mt-2"
              loading={syncHosts.isPending}
              disabled={pendingSync.length === 0}
              title="Abre um prompt de UAC para gravar o bloco gerenciado"
              onClick={() => {
                setNotice(null);
                syncHosts.mutate();
              }}
            >
              Sincronizar hosts
            </Button>
          </div>
        </div>
      </Card>

      <Card className="mt-4" bodyClassName="p-0">
        {domainsQuery.isLoading ? (
          <p className="p-6 text-sm text-zinc-500">Carregando domínios...</p>
        ) : routes.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Globe className="h-8 w-8" />}
              title="Nenhum domínio"
              description={
                projects.length === 0
                  ? 'Cadastre um projeto primeiro para criar um domínio.'
                  : 'Crie um endereço como api.uai.lsm ou app.localhost para acessar o projeto pelo navegador.'
              }
              action={
                projects.length > 0 ? (
                  <Button variant="primary" onClick={openCreate}>
                    <Plus className="h-4 w-4" />
                    Criar domínio
                  </Button>
                ) : undefined
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-zinc-800/70">
            {routes.map((route) => {
              const hasAlias = route.urls.localhost !== route.urls.http;
              return (
                <li key={route.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-100">
                        <Globe className="h-4 w-4 text-sky-400" />
                        <span className="mono">{route.host}</span>
                        {route.host.endsWith('.lsm') ? (
                          <Badge tone={route.hostsSynced ? 'emerald' : 'amber'}>
                            {route.hostsSynced ? 'hosts ok' : 'hosts pendente'}
                          </Badge>
                        ) : null}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                        <span>{route.projectName}</span>
                        <span>·</span>
                        <span>
                          {route.upstreamPort === null
                            ? 'sem porta'
                            : `porta ${route.upstreamPort}`}
                        </span>
                        <span>·</span>
                        <StatusBadge status={route.projectStatus} />
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        title="Abrir no navegador"
                        onClick={() => void open(route.urls.http)}
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Abrir
                      </Button>
                      <Button
                        size="sm"
                        title={`Copiar ${route.urls.http}`}
                        onClick={() => void copy(route.urls.http)}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        HTTP
                      </Button>
                      <Button
                        size="sm"
                        title={`Copiar ${route.urls.https}`}
                        onClick={() => void copy(route.urls.https)}
                      >
                        <Copy className="h-3.5 w-3.5" />
                        HTTPS
                      </Button>
                      {hasAlias ? (
                        <Button
                          size="sm"
                          title={`Copiar ${route.urls.localhost} (funciona sem hosts)`}
                          onClick={() => void copy(route.urls.localhost)}
                        >
                          .localhost
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        aria-label={`Editar ${route.host}`}
                        onClick={() => openEdit(route)}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        aria-label={`Remover ${route.host}`}
                        onClick={() => setDeleteTarget(route)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <Dialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? 'Editar domínio' : 'Novo domínio'}
        size="md"
        footer={
          <>
            <Button onClick={() => setFormOpen(false)}>Cancelar</Button>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={host.trim() === '' || (!editing && projectId === '')}
              onClick={() => save.mutate()}
            >
              {editing ? 'Salvar' : 'Criar'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {formError ? <ErrorBanner message={formError} /> : null}
          {!editing ? (
            <Field label="Projeto" htmlFor="domain-project">
              <Select
                id="domain-project"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.config.id} value={project.config.id}>
                    {project.config.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            <p className="text-xs text-zinc-500">
              Projeto: <span className="text-zinc-300">{editing.projectName}</span>
            </p>
          )}

          <Field
            label="Domínio"
            htmlFor="domain-host"
            hint="Use .lsm (nome bonito, pede hosts) ou .localhost (sem configuração)."
          >
            <Input
              id="domain-host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="api.uai.lsm"
              className="mono"
              autoFocus
            />
          </Field>

          <Field
            label="Porta (opcional)"
            htmlFor="domain-port"
            hint="Vazio usa a porta fixa do projeto."
          >
            <Input
              id="domain-port"
              value={port}
              onChange={(event) => setPort(event.target.value)}
              placeholder="3001"
              inputMode="numeric"
            />
          </Field>

          <p className="text-[11px] text-zinc-600">
            HTTP: porta {status?.httpPort ?? 8090} · HTTPS: porta {status?.httpsPort ?? 8443} · o
            proxy escuta apenas em 127.0.0.1.
          </p>
        </div>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Remover domínio"
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
          Remover <span className="mono font-semibold">{deleteTarget?.host}</span>? O projeto e a
          porta continuam cadastrados.
        </p>
        {remove.error ? (
          <div className="mt-3">
            <ErrorBanner message={errorMessage(remove.error)} />
          </div>
        ) : null}
      </Dialog>
    </div>
  );
}
