import { authenticatedFetch } from '../utils/api';
import { readVoiceConfig, voiceConfigHeaders } from '../hooks/useVoiceConfig';

export function voiceConfigSignature(): string {
  return JSON.stringify(readVoiceConfig());
}

// Push-to-talk dictation. Currently disabled at the server — MiniMax does not
// document a transcription endpoint, so there is no STT backend wired. We keep
// the function shape so the composer can render the mic button once a backend
// lands, but it always resolves with a 503-shaped error today.
export function transcribeVoice(_blob: Blob, _filename: string): Promise<Response> {
  return Promise.resolve(
    new Response(
      JSON.stringify({ error: 'STT not configured. MiniMax TTS only — dictation is disabled.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    ),
  );
}

// Read-aloud. Always goes through /api/voice/tts; the server routes to MiniMax
// only when the user has `ttsUseMinimax` toggled on. Without that toggle the
// proxy returns 503 because there is no other voice backend.
export function synthesizeVoice(text: string, signal: AbortSignal): Promise<Response> {
  return authenticatedFetch('/api/voice/tts', {
    method: 'POST',
    body: JSON.stringify({ text }),
    headers: voiceConfigHeaders(),
    signal,
  });
}