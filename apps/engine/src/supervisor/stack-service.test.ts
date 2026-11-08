import { describe, expect, it } from 'vitest';
import { AppError } from '@lsm/shared';
import {
  collectDependencies,
  orderByDependencies,
  type DependencyGraphNode,
} from './stack-service';

function node(
  id: string,
  dependsOn: Array<{ projectId: string; waitFor: 'started' | 'ready' }> = [],
  startupOrder = 0,
): DependencyGraphNode {
  return { id, name: id, startupOrder, dependsOn };
}

function graph(...nodes: DependencyGraphNode[]): Map<string, DependencyGraphNode> {
  return new Map(nodes.map((item) => [item.id, item]));
}

describe('orderByDependencies', () => {
  it('coloca dependências em níveis anteriores, paralelizando o mesmo nível', () => {
    const levels = orderByDependencies([
      node('web', [{ projectId: 'api', waitFor: 'ready' }]),
      node('api', [{ projectId: 'db', waitFor: 'ready' }]),
      node('worker', [{ projectId: 'db', waitFor: 'started' }]),
      node('db'),
    ]);

    expect(levels).toEqual([['db'], ['api', 'worker'], ['web']]);
  });

  it('usa startupOrder como desempate dentro do nível', () => {
    const levels = orderByDependencies([node('b', [], 20), node('a', [], 10)]);
    expect(levels).toEqual([['a', 'b']]);
  });

  it('detecta ciclo mesmo com arestas indiretas', () => {
    expect(() =>
      orderByDependencies([
        node('a', [{ projectId: 'c', waitFor: 'started' }]),
        node('b', [{ projectId: 'a', waitFor: 'started' }]),
        node('c', [{ projectId: 'b', waitFor: 'started' }]),
      ]),
    ).toThrowError(AppError);
  });

  it('ignora dependências fora do conjunto restrito (parada de grupo)', () => {
    const levels = orderByDependencies(
      [node('web', [{ projectId: 'db', waitFor: 'ready' }]), node('db'), node('externo')],
      new Set(['web']),
    );
    expect(levels).toEqual([['web']]);
  });
});

describe('collectDependencies', () => {
  it('inclui dependências transitivas e a raiz', () => {
    const all = graph(
      node('web', [{ projectId: 'api', waitFor: 'ready' }]),
      node('api', [{ projectId: 'db', waitFor: 'ready' }]),
      node('db'),
      node('outro'),
    );

    const selected = collectDependencies(['web'], all);
    expect([...selected.keys()].sort()).toEqual(['api', 'db', 'web']);
  });

  it('rejeita dependência que não existe mais', () => {
    const all = graph(node('web', [{ projectId: 'sumiu', waitFor: 'ready' }]));
    expect(() => collectDependencies(['web'], all)).toThrowError(/não existe mais/);
  });

  it('rejeita raiz desconhecida', () => {
    expect(() => collectDependencies(['fantasma'], new Map())).toThrowError(/não encontrado/i);
  });
});
