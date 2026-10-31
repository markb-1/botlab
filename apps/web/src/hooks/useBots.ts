import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { botApi } from '../lib/api';
import type { Bot, BotTrade, BotPosition, BotStats, CopyLeader, DashboardBotStats } from '../types';

/** Bot list + mutations. `{ list: false }`: mutations only (no list polling, e.g. on Bot detail). */
export function useBots(opts: { list?: boolean } = {}) {
  const queryClient = useQueryClient();

  const { data: bots = [], isLoading, error } = useQuery({
    queryKey: ['bots'],
    queryFn: async () => {
      return (await botApi.list()) as Bot[];
    },
    enabled: opts.list !== false,
    refetchInterval: 5000,
  });

  const createBotMutation = useMutation({
    mutationFn: async (botData: { name: string; scriptId: string; walletId?: string; config?: Record<string, unknown>; mode?: 'live' | 'paper' }) => {
      return (await botApi.create(botData)) as Bot;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
    },
  });

  const updateBotMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<Bot> }) => {
      return (await botApi.update(id, data)) as Bot;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
    },
  });

  const deleteBotMutation = useMutation({
    mutationFn: async (id: string) => {
      await botApi.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
    },
  });

  const startBotMutation = useMutation({
    mutationFn: async (id: string) => {
      await botApi.start(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
    },
  });

  const stopBotMutation = useMutation({
    mutationFn: async (id: string) => {
      await botApi.stop(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
    },
  });

  const restartBotMutation = useMutation({
    mutationFn: async (id: string) => {
      await botApi.restart(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bots'] });
    },
  });

  return {
    bots,
    isLoading,
    error,
    createBot: createBotMutation.mutateAsync,
    updateBot: updateBotMutation.mutateAsync,
    deleteBot: deleteBotMutation.mutateAsync,
    startBot: startBotMutation.mutateAsync,
    stopBot: stopBotMutation.mutateAsync,
    restartBot: restartBotMutation.mutateAsync,
    isCreating: createBotMutation.isPending,
    isStarting: startBotMutation.isPending,
    isStopping: stopBotMutation.isPending,
  };
}

export function useBot(id: string) {
  const { data: bot, isLoading, error } = useQuery({
    queryKey: ['bot', id],
    queryFn: async () => {
      return (await botApi.get(id)) as Bot;
    },
    enabled: !!id,
    refetchInterval: 5000,
  });

  return { bot, isLoading, error };
}

export function useBotTrades(botId: string, hours: number = 24) {
  const { data: trades = [], isLoading, error, refetch } = useQuery({
    queryKey: ['botTrades', botId, hours],
    queryFn: async () => {
      return (await botApi.getTrades(botId, hours)) as BotTrade[];
    },
    enabled: !!botId,
    refetchInterval: 30000,
  });

  return {
    trades,
    count: trades.length,
    isLoading,
    error,
    refetch,
  };
}

export function useBotPositions(botId: string) {
  const { data: positions = [], isLoading, error, refetch } = useQuery({
    queryKey: ['bot-positions', botId],
    queryFn: async () => {
      return (await botApi.getPositions(botId)) as BotPosition[];
    },
    enabled: !!botId,
    refetchInterval: 30000,
  });

  return { positions, isLoading, error, refetch };
}

export function useBotStats(botId: string) {
  const { data: stats, isLoading, error, refetch } = useQuery({
    queryKey: ['bot-stats', botId],
    queryFn: async () => {
      return (await botApi.getStats(botId)) as BotStats;
    },
    enabled: !!botId,
    refetchInterval: 30000,
  });

  return { stats, isLoading, error, refetch };
}

/** Leaders of a copy-trading bot with their scores (5c); `enabled` only for copy bots */
export function useCopyLeaders(botId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['copy-leaders', botId],
    queryFn: async () => ((await botApi.getCopyLeaders(botId)) as { leaders: CopyLeader[] }).leaders,
    enabled: !!botId && enabled,
    refetchInterval: 60000,
  });
  const reactivate = useMutation({
    mutationFn: async (address: string) => {
      await botApi.reactivateCopyLeader(botId, address);
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['copy-leaders', botId] }),
  });
  return { leaders: query.data, isLoading: query.isLoading, error: query.error, reactivate: reactivate.mutateAsync, isReactivating: reactivate.isPending };
}

export function useDashboardStats() {
  const { data: stats = [], isLoading, error, refetch } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: async () => {
      return (await botApi.getDashboardStats()) as DashboardBotStats[];
    },
    refetchInterval: 30000,
  });

  // Build a map for easy lookup by botId
  const statsMap = new Map<string, DashboardBotStats>();
  for (const s of stats) {
    statsMap.set(s.botId, s);
  }

  return { stats, statsMap, isLoading, error, refetch };
}

export function useAllTrades(hours: number = 24) {
  const { data: trades = [], isLoading, error, refetch } = useQuery({
    queryKey: ['allTrades', hours],
    queryFn: async () => {
      return (await botApi.getAllTrades(hours)) as BotTrade[];
    },
    refetchInterval: 30000,
  });

  return {
    trades,
    count: trades.length,
    isLoading,
    error,
    refetch,
  };
}
