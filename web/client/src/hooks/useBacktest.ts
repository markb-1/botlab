import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { backtestApi } from '../lib/electronApi';
import type { BacktestRun, BacktestRunResult, BacktestEngineResult } from '../types/backtest';

/**
 * Fetch list of backtest runs for a script.
 */
export function useBacktestRuns(scriptId?: string) {
  const { data: runs = [], isLoading, error, refetch } = useQuery({
    queryKey: ['backtest-runs', scriptId],
    queryFn: async () => {
      return (await backtestApi.list(scriptId)) as BacktestRun[];
    },
    enabled: !!scriptId,
  });

  return { runs, isLoading, error, refetch };
}

/**
 * Fetch a single backtest run with its trades.
 */
export function useBacktestResult(runId?: string) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['backtest-result', runId],
    queryFn: async () => {
      return (await backtestApi.get(runId!)) as BacktestRunResult;
    },
    enabled: !!runId,
  });

  return { result: data, isLoading, error };
}

/**
 * Mutation to run a backtest.
 */
export function useRunBacktest() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (data: {
      scriptId: string;
      symbol: string;
      interval?: string;
      startTime: number;
      endTime: number;
      initialBalance: number;
      config?: Record<string, unknown>;
    }) => {
      return (await backtestApi.run(data)) as BacktestEngineResult;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['backtest-runs', variables.scriptId] });
    },
  });

  return {
    runBacktest: mutation.mutateAsync,
    isRunning: mutation.isPending,
    error: mutation.error,
    result: mutation.data,
    reset: mutation.reset,
  };
}

/**
 * Mutation to delete a backtest run.
 */
export function useDeleteBacktest() {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (runId: string) => {
      await backtestApi.delete(runId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['backtest-runs'] });
    },
  });

  return {
    deleteRun: mutation.mutateAsync,
    isDeleting: mutation.isPending,
  };
}
