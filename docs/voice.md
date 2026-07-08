# Voice module

CloudCLI ships a small **voice** feature: push-to-talk dictation in the chat
composer and tap-to-speak read-aloud on assistant messages. Unlike the
[provider docs](./providers/), voice is **not** an AI coding agent — it is an
orthogonal feature that delegates speech-to-text (STT) and text-to-speech (TTS)
to any **OpenAI-compatible audio backend** the user points at (OpenAI, Groq,
LocalAI, Speaches, Kokoro-FastAPI, openedai-speech, or a self-hosted server).

The whole feature is a thin HTTP proxy in front of the upstream backend, plus
browser-side `MediaRecorder` and `<audio>` plumbing. There is **no in-house
STT/TTS code** and **no WebSocket transport** — voice is exclusively
request/response HTTP.

This doc assumes you've already read the [provider overview](./providers/README.md).
Voice is wired into the chat composer the same way every provider is, but the
voice feature itself lives outside `server/modules/providers/`.

## Architecture at a glance

```
                 ┌────────────────────────────┐
                 │  User taps 🎙 / 🔊 in UI   │
                 │  ChatComposer or           │
                 │  MessageSpeakControl       │
                 └──────────────┬─────────────┘
                                │
                                ▼
        ┌──────────────────────────────────────┐
        │ Frontend hooks                       │
        │  useVoiceInput  (record + transcribe)│
        │  useTts         (synthesize + play) │
        │  useVoiceAvailable (gate visibility) │
        │  useVoiceConfig (localStorage state)│
        └──────────────────┬───────────────────┘
                           │
                           ▼
        ┌──────────────────────────────────────┐
        │ Client API helpers                   │
        │  src/lib/voiceApi.ts                 │
        │    transcribeVoice(blob, filename)   │
        │    synthesizeVoice(text, signal)     │
        │  src/lib/voicePlayer.ts              │
        │    singleton <audio> + LRU cache     │
        └──────────────────┬───────────────────┘
                           │
            ┌──────────────┴──────────────┐
            ▼                             ▼
   ┌────────────────┐           ┌────────────────────┐
   │ Mode A: direct │           │ Mode B: proxy      │
   │ browser →      │           │ browser →          │
   │ baseUrl +      │           │ /api/voice/*       │
   │ Bearer <key>   │           │ (authenticatedFetch│
   │ (CORS required)│           │  + JWT)            │
   └────────┬───────┘           └─────────┬──────────┘
            │                             │
            │                             ▼
            │                ┌────────────────────────────┐
            │                │ Express proxy              │
            │                │  server/voice-proxy.js     │
            │                │  resolveConfig             │
            │                │  isAllowedBackendUrl       │
            │                │  multer 25 MB cap          │
            │                │  fetchWithTimeout 5 min    │
            │                └──────────┬─────────────────┘
            │                           │
            └─────────────┬─────────────┘
                          ▼
              ┌────────────────────────────┐
              │ Upstream STT/TTS           │
              │ OpenAI / Groq / LocalAI /  │
              │ Speaches / Kokoro / etc.   │
              └────────────────────────────┘
```

The two modes are mutually exclusive per request, decided by whether the user
filled in the `baseUrl` field in Settings → Voice:

- **Direct mode** (`baseUrl` non-empty): the browser calls the upstream backend
  directly. CORS must be allowed by the backend. The browser sends
  `Authorization: Bearer <apiKey>` from `voiceConfig.apiKey`.
- **Proxy mode** (`baseUrl` empty): the browser calls `/api/voice/*` on the
  CloudCLI server, which then forwards to whichever backend the server has
  configured via env vars. The server attaches its own auth and is the only
  party that talks to the upstream.

The two modes exist so that:

- **Self-hosted users** can run their own TTS/STT server (LocalAI, Speaches,
  Kokoro-FastAPI) and skip the round-trip through CloudCLI entirely.
- **Hosted users** can share one server-side backend across many users without
  ever exposing the upstream API key to the browser.

## Backend layout

Everything backend-side lives in one file:

| File | Role |
|---|---|
| `server/voice-proxy.js` | The entire backend. Express router mounted at `/api/voice` behind `authenticateToken`. Implements `GET /health`, `POST /transcribe`, `POST /tts`. |

That is the entire backend surface — there is **no** `voice.service.ts`,
`stt.service.ts`, or `tts.service.ts`. The proxy does not implement STT or TTS
itself; it forwards to whatever the user (or the server env) points at.

