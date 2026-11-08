import type { DatabaseSync } from 'node:sqlite';
import type { ProjectGroup } from '@lsm/contracts';

interface GroupRow {
  id: string;
  name: string;
  sort_order: number;
  created_at: string;
}

function mapGroup(row: GroupRow): ProjectGroup {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
  };
}

export class SqliteGroupRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(group: ProjectGroup): void {
    this.db
      .prepare(
        `INSERT INTO project_groups (id, name, sort_order, created_at)
         VALUES ($id, $name, $sortOrder, $createdAt)`,
      )
      .run({
        id: group.id,
        name: group.name,
        sortOrder: group.sortOrder,
        createdAt: group.createdAt,
      });
  }

  update(id: string, patch: { name?: string; sortOrder?: number }): boolean {
    const current = this.findById(id);
    if (!current) {
      return false;
    }
    const result = this.db
      .prepare('UPDATE project_groups SET name = $name, sort_order = $sortOrder WHERE id = $id')
      .run({
        id,
        name: patch.name ?? current.name,
        sortOrder: patch.sortOrder ?? current.sortOrder,
      });
    return result.changes > 0;
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM project_groups WHERE id = ?').run(id);
    return result.changes > 0;
  }

  findById(id: string): ProjectGroup | null {
    const row = this.db.prepare('SELECT * FROM project_groups WHERE id = ?').get(id) as unknown as
      GroupRow | undefined;
    return row ? mapGroup(row) : null;
  }

  findByName(name: string): ProjectGroup | null {
    const row = this.db
      .prepare('SELECT * FROM project_groups WHERE name = ? COLLATE NOCASE')
      .get(name) as unknown as GroupRow | undefined;
    return row ? mapGroup(row) : null;
  }

  list(): ProjectGroup[] {
    const rows = this.db
      .prepare('SELECT * FROM project_groups ORDER BY sort_order ASC, name COLLATE NOCASE ASC')
      .all() as unknown as GroupRow[];
    return rows.map(mapGroup);
  }

  countProjects(groupId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS total FROM projects WHERE group_id = ?')
      .get(groupId) as unknown as { total: number };
    return row.total;
  }
}
