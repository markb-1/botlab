import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture registered IPC handlers
const handlers = new Map<string, (...args: any[]) => any>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      handlers.set(channel, handler);
    }),
  },
}));

import { registerBotHandlers } from '../../electron/ipc/handlers/botHandlers';

function makeBotRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bot-1',
    name: 'Test Bot',
    script_id: 'script-1',
    wallet_id: 'wallet-1',
    config: '{}',
    status: 'stopped',
    enabled: 1,
    mode: 'live',
    last_started_at: null,
    last_stopped_at: null,
    last_heartbeat: null,
    error_logs: '[]',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeTradeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'trade-1',
    bot_id: 'bot-1',
    bot_name: 'Test Bot',
    script_name: 'test-script',
    trader_address: '0xtrader',
    market: 'Test Market',
    outcome: 'Yes',
    side: 'BUY',
    trader_bet_size: 100,
    bot_bet_size: 10,
    executed_at: '2025-01-01T00:00:00Z',
    metadata: null,
    ...overrides,
  };
}

describe('botHandlers', () => {
  let mockBotRepo: Record<string, ReturnType<typeof vi.fn>>;
  let mockWalletRepo: Record<string, ReturnType<typeof vi.fn>>;
  let mockScriptRepo: Record<string, ReturnType<typeof vi.fn>>;
  let mockTradeRepo: Record<string, ReturnType<typeof vi.fn>>;
  let mockBotManager: Record<string, ReturnType<typeof vi.fn>>;
  let mockWalletManager: Record<string, ReturnType<typeof vi.fn>>;

  async function invoke(channel: string, ...args: unknown[]) {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({}, ...args); // first arg is IPC event
  }

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();

    mockBotRepo = {
      findAll: vi.fn().mockReturnValue([]),
      findById: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    mockWalletRepo = {
      findById: vi.fn().mockReturnValue({ address: '0xaddr', name: 'W1', is_paper: 0 }),
    };

    mockScriptRepo = {
      findById: vi.fn().mockReturnValue({ name: 'Test Script' }),
    };

    mockTradeRepo = {
      findByBotId: vi.fn().mockReturnValue([]),
      findRecent: vi.fn().mockReturnValue([]),
    };

    mockBotManager = {
      startBot: vi.fn().mockResolvedValue(undefined),
      stopBot: vi.fn().mockResolvedValue(undefined),
      restartBot: vi.fn().mockResolvedValue(undefined),
    };

    mockWalletManager = {
      createPaperWallet: vi.fn().mockResolvedValue({ id: 'paper-w-1', name: 'Paper - Test' }),
      deletePaperWallet: vi.fn().mockResolvedValue(undefined),
    };

    registerBotHandlers(
      mockBotRepo as any,
      mockWalletRepo as any,
      mockScriptRepo as any,
      mockTradeRepo as any,
      mockBotManager as any,
      mockWalletManager as any
    );
  });

  describe('bots:list', () => {
    it('should return list of bots', async () => {
      mockBotRepo.findAll.mockReturnValue([makeBotRow()]);
      const result = await invoke('bots:list');
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(result.data[0].name).toBe('Test Bot');
    });

    it('should pass filter to findAll', async () => {
      mockBotRepo.findAll.mockReturnValue([]);
      await invoke('bots:list', { scriptId: 's1', status: 'running' });
      expect(mockBotRepo.findAll).toHaveBeenCalledWith({ scriptId: 's1', status: 'running' });
    });

    it('should return error on exception', async () => {
      mockBotRepo.findAll.mockImplementation(() => { throw new Error('DB error'); });
      const result = await invoke('bots:list');
      expect(result.success).toBe(false);
      expect(result.error).toBe('DB error');
    });
  });

  describe('bots:get', () => {
    it('should return single bot', async () => {
      mockBotRepo.findById.mockReturnValue(makeBotRow());
      const result = await invoke('bots:get', 'bot-1');
      expect(result.success).toBe(true);
      expect(result.data.id).toBe('bot-1');
    });

    it('should return error when not found', async () => {
      mockBotRepo.findById.mockReturnValue(undefined);
      const result = await invoke('bots:get', 'bad-id');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Bot not found');
    });
  });

  describe('bots:create', () => {
    it('should create a live bot with provided walletId', async () => {
      mockBotRepo.create.mockReturnValue(makeBotRow());
      const result = await invoke('bots:create', {
        name: 'Bot1', scriptId: 's1', walletId: 'w1', mode: 'live',
      });
      expect(result.success).toBe(true);
      expect(mockWalletManager.createPaperWallet).not.toHaveBeenCalled();
      expect(mockBotRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ walletId: 'w1' })
      );
    });

    it('should auto-generate paper wallet when mode is paper and no walletId', async () => {
      mockBotRepo.create.mockReturnValue(makeBotRow({ mode: 'paper', wallet_id: 'paper-w-1' }));
      const result = await invoke('bots:create', {
        name: 'PaperBot', scriptId: 's1', mode: 'paper',
      });
      expect(result.success).toBe(true);
      expect(mockWalletManager.createPaperWallet).toHaveBeenCalledWith('PaperBot');
      expect(mockBotRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ walletId: 'paper-w-1' })
      );
    });

    it('should use provided walletId for paper bot when specified', async () => {
      mockBotRepo.create.mockReturnValue(makeBotRow({ mode: 'paper' }));
      await invoke('bots:create', {
        name: 'Bot1', scriptId: 's1', walletId: 'existing-w', mode: 'paper',
      });
      expect(mockWalletManager.createPaperWallet).not.toHaveBeenCalled();
      expect(mockBotRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ walletId: 'existing-w' })
      );
    });

    it('should return error when no walletId for live bot', async () => {
      const result = await invoke('bots:create', {
        name: 'Bot1', scriptId: 's1', mode: 'live',
      });
      expect(result.success).toBe(false);
      expect(result.error).toBe('Wallet is required for live bots');
    });
  });

  describe('bots:delete', () => {
    it('should delete bot and clean up paper wallet', async () => {
      mockBotRepo.findById.mockReturnValue(makeBotRow({ wallet_id: 'pw1' }));
      mockWalletRepo.findById.mockReturnValue({ is_paper: 1 });
      mockBotRepo.delete.mockReturnValue(true);

      const result = await invoke('bots:delete', 'bot-1');
      expect(result.success).toBe(true);
      expect(mockWalletManager.deletePaperWallet).toHaveBeenCalledWith('pw1');
    });

    it('should delete bot without cleaning up non-paper wallet', async () => {
      mockBotRepo.findById.mockReturnValue(makeBotRow({ wallet_id: 'w1' }));
      mockWalletRepo.findById.mockReturnValue({ is_paper: 0 });
      mockBotRepo.delete.mockReturnValue(true);

      const result = await invoke('bots:delete', 'bot-1');
      expect(result.success).toBe(true);
      expect(mockWalletManager.deletePaperWallet).not.toHaveBeenCalled();
    });

    it('should return error when delete fails', async () => {
      mockBotRepo.findById.mockReturnValue(makeBotRow());
      mockBotRepo.delete.mockReturnValue(false);

      const result = await invoke('bots:delete', 'bot-1');
      expect(result.success).toBe(false);
      expect(result.error).toContain('cannot be deleted');
    });
  });

  describe('bots:start', () => {
    it('should delegate to botManager.startBot', async () => {
      const result = await invoke('bots:start', 'bot-1');
      expect(result.success).toBe(true);
      expect(mockBotManager.startBot).toHaveBeenCalledWith('bot-1');
    });

    it('should return error on failure', async () => {
      mockBotManager.startBot.mockRejectedValue(new Error('Start failed'));
      const result = await invoke('bots:start', 'bot-1');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Start failed');
    });
  });

  describe('bots:stop', () => {
    it('should delegate to botManager.stopBot', async () => {
      const result = await invoke('bots:stop', 'bot-1');
      expect(result.success).toBe(true);
      expect(mockBotManager.stopBot).toHaveBeenCalledWith('bot-1');
    });
  });

  describe('bots:restart', () => {
    it('should delegate to botManager.restartBot', async () => {
      const result = await invoke('bots:restart', 'bot-1');
      expect(result.success).toBe(true);
      expect(mockBotManager.restartBot).toHaveBeenCalledWith('bot-1');
    });
  });

  describe('bots:trades', () => {
    it('should return trades for a bot', async () => {
      mockTradeRepo.findByBotId.mockReturnValue([makeTradeRow()]);
      const result = await invoke('bots:trades', 'bot-1', 48);
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
      expect(mockTradeRepo.findByBotId).toHaveBeenCalledWith('bot-1', { hoursAgo: 48 });
    });
  });

  describe('bots:trades:all', () => {
    it('should return all recent trades', async () => {
      mockTradeRepo.findRecent.mockReturnValue([makeTradeRow()]);
      const result = await invoke('bots:trades:all');
      expect(result.success).toBe(true);
      expect(result.data).toHaveLength(1);
    });

    it('should default to 24 hours', async () => {
      mockTradeRepo.findRecent.mockReturnValue([]);
      await invoke('bots:trades:all');
      expect(mockTradeRepo.findRecent).toHaveBeenCalledWith(24);
    });
  });
});
