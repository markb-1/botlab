import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { scriptApi } from '../lib/electronApi';
import type { Script, ConfigSchema } from '../types';

export function useScripts() {
  const queryClient = useQueryClient();

  const { data: scripts = [], isLoading, error } = useQuery({
    queryKey: ['scripts'],
    queryFn: async () => {
      return (await scriptApi.list()) as Script[];
    },
  });

  const createScriptMutation = useMutation({
    mutationFn: async (data: { name: string; description?: string; source: string; configSchema?: Record<string, unknown> }) => {
      return (await scriptApi.create(data)) as Script;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scripts'] });
    },
  });

  const updateScriptMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: { name?: string; description?: string; source?: string; configSchema?: Record<string, unknown> } }) => {
      return (await scriptApi.update(id, data)) as Script;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scripts'] });
    },
  });

  const deleteScriptMutation = useMutation({
    mutationFn: async (id: string) => {
      await scriptApi.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scripts'] });
    },
  });

  const forkScriptMutation = useMutation({
    mutationFn: async ({ id, newName }: { id: string; newName?: string }) => {
      return (await scriptApi.fork(id, newName)) as Script;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scripts'] });
    },
  });

  const exportScriptMutation = useMutation({
    mutationFn: async (id: string) => {
      return await scriptApi.export(id);
    },
  });

  const importScriptMutation = useMutation({
    mutationFn: async () => {
      return await scriptApi.import();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scripts'] });
    },
  });

  const compileScriptMutation = useMutation({
    mutationFn: async (source: string) => {
      return await scriptApi.compile(source);
    },
  });

  return {
    scripts,
    isLoading,
    error,
    createScript: createScriptMutation.mutateAsync,
    updateScript: updateScriptMutation.mutateAsync,
    deleteScript: deleteScriptMutation.mutateAsync,
    forkScript: forkScriptMutation.mutateAsync,
    exportScript: exportScriptMutation.mutateAsync,
    importScripts: importScriptMutation.mutateAsync,
    compileScript: compileScriptMutation.mutateAsync,
    isCreating: createScriptMutation.isPending,
    isForking: forkScriptMutation.isPending,
    isExporting: exportScriptMutation.isPending,
    isImporting: importScriptMutation.isPending,
    isCompiling: compileScriptMutation.isPending,
  };
}

export function useScript(id: string) {
  const { data: script, isLoading, error } = useQuery({
    queryKey: ['script', id],
    queryFn: async () => {
      return (await scriptApi.get(id)) as Script;
    },
    enabled: !!id,
  });

  return { script, isLoading, error };
}

export function useScriptSchema(id: string) {
  const { data: schema, isLoading, error } = useQuery({
    queryKey: ['scriptSchema', id],
    queryFn: async () => {
      return (await scriptApi.getSchema(id)) as ConfigSchema;
    },
    enabled: !!id,
  });

  return { schema, isLoading, error };
}
