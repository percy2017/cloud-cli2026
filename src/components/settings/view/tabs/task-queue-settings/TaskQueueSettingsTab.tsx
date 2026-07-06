import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../../../utils/api';
import SettingsCard from '../../SettingsCard';
import SettingsRow from '../../SettingsRow';
import SettingsSection from '../../SettingsSection';
import SettingsToggle from '../../SettingsToggle';

type TasksSettings = {
  enabled: boolean;
};

async function readJson<T>(response: Response): Promise<T> {
  const data = await response.json();
  if (!response.ok || data.success === false) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data as T;
}

export default function TaskQueueSettingsTab() {
  const { t } = useTranslation('settings');
  const [settings, setSettings] = useState<TasksSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    const response = await authenticatedFetch('/api/tasks/settings');
    const data = await readJson<{ data: { settings: TasksSettings } }>(response);
    setSettings(data.data.settings);
  }, []);

  useEffect(() => {
    setError(null);
    setIsLoading(true);
    void loadSettings()
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load Tasks settings'))
      .finally(() => setIsLoading(false));
  }, [loadSettings]);

  const updateSettings = async (next: Partial<TasksSettings>) => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/tasks/settings', {
        method: 'PUT',
        body: JSON.stringify(next),
      });
      const data = await readJson<{ data: { settings: TasksSettings } }>(response);
      setSettings(data.data.settings);
      // The toggle flips MCP registration — refire the change event so
      // MainContent can reload its gate and reveal/hide the tab accordingly.
      if (next.enabled !== undefined) {
        window.dispatchEvent(new Event('tasksSettingsChanged'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save Tasks settings');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <SettingsSection
      title={t('mainTabs.taskQueue', { defaultValue: 'Task Queue' })}
      description={t('tasksQueue.description', {
        defaultValue:
          'Native task queue. Agents file tasks into the active project\'s queue and the tab in the header shows them with live status, history, and operator actions.',
      })}
    >
      {error && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </div>
      )}

      <SettingsCard>
        <SettingsRow
          label={t('tasksQueue.enableLabel', { defaultValue: 'Enable native task queue' })}
          description={t('tasksQueue.enableDescription', {
            defaultValue:
              'Registers the cloudcli-tasks MCP with all providers so any agent can file tasks, update status, approve, cancel, or quarantine items in the queue of the project it is currently working on.',
          })}
        >
          <SettingsToggle
            checked={settings?.enabled === true}
            disabled={isLoading || isSaving}
            ariaLabel={t('tasksQueue.enableLabel', { defaultValue: 'Enable native task queue' })}
            onChange={(value) => updateSettings({ enabled: value })}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}