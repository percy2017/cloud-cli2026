import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Loader2, RefreshCw, Sparkles, Terminal, XCircle } from 'lucide-react';

import { Button } from '../../../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../../../utils/api';

type MmxCredentials = {
  installed: boolean;
  authenticated: boolean;
  apiKey: string;
  maskedKey: string;
  apiHost: string;
  method: 'api-key' | 'oauth' | 'unknown';
  message: string;
};

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || data.details || `Request failed (${response.status})`);
  }
  return data as T;
}

export default function MiniMaxCredentialsSection() {
  const { t } = useTranslation('settings');
  const [creds, setCreds] = useState<MmxCredentials | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force = false) => {
    const url = force ? '/api/minimax/credentials?force=1' : '/api/minimax/credentials';
    const response = await authenticatedFetch(url);
    const data = await readJson<{ data: MmxCredentials }>(response);
    setCreds(data.data);
  }, []);

  useEffect(() => {
    setError(null);
    setIsLoading(true);
    void load(false)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load MiniMax credentials'))
      .finally(() => setIsLoading(false));
  }, [load]);

  const onRefresh = async () => {
    setIsRefreshing(true);
    setError(null);
    try {
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to refresh MiniMax credentials');
    } finally {
      setIsRefreshing(false);
    }
  };

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <Sparkles className="h-5 w-5" />
        <h3 className="text-lg font-semibold">{t('api.minimax.title')}</h3>
      </div>

      <p className="mb-4 text-sm text-muted-foreground">{t('api.minimax.description')}</p>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('api.minimax.loading')}
        </div>
      ) : (
        <div className="space-y-4 rounded-lg border bg-card p-4">
          {/* Status row */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              {creds?.authenticated ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <XCircle className="mt-0.5 h-5 w-5 text-red-600 dark:text-red-400" />
              )}
              <div className="space-y-1">
                <div className="text-sm font-medium text-foreground">
                  {creds?.authenticated
                    ? t('api.minimax.statusAuthenticated')
                    : t('api.minimax.statusNotAuthenticated')}
                </div>
                <div className="text-xs text-muted-foreground">
                  {creds?.message ?? ''}
                </div>
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void onRefresh()}
              disabled={isRefreshing}
            >
              {isRefreshing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {t('api.minimax.refresh')}
            </Button>
          </div>

          {/* Authenticated details */}
          {creds?.authenticated && (
            <dl className="grid grid-cols-1 gap-x-4 gap-y-2 border-t border-border pt-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">{t('api.minimax.methodLabel')}</dt>
                <dd className="font-mono text-foreground">
                  {creds.method === 'api-key' ? t('api.minimax.methodApiKey') : t('api.minimax.methodOAuth')}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t('api.minimax.keyLabel')}</dt>
                <dd className="font-mono text-foreground">{creds.maskedKey}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs text-muted-foreground">{t('api.minimax.hostLabel')}</dt>
                <dd className="font-mono text-foreground break-all">{creds.apiHost}</dd>
              </div>
            </dl>
          )}

          {/* CLI commands when not authenticated */}
          {!creds?.authenticated && (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="text-sm font-medium text-foreground">
                {t('api.minimax.setupTitle')}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('api.minimax.setupDescription')}
              </p>
              <div className="space-y-1.5">
                <CommandBlock
                  label={t('api.minimax.installLabel')}
                  command="curl -fsSL https://mmx.ai/install | bash"
                />
                <CommandBlock
                  label={t('api.minimax.loginLabel')}
                  command="mmx auth login"
                />
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CommandBlock({ label, command }: { label: string; command: string }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 p-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Terminal className="h-3.5 w-3.5" />
        {label}
      </div>
      <code className="block break-all font-mono text-xs text-foreground">{command}</code>
    </div>
  );
}
