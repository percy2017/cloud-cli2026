import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IProviderModels } from '@/shared/interfaces.js';
import type {
  ProviderChangeActiveModelInput,
  ProviderCurrentActiveModel,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import {
  buildDefaultProviderCurrentActiveModel,
  readObjectRecord,
  readOptionalString,
  writeProviderSessionActiveModelChange,
} from '@/shared/utils.js';

const QWEN_SETTINGS_PATH = path.join(os.homedir(), '.qwen', 'settings.json');

export const QWEN_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    {
      value: 'MiniMax-M3',
      label: 'MiniMax-M3',
      description: 'MiniMax-M3',
    },
  ],
  DEFAULT: 'MiniMax-M3',
};

const readQwenSettingsModel = async (): Promise<string | null> => {
  try {
    const raw = await readFile(QWEN_SETTINGS_PATH, 'utf8');
    const parsed = readObjectRecord(JSON.parse(raw));
    const model = readObjectRecord(parsed?.model);
    const modelName = readOptionalString(model?.name);
    return modelName ?? null;
  } catch {
    return null;
  }
};

const promoteConfiguredModel = (
  configuredModel: string,
  base: ProviderModelsDefinition,
): ProviderModelsDefinition => {
  if (base.OPTIONS.some((opt) => opt.value === configuredModel)) {
    return { ...base, DEFAULT: configuredModel };
  }
  const promoted: ProviderModelOption = {
    value: configuredModel,
    label: configuredModel,
    description: configuredModel,
  };
  return {
    OPTIONS: [promoted, ...base.OPTIONS],
    DEFAULT: configuredModel,
  };
};

export class QwenProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    // The picker should only offer MiniMax-M3. If the user's `~/.qwen/settings.json`
    // pins a different model name (rare — most setups route through MiniMax now),
    // promote it and keep MiniMax-M3 as a fallback so the picker is never empty.
    const configuredModel = await readQwenSettingsModel();
    if (configuredModel && configuredModel !== 'MiniMax-M3') {
      return promoteConfiguredModel(configuredModel, QWEN_FALLBACK_MODELS);
    }
    return QWEN_FALLBACK_MODELS;
  }

  async getCurrentActiveModel(_sessionId?: string): Promise<ProviderCurrentActiveModel> {
    return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    const modelId = readOptionalString((input as { model?: unknown }).model) ?? QWEN_FALLBACK_MODELS.DEFAULT;
    return writeProviderSessionActiveModelChange('qwen', {
      ...input,
      model: modelId,
    });
  }
}