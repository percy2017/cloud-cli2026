import { useTranslation } from 'react-i18next';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import { useUiPreferences } from '../../../../hooks/useUiPreferences';
import { useVoiceConfig } from '../../../../hooks/useVoiceConfig';
import { MINIMAX_VOICE_GROUPS } from './minimax-voices';

const selectClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60';

// Voice module: TTS goes through MiniMax only. STT (push-to-talk dictation)
// is currently disabled because MiniMax does not document a transcription
// endpoint — the mic button stays hidden until a backend is wired.
export default function VoiceSettingsTab() {
  const { t } = useTranslation('settings');
  const { preferences, setPreference } = useUiPreferences();
  const { config, update } = useVoiceConfig();
  const voiceEnabled = preferences.voiceEnabled;

  return (
    <div className="space-y-8">
      <SettingsSection title={t('voiceSettings.title')} description={t('voiceSettings.description')}>
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="pr-3">
            <div className="text-sm font-medium text-foreground">{t('voiceSettings.enable')}</div>
            <div className="text-xs text-muted-foreground">{t('voiceSettings.enableDescription')}</div>
          </div>
          <SettingsToggle
            checked={voiceEnabled}
            onChange={(v) => setPreference('voiceEnabled', v)}
            ariaLabel={t('voiceSettings.enable')}
          />
        </div>
      </SettingsSection>

      {voiceEnabled && (
        <SettingsSection
          title={t('voiceSettings.minimaxTtsTitle')}
          description={t('voiceSettings.minimaxTtsDescription')}
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div className="pr-3">
                <div className="text-sm font-medium text-foreground">{t('voiceSettings.minimaxTtsEnable')}</div>
                <div className="text-xs text-muted-foreground">{t('voiceSettings.minimaxTtsEnableDescription')}</div>
              </div>
              <SettingsToggle
                checked={config.ttsUseMinimax}
                onChange={(v) => update({ ttsUseMinimax: v })}
                ariaLabel={t('voiceSettings.minimaxTtsEnable')}
              />
            </div>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-foreground">
                {t('voiceSettings.minimaxTtsVoice')}
              </span>
              <select
                className={selectClass}
                value={config.ttsMinimaxVoice}
                onChange={(e) => update({ ttsMinimaxVoice: e.target.value })}
                disabled={!config.ttsUseMinimax}
              >
                {/* Empty option = use whatever the user previously typed (or the
                    server-side default if blank). We keep this so a custom voice
                    that the user wrote before this selector shipped stays valid. */}
                <option value="">
                  {t('voiceSettings.minimaxTtsVoiceDefault', {
                    defaultValue: '— Predeterminado del servidor —',
                  })}
                </option>
                {MINIMAX_VOICE_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.voices.map((voice) => (
                      <option key={voice.id} value={voice.id}>
                        {voice.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            <p className="text-xs text-muted-foreground">{t('voiceSettings.minimaxTtsNote')}</p>
          </div>

          {/* Auto-play the last assistant message aloud. Disabled until the user
              has actually opted in to MiniMax TTS — no point auto-playing
              through a backend they aren't using. */}
          {config.ttsUseMinimax && (
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div className="pr-3">
                <div className="text-sm font-medium text-foreground">
                  {t('voiceSettings.ttsAutoPlayTitle', {
                    defaultValue: 'Reproducir automáticamente la última respuesta',
                  })}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t('voiceSettings.ttsAutoPlayDescription', {
                    defaultValue:
                      'Cuando llegue una respuesta nueva del asistente, se lee en voz alta sin que toques nada.',
                  })}
                </div>
              </div>
              <SettingsToggle
                checked={config.ttsAutoPlay}
                onChange={(v) => update({ ttsAutoPlay: v })}
                ariaLabel={t('voiceSettings.ttsAutoPlayTitle', {
                  defaultValue: 'Reproducir automáticamente la última respuesta',
                })}
              />
            </div>
          )}
        </SettingsSection>
      )}
    </div>
  );
}