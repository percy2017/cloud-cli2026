import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, Loader2, Sparkles } from 'lucide-react';

import { Button, Input } from '../../../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../../../utils/api';

type MiniMaxSettings = {
  enabled: boolean;
  apiKey: string;
  apiHost: string;
};

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || data.details || `Request failed (${response.status})`);
  }
  return data as T;
}

function maskSecret(value: string): string {
  if (!value) {
    return '';
  }
  if (value.length <= 8) {
    return '••••';
  }
  return `${value.slice(0, 4)}${'•'.repeat(Math.min(value.length - 8, 24))}${value.slice(-4)}`;
}

export default function MiniMaxCredentialsSection() {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<MiniMaxSettings | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [apiHostDraft, setApiHostDraft] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    const response = await authenticatedFetch('/api/minimax/settings');
    const data = await readJson<{ data: { settings: MiniMaxSettings } }>(response);
    setSettings(data.data.settings);
    setApiKeyDraft(data.data.settings.apiKey);
    setApiHostDraft(data.data.settings.apiHost);
  }, []);

  useEffect(() => {
    setError(null);
    setIsLoading(true);
    void loadSettings()
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load MiniMax credentials'))
      .finally(() => setIsLoading(false));
  }, [loadSettings]);

  const save = async () => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/minimax/settings', {
        method: 'PUT',
        body: JSON.stringify({ apiKey: apiKeyDraft, apiHost: apiHostDraft }),
      });
      const data = await readJson<{ data: { settings: MiniMaxSettings } }>(response);
      setSettings(data.data.settings);
      setApiKeyDraft(data.data.settings.apiKey);
      setApiHostDraft(data.data.settings.apiHost);
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save MiniMax credentials');
    } finally {
      setIsSaving(false);
    }
  };

  const dirty = Boolean(settings) && (apiKeyDraft !== settings!.apiKey || apiHostDraft !== settings!.apiHost);
  const showSavedToast = savedAt !== null && !dirty && !isSaving && !error;

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
          <div className="space-y-1">
            <label htmlFor="minimax-api-key" className="text-sm font-medium text-foreground">
              {t('api.minimax.keyLabel')}
            </label>
            <div className="relative">
              <Input
                id="minimax-api-key"
                type={showApiKey ? 'text' : 'password'}
                value={showApiKey ? apiKeyDraft : maskSecret(apiKeyDraft)}
                onChange={(event) => setApiKeyDraft(event.target.value)}
                placeholder={t('api.minimax.keyPlaceholder')}
                autoComplete="off"
                spellCheck={false}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowApiKey((current) => !current)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label={showApiKey ? t('api.minimax.hideKey') : t('api.minimax.showKey')}
              >
                {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">{t('api.minimax.keyHint')}</p>
          </div>

          <div className="space-y-1">
            <label htmlFor="minimax-api-host" className="text-sm font-medium text-foreground">
              {t('api.minimax.hostLabel')}
            </label>
            <Input
              id="minimax-api-host"
              type="url"
              value={apiHostDraft}
              onChange={(event) => setApiHostDraft(event.target.value)}
              placeholder={t('api.minimax.hostPlaceholder')}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">{t('api.minimax.hostHint')}</p>
          </div>

          <div className="flex items-center justify-between border-t border-border pt-3">
            <div className="text-xs text-muted-foreground">
              {showSavedToast ? (
                <span className="text-emerald-600 dark:text-emerald-400">{t('api.minimax.savedToast')}</span>
              ) : null}
            </div>
            <Button type="button" size="sm" onClick={() => void save()} disabled={isSaving || !dirty}>
              {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('api.minimax.saveButton')}
            </Button>
          </div>

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
