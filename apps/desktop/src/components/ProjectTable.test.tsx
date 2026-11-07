// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import type { ProjectStatus, ProjectSummary, RuntimeSnapshot } from '@lsm/contracts';
import type { ComponentProps } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeProjectConfig } from '../../../../tests/helpers/project';
import { ProjectTable } from './ProjectTable';

afterEach(cleanup);

function summary(
  status: ProjectStatus,
  runtimeOverrides: Partial<RuntimeSnapshot> = {},
): ProjectSummary {
  const config = makeProjectConfig({
    name: 'API Teste',
    workingDirectory: 'C:\\dev\\api',
    port: 3000,
  });
  return {
    config,
    runtime: {
      projectId: config.id,
      status,
      desiredState: status === 'RUNNING' ? 'RUNNING' : 'STOPPED',
      health: 'UNKNOWN',
      instanceId: 'i1',
      pid: 1234,
      startedAt: '2026-01-01T00:00:00.000Z',
      restartAttempt: 0,
      lastExit: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...runtimeOverrides,
    },
  };
}

function renderTable(props: Partial<ComponentProps<typeof ProjectTable>> = {}) {
  const callbacks = {
    onStart: vi.fn(),
    onStop: vi.fn(),
    onRestart: vi.fn(),
    onDelete: vi.fn(),
  };
  const project = summary('RUNNING');
  render(
    <MemoryRouter>
      <ProjectTable projects={[project]} {...callbacks} {...props} />
    </MemoryRouter>,
  );
  return { callbacks, project };
}

describe('ProjectTable', () => {
  it('mostra nome, estado, PID e porta', () => {
    renderTable();

    expect(screen.getByRole('link', { name: /API Teste/ })).toBeInTheDocument();
    expect(screen.getByText('Executando')).toBeInTheDocument();
    expect(screen.getByText('1234')).toBeInTheDocument();
    expect(screen.getByText('3000')).toBeInTheDocument();
  });

  it('desabilita iniciar e remover para projeto em execução', () => {
    renderTable();

    expect(screen.getByRole('button', { name: 'Iniciar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Parar' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Remover' })).toBeDisabled();
  });

  it('desabilita parar para projeto parado', () => {
    renderTable({ projects: [summary('STOPPED', { pid: null, startedAt: null })] });

    expect(screen.getByRole('button', { name: 'Iniciar' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Parar' })).toBeDisabled();
  });

  it('dispara ações com o id correto', async () => {
    const user = userEvent.setup();
    const { callbacks, project } = renderTable();

    await user.click(screen.getByRole('button', { name: 'Parar' }));
    await user.click(screen.getByRole('button', { name: 'Reiniciar' }));

    expect(callbacks.onStop).toHaveBeenCalledWith(project.config.id);
    expect(callbacks.onRestart).toHaveBeenCalledWith(project.config.id);
  });

  it('permite selecionar projeto', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    renderTable({ selected: new Set<string>(), onToggle, onToggleAll: vi.fn() });

    await user.click(screen.getByRole('checkbox', { name: /Selecionar API Teste/ }));
    expect(onToggle).toHaveBeenCalled();
  });
});
