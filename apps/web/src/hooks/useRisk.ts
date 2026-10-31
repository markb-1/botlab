import { useQuery, useQueryClient } from '@tanstack/react-query';
import { configApi, riskApi } from '../lib/api';
import type { ConfigGetResult, Overview, RiskState } from '../types';
import type { JsonSchema } from '../lib/schemaForm';
import type { ConfigFile } from '../lib/api';

export function useOverview() {
  return useQuery({ queryKey: ['overview'], queryFn: async () => (await riskApi.overview()) as Overview, refetchInterval: 15_000 });
}

export function useRiskState() {
  return useQuery({ queryKey: ['riskState'], queryFn: async () => (await riskApi.getState()) as RiskState, refetchInterval: 15_000 });
}

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: async () => (await configApi.get()) as ConfigGetResult });
}

/** Refresh everything a halt / clear changes */
export function useInvalidateRisk() {
  const qc = useQueryClient();
  return () => {
    for (const key of ['overview', 'riskState', 'audit', 'bots', 'bot']) qc.invalidateQueries({ queryKey: [key] });
  };
}

export function useConfigSchemas() {
  return useQuery({ queryKey: ['configSchemas'], queryFn: async () => (await configApi.schemas()) as Record<ConfigFile, JsonSchema>, staleTime: Infinity });
}
