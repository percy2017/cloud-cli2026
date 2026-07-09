import { QwenProviderAuth } from '@/modules/providers/list/qwen/qwen-auth.provider.js';
import { QwenProviderModels } from '@/modules/providers/list/qwen/qwen-models.provider.js';
import { QwenMcpProvider } from '@/modules/providers/list/qwen/qwen-mcp.provider.js';
import { QwenSessionSynchronizer } from '@/modules/providers/list/qwen/qwen-session-synchronizer.provider.js';
import { QwenSessionsProvider } from '@/modules/providers/list/qwen/qwen-sessions.provider.js';
import { QwenSkillsProvider } from '@/modules/providers/list/qwen/qwen-skills.provider.js';
import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';

export class QwenProvider extends AbstractProvider {
  readonly models: IProviderModels = new QwenProviderModels();
  readonly mcp = new QwenMcpProvider();
  readonly auth: IProviderAuth = new QwenProviderAuth();
  readonly skills: IProviderSkills = new QwenSkillsProvider();
  readonly sessions: IProviderSessions = new QwenSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new QwenSessionSynchronizer();

  constructor() {
    super('qwen');
  }
}