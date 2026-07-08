import { useCallback, useEffect, useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';

import { authenticatedFetch } from '../../../../../utils/api';
import SettingsCard from '../../SettingsCard';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import SettingsToggle from '../../SettingsToggle';
import type { SettingsMainTab } from '../../../types/types';

type MiniMaxStatus = {
  enabled: boolean;
  uvxAvailable: boolean;
  apiKeyConfigured: boolean;
  available: boolean;
  message: string;
};

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || data.details || `Request failed (${response.status})`);
  }
  return data as T;
}

type MiniMaxSettingsTabProps = {
  onNavigateToCredentials: (tab: SettingsMainTab) => void;
};

export default function MiniMaxSettingsTab({ onNavigateToCredentials }: MiniMaxSettingsTabProps) {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<MiniMaxStatus | null>(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const [isStatusLoading, setIsStatusLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadEnabled = useCallback(async () => {
    const response = await authenticatedFetch('/api/minimax/settings');
    const data = await readJson<{ data: { settings: { enabled: boolean } } }>(response);
    setEnabled(data.data.settings.enabled);
  }, []);

  const loadStatus = useCallback(async () => {
    const response = await authenticatedFetch('/api/minimax/status');
    const data = await readJson<{ data: MiniMaxStatus }>(response);
    setStatus(data.data);
  }, []);

  useEffect(() => {
    setError(null);
    setIsSettingsLoading(true);
    setIsStatusLoading(true);

    void loadEnabled()
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load MiniMax settings'))
      .finally(() => setIsSettingsLoading(false));

    void loadStatus()
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load MiniMax status'))
      .finally(() => setIsStatusLoading(false));
  }, [loadEnabled, loadStatus]);

  const updateEnabled = async (next: boolean) => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/minimax/settings', {
        method: 'PUT',
        body: JSON.stringify({ enabled: next }),
      });
      const data = await readJson<{ data: { settings: { enabled: boolean } } }>(response);
      setEnabled(data.data.settings.enabled);
      setIsStatusLoading(true);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save MiniMax settings');
    } finally {
      setIsStatusLoading(false);
      setIsSaving(false);
    }
  };

  const runtimeLabel = (ok?: boolean) => {
    if (isStatusLoading && !status) {
      return 'checking...';
    }
    return ok ? 'available' : 'missing';
  };

  const needsApiKey = status?.enabled === true && status?.apiKeyConfigured === false;
  const overall = isStatusLoading && !status
    ? 'checking...'
    : status?.available
      ? 'ready'
      : enabled
        ? 'setup required'
        : 'disabled';

  return (
    <div className="space-y-8">
      <SettingsSection
        title="MiniMax"
        description="Expose web_search and understand_image tools to all your agents via the MiniMax Token Plan API."
      >
        <SettingsCard divided>
          <SettingsRow
            label="Enable MiniMax"
            description="Registers the cloudcli-minimax MCP for supported agents. Agents can call web_search and understand_image."
          >
            {isSettingsLoading && !status ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : (
              <SettingsToggle
                checked={enabled}
                onChange={(value) => void updateEnabled(value)}
                ariaLabel="Enable MiniMax"
                disabled={isSaving}
              />
            )}
          </SettingsRow>

          <div className="space-y-4 px-4 py-4">
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <span className="rounded-md border border-border px-2 py-1">
                uvx: {runtimeLabel(status?.uvxAvailable)}
              </span>
              <span className="rounded-md border border-border px-2 py-1">
                API key: {status?.apiKeyConfigured ? 'configured' : 'missing'}
              </span>
              <span className="rounded-md border border-border px-2 py-1">Status: {overall}</span>
            </div>

            {status?.message && !status.available && (
              <p className="text-sm text-muted-foreground">{status.message}</p>
            )}

            {needsApiKey && (
              <div className="flex flex-col gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/30 dark:text-amber-200">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>Register the MiniMax API key in API &amp; tokens to finish setup.</span>
                  <button
                    type="button"
                    onClick={() => onNavigateToCredentials('api')}
                    className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent"
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    Open API &amp; tokens
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
                {error}
              </div>
            )}
          </div>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
