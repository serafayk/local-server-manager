import { useQueryClient } from '@tanstack/react-query';
import {
  Cloud,
  FolderKanban,
  FolderTree,
  History,
  LayoutDashboard,
  RefreshCw,
  ScrollText,
  Server,
  Settings,
} from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import type { ConnectionStatus } from '../lib/socket';
import { useProjectsQuery } from '../lib/hooks';
import { useConnectionStatus } from '../providers/engine-provider';
import { Badge, Button, type Tone } from './ui';

const CONNECTION: Record<ConnectionStatus, { tone: Tone; label: string }> = {
  idle: { tone: 'zinc', label: 'Inativo' },
  connecting: { tone: 'amber', label: 'Conectando' },
  open: { tone: 'emerald', label: 'Conectado' },
  closed: { tone: 'red', label: 'Desconectado' },
};

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/projects', label: 'Projetos', icon: FolderKanban, end: false },
  { to: '/groups', label: 'Grupos', icon: FolderTree, end: false },
  { to: '/tunnels', label: 'Túneis', icon: Cloud, end: false },
  { to: '/logs', label: 'Logs', icon: ScrollText, end: false },
  { to: '/events', label: 'Eventos', icon: History, end: false },
  { to: '/settings', label: 'Configurações', icon: Settings, end: false },
];

export function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const meta = CONNECTION[status];
  return (
    <Badge tone={meta.tone} title={`WebSocket: ${status}`}>
      {meta.label}
    </Badge>
  );
}

function navClass(isActive: boolean): string {
  return [
    'flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors',
    isActive
      ? 'bg-zinc-800 text-zinc-100'
      : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200',
  ].join(' ');
}

export function AppLayout() {
  const connection = useConnectionStatus();
  const projectsQuery = useProjectsQuery();
  const queryClient = useQueryClient();

  const projects = projectsQuery.data ?? [];
  const running = projects.filter((project) => project.runtime.status === 'RUNNING').length;

  return (
    <div className="flex min-h-screen bg-zinc-950">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40 p-3 md:flex">
        <div className="mb-6 px-2 pt-2">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
            <Server className="h-4 w-4 text-emerald-400" />
            Local Server Manager
          </div>
          <p className="mt-1 text-[11px] uppercase tracking-wide text-zinc-500">Engine local</p>
        </div>

        <nav className="space-y-1" aria-label="Navegação principal">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => navClass(isActive)}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-zinc-500">Conexão</span>
            <ConnectionBadge status={connection} />
          </div>
          <p className="text-zinc-500">
            <span className="text-zinc-200">{running}</span> executando ·{' '}
            <span className="text-zinc-200">{projects.length}</span> cadastrados
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-zinc-800 px-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-zinc-200 md:hidden">
            <Server className="h-4 w-4 text-emerald-400" />
            Local Server Manager
          </div>
          <div className="hidden text-xs text-zinc-500 md:block">
            Controle de projetos Node.js — Engine independente
          </div>
          <div className="flex items-center gap-2">
            <ConnectionBadge status={connection} />
            <Button
              size="sm"
              onClick={() => {
                void queryClient.invalidateQueries();
              }}
              title="Recarregar dados"
              aria-label="Recarregar dados"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
        </header>

        <nav
          className="flex gap-1 overflow-x-auto border-b border-zinc-800 px-2 py-1.5 md:hidden"
          aria-label="Navegação principal"
        >
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `${navClass(isActive)} shrink-0 px-2.5 py-1.5 text-xs`}
            >
              <item.icon className="h-3.5 w-3.5" />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <main className="min-w-0 flex-1 p-4 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
