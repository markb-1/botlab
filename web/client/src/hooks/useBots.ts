import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { botApi } from '../lib/electronApi';
import type { Bot, BotTrade, BotPosition, BotStats, DashboardBotStats } from '../types';

export function useBots() {
  const queryClient = useQueryClient();

  const { data: bots = [], isLoading, error } = useQuery({
    queryKey: ['bots'],
    queryFn: async () => {
      return (await botApi.list()) as Bot[];
    },
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
