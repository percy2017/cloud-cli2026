import { readFile } from 'node:fs/promises';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type { AnyRecord, FetchHistoryOptions, FetchHistoryResult, NormalizedMessage } from '@/shared/types.js';
import {
  createNormalizedMessage,
  generateMessageId,
  normalizeProviderTimestamp,
  readObjectRecord,
  readOptionalString,
  sliceTailPage,
} from '@/shared/utils.js';

const PROVIDER = 'qwen';

/**
 * Streaming event shapes emitted by `qwen --output-format stream-json`.
 *
 *   { "type":"user",         "message":{"role":"user","parts":[{"text":"..."}]},   "sessionId":"...", "timestamp":"..." }
 *   { "type":"assistant",    "message":{"role":"assistant","content":[...]},      "sessionId":"...", "timestamp":"..." }
 *   { "type":"tool_use",     "tool_name":"...", "tool_input":{...},                "sessionId":"...", "timestamp":"..." }
 *   { "type":"tool_result",  "tool_use_id":"...", "content":"...",                 "sessionId":"...", "timestamp":"..." }
 *   { "type":"thinking",     "content":"...",                                      "sessionId":"...", "timestamp":"..." }
 *   { "type":"result",       "sessionId":"...", "duration_ms":..., "result":"..." }
 *
 * Confirmed against `~/.qwen/projects/<sanitized-cwd>/chats/*.jsonl`.
 */
