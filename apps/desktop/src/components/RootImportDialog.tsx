import type { ScannedProject } from '@lsm/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, FolderSearch, ShieldAlert } from 'lucide-react';
import { ApiError } from '../lib/api';
import { useGroupsQuery } from '../lib/hooks';
import { buildNodeOptions, MEMORY_PROFILES, type MemoryProfile } from '../lib/payload';
import { queryKeys } from '../lib/queries';
import { pickFolder, isTauriRuntime } from '../lib/tauri';
import { useEngine } from '../providers/engine-provider';
import { Button, Checkbox, Dialog, ErrorBanner, Field, Input, Select, Spinner } from './ui';

interface Row {
  key: string;
  directory: string;
  relativeDirectory: string;
  packageManager: ScannedProject['packageManager'];
  name: string;
  port: string;
  portSource: ScannedProject['portSource'];
  script: string;
  availableScripts: string[];
  runnable: boolean;
  notes: string[];
  healthType: 'http' | 'tcp';
  healthTarget: string;
  startupOrder: number;
  selected: boolean;
  recommended: boolean;
}

function toRows(projects: ScannedProject[]): Row[] {
  return projects.map((project) => ({
    key: project.directory,
    directory: project.directory,
    relativeDirectory: project.relativeDirectory,
    packageManager: project.packageManager,
    name: project.name,
    port: project.port === null ? '' : String(project.port),
    portSource: project.portSource,
    script: project.script ?? '',
    availableScripts: project.availableScripts,
    runnable: project.runnable,
    recommended: project.recommended,
    notes: project.notes,
    healthType: project.healthType,
    healthTarget: project.healthTarget ?? '',
    startupOrder: project.startupOrder,
    selected: project.recommended,
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : error instanceof Error
      ? error.message
      : String(error);
}

function healthCheckBody(row: Row): Record<string, unknown> {
  const target = row.healthTarget.trim();
  return {
    enabled: target !== '',
    type: row.healthType,
    target,
    expectedStatus: 200,
    intervalMs: 30_000,
    timeoutMs: row.healthType === 'tcp' ? 5_000 : 15_000,
    failureThreshold: 3,
    restartOnUnhealthy: false,
    unhealthyRestartCooldownMs: 60_000,
  };
}

export function RootImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { client } = useEngine();
  const queryClient = useQueryClient();
  const groupsQuery = useGroupsQuery();

  const [root, setRoot] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [groupName, setGroupName] = useState('');
  const [createGroup, setCreateGroup] = useState(true);
  const [memoryProfile, setMemoryProfile] = useState<MemoryProfile>('off');
  const [scanError, setScanError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [results, setResults] = useState<
    Array<{ name: string; success: boolean; message?: string }>
  >([]);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (open) {
      setRoot('');
      setRows([]);
      setGroupName('');
      setCreateGroup(true);
      setMemoryProfile('off');
      setScanError(null);
      setSubmitError(null);
      setResults([]);
    }
  }, [open]);

  const scan = useMutation({
    mutationFn: (directory: string) => client.scanRoot(directory),
    onSuccess: (result) => {
      setRows(toRows(result.projects));
      setGroupName((previous) => previous || result.groupSuggestion);
      setScanError(null);
      setResults([]);
    },
    onError: (error) => {
      setRows([]);
      setScanError(errorMessage(error));
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const selected = rows.filter((row) => row.selected && row.script !== '');
      if (selected.length === 0) {
        throw new Error('Selecione ao menos um projeto executável.');
      }

      let groupId: string | null = null;
      const trimmedGroup = groupName.trim();
      if (createGroup && trimmedGroup !== '') {
        const existing = (groupsQuery.data ?? []).find(
          (group) => group.name.toLowerCase() === trimmedGroup.toLowerCase(),
        );
        if (existing) {
          groupId = existing.id;
        } else {
          try {
            groupId = (await client.createGroup({ name: trimmedGroup })).id;
          } catch (error) {
            if (error instanceof ApiError && error.code === 'GROUP_NAME_IN_USE') {
              const groups = await client.listGroups();
              groupId =
                groups.find((group) => group.name.toLowerCase() === trimmedGroup.toLowerCase())
                  ?.id ?? null;
            } else {
              throw error;
            }
          }
        }
      }

      const created: Array<{ name: string; success: boolean; message?: string }> = [];
      const preset = MEMORY_PROFILES.find((item) => item.value === memoryProfile);
      const nodeOptions = buildNodeOptions(preset?.heapMb ?? null, preset?.semiSpaceMb ?? null);
      const environment = nodeOptions === '' ? {} : { NODE_OPTIONS: nodeOptions };

      for (const row of selected) {
        try {
          await client.importProject({
            directory: row.directory,
            name: row.name.trim(),
            script: row.script,
            packageManager: row.packageManager,
            port: row.port.trim() === '' ? null : Number.parseInt(row.port, 10),
            groupId,
            startupOrder: row.startupOrder,
            startOnBoot: false,
            enabled: true,
            environment,
            healthCheck: healthCheckBody(row),
          });
          created.push({ name: row.name, success: true });
        } catch (error) {
          created.push({ name: row.name, success: false, message: errorMessage(error) });
        }
      }
      return created;
    },
    onSuccess: (created) => {
      setResults(created);
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      if (created.every((item) => item.success)) {
        onClose();
      }
    },
    onError: (error) => setSubmitError(errorMessage(error)),
  });

  async function chooseFolder(): Promise<void> {
    setPicking(true);
    try {
      const selected = await pickFolder('Selecione a raiz do repositório');
      if (selected) {
        setRoot(selected);
        scan.mutate(selected);
      }
    } finally {
      setPicking(false);
    }
  }

  const duplicates = useMemo(() => {
    const seen = new Map<string, number>();
    for (const row of rows) {
      if (!row.selected || row.port.trim() === '') {
        continue;
      }
      seen.set(row.port.trim(), (seen.get(row.port.trim()) ?? 0) + 1);
    }
    return [...seen.entries()].filter(([, count]) => count > 1).map(([port]) => port);
  }, [rows]);

  const selectedCount = rows.filter((row) => row.selected && row.script !== '').length;

  function patchRow(key: string, patch: Partial<Row>): void {
    setRows((previous) => previous.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Adicionar pela raiz"
      description="Escolha a pasta do repositório. O Engine detecta os serviços e propõe a configuração — nada é criado sem confirmar."
      size="xl"
      footer={
        <>
          <span className="mr-auto text-xs text-zinc-500">
            {rows.length === 0
              ? 'Nenhuma varredura ainda'
              : `${selectedCount} de ${rows.length} selecionado(s)`}
          </span>
          <Button onClick={onClose}>Cancelar</Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={selectedCount === 0 || duplicates.length > 0}
            onClick={() => {
              setSubmitError(null);
              create.mutate();
            }}
          >
            Criar {selectedCount > 0 ? `${selectedCount} projeto(s)` : ''}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {scanError ? (
          <ErrorBanner message={scanError} onDismiss={() => setScanError(null)} />
        ) : null}
        {submitError ? (
          <ErrorBanner message={submitError} onDismiss={() => setSubmitError(null)} />
        ) : null}

        <Field
          label="Raiz do repositório"
          htmlFor="scan-root"
          hint="A varredura é read-only: lê package.json, lockfiles, .env e configs."
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="scan-root"
              value={root}
              onChange={(event) => setRoot(event.target.value)}
              placeholder="C:\dev\meu-repo"
              className="mono"
              onKeyDown={(event) => {
                if (event.key === 'Enter' && root.trim() !== '') {
                  scan.mutate(root.trim());
                }
              }}
            />
            <Button
              onClick={() => void chooseFolder()}
              disabled={picking}
              className="shrink-0"
              title={isTauriRuntime() ? 'Abrir seletor de pasta' : 'Disponível no app desktop'}
            >
              {picking ? <Spinner /> : <FolderOpen className="h-4 w-4" />}
              Escolher pasta
            </Button>
            <Button
              variant="primary"
              onClick={() => scan.mutate(root.trim())}
              disabled={root.trim() === '' || scan.isPending}
              className="shrink-0"
            >
              {scan.isPending ? <Spinner /> : <FolderSearch className="h-4 w-4" />}
              Detectar
            </Button>
          </div>
        </Field>

        {scan.isPending ? <p className="text-sm text-zinc-500">Varrendo o repositório...</p> : null}

        {rows.length > 0 ? (
          <>
            <div className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
              <Checkbox
                label="Agrupar"
                description="Cria/reaproveita o grupo com os projetos"
                checked={createGroup}
                onChange={setCreateGroup}
              />
              <Field label="Nome do grupo" htmlFor="scan-group" className="min-w-[220px] flex-1">
                <Input
                  id="scan-group"
                  value={groupName}
                  onChange={(event) => setGroupName(event.target.value)}
                  disabled={!createGroup}
                  placeholder="UAIZAPI"
                />
              </Field>
              <Field
                label="Perfil de memória"
                htmlFor="scan-memory"
                hint="Aplicado a todos os projetos criados"
                className="min-w-[240px]"
              >
                <Select
                  id="scan-memory"
                  value={memoryProfile}
                  onChange={(event) => setMemoryProfile(event.target.value as MemoryProfile)}
                >
                  {MEMORY_PROFILES.filter((preset) => preset.value !== 'custom').map((preset) => (
                    <option key={preset.value} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            {duplicates.length > 0 ? (
              <div className="flex items-start gap-2 rounded-lg border border-amber-800/70 bg-amber-950/40 px-3 py-2 text-xs text-amber-200">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  Porta repetida em mais de um projeto: {duplicates.join(', ')}. Ajuste antes de
                  criar.
                </span>
              </div>
            ) : null}

            <div className="space-y-2">
              {rows.map((row) => (
                <div
                  key={row.key}
                  className={[
                    'rounded-lg border p-3',
                    row.selected ? 'border-zinc-700 bg-zinc-900/50' : 'border-zinc-800/70',
                  ].join(' ')}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <Checkbox
                      label={row.runnable ? row.name : `${row.name} (sem script)`}
                      description={`${row.relativeDirectory} · ${row.packageManager}`}
                      checked={row.selected}
                      disabled={!row.runnable}
                      onChange={(checked) => patchRow(row.key, { selected: checked })}
                    />
                    <span className="mono text-[11px] text-zinc-500">{row.directory}</span>
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-4">
                    <Field label="Nome" htmlFor={`row-name-${row.key}`}>
                      <Input
                        id={`row-name-${row.key}`}
                        value={row.name}
                        onChange={(event) => patchRow(row.key, { name: event.target.value })}
                        disabled={!row.runnable}
                      />
                    </Field>
                    <Field label="Script" htmlFor={`row-script-${row.key}`}>
                      <Select
                        id={`row-script-${row.key}`}
                        value={row.script}
                        disabled={!row.runnable}
                        onChange={(event) => patchRow(row.key, { script: event.target.value })}
                      >
                        {row.availableScripts.length === 0 ? <option value="">—</option> : null}
                        {row.availableScripts.map((script) => (
                          <option key={script} value={script}>
                            {script}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Porta" htmlFor={`row-port-${row.key}`}>
                      <Input
                        id={`row-port-${row.key}`}
                        value={row.port}
                        onChange={(event) => patchRow(row.key, { port: event.target.value })}
                        disabled={!row.runnable}
                        inputMode="numeric"
                        title={
                          row.portSource === 'none'
                            ? 'Porta não detectada'
                            : `Detectada em ${row.portSource}`
                        }
                      />
                    </Field>
                    <Field label="Health" htmlFor={`row-health-${row.key}`}>
                      <Input
                        id={`row-health-${row.key}`}
                        value={row.healthTarget}
                        onChange={(event) =>
                          patchRow(row.key, { healthTarget: event.target.value })
                        }
                        disabled={!row.runnable}
                        className="mono"
                      />
                    </Field>
                  </div>

                  {row.notes.length > 0 ? (
                    <ul className="mt-2 space-y-1 text-[11px] text-amber-200/90">
                      {row.notes.map((note) => (
                        <li key={note}>• {note}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          </>
        ) : null}

        {results.length > 0 ? (
          <ul className="space-y-1 rounded-lg border border-zinc-800 p-3 text-xs">
            {results.map((result) => (
              <li
                key={result.name}
                className={result.success ? 'text-emerald-300' : 'text-red-300'}
              >
                {result.name}: {result.success ? 'criado' : `falhou — ${result.message ?? ''}`}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Dialog>
  );
}