Mount point in `server/index.js:231`:

```js
app.use('/api/voice', authenticateToken, voiceRoutes);
```

## Runtime: `server/voice-proxy.js`

The header comment at `server/voice-proxy.js:1-8` enumerates the contract the
upstream must satisfy:

```
POST {base}/audio/transcriptions   (multipart 'file' + 'model')      -> { text }
POST {base}/audio/speech           ({ model, voice, input })         -> audio bytes
```

This is the OpenAI audio API shape. Any backend that exposes these two
endpoints will work — the comment lists: **OpenAI, Groq, LocalAI, Speaches,
Kokoro-FastAPI, openedai-speech**.

### Config resolution

`resolveConfig(req)` (`server/voice-proxy.js:29-41`) merges server env defaults
with per-request `x-voice-*` headers set by the client:

| Field | Env default | Header override |
|---|---|---|
| `baseUrl` | `VOICE_API_BASE_URL` | **server-controlled only** (security: the client cannot override the upstream host) |
| `apiKey` | `VOICE_API_KEY` | `x-voice-api-key` |
| `sttModel` | `VOICE_STT_MODEL` (default `whisper-1`) | `x-voice-stt-model` |
| `ttsModel` | `VOICE_TTS_MODEL` (default `tts-1`) | `x-voice-tts-model` |
| `ttsVoice` | `VOICE_TTS_VOICE` (default `alloy`) | `x-voice-tts-voice` |
| `ttsFormat` | _(none)_ | `x-voice-tts-format` |

The header override on `apiKey` and the model fields lets each user set their
own key/models in Settings → Voice without restarting the server.

The `baseUrl` is intentionally **not** overridable per-request
(`server/voice-proxy.js:32-33`):

> Security: do not allow clients to control the outbound backend host.
> Always use the server-side configured base URL.

This is what stops an attacker who steals a user's JWT from redirecting the
voice backend to their own server and exfiltrating audio.

### Endpoints

| Method | Path | Handler | Behavior |
|---|---|---|---|
| `GET` | `/api/voice/health` | `server/voice-proxy.js:150-152` | Returns `{ configured: Boolean(resolveConfig(req).baseUrl) }`. Used by `useVoiceAvailable` to decide whether to render the UI when the client has no `baseUrl` set. |
| `POST` | `/api/voice/transcribe` | `server/voice-proxy.js:158-188` | `multipart/form-data` upload (multer `memoryStorage`, **25 MB** cap, lazy-imported at first use). Forwards to `${baseUrl}/audio/transcriptions` as `multipart` with `file` + `model`. Returns `{ text }`. |
| `POST` | `/api/voice/tts` | `server/voice-proxy.js:194-222` | JSON `{ text }` body. Forwards JSON `{ model, voice, input, response_format? }` to `${baseUrl}/audio/speech`. Streams the audio bytes back with `Content-Type` from upstream and `Cache-Control: no-store`. |

### Failure modes and error mapping

The proxy deliberately remaps upstream errors so they don't get confused with
app-level auth failures:

| Failure | Mapped to | Source |
|---|---|---|
| Upstream returns 401/403 | 502 with message `"Voice backend rejected the request (check the API key)."` | `upstreamError()` — `server/voice-proxy.js:116-121` |
| `AbortError` (timeout) | 504 with message `"Voice backend timed out after Ns. Check your voice backend."` | `backendError()` — `server/voice-proxy.js:80-87` |
| Other fetch failures | 502 with the raw upstream error | `backendError()` — `server/voice-proxy.js:80-87` |
| No `baseUrl` resolved | 503 `"No voice backend configured"` | `server/voice-proxy.js:160` |
| Backend URL is link-local (`169.254/16`) | rejected pre-fetch | `isAllowedBackendUrl()` — `server/voice-proxy.js:97-107` |

`isAllowedBackendUrl()` also requires `http:` or `https:`. Localhost and
private ranges are explicitly allowed so users can point at local servers.

### Timeouts

Two layers:

- **Server-side** (`server/voice-proxy.js:60-72`): `AbortController` aborts the
  upstream fetch after `VOICE_TIMEOUT_MS` (env, default `300_000` ms = **5 min**).
- **Client-side** (`src/lib/voicePlayer.ts:15`): `CLIENT_TIMEOUT_MS = 330000`
  (5.5 min) as a backstop. The client side is slightly longer than the server
  side so the server's clearer 504 message reaches the user before the client
  gives up.

