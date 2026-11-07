import type { AnyDomainEvent, ProjectSummary, RuntimeSnapshot } from '@lsm/contracts';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { makeProjectConfig } from '../../../../tests/helpers/project';
import { applyEngineEvent } from './event-handler';
import { queryKeys } from './queries';

function buildSummary(status: RuntimeSnapshot['status'] = 'STOPPED'): ProjectSummary {
  const config = makeProjectConfig({ name: 'API' });
  return {
    config,
    runtime: {
      projectId: config.id,
      status,
      desiredState: 'STOPPED',
      health: 'UNKNOWN',
      instanceId: null,
      pid: null,
      startedAt: null,
      restartAttempt: 0,
      lastExit: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  };
}

function stateEvent(snapshot: RuntimeSnapshot): AnyDomainEvent {
  return {
    eventId: 'e1',
    protocolVersion: 1,
    type: 'project.state.changed',
    timestamp: '2026-01-01T00:00:00.000Z',
    projectId: snapshot.projectId,
    payload: { snapshot, previousStatus: 'STOPPED' },
  };
}

describe('applyEngineEvent', () => {
  it('atualiza o runtime no cache de projetos', () => {
    const queryClient = new QueryClient();
    const summary = buildSummary('STOPPED');
    queryClient.setQueryData(queryKeys.projects, [summary]);
    const appendLog = vi.fn();

    const running: RuntimeSnapshot = {
      ...summary.runtime,
      status: 'RUNNING',
      pid: 4321,
      instanceId: 'i1',
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    applyEngineEvent(stateEvent(running), { queryClient, appendLog });

    const updated = queryClient.getQueryData<ProjectSummary[]>(queryKeys.projects);
    expect(updated?.[0]?.runtime.status).toBe('RUNNING');
    expect(updated?.[0]?.runtime.pid).toBe(4_321);
    expect(appendLog).not.toHaveBeenCalled();
  });

  it('encaminha project.log para o buffer', () => {
    const queryClient = new QueryClient();
    const appendLog = vi.fn();

    applyEngineEvent(
      {
        eventId: 'e2',
        protocolVersion: 1,
        type: 'project.log',
        timestamp: '2026-01-01T00:00:00.000Z',
        projectId: 'p1',
        payload: {
          projectId: 'p1',
          instanceId: 'i1',
          sequence: 1,
          stream: 'stdout',
          timestamp: '2026-01-01T00:00:00.000Z',
          text: 'linha',
          truncated: false,
        },
      },
      { queryClient, appendLog },
    );

    expect(appendLog).toHaveBeenCalledWith(expect.objectContaining({ text: 'linha', sequence: 1 }));
  });

  it('invalida caches quando um projeto é criado', () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');

    applyEngineEvent(
      {
        eventId: 'e3',
        protocolVersion: 1,
        type: 'project.created',
        timestamp: '2026-01-01T00:00:00.000Z',
        projectId: 'p9',
        payload: { projectId: 'p9', name: 'Novo' },
      },
      { queryClient, appendLog: vi.fn() },
    );

    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.projects });
    expect(spy).toHaveBeenCalledWith({ queryKey: queryKeys.project('p9') });
  });
});
