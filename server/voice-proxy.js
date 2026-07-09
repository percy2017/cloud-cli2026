// Voice proxy — MiniMax TTS only.
//
// CloudCLI ships with MiniMax as its sole voice backend. The browser never talks
// to MiniMax directly: every TTS request hits /api/voice/tts, and when the user
// has the "Use MiniMax for text-to-speech" toggle on (header x-voice-tts-minimax: 1)
// the proxy delegates to minimaxService.synthesizeText(), which shells `mmx`
// speech synthesize. The MiniMax API key lives only in app_config#minimax_settings
// — the client never sees it.
//
// STT (push-to-talk dictation) is currently disabled: MiniMax does not document
// a transcription endpoint, and we do not ship any other STT backend. /transcribe
// always returns 503 so the mic button stays hidden until a backend is wired.
//
// Mounted at /api/voice behind authenticateToken.

import express from 'express';

import { minimaxService } from './modules/minimax/index.js';

const router = express.Router();

/**
 * Map the TTS format string (mp3/pcm/flac/wav/opus) to a Content-Type the
 * browser recognises. Falls back to audio/mpeg (covers `mp3`).
 * @param {string} format
 * @returns {string}
 */
function contentTypeFor(format) {
  const f = String(format || '').trim().toLowerCase();
  if (f === 'wav') return 'audio/wav';
  if (f === 'flac') return 'audio/flac';
  if (f === 'pcm' || f === 'pcmu_raw' || f === 'pcmu_wav') return 'audio/L16';
  if (f === 'opus') return 'audio/ogg; codecs=opus';
  return 'audio/mpeg';
}

/**
 * GET /api/voice/health -> { configured }.
 * True when MiniMax TTS is enabled and a non-default config is resolvable.
 * Drives `useVoiceAvailable` on the client.
 */
router.get('/health', async (_req, res) => {
  try {
    const cfg = await minimaxService.getTtsConfig();
    res.json({ configured: Boolean(cfg) });
  } catch {
    res.json({ configured: false });
  }
});

/**
 * POST /api/voice/transcribe. Disabled — no STT backend wired.
 */
router.post('/transcribe', (_req, res) => {
  res.status(503).json({
    error: 'STT not configured. MiniMax TTS only — dictation is disabled.',
  });
});

/**
 * POST /api/voice/tts { text } -> audio bytes.
 * Requires `x-voice-tts-minimax: 1`; without it we return 503 (no other backend).
 */
router.post('/tts', async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'text required' });
  }

  const wantsMinimax = String(req.headers['x-voice-tts-minimax'] || '') === '1';
  if (!wantsMinimax) {
    return res.status(503).json({
      error: 'TTS requires the MiniMax toggle (x-voice-tts-minimax: 1).',
    });
  }

  try {
    const cfg = await minimaxService.getTtsConfig();
    if (!cfg) {
      return res.status(503).json({
        error: 'MiniMax TTS is not enabled. Configure it in Settings → MiniMax.',
      });
    }
    const voiceOverride = String(req.headers['x-voice-tts-minimax-voice'] || '').trim();
    const { audio, format } = await minimaxService.synthesizeText({
      text,
      ...(voiceOverride ? { voice: voiceOverride } : {}),
    });
    res.setHeader('Content-Type', contentTypeFor(format));
    res.setHeader('Content-Length', String(audio.length));
    res.setHeader('Cache-Control', 'no-store');
    return res.end(audio);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'minimax tts failed';
    if (msg.includes('10000 character limit')) {
      return res.status(413).json({ error: msg });
    }
    console.error('[Voice] MiniMax TTS error:', msg);
    return res.status(502).json({ error: `MiniMax TTS failed: ${msg}` });
  }
});

export default router;