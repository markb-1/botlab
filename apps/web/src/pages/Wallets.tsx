import { useState } from 'react';
import { useWallets, useWalletBalance } from '../hooks/useWallets';
import type { Wallet } from '../types';

function WalletBalanceDisplay({ walletId }: { walletId: string }) {
  const { balance, isLoading, refetch } = useWalletBalance(walletId);

  if (isLoading) {
    return <span className="text-gray-400">Loading...</span>;
  }

  if (!balance) {
    return (
      <button
        onClick={() => refetch()}
        className="text-accent hover:text-accent-hover text-sm"
      >
        Load Balance
      </button>
    );
  }

  return (
    <div className="text-sm">
      <span className="font-medium text-white">${balance.usdc.toFixed(2)}</span>
      <span className="text-gray-400 ml-2">USDC</span>
    </div>
  );
}

export function Wallets() {
  const { wallets, isLoading, createWallet, updateWallet, deleteWallet, isCreating } = useWallets();
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Create form state
  const [newName, setNewName] = useState('');
  const [newAddress, setNewAddress] = useState('');
  const [newProxyAddress, setNewProxyAddress] = useState('');
  const [newPrivateKey, setNewPrivateKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Edit form state
  const [editName, setEditName] = useState('');
  const [editProxyAddress, setEditProxyAddress] = useState('');

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!newName.trim()) {
      setError('Name is required');
      return;
    }
    if (!newAddress.trim()) {
      setError('Address is required');
      return;
    }
    if (!newPrivateKey.trim()) {
      setError('Private key is required');
      return;
    }

    try {
      await createWallet({
        name: newName.trim(),
        address: newAddress.trim(),
        proxyAddress: newProxyAddress.trim() || undefined,
        privateKey: newPrivateKey.trim(),
      });
      setShowCreate(false);
      setNewName('');
      setNewAddress('');
      setNewProxyAddress('');
      setNewPrivateKey('');
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to create wallet');
    }
  };

  const handleStartEdit = (wallet: Wallet) => {
    setEditingId(wallet.id);
    setEditName(wallet.name);
    setEditProxyAddress(wallet.proxyAddress || '');
  };

  const handleSaveEdit = async (id: string) => {
    try {
      await updateWallet({ id, name: editName, proxyAddress: editProxyAddress || undefined });
      setEditingId(null);
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to update wallet');
    }
  };

  const handleDelete = async (wallet: Wallet) => {
    if (wallet.currentBotId) {
      alert('This wallet is currently assigned to a bot. Please stop and remove the bot first.');
      return;
    }
    if (!confirm(`Are you sure you want to delete wallet "${wallet.name}"?`)) return;

    try {
      await deleteWallet(wallet.id);
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to delete wallet');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white">Wallets</h2>
          <p className="mt-1 text-sm text-gray-400">
            Manage your trading wallets
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-lg text-white bg-accent hover:bg-accent-hover"
        >
          + Add Wallet
        </button>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
          <p className="text-sm text-red-300">{error}</p>
          <button onClick={() => setError(null)} className="text-red-400 text-sm underline mt-1">
            Dismiss
          </button>
        </div>
      )}

      {/* Create Form */}
      {showCreate && (
        <div className="bg-surface border border-[#2a2a2a] rounded-xl p-6">
          <h3 className="text-lg font-medium text-white mb-4">Add New Wallet</h3>
          <form onSubmit={handleCreate} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300">Name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="My Trading Wallet"
                className="mt-1 block w-full rounded-lg border border-[#2a2a2a] bg-surface-dark text-gray-100 placeholder-gray-500 shadow-sm focus:border-accent focus:ring-accent sm:text-sm px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300">Wallet Address (EOA)</label>
              <input
                type="text"
                value={newAddress}
                onChange={(e) => setNewAddress(e.target.value)}
                placeholder="0x... (your wallet that owns the private key)"
                className="mt-1 block w-full rounded-lg border border-[#2a2a2a] bg-surface-dark text-gray-100 placeholder-gray-500 shadow-sm focus:border-accent focus:ring-accent sm:text-sm font-mono px-3 py-2"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300">Polymarket Proxy Address (Optional)</label>
              <input
                type="text"
                value={newProxyAddress}
                onChange={(e) => setNewProxyAddress(e.target.value)}
                placeholder="0x... (your Polymarket trading wallet)"
                className="mt-1 block w-full rounded-lg border border-[#2a2a2a] bg-surface-dark text-gray-100 placeholder-gray-500 shadow-sm focus:border-accent focus:ring-accent sm:text-sm font-mono px-3 py-2"
              />
              <p className="mt-1 text-xs text-gray-500">
                Find this in Polymarket Settings → Profile. Leave empty if not using Polymarket proxy.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300">Private Key</label>
              <input
                type="password"
                value={newPrivateKey}
                onChange={(e) => setNewPrivateKey(e.target.value)}
                placeholder="Enter private key (will be encrypted)"
                className="mt-1 block w-full rounded-lg border border-[#2a2a2a] bg-surface-dark text-gray-100 placeholder-gray-500 shadow-sm focus:border-accent focus:ring-accent sm:text-sm font-mono px-3 py-2"
              />
              <p className="mt-1 text-xs text-gray-500">
                Private key will be encrypted before storing
              </p>
            </div>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowCreate(false);
                  setNewName('');
                  setNewAddress('');
                  setNewProxyAddress('');
                  setNewPrivateKey('');
                }}
                className="px-4 py-2 border border-[#333] rounded-lg text-sm font-medium text-gray-300 hover:bg-surface-light"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isCreating}
                className="px-4 py-2 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-accent hover:bg-accent-hover disabled:opacity-50"
              >
                {isCreating ? 'Adding...' : 'Add Wallet'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Wallets List */}
      <div className="bg-surface border border-[#2a2a2a] rounded-xl overflow-hidden">
        {isLoading ? (
          <div className="p-6 text-center text-gray-400">Loading wallets...</div>
        ) : wallets.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-gray-400 mb-4">No wallets added yet</p>
            <button
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-lg text-white bg-accent hover:bg-accent-hover"
            >
              Add your first wallet
            </button>
          </div>
        ) : (
          <table className="min-w-full divide-y divide-[#2a2a2a]">
            <thead className="bg-surface-dark">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Address</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Balance</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-surface divide-y divide-[#2a2a2a]">
              {wallets.map((wallet) => (
                <tr key={wallet.id} className="hover:bg-surface-light">
                  <td className="px-6 py-4 whitespace-nowrap">
                    {editingId === wallet.id ? (
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        className="block w-full rounded-lg border border-[#2a2a2a] bg-surface-dark text-gray-100 shadow-sm focus:border-accent focus:ring-accent sm:text-sm px-3 py-2"
                        autoFocus
                      />
                    ) : (
                      <span className="text-sm font-medium text-gray-100">{wallet.name}</span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <span className="text-sm text-gray-400 font-mono">
                      {wallet.address.slice(0, 6)}...{wallet.address.slice(-4)}
                    </span>
                    <button
                      onClick={() => navigator.clipboard.writeText(wallet.address)}
                      className="ml-2 text-gray-500 hover:text-gray-300"
                      title="Copy address"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </button>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <WalletBalanceDisplay walletId={wallet.id} />
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    {wallet.currentBotId ? (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400">
                        In Use
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-500/10 text-green-400">
                        Available
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-right text-sm space-x-3">
                    {editingId === wallet.id ? (
                      <>
                        <button
                          onClick={() => setEditingId(null)}
                          className="text-gray-400 hover:text-gray-300 font-medium"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleSaveEdit(wallet.id)}
                          className="text-accent hover:text-accent-hover font-medium"
                        >
                          Save
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          onClick={() => handleStartEdit(wallet)}
                          className="text-accent hover:text-accent-hover font-medium"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleDelete(wallet)}
                          disabled={!!wallet.currentBotId}
                          className="text-red-400 hover:text-red-300 font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