The 5-minute default is intentionally generous — local TTS can synthesize long
messages at roughly real-time on CPU, and we don't want to cut off legitimate
long-form read-aloud.

### Lazy multer import

`server/voice-proxy.js:129-135` lazy-imports `multer` on first STT request via
`getUpload()`. This way the dep is not paid at server startup when nobody uses
the voice feature.

## Frontend layout

The frontend pieces are all under `src/`:

### Hooks

| File | Exports | Purpose |
|---|---|---|
| `src/hooks/useVoiceConfig.ts` | `VoiceConfig`, `useVoiceConfig()`, `readVoiceConfig()`, `voiceConfigHeaders()`, `VOICE_CONFIG_SYNC_EVENT` | localStorage-backed config (`baseUrl`, `apiKey`, `sttModel`, `ttsModel`, `ttsVoice`, `ttsFormat`). Dispatches a `voice-config:sync` event when changed. |
| `src/components/chat/hooks/useVoiceInput.ts` | `useVoiceInput(onTranscript, onError)` → `{ state, toggle, stop }` | Recording state machine + `MediaRecorder` wrapper + transcribe dispatch. State: `idle \| recording \| transcribing`. |
| `src/components/chat/hooks/useVoiceAvailable.ts` | `useVoiceAvailable()` → `boolean` | Visibility gate: requires `uiPreferences.voiceEnabled` plus either a non-empty client `baseUrl` or a successful `/api/voice/health` probe. |
| `src/components/chat/hooks/useTts.ts` | `useTts(getText)` → `{ state, toggle, error }` | React adapter over the `voicePlayer` singleton. |

### Client helpers

| File | Exports | Purpose |
|---|---|---|
| `src/lib/voiceApi.ts` | `transcribeVoice(blob, filename)`, `synthesizeVoice(text, signal)`, `voiceConfigSignature()` | Branch on `config.baseUrl`: direct call vs `/api/voice/*` proxy call. |
| `src/lib/voicePlayer.ts` | `voicePlayer` (singleton) | App-level `<audio>` element, LRU blob cache, iOS unlock trick, `subscribe()` for React state. |

### UI components

| Component | File | Role |
|---|---|---|
| `VoiceInputButton` | `src/components/chat/view/subcomponents/VoiceInputButton.tsx` | Pure presentational mic button. Icons for mic / square / loader + tooltips from `chat.json#voice.*`. |
| `MessageSpeakControl` | `src/components/chat/view/subcomponents/MessageSpeakControl.tsx` | Read-aloud button. Rendered only on assistant messages (`MessageComponent.tsx:390`). Renders only if `useVoiceAvailable()` is true. |
| `VoiceSettingsTab` | `src/components/settings/view/tabs/VoiceSettingsTab.tsx` | The one place the user can edit voice config: enable toggle + 5 backend fields + CORS warning. |
| Quick Settings toggle | `src/components/quick-settings-panel/view/QuickSettingsContent.tsx:32-34` | "Voice (mic + read aloud)" toggle — only rendered if the user already enabled voice at least once. |

## Runtime flows

### STT flow — user taps the mic

1. `ChatComposer.tsx:335-337` renders `<VoiceInputButton/>` only if
   `onVoiceTranscript && useVoiceAvailable()`.
2. `useVoiceAvailable` (`src/components/chat/hooks/useVoiceAvailable.ts`):
   - `voiceEnabled === false` → return `false`.
   - `baseUrl` set → return `true` immediately (no health probe).
   - Otherwise fire `GET /api/voice/health` (memoized in a module-level
     promise) and return the body's `configured`.
3. Click → `useVoiceInput.start()`:
   - `navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })`
   - `pickMime()` picks the first supported MIME from `MIME_CANDIDATES`
     (`useVoiceInput.ts:6-12`):
     `audio/webm;codecs=opus` → `audio/webm` → `audio/mp4` →
     `audio/ogg;codecs=opus` → `audio/ogg`. iOS Safari 18.4+ supports
     webm/opus; older iOS falls back to mp4.
   - `new MediaRecorder(stream, { mimeType })` → `rec.start()`. State →
     `recording`.
4. User taps Stop (mic button or main Send button):
   - Mic button → `stop({ send: false })`.
   - Main Send button (`ChatComposer.tsx:416-431`) →
     `voiceStop({ send: true })`. This also disables the Submit button while
     transcribing.
