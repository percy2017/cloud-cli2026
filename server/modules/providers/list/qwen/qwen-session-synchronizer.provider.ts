import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';

import { sessionsDb } from '@/modules/database/index.js';
import {
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import type { AnyRecord } from '@/shared/types.js';

type QwenJsonlMetadata = {
  sessionId: string;
  cwd?: string;
  firstUserMessage?: string;
};

/**
 * Session indexer for Qwen Code transcripts.
 *
 * Qwen Code stores transcripts at `~/.qwen/projects/<sanitized-cwd>/chats/<session-id>.jsonl`.
 * The sanitization rule replaces every non-`[A-Za-z0-9-]` run with `-` (mirror of Claude's encoding).
 *
 * Format confirmed against `~/.qwen/projects/-opt-cloud-cli2026/chats/*.jsonl`:
 *   { "uuid":"...", "parentUuid":null, "sessionId":"...", "timestamp":"...",
 *     "type":"user", "cwd":"/path/to/cwd", "version":"0.19.7",
 *     "gitBranch":"master",
 *     "message":{"role":"user","parts":[{"text":"..."}]} }
 */
export class QwenSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider = 'qwen' as const;
  private readonly qwenHome = path.join(os.homedir(), '.qwen');

  /**
   * Scans Qwen transcript JSONL files and upserts sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.qwenHome, 'projects'),
      '.jsonl',
      since ?? null,
    );

    let processed = 0;
    for (const filePath of files) {
      // Only index files inside `chats/` directories to mirror the Gemini pattern
      // (subagent transcripts live in sibling `subagents/` folders and would
      // clobber the parent row if indexed).
      if (!filePath.includes(`${path.sep}chats${path.sep}`)) {
        continue;
      }

      const parsed = await this.processJsonlSessionFile(filePath);
      if (!parsed) {
        continue;
      }

      const timestamps = await readFileTimestamps(filePath);
      sessionsDb.createSession(
        parsed.sessionId,
        this.provider,
        parsed.projectPath,
        parsed.sessionName,
        timestamps.createdAt,
        timestamps.updatedAt,
        filePath,
      );
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Qwen JSONL artifact.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }

    if (!filePath.includes(`${path.sep}chats${path.sep}`)) {
      return null;
    }

    const parsed = await this.processJsonlSessionFile(filePath);
    if (!parsed) {
      return null;
    }

    const timestamps = await readFileTimestamps(filePath);
    return sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.sessionName,
      timestamps.createdAt,
      timestamps.updatedAt,
      filePath,
    );
  }

  /**
   * Reads first useful metadata from one Qwen JSONL file.
   */
  private async processJsonlSessionFile(filePath: string): Promise<{
    sessionId: string;
    projectPath: string;
    sessionName: string;
  } | null> {
    const metadata = await this.extractJsonlMetadata(filePath);
    if (!metadata || !metadata.cwd) {
      return null;
    }

    return {
      sessionId: metadata.sessionId,
      projectPath: metadata.cwd,
      sessionName: normalizeSessionName(metadata.firstUserMessage, 'Untitled Qwen Session'),
    };
  }

  /**
   * Walks the JSONL lines once, extracting sessionId, cwd, and the first user message.
   */
  private async extractJsonlMetadata(filePath: string): Promise<QwenJsonlMetadata | null> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split('\n');

      let sessionId: string | undefined;
      let cwd: string | undefined;
      let firstUserMessage: string | undefined;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }

        let parsed: AnyRecord;
        try {
          parsed = JSON.parse(trimmed) as AnyRecord;
        } catch {
          continue;
        }

        if (!sessionId && typeof parsed.sessionId === 'string') {
          sessionId = parsed.sessionId;
        }
        if (!cwd && typeof parsed.cwd === 'string' && parsed.cwd.trim()) {
          cwd = parsed.cwd.trim();
        }

        if (!firstUserMessage && parsed.type === 'user') {
          const text = this.extractQwenUserText(parsed.message);
          if (text) {
            firstUserMessage = text;
          }
        }

        if (sessionId && cwd && firstUserMessage) {
          break;
        }
      }

      if (!sessionId || !cwd) {
        return null;
      }

      return {
        sessionId,
        cwd,
        firstUserMessage,
      };
    } catch {
      return null;
    }
  }

  /**
   * Qwen CLI user messages carry `message.parts[].text` (mirror of Claude's structure).
   */
  private extractQwenUserText(message: unknown): string | undefined {
    const record = (message && typeof message === 'object')
      ? (message as AnyRecord)
      : null;
    if (!record) {
      return undefined;
    }

    const parts = Array.isArray(record.parts) ? record.parts : null;
    if (parts) {
      for (const part of parts) {
        if (part && typeof part === 'object') {
          const text = (part as AnyRecord).text;
          if (typeof text === 'string' && text.trim()) {
            return text;
          }
        }
      }
    }

    if (typeof record.content === 'string' && record.content.trim()) {
      return record.content;
    }

    return undefined;
  }
}