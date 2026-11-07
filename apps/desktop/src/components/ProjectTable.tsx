import type { ProjectSummary } from '@lsm/contracts';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Play, RotateCw, Square, Trash2 } from 'lucide-react';
import { formatUptime } from '../lib/format';
import { HealthBadge, isActiveStatus, StatusBadge, StatusDot } from './status';
import { Spinner } from './ui';

export interface ProjectTableProps {
  projects: ProjectSummary[];
  busyId?: string | null;
  selected?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
  onToggleAll?: () => void;
  onStart: (id: string) => void;
  onStop: (id: string) => void;
  onRestart: (id: string) => void;
  onDelete?: (id: string) => void;
}

function IconAction({
  label,
  title,
  disabled,
  onClick,
  tone = 'default',
  children,
}: {
  label: string;
  title: string;
  disabled: boolean;
  onClick: () => void;
  tone?: 'default' | 'danger';
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={disabled ? `${label} — ${title}` : label}
      disabled={disabled}
      onClick={onClick}
      className={[
        'rounded-md border border-transparent p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-35',
        tone === 'danger'
          ? 'text-zinc-400 hover:border-red-800 hover:bg-red-950/50 hover:text-red-300'
          : 'text-zinc-400 hover:border-zinc-700 hover:bg-zinc-800 hover:text-zinc-100',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

export function ProjectTable({
  projects,
  busyId = null,
  selected,
  onToggle,
  onToggleAll,
  onStart,
  onStop,
  onRestart,
  onDelete,
}: ProjectTableProps) {
  const selectable = Boolean(selected && onToggle);
  const allSelected =
    selectable &&
    projects.length > 0 &&
    projects.every((project) => selected?.has(project.config.id));

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[860px] text-sm">
        <thead>
          <tr className="border-b border-zinc-800 text-left text-[11px] uppercase tracking-wide text-zinc-500">
            {selectable ? (
              <th className="w-8 py-2 pl-1">
                <input
                  type="checkbox"
                  aria-label="Selecionar todos os projetos"
                  checked={allSelected}
                  onChange={() => onToggleAll?.()}
                  className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 accent-emerald-600"
                />
              </th>
            ) : null}
            <th className="py-2 pr-3">Projeto</th>
            <th className="py-2 pr-3">Estado</th>
            <th className="py-2 pr-3">PID</th>
            <th className="py-2 pr-3">Uptime</th>
            <th className="py-2 pr-3">Porta</th>
            <th className="py-2 pr-1 text-right">Ações</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/70">
          {projects.map((project) => {
            const runtime = project.runtime;
            const active = isActiveStatus(runtime.status);
            const busy = busyId === project.config.id;

            return (
              <tr key={project.config.id} className="align-middle hover:bg-zinc-900/40">
                {selectable ? (
                  <td className="py-2 pl-1">
                    <input
                      type="checkbox"
                      aria-label={`Selecionar ${project.config.name}`}
                      checked={selected?.has(project.config.id) ?? false}
                      onChange={() => onToggle?.(project.config.id)}
                      className="h-4 w-4 rounded border-zinc-600 bg-zinc-900 accent-emerald-600"
                    />
                  </td>
                ) : null}
                <td className="py-2 pr-3">
                  <Link
                    to={`/projects/${project.config.id}`}
                    className="flex items-center gap-2 font-medium text-zinc-100 hover:text-emerald-300"
                  >
                    <StatusDot status={runtime.status} />
                    {project.config.name}
                  </Link>
                  <p
                    className="mono mt-0.5 max-w-[360px] truncate text-[11px] text-zinc-500"
                    title={project.config.workingDirectory}
                  >
                    {project.config.workingDirectory}
                  </p>
                </td>
                <td className="py-2 pr-3">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StatusBadge status={runtime.status} />
                    <HealthBadge health={runtime.health} />
                  </div>
                </td>
                <td className="mono py-2 pr-3 text-xs text-zinc-400">{runtime.pid ?? '—'}</td>
                <td className="py-2 pr-3 text-xs text-zinc-400">
                  {formatUptime(runtime.startedAt)}
                </td>
                <td className="mono py-2 pr-3 text-xs text-zinc-400">
                  {project.config.port ?? '—'}
                </td>
                <td className="py-2 pr-1">
                  <div className="flex items-center justify-end gap-1">
                    {busy ? (
                      <Spinner className="mx-2 h-4 w-4 text-zinc-400" />
                    ) : (
                      <>
                        <IconAction
                          label="Iniciar"
                          title={active ? 'projeto já está ativo' : ''}
                          disabled={active}
                          onClick={() => onStart(project.config.id)}
                        >
                          <Play className="h-4 w-4" />
                        </IconAction>
                        <IconAction
                          label="Parar"
                          title={active ? '' : 'projeto não está em execução'}
                          disabled={!active}
                          onClick={() => onStop(project.config.id)}
                        >
                          <Square className="h-4 w-4" />
                        </IconAction>
                        <IconAction
                          label="Reiniciar"
                          title=""
                          disabled={busy}
                          onClick={() => onRestart(project.config.id)}
                        >
                          <RotateCw className="h-4 w-4" />
                        </IconAction>
                        {onDelete ? (
                          <IconAction
                            label="Remover"
                            title={active ? 'pare o projeto antes de remover' : ''}
                            disabled={active}
                            tone="danger"
                            onClick={() => onDelete(project.config.id)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </IconAction>
                        ) : null}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
