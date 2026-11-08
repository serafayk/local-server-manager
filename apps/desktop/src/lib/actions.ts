import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEngine } from '../providers/engine-provider';
import { queryKeys } from './queries';

export function useProjectActions() {
  const { client } = useEngine();
  const queryClient = useQueryClient();

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projects });
    void queryClient.invalidateQueries({ queryKey: ['project'] });
    void queryClient.invalidateQueries({ queryKey: ['events'] });
    void queryClient.invalidateQueries({ queryKey: ['instances'] });
  };

  const start = useMutation({
    mutationFn: (id: string) => client.startProject(id),
    onSettled: invalidate,
  });
  const stop = useMutation({
    mutationFn: (id: string) => client.stopProject(id),
    onSettled: invalidate,
  });
  const restart = useMutation({
    mutationFn: (id: string) => client.restartProject(id),
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => client.deleteProject(id),
    onSettled: invalidate,
  });
  const removeForced = useMutation({
    mutationFn: (id: string) => client.deleteProject(id, { force: true }),
    onSettled: invalidate,
  });
  const startMany = useMutation({
    mutationFn: (ids: string[]) => client.bulkStart(ids),
    onSettled: invalidate,
  });
  const stopMany = useMutation({
    mutationFn: (ids: string[]) => client.bulkStop(ids),
    onSettled: invalidate,
  });

  return { start, stop, restart, remove, removeForced, startMany, stopMany };
}
