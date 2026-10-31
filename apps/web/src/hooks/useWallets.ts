import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { walletApi } from '../lib/api';
import type { Wallet, WalletBalance } from '../types';

export function useWallets() {
  const queryClient = useQueryClient();

  const { data: wallets = [], isLoading, error } = useQuery({
    queryKey: ['wallets'],
    queryFn: async () => {
      return (await walletApi.list()) as Wallet[];
    },
  });

  const createWalletMutation = useMutation({
    mutationFn: async (walletData: { name: string; address: string; proxyAddress?: string; privateKey: string }) => {
      return (await walletApi.create(walletData)) as Wallet;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
    },
  });

  const updateWalletMutation = useMutation({
    mutationFn: async ({ id, name, proxyAddress }: { id: string; name?: string; proxyAddress?: string }) => {
      return (await walletApi.update(id, { name, proxyAddress })) as Wallet;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
    },
  });

  const deleteWalletMutation = useMutation({
    mutationFn: async (id: string) => {
      await walletApi.delete(id);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['wallets'] });
    },
  });

  return {
    wallets,
    isLoading,
    error,
    createWallet: createWalletMutation.mutateAsync,
    updateWallet: updateWalletMutation.mutateAsync,
    deleteWallet: deleteWalletMutation.mutateAsync,
    isCreating: createWalletMutation.isPending,
  };
}

export function useWalletBalance(id: string) {
  const { data: balance, isLoading, error, refetch } = useQuery({
    queryKey: ['walletBalance', id],
    queryFn: async () => {
      return (await walletApi.getBalance(id)) as WalletBalance;
    },
    enabled: !!id,
  });

  return { balance, isLoading, error, refetch };
}
