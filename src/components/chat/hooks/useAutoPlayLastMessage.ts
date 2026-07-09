import { useCallback, useEffect } from 'react';

import type { NormalizedMessage, SessionStore } from '../../../stores/useSessionStore';
import { voicePlayer } from '../../../lib/voicePlayer';
import { readVoiceConfig, VOICE_CONFIG_SYNC_EVENT } from '../../../hooks/useVoiceConfig';

// Fired whenever a successful assistant run completes. Listened to by
// `useAutoPlayLastMessage`. Lives on `window` so the realtime handler
// (which lives in another component tree) and this hook can talk without
// threading a prop. See `useChatRealtimeHandlers.ts#complete` for the
// producer side.
export const AUTO_PLAY_TRIGGER_EVENT = 'voice:auto-play-trigger';

type AutoPlayDetail = { sessionId: string };

/**
 * When the user has `ttsAutoPlay` enabled in Settings → Voice, read the most
 * recent assistant message aloud as soon as a run finishes.
 *
 * The hook listens for the `voice:auto-play-trigger` CustomEvent fired by
 * `useChatRealtimeHandlers` in the `case 'complete'` branch (only on
 * successful, non-aborted runs). It then resolves the latest assistant text
 * for that session via `sessionStore.getMessages`, optionally filters out
 * thinking rows, and hands the string to the shared `voicePlayer`.
 *
 * The toggle itself is read from localStorage on every trigger so flipping
 * `ttsAutoPlay` mid-flight takes effect on the very next assistant message
 * without needing to remount the chat.
 */
export function useAutoPlayLastMessage(
  sessionStore: SessionStore,
  sessionId: string | null,
): void {
  const handleTrigger = useCallback(
    (event: Event) => {
      const detail = (event as CustomEvent<AutoPlayDetail>).detail;
      if (!detail?.sessionId) return;
      // Only auto-play messages in the session the user is currently viewing —
      // background sessions also complete, but speaking them while you're on a
      // different chat would be surprising and hostile.
      if (!sessionId || detail.sessionId !== sessionId) return;
      const cfg = readVoiceConfig();
      if (!cfg.ttsAutoPlay) return;

      const messages = sessionStore.getMessages(detail.sessionId) as NormalizedMessage[];
      if (!messages.length) return;
      // Walk from the end, skipping thinking / tool rows; only `text` rows
      // with non-empty string content and `role === 'assistant'` are narratable.
      const lastAssistant = [...messages].reverse().find((m) => {
        if (!m) return false;
        if (m.kind !== 'text') return false;
        if (m.role !== 'assistant') return false;
        const text = String((m as NormalizedMessage).content || '');
        return text.trim().length > 0;
      }) as NormalizedMessage | undefined;
      if (!lastAssistant) return;
      const text = String(lastAssistant.content || '').trim();
      if (!text) return;
      // Defer one tick so React can flush the "stop loading" UI before audio
      // starts fetching; otherwise the spinner keeps spinning while we wait.
      setTimeout(() => voicePlayer.toggle(text), 50);
    },
    [sessionId, sessionStore],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener(AUTO_PLAY_TRIGGER_EVENT, handleTrigger);
    // Also re-check on toggle change so the user can disable / re-enable
    // without unmounting — currently a no-op (the trigger is fired by WS
    // events, not by toggling), but keeps the seam consistent with the other
    // voice-config consumers.
    window.addEventListener(VOICE_CONFIG_SYNC_EVENT, handleTrigger);
    return () => {
      window.removeEventListener(AUTO_PLAY_TRIGGER_EVENT, handleTrigger);
      window.removeEventListener(VOICE_CONFIG_SYNC_EVENT, handleTrigger);
    };
  }, [handleTrigger]);
}