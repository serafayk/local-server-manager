import type { Repositories } from '@lsm/database';
import { isProcessAlive, pidMatchesStartTime } from '@lsm/platform-win';
import type { Clock, Logger } from '@lsm/shared';

export interface UnfinishedInstance {
  id: string;
  projectId: string;
  pid: number | null;
  pidStartedAt: string | null;
}

export interface LiveOrphan {
  instanceId: string;
  projectId: string;
  pid: number;
}

export interface ReconciliationReport {
  /** Instâncias sem encerramento registrado encontradas no boot. */
  detected: number;
  /** Instâncias finalizadas como CRASHED/EXIT_UNEXPECTED. */
  finalized: number;
  /** Processos vivos cuja propriedade foi comprovada pelo StartTime. */
  liveOrphans: LiveOrphan[];
  /** Processos vivos cujo PID pode ter sido reutilizado (não comprovados). */
  unverifiedLivePids: number[];
  /** Projetos que não devem iniciar automaticamente neste boot. */
  blockedProjectIds: string[];
}

export interface ReconcileDependencies {
  repositories: Repositories;
  clock: Clock;
  logger: Logger;
}

/**
 * Reconciliação de estado após queda do Engine (docs/04 §8, ADR-012).
 *
 * Regras:
 * - nunca adota processo que o Engine não pode supervisionar;
 * - nunca mata por nome, porta ou PID não comprovado;
 * - finaliza o registro da instância para o estado deixar de mentir;
 * - bloqueia startOnBoot quando existe órfão comprovadamente nosso,
 *   evitando duas instâncias do mesmo projeto na mesma máquina.
 */
export async function reconcileInstances(
  deps: ReconcileDependencies,
): Promise<ReconciliationReport> {
  const unfinished = deps.repositories.instances.listUnfinished();
  const report: ReconciliationReport = {
    detected: unfinished.length,
    finalized: 0,
    liveOrphans: [],
    unverifiedLivePids: [],
    blockedProjectIds: [],
  };
  const blocked = new Set<string>();

  for (const instance of unfinished) {
    const pid = instance.pid;
    let alive = false;
    let ownershipVerified = false;

    if (pid !== null) {
      alive = isProcessAlive(pid);
      if (alive && instance.pidStartedAt) {
        ownershipVerified = await pidMatchesStartTime(pid, instance.pidStartedAt);
      }
    }

    const endedAt = deps.clock.nowIso();
    deps.repositories.instances.finish({
      id: instance.id,
      endedAt,
      exitCode: null,
      exitSignal: null,
      terminationReason: 'EXIT_UNEXPECTED',
      status: 'CRASHED',
    });
    report.finalized += 1;

    const action = alive
      ? ownershipVerified
        ? 'orphan-confirmed'
        : 'pid-alive-unverified'
      : 'process-gone';

    deps.repositories.events.append({
      projectId: instance.projectId,
      instanceId: instance.id,
      level: action === 'process-gone' ? 'info' : 'warn',
      eventType: 'engine.reconciliation.detected',
      message:
        action === 'orphan-confirmed'
          ? `processo órfão confirmado (pid ${pid}); início automático do projeto será bloqueado`
          : action === 'pid-alive-unverified'
            ? `PID ${pid} está vivo mas a propriedade não pôde ser comprovada (possível reuso)`
            : 'instância sem encerramento registrado; processo não está mais ativo',
      metadata: { pid, alive, ownershipVerified, action },
      createdAt: endedAt,
    });

    if (action === 'orphan-confirmed' && pid !== null) {
      report.liveOrphans.push({
        instanceId: instance.id,
        projectId: instance.projectId,
        pid,
      });
      blocked.add(instance.projectId);
    } else if (action === 'pid-alive-unverified' && pid !== null) {
      report.unverifiedLivePids.push(pid);
    }
  }

  report.blockedProjectIds = [...blocked];

  if (report.detected > 0) {
    deps.logger.warn('Reconciliação de instâncias concluída', {
      detected: report.detected,
      finalized: report.finalized,
      liveOrphans: report.liveOrphans.length,
      unverifiedLivePids: report.unverifiedLivePids.length,
      blockedProjects: report.blockedProjectIds.length,
    });
  }

  return report;
}
