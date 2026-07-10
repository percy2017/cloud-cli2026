import { useEffect, useState } from 'react';
import { getStoredProvider } from '../../providers/useEnabledProviders';

const ALL_PROVIDERS: ('claude' | 'qwen' | 'codex' | 'opencode' | 'cursor' | 'gemini')[] = ['claude', 'qwen', 'codex', 'opencode', 'cursor', 'gemini'];

export function useSelectedProvider() {
  const [provider, setProvider] = useState<string>(() => {
    return getStoredProvider(ALL_PROVIDERS);
  });

  useEffect(() => {
    // Keep provider in sync when another tab changes the selected provider.
    const handleStorageChange = () => {
      const nextProvider = getStoredProvider(ALL_PROVIDERS);
      setProvider(nextProvider);
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  return provider;
}
