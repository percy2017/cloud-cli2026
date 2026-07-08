import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link2, Loader2, RefreshCw } from 'lucide-react';

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

// Quota data returned by `GET /api/minimax/usage`. Field names match the
// `mmx quota show --output json` shape verbatim.
type ModelRemain = {
  model_name: string;
  start_time: number;
  end_time: number;
  remains_time: number;
  current_interval_total_count: number;
  current_interval_usage_count: number;
  current_interval_remaining_percent: number;
  current_interval_status: number;
  current_weekly_total_count: number;
  current_weekly_usage_count: number;
  weekly_start_time: number;
  weekly_end_time: number;
  weekly_remains_time: number;
  current_weekly_remaining_percent: number;
  current_weekly_status: number;
};

type UsageResult =
  | { available: true; source: 'mmx'; fetchedAt: number; model_remains: ModelRemain[] }
  | {
      available: false;
      source: 'unavailable';
      fetchedAt: number;
      model_remains: [];
      reason: 'missing-cli' | 'cli-error';
    };

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || data.details || `Request failed (${response.status})`);
  }
  return data as T;
}

function formatRemains(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '—';
  }
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (d > 0) {
    return `${d}d ${h}h`;
  }
  if (h > 0) {
    return `${h}h ${m}m`;
  }
  if (m > 0) {
    return `${m}m ${s}s`;
  }
  return `${s}s`;
}

function progressColor(percent: number): string {
  if (percent >= 50) {
    return 'bg-emerald-500';
  }
  if (percent >= 20) {
    return 'bg-amber-500';
  }
  return 'bg-red-500';
}

function statusLabelKey(status: number, t: (key: string) => string): string {
  if (status === 1) {
    return t('minimax.usage.statusActive');
  }
  if (status === 3) {
    return t('minimax.usage.statusIdle');
  }
  return t('minimax.usage.statusUnknown');
}

function statusPillClass(status: number): string {
  if (status === 1) {
    return 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-200';
  }
  if (status === 3) {
    return 'border-border bg-muted text-muted-foreground';
  }
  return 'border-border bg-muted text-muted-foreground';
}

type ProgressBarProps = {
  percent: number;
  ariaLabel: string;
  showLabel?: boolean;
};

function ProgressBar({ percent, ariaLabel, showLabel = true }: ProgressBarProps) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="flex items-center gap-3">
      <div
        role="progressbar"
        aria-label={ariaLabel}
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        className="relative h-2.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`h-full transition-all duration-300 ${progressColor(clamped)}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
      {showLabel && (
        <span
          className="min-w-[3rem] text-right font-mono text-xs font-semibold tabular-nums text-foreground"
          aria-hidden="true"
        >
          {clamped}%
        </span>
      )}
    </div>
  );
}

type MiniMaxSettingsTabProps = {
  onNavigateToCredentials: (tab: SettingsMainTab) => void;
};

export default function MiniMaxSettingsTab({ onNavigateToCredentials }: MiniMaxSettingsTabProps) {
  const { t } = useTranslation('settings');
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<MiniMaxStatus | null>(null);
  const [usage, setUsage] = useState<UsageResult | null>(null);
  const [isSettingsLoading, setIsSettingsLoading] = useState(true);
  const [isStatusLoading, setIsStatusLoading] = useState(true);
  const [isUsageLoading, setIsUsageLoading] = useState(true);
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

  const loadUsage = useCallback(async (force = false) => {
    const url = force ? '/api/minimax/usage?force=1' : '/api/minimax/usage';
    const response = await authenticatedFetch(url);
    const data = await readJson<{ data: UsageResult }>(response);
    setUsage(data.data);
  }, []);

  useEffect(() => {
    setError(null);
    setIsSettingsLoading(true);
    setIsStatusLoading(true);
    setIsUsageLoading(true);

    void loadEnabled()
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load MiniMax settings'))
      .finally(() => setIsSettingsLoading(false));

    void loadStatus()
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load MiniMax status'))
      .finally(() => setIsStatusLoading(false));

    void loadUsage()
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load MiniMax usage'))
      .finally(() => setIsUsageLoading(false));
  }, [loadEnabled, loadStatus, loadUsage]);

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

  const refreshUsage = async () => {
    setIsUsageLoading(true);
    setError(null);
    try {
      await loadUsage(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load MiniMax usage');
    } finally {
      setIsUsageLoading(false);
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
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t('minimax.usage.sectionTitle')}
        description={t('minimax.usage.sectionDescription')}
      >
        <SettingsCard>
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="text-sm font-medium text-foreground">
              {t('minimax.usage.sectionTitle')}
            </div>
            <button
              type="button"
              onClick={() => void refreshUsage()}
              disabled={isUsageLoading}
              aria-label={t('minimax.usage.refresh')}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-accent disabled:opacity-50"
            >
              {isUsageLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
              {isUsageLoading
                ? t('minimax.usage.refreshing')
                : t('minimax.usage.refresh')}
            </button>
          </div>

          {isUsageLoading && !usage ? (
            <div className="flex items-center gap-2 px-4 pb-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('minimax.usage.loading')}
            </div>
          ) : usage?.available === false ? (
            <div className="space-y-2 px-4 pb-4 text-sm text-muted-foreground">
              <p>
                {usage.reason === 'missing-cli'
                  ? t('minimax.usage.emptyMissingCli')
                  : t('minimax.usage.emptyCliError')}
              </p>
              <p className="text-xs">{t('minimax.usage.emptyHint')}</p>
            </div>
          ) : usage?.available === true ? (
            <div className="space-y-3 px-4 pb-4">
              {usage.model_remains.map((entry) => {
                const nameKey = `minimax.usage.perModel.${entry.model_name}`;
                const modelName = t(nameKey, {
                  defaultValue: entry.model_name.charAt(0).toUpperCase() + entry.model_name.slice(1),
                });
                const intervalPercent = entry.current_interval_remaining_percent;
                const weeklyPercent = entry.current_weekly_remaining_percent;
                return (
                  <div
                    key={entry.model_name}
                    className="rounded-lg border border-border bg-card/50 p-3"
                  >
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <div className="text-sm font-medium text-foreground">{modelName}</div>
                      <span
                        className={`rounded-md border px-2 py-0.5 text-xs ${statusPillClass(entry.current_interval_status)}`}
                      >
                        {statusLabelKey(entry.current_interval_status, t)}
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground/80">
                          {t('minimax.usage.modelIntervalLabel')}
                        </span>
                        <span>
                          {t('minimax.usage.resetsIn', {
                            value: formatRemains(entry.remains_time),
                          })}
                        </span>
                      </div>
                      <ProgressBar
                        percent={intervalPercent}
                        ariaLabel={`${modelName} ${t('minimax.usage.modelIntervalLabel')}`}
                      />
                    </div>

                    <div className="mt-2 space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground/80">
                          {t('minimax.usage.modelWeeklyLabel')}
                        </span>
                        <span>
                          {t('minimax.usage.resetsIn', {
                            value: formatRemains(entry.weekly_remains_time),
                          })}
                        </span>
                      </div>
                      <ProgressBar
                        percent={weeklyPercent}
                        ariaLabel={`${modelName} ${t('minimax.usage.modelWeeklyLabel')}`}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
          {error}
        </div>
      )}
    </div>
  );
}