5. `rec.onstop` (`useVoiceInput.ts:83-113`):
   - Stops all media tracks.
   - Builds a `Blob` from the recorded chunks. If `< 800 bytes` → error
     `"Recording too short"`.
   - State → `transcribing`.
   - Calls `transcribeVoice(blob, 'recording.<ext>')`.
6. `transcribeVoice` (`src/lib/voiceApi.ts`):
   - **Mode A (direct):** `fetch(baseUrl + '/audio/transcriptions', POST multipart)` with `Authorization: Bearer <apiKey>`.
   - **Mode B (proxy):** `authenticatedFetch('/api/voice/transcribe', POST multipart field 'audio', headers = x-voice-*)`. The proxy attaches the user's JWT.
7. The Express proxy (`server/voice-proxy.js:158-188`):
   - `resolveConfig(req)` → merge env defaults with `x-voice-*` headers.
   - `isAllowedBackendUrl(baseUrl)` → reject link-local, require http/https.
   - Lazy `multer.memoryStorage()` (25 MB cap) → `req.file.buffer`.
   - `fetchWithTimeout(baseUrl + '/audio/transcriptions', multipart 'file' + 'model', Authorization)`.
8. Upstream STT returns `{ text }` (or 4xx/5xx).
9. `useVoiceInput.onstop` parses the response:
   - `!res.ok` → `throw new Error('transcribe ' + status)`.
   - `data.text` empty → `"No speech detected"`.
   - Otherwise → `onTranscript(text, shouldSend)`.
10. `handleVoiceTranscript` (`src/components/chat/hooks/useChatComposerState.ts:799`):
    - `setInput(base ? base + ' ' + text : text)` — fills the textarea
      (synchronously mirrored to `inputValueRef.current` so `handleSubmit`
      reads the fresh value).
    - If `send === true` → `handleSubmitRef.current?.(createFakeSubmitEvent())`
      — fires the same submit pipeline as the Enter key.

The transcribed text then rides the chat WebSocket (`/ws`) through the
provider runtime — voice never touches the WS itself, only the resulting text.

### TTS flow — user taps 🔊 on an assistant message

1. `MessageSpeakControl` (`MessageComponent.tsx:390`) mounts on assistant
   messages, only if `useVoiceAvailable()` is true.
2. Click → `useTts.toggle()`:
   - `voicePlayer.unlock()` — synchronous `audio.play()` then `pause()` priming
     call. This is the iOS Safari gesture trick: by issuing play/pause from the
     click handler, Safari grants playback to the reused `<audio>` element.
   - `voicePlayer.toggle(content)`.
3. `voicePlayer.play(id, content)` (`src/lib/voicePlayer.ts:132-182`):
   - `voiceId = djb2(content + voiceConfigSignature())`. The cache key depends
     on the voice config so changing models/voices invalidates the cache
     automatically.
   - `cache.get(id)` exists → `audio.play()` directly with the cached blob URL.
   - Otherwise: `token++` (discards older in-flight results), `abortActive()`,
     `synthesizeVoice(content, signal)`, `await res.blob()`,
     `URL.createObjectURL(blob)`, `cacheSet`, `audio.play()`.
4. `synthesizeVoice` (`src/lib/voiceApi.ts:34`):
   - **Mode A (direct):** `fetch(baseUrl + '/audio/speech', POST JSON)` with
     `Authorization: Bearer <apiKey>`. CORS required.
   - **Mode B (proxy):** `authenticatedFetch('/api/voice/tts', POST JSON, headers = x-voice-*)`.
5. Express proxy (`server/voice-proxy.js:194-222`):
   - Forwards JSON `{ model, voice, input, response_format? }` to
     `${baseUrl}/audio/speech`.
   - Streams audio bytes back with the upstream `Content-Type` and
     `Cache-Control: no-store` so the browser doesn't cache TTS responses.
6. Errors surface as a tooltip over the speak button for 6 s. `AbortError` is
   reported as `"Read-aloud timed out."`.

### LRU cache

`voicePlayer` keeps an in-memory LRU of generated audio (`CACHE_MAX = 24`,
`src/lib/voicePlayer.ts:14`). The cache key is `voiceId(content, signature)`
where `signature = voiceConfigSignature()` — a JSON dump of the user's voice
config. This means:

