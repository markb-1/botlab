import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../lib/api';
import type { Settings } from '../types';

export function useSettings() {
  const queryClient = useQueryClient();

  const { data: settings, isLoading, error } = useQuery({
    queryKey: ['settings'],
    queryFn: async () => {
      return (await settingsApi.get()) as Settings;
    },
  });

  const updateSettingsMutation = useMutation({
    mutationFn: async (data: Partial<Settings>) => {
      return (await settingsApi.update(data)) as Settings;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const testRpcMutation = useMutation({
    mutationFn: async (_rpcUrl: string) => {
      return await settingsApi.testRpc();
    },
  });

  const testClobMutation = useMutation({
    mutationFn: async (_clobHttpUrl: string) => {
      return await settingsApi.testClob();
    },
  });

  const saveBinanceMutation = useMutation({
    mutationFn: async (data: { apiKey: string; apiSecret: string }) => {
      return await settingsApi.saveBinance(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const clearBinanceMutation = useMutation({
    mutationFn: async () => {
      return await settingsApi.clearBinance();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const testBinanceMutation = useMutation({
    mutationFn: async (data?: { apiKey: string; apiSecret: string }) => {
      return await settingsApi.testBinance(data);
    },
  });

  return {
    settings,
    isLoading,
    error,
    updateSettings: updateSettingsMutation.mutateAsync,
    testRpc: testRpcMutation.mutateAsync,
    testClob: testClobMutation.mutateAsync,
    saveBinance: saveBinanceMutation.mutateAsync,
    clearBinance: clearBinanceMutation.mutateAsync,
    testBinance: testBinanceMutation.mutateAsync,
    isUpdating: updateSettingsMutation.isPending,
    isTestingRpc: testRpcMutation.isPending,
    isTestingClob: testClobMutation.isPending,
    isSavingBinance: saveBinanceMutation.isPending,
    isTestingBinance: testBinanceMutation.isPending,
  };
}