export class QwenSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one streaming event into the shared NormalizedMessage shape.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    const type = readOptionalString(raw.type) ?? readOptionalString(raw.event);
    const eventSessionId = readOptionalString(raw.sessionId) ?? sessionId;
    const timestamp = normalizeProviderTimestamp(raw.timestamp ?? raw.time);
    const baseId = readOptionalString(raw.uuid)
      ?? readOptionalString(raw.id)
      ?? generateMessageId('qwen');

    if (type === 'user') {
      const text = this.extractUserText(raw.message);
      if (!text.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'text',
        role: 'user',
        content: text,
      })];
    }

    if (type === 'assistant') {
      // Qwen 0.19.x writes assistant messages with `message: { role: "model",
      // parts: [{ text, thought?: boolean }, ...] }`. We emit EACH part as its
      // own NormalizedMessage — `thought: true` parts become `kind:'thinking'`
      // and visible parts become `kind:'text'` — so the UI can render them
      // separately instead of concatenating reasoning into the visible reply.
      // The old Anthropic-style `{ content: [...] }` envelope is still accepted
      // as a forward-compat fallback.
      const parts = this.collectAssistantParts(raw.message);

      if (parts.length === 0) {
        return [];
      }

      const messages: NormalizedMessage[] = [];
      let partIndex = 0;
      for (const part of parts) {
        const partId = `${baseId}_${part.kind}_${partIndex++}`;
        if (part.kind === 'thinking') {
          messages.push(createNormalizedMessage({
            id: partId,
            sessionId: eventSessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'thinking',
            content: part.text,
          }));
        } else {
          messages.push(createNormalizedMessage({
            id: partId,
            sessionId: eventSessionId,
            timestamp,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: part.text,
          }));
        }
      }

      const usage = readObjectRecord(raw.usageMetadata);
      if (usage && messages.length > 0) {
        const last = messages[messages.length - 1];
        const tokenUsage = this.extractUsageMetadata(usage);
        if (tokenUsage) {
          (last as NormalizedMessage & { tokenUsage?: unknown }).tokenUsage = tokenUsage;
        }
      }

      return messages;
    }

    if (type === 'thinking') {
      const directContent = readOptionalString(raw.content);
      const content = directContent ?? (() => {
        // Legacy fallback: a `thinking` event without its own content field
        // may still carry a single visible part under `message.parts[]`.
        const parts = this.collectAssistantParts(raw.message);
        const visible = parts.find((p) => p.kind === 'text');
        return visible?.text;
      })() ?? '';
      if (!content.trim()) {
        return [];
      }
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'thinking',
        content,
      })];
    }

    if (type === 'tool_use') {
      const toolName = readOptionalString(raw.tool_name)
        ?? readOptionalString(raw.name)
        ?? 'Tool';
      const toolId = readOptionalString(raw.tool_use_id)
        ?? readOptionalString(raw.id)
        ?? baseId;
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName,
        toolInput: readObjectRecord(raw.tool_input) ?? readObjectRecord(raw.input) ?? {},
        toolId,
      })];
    }

    if (type === 'tool_result') {
      const toolId = readOptionalString(raw.tool_use_id)
        ?? readOptionalString(raw.id)
        ?? baseId;
      const content = typeof raw.content === 'string'
        ? raw.content
        : JSON.stringify(raw.content ?? '');
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId,
        content,
        toolResult: { content, isError: false },
      })];
    }

    if (type === 'error') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'error',
        content: readOptionalString(raw.error) ?? readOptionalString(raw.message) ?? 'Unknown Qwen error',
      })];
    }

    if (type === 'result') {
      return [createNormalizedMessage({
        id: baseId,
        sessionId: eventSessionId,
        timestamp,
        provider: PROVIDER,
        kind: 'stream_end',
      })];
    }

    return [];
  }

  /**
   * Loads Qwen transcript history from the JSONL file indexed by the synchronizer.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const filePath = options.jsonlPath;
    if (!filePath) {
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split('\n');

      const normalized: NormalizedMessage[] = [];
      // Track tool_use ids so we can attach their result as toolResult.
      const toolIdToMessageIndex = new Map<string, number>();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let parsed: AnyRecord;
        try {
          parsed = JSON.parse(trimmed) as AnyRecord;
        } catch {
          continue;
        }

        const messages = this.normalizeMessage(parsed, sessionId);
        for (const message of messages) {
          const idx = normalized.length;
          normalized.push(message);

          if (message.kind === 'tool_use' && message.toolId) {
            toolIdToMessageIndex.set(message.toolId, idx);
          }
          if (message.kind === 'tool_result' && message.toolId) {
            const parentIdx = toolIdToMessageIndex.get(message.toolId);
            if (parentIdx !== undefined && normalized[parentIdx]) {
              normalized[parentIdx].toolResult = message.toolResult;
            }
          }
        }
      }

      const normalizedOffset = Math.max(0, offset);
      const normalizedLimit = limit === null ? null : Math.max(0, limit);
      const total = normalized.length;
      const { page, hasMore } = sliceTailPage(normalized, normalizedLimit, normalizedOffset);

      return {
        messages: page,
        total,
        hasMore,
        offset: normalizedOffset,
        limit: normalizedLimit,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[QwenProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }
  }

  private extractUserText(message: unknown): string {
    const record = readObjectRecord(message);
    if (!record) {
      return '';
    }

    const parts = Array.isArray(record.parts) ? record.parts : null;
    if (parts) {
      const collected: string[] = [];
      for (const part of parts) {
        const partRecord = readObjectRecord(part);
        const text = readOptionalString(partRecord?.text);
        if (text) {
          collected.push(text);
        }
      }
      if (collected.length > 0) {
        return collected.join('');
      }
    }

    if (typeof record.content === 'string') {
      return record.content;
    }

    return '';
  }

  /**
   * Collects ordered text parts from a Qwen assistant message envelope.
   *
   * Qwen 0.19.x writes assistant rows as `{ role: "model", parts: [...] }`
   * (verified against `~/.qwen/projects/-opt-cloud-cli2026/chats/*.jsonl`).
   * Each entry can be:
   *   - `{ text: "...", thought?: boolean }`           → Qwen 0.19.x format
   *   - `{ type: "text" | "thinking", text: "..." }`   → Anthropic-style part
   *
   * Returns one entry per non-empty part tagged as `thinking` or `text` so the
   * caller can emit each as a separate `NormalizedMessage` instead of
   * concatenating reasoning into the visible reply. Falls back to a single
   * `text` entry when only the legacy `message.content` (string or array) is
   * present.
   */
  private collectAssistantParts(
    message: unknown,
  ): Array<{ kind: 'text' | 'thinking'; text: string }> {
    const record = readObjectRecord(message);
    if (!record) {
      return [];
    }

    const out: Array<{ kind: 'text' | 'thinking'; text: string }> = [];

    const parts = Array.isArray(record.parts) ? record.parts : null;
    if (parts) {
      for (const part of parts) {
        const partRecord = readObjectRecord(part);
        if (!partRecord) {
          continue;
        }
        const text = readOptionalString(partRecord.text);
        if (!text) {
          continue;
        }
        const isThought = partRecord.thought === true
          || partRecord.type === 'thinking';
        out.push({ kind: isThought ? 'thinking' : 'text', text });
      }
      if (out.length > 0) {
        return out;
      }
    }

    const content = record.content;
    if (typeof content === 'string' && content.trim()) {
      return [{ kind: 'text', text: content }];
    }

    if (Array.isArray(content)) {
      for (const part of content) {
        const partRecord = readObjectRecord(part);
        if (!partRecord) {
          continue;
        }
        const text = readOptionalString(partRecord.text);
        if (!text) {
          continue;
        }
        const isThought = partRecord.type === 'thinking'
          || partRecord.thought === true;
        out.push({ kind: isThought ? 'thinking' : 'text', text });
      }
    }

    return out;
  }

  /**
   * Maps Qwen's `usageMetadata` (from the assistant row envelope) onto the
   * canonical `tokenUsage` shape used by `sessionStore`. Returns `null` when
   * the metadata is missing or zeroed so callers can skip the assignment.
   */
  private extractUsageMetadata(raw: AnyRecord): {
    input: number;
    output: number;
    cached: number;
    total: number;
  } | null {
    const input = Number(raw.promptTokenCount ?? raw.inputTokenCount ?? 0);
    const output = Number(raw.candidatesTokenCount ?? raw.outputTokenCount ?? 0);
    const cached = Number(raw.cachedContentTokenCount ?? raw.cachedTokenCount ?? 0);
    const thoughts = Number(raw.thoughtsTokenCount ?? 0);
    const total = Number(raw.totalTokenCount ?? input + output + cached + thoughts);

    if (!input && !output && !cached && !total) {
      return null;
    }

    return { input, output, cached, total };
  }
}