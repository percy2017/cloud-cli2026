import { spawn } from 'node:child_process';

import crossSpawn from 'cross-spawn';

import { sessionsService } from './modules/providers/services/sessions.service.js';
import { providerAuthService } from './modules/providers/services/provider-auth.service.js';
import { providerModelsService } from './modules/providers/services/provider-models.service.js';
import { notifyRunFailed, notifyRunStopped } from './services/notification-orchestrator.js';
import { createCompleteMessage, createNormalizedMessage } from './shared/utils.js';

const spawnFunction = process.platform === 'win32' ? crossSpawn : spawn;

const activeQwenProcesses = new Map();

function readQwenSessionId(event) {
  if (!event || typeof event !== 'object') {
    return null;
  }

  return event.sessionId || event.sessionID || null;
}

async function spawnQwen(command, options = {}, ws) {
  return new Promise((resolve, reject) => {
    const { sessionId, projectPath, cwd, model, sessionSummary, permissionMode } = options;
    const workingDir = cwd || projectPath || process.cwd();
    const processKey = sessionId || Date.now().toString();
    let capturedSessionId = sessionId || null;
    let sessionCreatedSent = false;
    let stdoutLineBuffer = '';
    let terminalNotificationSent = false;
    let qwenProcess = null;
    // Cumulative token usage across the run. Each `assistant` row in the
    // qwen 0.19.x stream carries its own `usageMetadata` snapshot (NOT a
    // running total) so we add them up here to feed the frontend's
    // `/cost` modal and the composer token counter. Mirrors the
    // `status: 'token_budget'` channel that Claude emits in
    // `server/claude-sdk.js:726`.
    let cumulativeTokenUsage = {
      input: 0,
      output: 0,
      cached: 0,
      total: 0,
    };
    // Unified lifecycle contract: exactly one terminal `complete` per run.
    let completeSent = false;
    // qwen 0.19.x writes a single `result.success` frame to stdout BEFORE
    // exiting. If we saw it, the run was successful regardless of the exit
    // code (the CLI exits non-zero just to surface the YOLO/headless warning
    // on stderr, not because anything failed). Tracks whether to treat the
    // close as success.
    let resultSuccessSeen = false;

    const notifyTerminalState = ({ code = null, error = null } = {}) => {
      if (terminalNotificationSent) {
        return;
      }

      terminalNotificationSent = true;
      const finalSessionId = capturedSessionId || sessionId || processKey;
      if (code === 0 && !error) {
        notifyRunStopped({
          userId: ws?.userId || null,
          provider: 'qwen',
          sessionId: finalSessionId,
          sessionName: sessionSummary,
          stopReason: 'completed',
        });
        return;
      }

      notifyRunFailed({
        userId: ws?.userId || null,
        provider: 'qwen',
        sessionId: finalSessionId,
        sessionName: sessionSummary,
        error: error || `Qwen CLI exited with code ${code}`,
      });
    };

    const registerSession = (nextSessionId) => {
      if (!nextSessionId || capturedSessionId === nextSessionId) {
        return;
      }

      capturedSessionId = nextSessionId;
      if (processKey !== capturedSessionId && qwenProcess) {
        activeQwenProcesses.delete(processKey);
        activeQwenProcesses.set(capturedSessionId, qwenProcess);
      }
      if (qwenProcess) {
        qwenProcess.sessionId = capturedSessionId;
      }

      if (ws.setSessionId && typeof ws.setSessionId === 'function') {
        ws.setSessionId(capturedSessionId);
      }

      if (!sessionId && !sessionCreatedSent) {
        sessionCreatedSent = true;
        ws.send(createNormalizedMessage({
          kind: 'session_created',
          newSessionId: capturedSessionId,
          sessionId: capturedSessionId,
          provider: 'qwen',
        }));
      }
    };

    const processQwenOutputLine = (line) => {
      if (!line || !line.trim()) {
        return;
      }

      let response;
      try {
        response = JSON.parse(line);
      } catch {
        ws.send(createNormalizedMessage({
          kind: 'stream_delta',
          content: line,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'qwen',
        }));
        return;
      }

      try {
        registerSession(readQwenSessionId(response));
        // Track terminal success even before `qwenProcess.on('close')` fires:
        // qwen 0.19.x prints a non-zero exit when it's just emitting the
        // headless/YOLO warning on stderr. If we observed `result.success`
        // on stdout, the run is good and we should treat the close as such.
        if (response?.type === 'result' && response?.subtype === 'success') {
          resultSuccessSeen = true;
        }
        // Accumulate per-row usage so the composer token counter and the
        // /cost modal have a running total. Qwen emits `usageMetadata` at
        // the TOP LEVEL of every `assistant` row (not nested under
        // message.parts[]), per docs/providers/qwen.md §7.3.
        if (response?.type === 'assistant' && response?.usageMetadata
            && typeof response.usageMetadata === 'object') {
          const u = response.usageMetadata;
          cumulativeTokenUsage = {
            input: cumulativeTokenUsage.input
              + Number(u.promptTokenCount ?? u.inputTokenCount ?? 0),
            output: cumulativeTokenUsage.output
              + Number(u.candidatesTokenCount ?? u.outputTokenCount ?? 0),
            cached: cumulativeTokenUsage.cached
              + Number(u.cachedContentTokenCount ?? u.cachedTokenCount ?? 0),
            total: cumulativeTokenUsage.total
              + Number(u.totalTokenCount
                ?? (Number(u.promptTokenCount ?? 0)
                  + Number(u.candidatesTokenCount ?? 0)
                  + Number(u.cachedContentTokenCount ?? 0)
                  + Number(u.thoughtsTokenCount ?? 0))),
          };
          ws.send(createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget: {
              inputTokens: cumulativeTokenUsage.input,
              outputTokens: cumulativeTokenUsage.output,
              cacheReadTokens: cumulativeTokenUsage.cached,
              totalTokens: cumulativeTokenUsage.total,
              // Shape that /cost command also reads (commands.js:262-280).
              used: cumulativeTokenUsage.total,
              total: cumulativeTokenUsage.total,
              input: cumulativeTokenUsage.input,
              output: cumulativeTokenUsage.output,
              cached: cumulativeTokenUsage.cached,
            },
            sessionId: capturedSessionId || sessionId || null,
            provider: 'qwen',
          }));
        }
        const normalized = sessionsService.normalizeMessage(
          'qwen',
          response,
          capturedSessionId || sessionId || null,
        );
        for (const msg of normalized) {
          ws.send(msg);
        }
      } catch (error) {
        const errorContent = error instanceof Error ? error.message : String(error);
        console.error('[Qwen] Failed to process JSON output:', errorContent);
        ws.send(createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'qwen',
        }));
      }
    };

    void providerModelsService.resolveResumeModel('qwen', sessionId, model).then((resolvedModel) => {
      const args = [];
      const trimmedCommand = command?.trim() || '';
      if (sessionId) {
        // `-r, --resume <string>` — resume a specific session by id
        args.push('-r', sessionId);
        // In resume mode we ALSO pass `-p <text>`. Without it, qwen 0.19.8
        // treats the run as interactive and aborts with
        // "No input provided via stdin. Input can be provided by piping
        // data into gemini or using the --prompt option." even though `-r`
        // should be enough on its own. Verified: `qwen --help` documents
        // `-p` as "Prompt. Appended to input on stdin (if any)." — in 0.19.8
        // resume mode the prompt is required, not optional. We only forward
        // the user message if there is one to avoid an empty `-p ''` arg.
        if (trimmedCommand) {
          args.push('-p', trimmedCommand);
        }
      } else {
        // `-p, --prompt <string>` — non-interactive single prompt. We do NOT use
        // `-i` (--prompt-interactive) because qwen CLI rejects it when stdin is
        // a pipe that has been closed (`stdin.end()`). Verified: passing `-i`
        // plus a closed pipe yields "Error: The --prompt-interactive flag
        // cannot be used when input is piped from stdin." in qwen 0.19.8. The
        // non-interactive `-p` flag is compatible with closed pipes and is what
        // Gemini's spawner uses for the same reason (see server/gemini-cli.js).
        args.push('-p', trimmedCommand);
      }
      if (resolvedModel) {
        args.push('-m', resolvedModel);
      }

      // Permission mode mapping → qwen CLI flags. Verified against qwen 0.19.8:
      //   - 'default'           → no flag (CLI default; user approves per tool)
      //   - 'plan'              → --approval-mode plan (no tool execution)
      //   - 'auto-edit'         → --approval-mode auto-edit (auto-approve edits)
      //   - 'bypassPermissions' → --approval-mode yolo (auto-approve all)
      // The bare --yolo flag is an alias for --approval-mode yolo but we use the
      // explicit form for symmetry with the other modes.
      if (permissionMode && permissionMode !== 'default') {
        const qwenApprovalMode =
          permissionMode === 'plan' ? 'plan'
          : permissionMode === 'auto-edit' ? 'auto-edit'
          : permissionMode === 'bypassPermissions' ? 'yolo'
          : null;
        if (qwenApprovalMode) {
          args.push('--approval-mode', qwenApprovalMode);
        }
      }

      // Streaming JSON output (verified for qwen 0.19.7; no --include-partial-messages flag)
      args.push('--output-format', 'stream-json');

      qwenProcess = spawnFunction('qwen', args, {
        cwd: workingDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      activeQwenProcesses.set(processKey, qwenProcess);
      qwenProcess.sessionId = processKey;
      // Stdin handling differs by mode:
      //   - resume (-r <id>): CLI enters interactive mode and needs stdin to
      //     stay OPEN. Closing it triggers "No input provided via stdin" in
      //     qwen 0.19.8 even though -r is enough on its own.
      //   - fresh (-p <text>): CLI runs the prompt non-interactively and
      //     refuses to start if stdin is a pipe that is then closed, so we
      //     must signal EOF here.
      if (!sessionId) {
        qwenProcess.stdin.end();
      }

      qwenProcess.stdout.on('data', (data) => {
        stdoutLineBuffer += data.toString();
        const completeLines = stdoutLineBuffer.split(/\r?\n/);
        stdoutLineBuffer = completeLines.pop() || '';

        completeLines.forEach((line) => {
          processQwenOutputLine(line.trim());
        });
      });

      qwenProcess.stderr.on('data', (data) => {
        const stderrText = data.toString();
        if (!stderrText.trim()) {
          return;
        }

        // qwen 0.19.x writes informational notices (YOLO/sandbox warning,
        // deprecation hints, …) to stderr and exits non-zero — these are
        // NOT real failures. Only forward stderr as `kind:'error'` when it
        // looks like an actual failure (starts with "Error:" or contains
        // a non-zero code-shape pattern). Everything else is logged at
        // warn level so the UI doesn't show a red banner for a successful
        // run that just printed a sandbox notice.
        const trimmed = stderrText.trim();
        const looksLikeError =
          /^Error:/i.test(trimmed)
          || /\bENOENT\b/i.test(trimmed)
          || /\binvalid params\b/i.test(trimmed)
          || /\bpermission_denied\b/i.test(trimmed);
        if (!looksLikeError) {
          console.warn('[Qwen] stderr:', trimmed);
          return;
        }

        ws.send(createNormalizedMessage({
          kind: 'error',
          content: trimmed,
          sessionId: capturedSessionId || sessionId || null,
          provider: 'qwen',
        }));
      });

      qwenProcess.on('close', async (code) => {
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeQwenProcesses.delete(finalSessionId);
        activeQwenProcesses.delete(processKey);

        if (stdoutLineBuffer.trim()) {
          processQwenOutputLine(stdoutLineBuffer.trim());
          stdoutLineBuffer = '';
        }

        if (cumulativeTokenUsage.total > 0) {
          // Final token_budget emit on close — covers the edge case where
          // the last assistant row had no usageMetadata (e.g. truncated
          // run) so the frontend still gets a non-zero total when the
          // user opens /cost right after `complete`.
          ws.send(createNormalizedMessage({
            kind: 'status',
            text: 'token_budget',
            tokenBudget: {
              inputTokens: cumulativeTokenUsage.input,
              outputTokens: cumulativeTokenUsage.output,
              cacheReadTokens: cumulativeTokenUsage.cached,
              totalTokens: cumulativeTokenUsage.total,
              used: cumulativeTokenUsage.total,
              total: cumulativeTokenUsage.total,
              input: cumulativeTokenUsage.input,
              output: cumulativeTokenUsage.output,
              cached: cumulativeTokenUsage.cached,
            },
            sessionId: finalSessionId,
            provider: 'qwen',
          }));
        }

        if (!completeSent && !qwenProcess.aborted) {
          completeSent = true;
          ws.send(createCompleteMessage({ provider: 'qwen', sessionId: finalSessionId, exitCode: code }));
        }

        if (code === 0 || resultSuccessSeen) {
          notifyTerminalState({ code: 0 });
          resolve();
          return;
        }

        if (code === 127 || code === null) {
          const installed = await providerAuthService.isProviderInstalled('qwen');
          if (!installed) {
            ws.send(createNormalizedMessage({
              kind: 'error',
              content: 'Qwen CLI is not installed. Install it with `npm i -g @qwen-code/qwen-code`.',
              sessionId: finalSessionId,
              provider: 'qwen',
            }));
          }
        }

        notifyTerminalState({ code });
        reject(new Error(code === null ? 'Qwen CLI process was terminated' : `Qwen CLI exited with code ${code}`));
      });

      qwenProcess.on('error', async (error) => {
        const finalSessionId = capturedSessionId || sessionId || processKey;
        activeQwenProcesses.delete(finalSessionId);
        activeQwenProcesses.delete(processKey);

        const installed = await providerAuthService.isProviderInstalled('qwen');
        const errorContent = !installed
          ? 'Qwen CLI is not installed. Install it with `npm i -g @qwen-code/qwen-code`.'
          : error.message;

        ws.send(createNormalizedMessage({
          kind: 'error',
          content: errorContent,
          sessionId: finalSessionId,
          provider: 'qwen',
        }));
        if (!completeSent && !qwenProcess.aborted) {
          completeSent = true;
          ws.send(createCompleteMessage({ provider: 'qwen', sessionId: finalSessionId, exitCode: 1 }));
        }
        notifyTerminalState({ error });
        reject(error);
      });
    }).catch(reject);
  });
}

function abortQwenSession(sessionId) {
  const process = activeQwenProcesses.get(sessionId);
  if (!process) {
    return false;
  }

  process.aborted = true;
  process.kill('SIGTERM');
  activeQwenProcesses.delete(sessionId);
  return true;
}

function isQwenSessionActive(sessionId) {
  return activeQwenProcesses.has(sessionId);
}

function getActiveQwenSessions() {
  return Array.from(activeQwenProcesses.keys());
}

export {
  spawnQwen,
  abortQwenSession,
  isQwenSessionActive,
  getActiveQwenSessions,
};