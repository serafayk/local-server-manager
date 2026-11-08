import type { DetectProjectResponse, ProjectConfig } from '@lsm/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import { ApiError } from '../lib/api';
import { formatCommand } from '../lib/format';
import {
  buildCreateBody,
  buildImportBody,
  buildUpdateBody,
  emptyFormState,
  formStateFromConfig,
  parseArgsText,
  validateFormState,
  validateStep,
  type EnvironmentRow,
  type ProjectFormState,
} from '../lib/payload';
import { queryKeys } from '../lib/queries';
import { useGroupsQuery, useNodeVersionsQuery } from '../lib/hooks';
import { isTauriRuntime, pickFolder } from '../lib/tauri';
import { useEngine } from '../providers/engine-provider';
import {
  Button,
  Checkbox,
  Dialog,
  ErrorBanner,
  Field,
  Input,
  Select,
  Spinner,
  Textarea,
} from './ui';

const STEP_LABELS = ['Projeto', 'Comando', 'Execução'];

function initialState(
  project?: ProjectConfig | null,
  template?: ProjectConfig | null,
): ProjectFormState {
  if (project) {
    return formStateFromConfig(project);
  }
  if (template) {
    return {
      ...formStateFromConfig(template),
      name: `${template.name} (cópia)`,
      // Porta e boot não são copiados: evita conflito imediato.
      port: '',
      startOnBoot: false,
    };
  }
  return emptyFormState();
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function ProjectForm({
  open,
  onClose,
  project,
  template,
}: {
  open: boolean;
  onClose: () => void;
  project?: ProjectConfig | null;
  /** Usado em "Duplicar": preenche o formulário a partir de outro projeto. */
  template?: ProjectConfig | null;
}) {
  const { client } = useEngine();
  const queryClient = useQueryClient();
  const isEdit = Boolean(project);
  const groupsQuery = useGroupsQuery();
  const nodeVersionsQuery = useNodeVersionsQuery();
  const detectedNodes = nodeVersionsQuery.data ?? [];

  const [state, setState] = useState<ProjectFormState>(() => initialState(project, template));
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [detection, setDetection] = useState<DetectProjectResponse | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (open) {
      setState(initialState(project, template));
      setStep(0);
      setErrors([]);
      setSubmitError(null);
      setDetection(null);
      setAdvancedOpen(false);
    }
  }, [open, project, template]);

  function update<K extends keyof ProjectFormState>(key: K, value: ProjectFormState[K]): void {
    setState((previous) => ({ ...previous, [key]: value }));
  }

  function updateEnvironment(index: number, patch: Partial<EnvironmentRow>): void {
    setState((previous) => ({
      ...previous,
      environment: previous.environment.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    }));
  }

  const detect = useMutation({
    mutationFn: (directory: string) => client.detect(directory),
    onSuccess: (result) => {
      setDetection(result);
      setState((previous) => ({
        ...previous,
        name:
          previous.name.trim() === '' && result.projectName ? result.projectName : previous.name,
        packageManager: result.packageManager,
        mode: result.scripts.length > 0 ? 'script' : previous.mode,
        script: result.scripts.some((script) => script.name === previous.script)
          ? previous.script
          : (result.scripts[0]?.name ?? previous.script),
      }));
    },
    onError: (error) => setSubmitError(errorMessage(error)),
  });

  const submit = useMutation({
    mutationFn: () => {
      if (isEdit && project) {
        return client.updateProject(project.id, buildUpdateBody(state));
      }
      if (state.mode === 'script') {
        return client.importProject(buildImportBody(state));
      }
      return client.createProject(buildCreateBody(state));
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
      if (project) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.project(project.id) });
      }
      onClose();
    },
    onError: (error) => setSubmitError(errorMessage(error)),
  });

  function goNext(): void {
    const problems = validateStep(state, step);
    if (problems.length > 0) {
      setErrors(problems);
      return;
    }
    setErrors([]);
    setStep((value) => Math.min(2, value + 1));
  }

  const commandPreview =
    state.mode === 'script'
      ? `${state.packageManager} run ${state.script || '?'} (resolvido pelo Engine)`
      : formatCommand(state.executable.trim() || '?', parseArgsText(state.argsText));

  const currentNodePath = detectedNodes.some((node) => node.executable === state.executable)
    ? state.executable
    : '';

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        isEdit && project
          ? `Editar ${project.name}`
          : template
            ? `Duplicar ${template.name}`
            : 'Novo projeto'
      }
      description={
        isEdit
          ? 'Projeto parado obrigatoriamente. Campos de comando usam executável + argumentos.'
          : template
            ? 'Cópia da configuração. Porta e boot não são copiados; ajuste antes de criar.'
            : 'Cadastro em três etapas. Nada é executado durante a detecção.'
      }
      size="xl"
      footer={
        <>
          <span className="mr-auto text-xs text-zinc-500">
            Passo {step + 1} de {STEP_LABELS.length}
          </span>
          <Button onClick={onClose}>Cancelar</Button>
          {step > 0 ? (
            <Button onClick={() => setStep((value) => Math.max(0, value - 1))}>Voltar</Button>
          ) : null}
          {step < 2 ? (
            <Button variant="primary" onClick={goNext}>
              Avançar
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={submit.isPending}
              onClick={() => {
                const problems = validateFormState(state);
                if (problems.length > 0) {
                  setErrors(problems);
                  return;
                }
                setErrors([]);
                submit.mutate();
              }}
            >
              {isEdit ? 'Salvar alterações' : template ? 'Criar cópia' : 'Criar projeto'}
            </Button>
          )}
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {STEP_LABELS.map((label, index) => (
          <div
            key={label}
            className={[
              'flex items-center gap-2 rounded-full border px-3 py-1 text-xs',
              index === step
                ? 'border-emerald-700 bg-emerald-950/40 text-emerald-200'
                : index < step
                  ? 'border-zinc-700 bg-zinc-800 text-zinc-300'
                  : 'border-zinc-800 text-zinc-500',
            ].join(' ')}
          >
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-zinc-900 text-[10px]">
              {index + 1}
            </span>
            {label}
          </div>
        ))}
      </div>

      {errors.length > 0 ? (
        <div className="mb-3">
          <ErrorBanner message={errors[0] as string} onDismiss={() => setErrors([])} />
        </div>
      ) : null}
      {submitError ? (
        <div className="mb-3">
          <ErrorBanner message={submitError} onDismiss={() => setSubmitError(null)} />
        </div>
      ) : null}

      {step === 0 ? (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Nome" htmlFor="project-name">
              <Input
                id="project-name"
                value={state.name}
                onChange={(event) => update('name', event.target.value)}
                placeholder="Fiscal API"
                autoFocus
              />
            </Field>
            <Field label="Descrição" htmlFor="project-description">
              <Input
                id="project-description"
                value={state.description}
                onChange={(event) => update('description', event.target.value)}
                placeholder="Opcional"
              />
            </Field>
          </div>

          <Field
            label="Grupo"
            htmlFor="project-group"
            hint="Opcional; organização visual (não cria dependência)."
          >
            <Select
              id="project-group"
              value={state.groupId}
              onChange={(event) => update('groupId', event.target.value)}
            >
              <option value="">Sem grupo</option>
              {(groupsQuery.data ?? []).map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Diretório do projeto"
            htmlFor="project-directory"
            hint="Caminho absoluto. Escolher a pasta já dispara a detecção."
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="project-directory"
                value={state.directory}
                onChange={(event) => update('directory', event.target.value)}
                placeholder="C:\dev\fiscal-api"
                className="mono"
                onBlur={() => {
                  if (state.directory.trim() !== '' && !detection && !detect.isPending) {
                    detect.mutate(state.directory.trim());
                  }
                }}
              />
              <Button
                onClick={() => {
                  setPicking(true);
                  void pickFolder('Selecione a pasta do projeto')
                    .then((selected) => {
                      if (selected) {
                        update('directory', selected);
                        detect.mutate(selected);
                      }
                    })
                    .finally(() => setPicking(false));
                }}
                disabled={picking}
                className="shrink-0"
                title={
                  isTauriRuntime() ? 'Abrir seletor de pasta' : 'Disponível no aplicativo desktop'
                }
              >
                {picking ? <Spinner /> : null}
                Escolher pasta
              </Button>
              <Button
                onClick={() => detect.mutate(state.directory.trim())}
                disabled={state.directory.trim() === '' || detect.isPending}
                className="shrink-0"
              >
                {detect.isPending ? <Spinner /> : null}
                Detectar
              </Button>
            </div>
          </Field>

          {detection ? (
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-400">
              <p>
                {detection.hasPackageJson
                  ? 'package.json encontrado'
                  : 'package.json não encontrado (use comando personalizado)'}
                {' · '}
                gerenciador: <span className="text-zinc-200">{detection.packageManager}</span>
                {detection.packageManagerConfirmed ? '' : ' (padrão)'}
              </p>
              {detection.scripts.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {detection.scripts.map((script) => (
                    <button
                      key={script.name}
                      type="button"
                      onClick={() => {
                        update('mode', 'script');
                        update('script', script.name);
                      }}
                      title={script.command}
                      className={[
                        'rounded-md border px-2 py-1 text-[11px]',
                        state.script === script.name
                          ? 'border-emerald-700 bg-emerald-950/50 text-emerald-200'
                          : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800',
                      ].join(' ')}
                    >
                      {script.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {step === 1 ? (
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={isEdit}
              onClick={() => update('mode', 'script')}
              className={[
                'rounded-lg border p-3 text-left text-sm disabled:cursor-not-allowed disabled:opacity-50',
                state.mode === 'script'
                  ? 'border-emerald-700 bg-emerald-950/30 text-emerald-100'
                  : 'border-zinc-800 text-zinc-300 hover:border-zinc-700',
              ].join(' ')}
            >
              <span className="block font-medium">Script do package.json</span>
              <span className="block text-xs text-zinc-500">
                O Engine resolve o entrypoint sem shell
              </span>
            </button>
            <button
              type="button"
              onClick={() => update('mode', 'custom')}
              className={[
                'rounded-lg border p-3 text-left text-sm',
                state.mode === 'custom'
                  ? 'border-emerald-700 bg-emerald-950/30 text-emerald-100'
                  : 'border-zinc-800 text-zinc-300 hover:border-zinc-700',
              ].join(' ')}
            >
              <span className="block font-medium">Comando personalizado</span>
              <span className="block text-xs text-zinc-500">Executável + argumentos</span>
            </button>
          </div>

          {state.mode === 'script' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Package manager" htmlFor="project-pm">
                <Select
                  id="project-pm"
                  value={state.packageManager}
                  onChange={(event) =>
                    update(
                      'packageManager',
                      event.target.value as ProjectFormState['packageManager'],
                    )
                  }
                >
                  <option value="npm">npm</option>
                  <option value="pnpm">pnpm</option>
                  <option value="yarn">yarn</option>
                  <option value="bun">bun</option>
                </Select>
              </Field>
              <Field label="Script" htmlFor="project-script">
                <Input
                  id="project-script"
                  value={state.script}
                  onChange={(event) => update('script', event.target.value)}
                  placeholder="dev"
                  className="mono"
                />
              </Field>
              <p className="text-[11px] text-zinc-500 sm:col-span-2">
                Use <span className="mono">start</span> para execução supervisionada sem watcher. Se
                o script exigir build prévio (ex.: Next.js), prefira{' '}
                <span className="mono">dev</span> ou rode o build antes.
              </p>
            </div>
          ) : (
            <>
              <Field
                label="Node instalado"
                htmlFor="project-node"
                hint="Preenche o caminho absoluto do node.exe (NVM, sistema ou Engine)."
              >
                <Select
                  id="project-node"
                  value={currentNodePath}
                  onChange={(event) => {
                    if (event.target.value !== '') {
                      update('executable', event.target.value);
                    }
                  }}
                >
                  <option value="">Personalizado (use o campo abaixo)</option>
                  {detectedNodes.map((node) => (
                    <option key={node.executable} value={node.executable}>
                      v{node.version} · {node.source}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                label="Executável"
                htmlFor="project-executable"
                hint="Ex.: node, npm, C:\Program Files\nodejs\node.exe"
              >
                <Input
                  id="project-executable"
                  value={state.executable}
                  onChange={(event) => update('executable', event.target.value)}
                  placeholder="node"
                  className="mono"
                />
              </Field>
              <Field
                label="Argumentos"
                htmlFor="project-args"
                hint="Um argumento por linha. Espaços dentro da linha são preservados."
              >
                <Textarea
                  id="project-args"
                  rows={3}
                  value={state.argsText}
                  onChange={(event) => update('argsText', event.target.value)}
                  placeholder={'server.js\n--port\n3000'}
                />
              </Field>
            </>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Porta"
              htmlFor="project-port"
              hint="Usada para avisar conflito antes de iniciar e para o health check."
            >
              <Input
                id="project-port"
                value={state.port}
                onChange={(event) => update('port', event.target.value)}
                placeholder="3000"
                inputMode="numeric"
              />
            </Field>
            <Field
              label="Ordem de inicialização"
              htmlFor="project-order"
              hint="Menor inicia primeiro no boot."
            >
              <Input
                id="project-order"
                value={state.startupOrder}
                onChange={(event) => update('startupOrder', event.target.value)}
                inputMode="numeric"
              />
            </Field>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                Variáveis de ambiente
              </span>
              <Button
                size="sm"
                onClick={() =>
                  setState((previous) => ({
                    ...previous,
                    environment: [...previous.environment, { key: '', value: '' }],
                  }))
                }
              >
                Adicionar
              </Button>
            </div>
            {state.environment.length === 0 ? (
              <p className="text-xs text-zinc-500">Nenhuma variável configurada.</p>
            ) : (
              state.environment.map((row, index) => (
                <div key={index} className="flex gap-2">
                  <Input
                    aria-label={`Chave da variável ${index + 1}`}
                    value={row.key}
                    onChange={(event) => updateEnvironment(index, { key: event.target.value })}
                    placeholder="NODE_ENV"
                    className="mono"
                  />
                  <Input
                    aria-label={`Valor da variável ${index + 1}`}
                    value={row.value}
                    onChange={(event) => updateEnvironment(index, { value: event.target.value })}
                    placeholder="development"
                    className="mono"
                  />
                  <Button
                    variant="ghost"
                    aria-label="Remover variável"
                    onClick={() =>
                      setState((previous) => ({
                        ...previous,
                        environment: previous.environment.filter(
                          (_, rowIndex) => rowIndex !== index,
                        ),
                      }))
                    }
                  >
                    ✕
                  </Button>
                </div>
              ))
            )}
          </div>

          <div className="rounded-lg border border-zinc-800 bg-black/40 p-3">
            <p className="text-[11px] uppercase tracking-wide text-zinc-500">Comando final</p>
            <p className="mono mt-1 break-all text-xs text-zinc-200">{commandPreview}</p>
          </div>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-3">
            <Checkbox
              label="Habilitado"
              description="Pode ser iniciado"
              checked={state.enabled}
              onChange={(checked) => update('enabled', checked)}
            />
            <Checkbox
              label="Iniciar no boot"
              description="Sobe junto com o Engine"
              checked={state.startOnBoot}
              onChange={(checked) => update('startOnBoot', checked)}
            />
            <Checkbox
              label="Auto-restart"
              description="Recupera crashes"
              checked={state.restartEnabled}
              onChange={(checked) => update('restartEnabled', checked)}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-950/50 px-3 py-2">
            <div>
              <p className="text-xs font-medium text-zinc-300">Configuração avançada</p>
              <p className="text-[11px] text-zinc-500">
                Retry, timeouts e health check. Os padrões atendem a maioria dos casos.
              </p>
            </div>
            <Button size="sm" onClick={() => setAdvancedOpen((value) => !value)}>
              {advancedOpen ? 'Ocultar' : 'Mostrar'}
            </Button>
          </div>

          {advancedOpen ? (
            <>
              <div className="grid gap-3 sm:grid-cols-4">
                <Field label="maxRetries" htmlFor="policy-retries">
                  <Input
                    id="policy-retries"
                    value={state.maxRetries}
                    onChange={(event) => update('maxRetries', event.target.value)}
                    inputMode="numeric"
                  />
                </Field>
                <Field label="baseDelayMs" htmlFor="policy-base">
                  <Input
                    id="policy-base"
                    value={state.baseDelayMs}
                    onChange={(event) => update('baseDelayMs', event.target.value)}
                    inputMode="numeric"
                  />
                </Field>
                <Field label="maxDelayMs" htmlFor="policy-max">
                  <Input
                    id="policy-max"
                    value={state.maxDelayMs}
                    onChange={(event) => update('maxDelayMs', event.target.value)}
                    inputMode="numeric"
                  />
                </Field>
                <Field label="stableAfterMs" htmlFor="policy-stable">
                  <Input
                    id="policy-stable"
                    value={state.stableAfterMs}
                    onChange={(event) => update('stableAfterMs', event.target.value)}
                    inputMode="numeric"
                  />
                </Field>
              </div>

              <Field
                label="Timeout de encerramento gracioso (ms)"
                htmlFor="project-graceful"
                hint="No Windows o encerramento é forçado após uma janela curta."
              >
                <Input
                  id="project-graceful"
                  value={state.gracefulTimeoutMs}
                  onChange={(event) => update('gracefulTimeoutMs', event.target.value)}
                  inputMode="numeric"
                />
              </Field>

              <div className="rounded-lg border border-zinc-800 p-3">
                <Checkbox
                  label="Health check"
                  description="Dimensão separada do estado do processo (execução na Fase 5)"
                  checked={state.healthEnabled}
                  onChange={(checked) => update('healthEnabled', checked)}
                />
                {state.healthEnabled ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <Field label="Tipo" htmlFor="health-type">
                      <Select
                        id="health-type"
                        value={state.healthType}
                        onChange={(event) =>
                          update('healthType', event.target.value as ProjectFormState['healthType'])
                        }
                      >
                        <option value="http">HTTP</option>
                        <option value="tcp">TCP</option>
                      </Select>
                    </Field>
                    <Field label="Alvo" htmlFor="health-target" className="sm:col-span-2">
                      <Input
                        id="health-target"
                        value={state.healthTarget}
                        onChange={(event) => update('healthTarget', event.target.value)}
                        placeholder={
                          state.healthType === 'http'
                            ? 'http://127.0.0.1:3000/health'
                            : '127.0.0.1:3000'
                        }
                        className="mono"
                      />
                    </Field>
                    <Field label="intervalMs" htmlFor="health-interval">
                      <Input
                        id="health-interval"
                        value={state.healthIntervalMs}
                        onChange={(event) => update('healthIntervalMs', event.target.value)}
                        inputMode="numeric"
                      />
                    </Field>
                    <Field label="timeoutMs" htmlFor="health-timeout">
                      <Input
                        id="health-timeout"
                        value={state.healthTimeoutMs}
                        onChange={(event) => update('healthTimeoutMs', event.target.value)}
                        inputMode="numeric"
                      />
                    </Field>
                    <Field label="failureThreshold" htmlFor="health-threshold">
                      <Input
                        id="health-threshold"
                        value={state.healthFailureThreshold}
                        onChange={(event) => update('healthFailureThreshold', event.target.value)}
                        inputMode="numeric"
                      />
                    </Field>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <p className="text-[11px] uppercase tracking-wide text-zinc-500">Revisão</p>
            <dl className="mt-2 grid gap-1 text-xs sm:grid-cols-2">
              <div>
                <dt className="text-zinc-500">Nome</dt>
                <dd className="text-zinc-200">{state.name || '—'}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">Porta</dt>
                <dd className="text-zinc-200">{state.port || 'não definida'}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-zinc-500">Diretório</dt>
                <dd className="mono break-all text-zinc-200">{state.directory || '—'}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-zinc-500">Comando</dt>
                <dd className="mono break-all text-zinc-200">{commandPreview}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-zinc-500">Reinício</dt>
                <dd className="text-zinc-200">
                  {state.restartEnabled
                    ? `até ${state.maxRetries} tentativas, backoff ${state.baseDelayMs}–${state.maxDelayMs}ms`
                    : 'desabilitado'}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
