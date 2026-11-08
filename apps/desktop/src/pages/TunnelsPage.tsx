import type { TunnelSummary } from '@lsm/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  Cloud,
  ExternalLink,
  Pencil,
  Play,
  Plus,
  RotateCw,
  ScrollText,
  Square,
  Trash2,
} from 'lucide-react';
import { ApiError } from '../lib/api';
import { useTunnelsQuery } from '../lib/hooks';
import { queryKeys } from '../lib/queries';
import { useEngine } from '../providers/engine-provider';
import { LogViewer } from '../components/LogViewer';
import { PageHeader } from '../components/page';
import {
  Button,
  Card,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorBanner,
  Field,
  Input,
  Select,
  Spinner,
} from '../components/ui';

type TunnelKind = 'config' | 'token' | 'quick';

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);
}

function StateBadge({ state }: { state: TunnelSummary['status']['state'] }) {
  const styles: Record<string, string> = {
    RUNNING: 'border-emerald-800 bg-emerald-950/40 text-emerald-300',
    STARTING: 'border-sky-800 bg-sky-950/40 text-sky-300',
    STOPPING: 'border-amber-800 bg-amber-950/40 text-amber-300',
    FAILED: 'border-red-800 bg-red-950/40 text-red-300',
    STOPPED: 'border-zinc-700 bg-zinc-800/60 text-zinc-300',
  };
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${styles[state] ?? styles.STOPPED}`}
    >
      {state}
    </span>
  );
}

function kindLabel(kind: TunnelKind): string {
  if (kind === 'config') {
    return 'config.yml';
  }
  if (kind === 'token') {
    return 'token';
  }
  return 'quick';
}

export function TunnelsPage() {
  const { client } = useEngine();
  const queryClient = useQueryClient();
  const tunnelsQuery = useTunnelsQuery();

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TunnelSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TunnelSummary | null>(null);
  const [logsTarget, setLogsTarget] = useState<TunnelSummary | null>(null);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<TunnelKind>('config');
  const [configPath, setConfigPath] = useState('');
  const [targetPort, setTargetPort] = useState('');
  const [token, setToken] = useState('');
  const [startOnBoot, setStartOnBoot] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const tunnels = tunnelsQuery.data ?? [];

  function openCreate(): void {
    setEditing(null);
    setName('');
    setKind('config');
    setConfigPath('');
    setTargetPort('');
    setToken('');
    setStartOnBoot(false);
    setFormError(null);
    setFormOpen(true);
  }

  function openEdit(tunnel: TunnelSummary): void {
    setEditing(tunnel);
    setName(tunnel.config.name);
    setKind(tunnel.config.kind);
    setConfigPath(tunnel.config.configPath ?? '');
    setTargetPort(tunnel.config.targetPort === null ? '' : String(tunnel.config.targetPort));
    setToken('');
    setStartOnBoot(tunnel.config.startOnBoot);
    setFormError(null);
    setFormOpen(true);
  }

  const save = useMutation({
    mutationFn: () => {
      const base = {
        name: name.trim(),
        kind,
        configPath: configPath.trim() === '' ? null : configPath.trim(),
        targetPort: kind === 'quick' ? Number.parseInt(targetPort, 10) || null : null,
        startOnBoot,
        ...(token.trim() === '' ? {} : { token: token.trim() }),
      };
      return editing ? client.updateTunnel(editing.config.id, base) : client.createTunnel(base);
    },
    onSuccess: () => {
      setFormOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.tunnels });
    },
    onError: (error) => setFormError(errorMessage(error)),
  });

  const start = useMutation({
    mutationFn: (id: string) => client.startTunnel(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.tunnels }),
    onError: (error) => setFormError(errorMessage(error)),
  });

  const stop = useMutation({
    mutationFn: (id: string) => client.stopTunnel(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.tunnels }),
    onError: (error) => setFormError(errorMessage(error)),
  });

  const restart = useMutation({
    mutationFn: (id: string) => client.restartTunnel(id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.tunnels }),
    onError: (error) => setFormError(errorMessage(error)),
  });

  const busy = start.isPending || stop.isPending || restart.isPending;

  const remove = useMutation({
    mutationFn: (id: string) => client.deleteTunnel(id),
    onSuccess: () => {
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.tunnels });
    },
    onError: (error) => setFormError(errorMessage(error)),
  });

  const logsQuery = useQuery({
    queryKey: queryKeys.tunnelLogs(logsTarget?.config.id ?? '', 200),
    queryFn: () => client.getTunnelLogs(logsTarget?.config.id ?? '', 200),
    enabled: logsTarget !== null,
    refetchInterval: 3_000,
  });

  const pageError = tunnelsQuery.error;

  return (
    <div>
      <PageHeader
        title="Túneis"
        description="Cloudflare Tunnel supervisionado: start, stop, logs e URL pública."
        actions={
          <Button variant="primary" onClick={openCreate}>
            <Plus className="h-4 w-4" />
            Novo túnel
          </Button>
        }
      />

      {pageError ? <ErrorBanner message={pageError.message} /> : null}
      {formError && !formOpen ? (
        <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />
      ) : null}

      <Card className="mt-4" bodyClassName="p-0">
        {tunnelsQuery.isLoading ? (
          <p className="p-6 text-sm text-zinc-500">Carregando túneis...</p>
        ) : tunnels.length === 0 ? (
          <div className="p-4">
            <EmptyState
              icon={<Cloud className="h-8 w-8" />}
              title="Nenhum túnel"
              description="Use o config.yml do cloudflared, um token do dashboard ou um quick tunnel para uma porta local."
              action={
                <Button variant="primary" onClick={openCreate}>
                  <Plus className="h-4 w-4" />
                  Criar túnel
                </Button>
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wide text-zinc-500">
                  <th className="py-2 pl-4 pr-3">Túnel</th>
                  <th className="py-2 pr-3">Tipo</th>
                  <th className="py-2 pr-3">Estado</th>
                  <th className="py-2 pr-3">Destino</th>
                  <th className="py-2 pr-4 text-right">Ações</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/70">
                {tunnels.map((tunnel) => {
                  const status = tunnel.status;
                  const running = status.state === 'RUNNING' || status.state === 'STARTING';
                  return (
                    <tr key={tunnel.config.id} className="align-top hover:bg-zinc-900/40">
                      <td className="py-2 pl-4 pr-3">
                        <p className="flex items-center gap-2 font-medium text-zinc-100">
                          <Cloud className="h-4 w-4 text-zinc-500" />
                          {tunnel.config.name}
                        </p>
                        <p className="mono mt-0.5 max-w-[340px] truncate text-[11px] text-zinc-500">
                          {tunnel.config.configPath ??
                            `127.0.0.1:${tunnel.config.targetPort ?? '—'}`}
                        </p>
                      </td>
                      <td className="py-2 pr-3 text-xs text-zinc-400">
                        {kindLabel(tunnel.config.kind)}
                        {tunnel.config.startOnBoot ? (
                          <span className="ml-1 text-[10px] text-emerald-400">boot</span>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3">
                        <StateBadge state={status.state} />
                        {status.healthy === false ? (
                          <p className="mt-1 text-[10px] text-amber-300">sem /ready</p>
                        ) : null}
                        {status.lastError ? (
                          <p
                            className="mt-1 max-w-[240px] truncate text-[10px] text-red-300"
                            title={status.lastError}
                          >
                            {status.lastError}
                          </p>
                        ) : null}
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        {status.url ? (
                          <a
                            href={status.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-emerald-400 hover:underline"
                          >
                            {status.url.replace(/^https?:\/\//, '')}
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        ) : null}
                        {status.hostnames.length > 0 ? (
                          <ul className="mt-1 space-y-0.5 text-zinc-400">
                            {status.hostnames.map((hostname) => (
                              <li key={hostname.hostname}>
                                {hostname.hostname} → {hostname.service}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        {!status.url && status.hostnames.length === 0 ? '—' : null}
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex items-center justify-end gap-1">
                          {running ? (
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => stop.mutate(tunnel.config.id)}
                            >
                              {stop.isPending ? <Spinner /> : <Square className="h-3.5 w-3.5" />}
                              Parar
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              disabled={busy}
                              onClick={() => start.mutate(tunnel.config.id)}
                            >
                              {start.isPending ? <Spinner /> : <Play className="h-3.5 w-3.5" />}
                              Iniciar
                            </Button>
                          )}
                          <Button
                            size="sm"
                            disabled={busy || !running}
                            onClick={() => restart.mutate(tunnel.config.id)}
                          >
                            <RotateCw className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            aria-label={`Logs de ${tunnel.config.name}`}
                            onClick={() => setLogsTarget(tunnel)}
                          >
                            <ScrollText className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            aria-label={`Editar ${tunnel.config.name}`}
                            onClick={() => openEdit(tunnel)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="danger"
                            aria-label={`Remover ${tunnel.config.name}`}
                            disabled={running}
                            title={running ? 'pare o túnel antes de remover' : 'Remover'}
                            onClick={() => setDeleteTarget(tunnel)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Dialog
        open={formOpen}
        onClose={() => setFormOpen(false)}
        title={editing ? `Editar ${editing.config.name}` : 'Novo túnel'}
        description="O cloudflared precisa estar no PATH (ou defina LSM_CLOUDFLARED)."
        size="lg"
        footer={
          <>
            <Button onClick={() => setFormOpen(false)}>Cancelar</Button>
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={name.trim() === ''}
              onClick={() => {
                setFormError(null);
                save.mutate();
              }}
            >
              {editing ? 'Salvar' : 'Criar'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {formError ? (
            <ErrorBanner message={formError} onDismiss={() => setFormError(null)} />
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nome" htmlFor="tunnel-name">
              <Input
                id="tunnel-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="uai-cloudflare"
              />
            </Field>
            <Field label="Tipo" htmlFor="tunnel-kind">
              <Select
                id="tunnel-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value as TunnelKind)}
              >
                <option value="config">config.yml (túnel nomeado)</option>
                <option value="token">Token do dashboard</option>
                <option value="quick">Quick tunnel (URL temporária)</option>
              </Select>
            </Field>
          </div>

          {kind === 'config' ? (
            <Field
              label="Caminho do config.yml"
              htmlFor="tunnel-config"
              hint="Vazio usa %USERPROFILE%\.cloudflared\config.yml"
            >
              <Input
                id="tunnel-config"
                value={configPath}
                onChange={(event) => setConfigPath(event.target.value)}
                placeholder="C:\Users\você\.cloudflared\config.yml"
                className="mono"
              />
            </Field>
          ) : null}

          {kind === 'quick' ? (
            <Field
              label="Porta alvo"
              htmlFor="tunnel-port"
              hint="Serviço local que receberá o túnel."
            >
              <Input
                id="tunnel-port"
                value={targetPort}
                onChange={(event) => setTargetPort(event.target.value)}
                inputMode="numeric"
                placeholder="3000"
              />
            </Field>
          ) : null}

          {kind === 'token' ? (
            <Field
              label="Token"
              htmlFor="tunnel-token"
              hint={
                editing?.config.hasToken
                  ? 'Já existe um token salvo. Deixe vazio para manter.'
                  : 'Token do túnel gerenciado no dashboard da Cloudflare.'
              }
            >
              <Input
                id="tunnel-token"
                type="password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder={editing?.config.hasToken ? '••••••••' : ''}
                className="mono"
              />
            </Field>
          ) : null}

          <Checkbox
            label="Iniciar com o Engine"
            description="Sobe junto no boot do Engine"
            checked={startOnBoot}
            onChange={setStartOnBoot}
          />
        </div>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Remover túnel"
        size="md"
        footer={
          <>
            <Button onClick={() => setDeleteTarget(null)}>Cancelar</Button>
            <Button
              variant="danger"
              loading={remove.isPending}
              onClick={() => {
                if (deleteTarget) {
                  remove.mutate(deleteTarget.config.id);
                }
              }}
            >
              Remover
            </Button>
          </>
        }
      >
        <p className="text-sm text-zinc-300">
          Remover <span className="font-semibold">{deleteTarget?.config.name}</span>? O túnel no
          Cloudflare não é alterado.
        </p>
      </Dialog>

      <Dialog
        open={logsTarget !== null}
        onClose={() => setLogsTarget(null)}
        title={`Logs · ${logsTarget?.config.name ?? ''}`}
        size="xl"
        footer={<Button onClick={() => setLogsTarget(null)}>Fechar</Button>}
      >
        <LogViewer records={logsQuery.data?.records ?? []} autoScroll />
      </Dialog>
    </div>
  );
}
