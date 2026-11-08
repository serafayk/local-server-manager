import type { ProjectGroup } from '@lsm/contracts';
import type { Repositories } from '@lsm/database';
import type { Clock, Logger } from '@lsm/shared';
import { AppError, newId } from '@lsm/shared';
import { parseCreateGroupRequest, parseUpdateGroupRequest } from '@lsm/validation';

export interface GroupServiceDeps {
  repositories: Repositories;
  clock: Clock;
  logger: Logger;
}

/** Grupos são organização visual; não criam dependência entre projetos. */
export class GroupService {
  constructor(private readonly deps: GroupServiceDeps) {}

  list(): ProjectGroup[] {
    return this.deps.repositories.groups.list();
  }

  create(input: unknown): ProjectGroup {
    const data = parseCreateGroupRequest(input);
    if (this.deps.repositories.groups.findByName(data.name)) {
      throw new AppError('GROUP_NAME_IN_USE', `Já existe um grupo com o nome "${data.name}"`);
    }
    const group: ProjectGroup = {
      id: newId(),
      name: data.name,
      sortOrder: data.sortOrder,
      createdAt: this.deps.clock.nowIso(),
    };
    this.deps.repositories.groups.create(group);
    return group;
  }

  update(id: string, input: unknown): ProjectGroup {
    const data = parseUpdateGroupRequest(input);
    const existing = this.deps.repositories.groups.findById(id);
    if (!existing) {
      throw new AppError('GROUP_NOT_FOUND', `Grupo não encontrado: ${id}`);
    }
    if (data.name !== undefined && data.name.toLowerCase() !== existing.name.toLowerCase()) {
      const other = this.deps.repositories.groups.findByName(data.name);
      if (other && other.id !== id) {
        throw new AppError('GROUP_NAME_IN_USE', `Já existe um grupo com o nome "${data.name}"`);
      }
    }
    this.deps.repositories.groups.update(id, data);
    const updated = this.deps.repositories.groups.findById(id);
    if (!updated) {
      throw new AppError('GROUP_NOT_FOUND', `Grupo não encontrado: ${id}`);
    }
    return updated;
  }

  delete(id: string): { id: string; name: string } {
    const existing = this.deps.repositories.groups.findById(id);
    if (!existing) {
      throw new AppError('GROUP_NOT_FOUND', `Grupo não encontrado: ${id}`);
    }
    this.deps.repositories.groups.delete(id);
    return { id: existing.id, name: existing.name };
  }

  /** Usado na importação de configurações; cria o grupo se ainda não existir. */
  ensureByName(name: string): ProjectGroup {
    const existing = this.deps.repositories.groups.findByName(name);
    return existing ?? this.create({ name });
  }
}
