import { useState, useCallback } from 'react';
import { aiApi } from '../lib/electronApi';

interface UseAIReturn {
  generate: (prompt: string) => Promise<string>;
  edit: (prompt: string, currentSource: string) => Promise<string>;
  isGenerating: boolean;
  isEditing: boolean;
  error: string | null;
  clearError: () => void;
}

export function useAI(): UseAIReturn {
  const [isGenerating, setIsGenerating] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generate = useCallback(async (prompt: string): Promise<string> => {
    setIsGenerating(true);
    setError(null);
    try {
      const result = await aiApi.generate({ prompt }) as { code: string };
      return result.code;
    } catch (err: any) {
      const message = err.message || 'Failed to generate script';
      setError(message);
      throw err;
    } finally {
      setIsGenerating(false);
    }
  }, []);

  const edit = useCallback(async (prompt: string, currentSource: string): Promise<string> => {
    setIsEditing(true);
    setError(null);
    try {
      const result = await aiApi.edit({ prompt, currentSource }) as { code: string };
      return result.code;
    } catch (err: any) {
      const message = err.message || 'Failed to edit script';
      setError(message);
      throw err;
    } finally {
      setIsEditing(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { generate, edit, isGenerating, isEditing, error, clearError };
}
