import { useState } from 'react';

export type VoiceConfig = {
  // When true, the TTS request is routed through the MiniMax TTS backend
  // (server-side `mmx speech synthesize`) instead of an OpenAI-compatible
  // backend. CloudCLI ships with MiniMax only — no other voice backend.
  ttsUseMinimax: boolean;
  // Optional voice override for the MiniMax TTS branch. Empty means
  // "use whatever the user picked in Settings -> MiniMax". Surfaced in
  // `x-voice-tts-minimax-voice`.
  ttsMinimaxVoice: string;
  // When true, every assistant response (the final message of a successful
  // run) is read aloud automatically as soon as the run completes. The user
  // can still cancel by tapping the 🔊 button on the message or the global
  // stop control. Persisted alongside the other voice prefs in localStorage
  // so the choice survives reloads and is shared across browser tabs.
  ttsAutoPlay: boolean;
};

const STORAGE_KEY = 'voiceConfig';
export const VOICE_CONFIG_SYNC_EVENT = 'voice-config:sync';
const DEFAULTS: VoiceConfig = {
  ttsUseMinimax: false,
  ttsMinimaxVoice: '',
  ttsAutoPlay: false,
};

export function readVoiceConfig(): VoiceConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULTS };
    const config = { ...DEFAULTS };
    if (parsed.ttsUseMinimax === true) config.ttsUseMinimax = true;
    if (typeof parsed.ttsMinimaxVoice === 'string') config.ttsMinimaxVoice = parsed.ttsMinimaxVoice;
    if (parsed.ttsAutoPlay === true) config.ttsAutoPlay = true;
    return config;
  } catch {
    return { ...DEFAULTS };
  }
}

// Headers the voice proxy reads to know whether to route TTS through MiniMax.
// STT is currently disabled at the proxy level (no backend wired) so no
// transcription headers are sent.
export function voiceConfigHeaders(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const c = readVoiceConfig();
  const h: Record<string, string> = {};
  if (c.ttsUseMinimax) h['x-voice-tts-minimax'] = '1';
  if (c.ttsMinimaxVoice.trim()) h['x-voice-tts-minimax-voice'] = c.ttsMinimaxVoice.trim();
  return h;
}

export function useVoiceConfig() {
  const [config, setConfig] = useState<VoiceConfig>(() =>
    typeof window === 'undefined' ? { ...DEFAULTS } : readVoiceConfig(),
  );

  const update = (patch: Partial<VoiceConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      try {
        const stored: Partial<VoiceConfig> = { ...next };
        if (!next.ttsMinimaxVoice.trim()) delete stored.ttsMinimaxVoice;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
        window.dispatchEvent(new Event(VOICE_CONFIG_SYNC_EVENT));
      } catch {
        /* ignore persistence errors */
      }
      return next;
    });
  };

  return { config, update };
}