- Switching from `tts-1` to `tts-1-hd` automatically invalidates the cache.
- Switching voices (`alloy` → `nova`) does the same.
- The same content synthesised with the same config always hits the cache.

The cache stores **blob URLs** (`URL.createObjectURL(blob)`), not raw bytes,
so memory is held by the browser until tab close.

### iOS Safari gotcha

Safari on iOS will not play audio on a programmatically-created `<audio>`
element without a user-gesture unlock. `voicePlayer.unlock()`
(`src/lib/voicePlayer.ts:70-81`) issues `audio.play()` followed by
`audio.pause()` from the click handler — synchronous, not awaited. This
primes the audio element so subsequent `audio.play()` calls (issued from
async fetch completion) succeed. Without this, the entire read-aloud
feature is silent on iOS.

## UI integration

### Chat composer (push-to-talk)

- `src/components/chat/view/subcomponents/ChatComposer.tsx:335-337` renders
  the mic button.
- `src/components/chat/view/subcomponents/ChatComposer.tsx:416-431` turns the
  main Submit button into "stop & send" while recording.
- The transcribed text is appended to the existing composer input via
  `setInput()` in `useChatComposerState.ts:799`, or auto-submitted if the user
  tapped the main Send button to stop.

### Assistant message read-aloud

- `src/components/chat/view/subcomponents/MessageSpeakControl.tsx` renders the
  speaker button. Hidden when `useVoiceAvailable()` is `false`.
- Mounted only on assistant messages at `MessageComponent.tsx:390`.
- Uses `useTts(() => assistantCopyContent)` so the speak target is the cleaned
  assistant copy, not raw streaming deltas.

### Settings — Voice tab

`src/components/settings/view/tabs/VoiceSettingsTab.tsx` is the only
configuration surface. Fields, in order:

1. **Enable voice** toggle (`SettingsToggle`) — drives
   `uiPreferences.voiceEnabled`.
2. **Backend section** (only shown when enabled):
   - `baseUrl` — placeholder `https://api.openai.com/v1`. Filled → direct mode.
   - `apiKey` — `type="password"`, placeholder `sk-…`.
   - `sttModel` — placeholder `whisper-1`.
   - `ttsModel` — placeholder `tts-1`.
   - `ttsVoice` — placeholder `alloy`.
   - `ttsFormat` — placeholder `mp3`.
3. Note line: *"A custom base URL is called directly by your browser and must
   allow browser CORS requests. Leave it blank to use the server-configured
   backend."*

### Quick Settings panel

`src/components/quick-settings-panel/view/QuickSettingsContent.tsx:32-34`
shows a "Voice (mic + read aloud)" toggle, but **only** if the user already
enabled voice at least once. The toggle is hidden from first-time users.

### Settings sidebar entry

`src/components/settings/view/SettingsSidebar.tsx:24` adds a "Voice" entry
with a `Mic` icon; the tab key is `'voice'` in
`src/components/settings/types/types.ts:6`.

## Persistence

Voice is **entirely client-side for user settings** — it does not write to
SQLite or `app_config`. The two relevant `localStorage` keys:

| Key | File | Shape |
|---|---|---|
| `uiPreferences` | `src/hooks/useUiPreferences.ts:147` | `{ voiceEnabled, showRawParameters, showThinking, sendByCtrlEnter, sidebarVisible, ... }` |
| `voiceConfig` | `src/hooks/useVoiceConfig.ts:12` | `{ baseUrl, apiKey, sttModel, ttsModel, ttsVoice, ttsFormat }` |

Cross-tab sync:

- `useUiPreferences` listens to both `storage` and a custom
  `ui-preferences:sync` event so other tabs pick up changes.
- `useVoiceConfig` dispatches `voice-config:sync` (a plain `Event`, not
  `CustomEvent`) when the user edits the baseUrl. `useVoiceAvailable` listens
  to this so the UI re-evaluates immediately when the user toggles direct
  mode.

Server-side env defaults (in `server/voice-proxy.js:15-20, 47-51`):

- `VOICE_API_BASE_URL` — server-controlled upstream base URL.
- `VOICE_API_KEY` — bearer key sent to the upstream.
- `VOICE_STT_MODEL` — default `whisper-1`.
- `VOICE_TTS_MODEL` — default `tts-1`.
- `VOICE_TTS_VOICE` — default `alloy`.
- `VOICE_TIMEOUT_MS` — default `300000` (5 min).

Per-request model/key/voice/format ride on `x-voice-*` headers, so the server
needs no per-user state.

## i18n

Two namespaces:

- `src/i18n/locales/{en,es}/chat.json` namespace `voice` (`chat.json:125-132`):
  tooltips for the mic button (`input`, `stopRecording`, `transcribing`) and
  the speaker button (`speak`, `stopSpeaking`, `loading`). **Complete in both
  `en` and `es`.**
- `src/i18n/locales/{en,es}/settings.json` namespace `voiceSettings`
  (`settings.json:53-67`): tab title, enable toggle, all 5 backend field
  labels, and the CORS warning. **Complete in `en`; most keys missing in
  `es`** (only `voiceSettings.voice` and `mainTabs.voice` exist on the ES
  side). Spanish users see English fallbacks for the field labels in
  Settings → Voice. This is a known gap.

`mainTabs.voice` (`settings.json:110`) — `"Voice"` / `"Voz"` — is in both.

## Configuration summary

### Server-side env

```bash
# Required to enable voice in proxy mode
VOICE_API_BASE_URL=https://api.openai.com/v1
VOICE_API_KEY=sk-...

# Optional — defaults shown
VOICE_STT_MODEL=whisper-1
VOICE_TTS_MODEL=tts-1
VOICE_TTS_VOICE=alloy
VOICE_TIMEOUT_MS=300000
```

If `VOICE_API_BASE_URL` is empty AND the user has no client-side `baseUrl` in
Settings → Voice, voice is unavailable: `/api/voice/health` returns
`{ configured: false }`, the mic button is hidden, the speaker button is
hidden, and `POST /api/voice/{transcribe,tts}` returns 503.

### Client-side (Settings → Voice)

| Field | Default | Effect when set |
|---|---|---|
| `baseUrl` | empty | Non-empty → direct mode (browser → backend, CORS required) |
| `apiKey` | empty | Bearer key for direct mode; ignored in proxy mode |
| `sttModel` | empty → falls back to server default | Passed via `x-voice-stt-model` |
| `ttsModel` | empty → falls back to server default | Passed via `x-voice-tts-model` |
| `ttsVoice` | empty → falls back to server default | Passed via `x-voice-tts-voice` |
| `ttsFormat` | empty | Optional `response_format` for `/audio/speech` |

## Security

- **`baseUrl` is server-controlled.** The proxy ignores any client attempt to
  override the upstream host (`server/voice-proxy.js:32-33`). A stolen JWT
  cannot redirect the voice backend.
- **Link-local blocked.** `isAllowedBackendUrl()` rejects `169.254/16` so
  neither the user nor an attacker can point voice traffic at cloud metadata
  endpoints.
- **`http(s)` only.** Other protocols are rejected pre-fetch.
- **`Authorization` is server-attached.** In proxy mode the upstream sees
  `Authorization: Bearer <VOICE_API_KEY>` from the server, never from the
  client. The client's `x-voice-api-key` overrides this — if you set a
  per-user key in Settings → Voice, that key reaches the upstream directly.
  The server log should still not capture it (the value rides in a request
  header, not the response).

## Known gaps

- **Spanish i18n missing for `voiceSettings.*`.** Most field labels in
  Settings → Voice fall back to English for Spanish users. Keys exist in
  `en/settings.json:53-67` and just need to be mirrored to
  `es/settings.json:53-67`.
- **No tests.** The voice module has no colocated test files. Manual smoke
  test: open Settings → Voice, enable the toggle, tap the mic in the chat
  composer, speak, tap Stop — the transcribed text should appear in the input
  box.
- **No streaming STT.** The browser sends the full recording as one multipart
  upload after the user taps Stop. There's no interim partial transcript.
- **No voice activity detection.** Recordings shorter than 800 bytes are
  rejected (`useVoiceInput.ts:91`); there is no automatic silence-cutoff.
- **Direct mode CORS.** Many self-hosted TTS/STT servers don't allow browser
  CORS by default. In that case the user must either enable CORS on the
  backend or leave `baseUrl` blank and use the proxy.

## See also

- [Provider overview](./providers/README.md) — the provider facet contract that
  voice composes with (chat composer is provider-aware, voice is provider-agnostic).
- [Claude provider](./providers/claude.md) — the canonical doc for how
  providers wire into the chat composer; voice uses the same `onVoiceTranscript`
  prop on `ChatComposer`.