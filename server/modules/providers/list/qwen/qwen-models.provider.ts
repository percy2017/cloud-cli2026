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
      value: 'qwen3-coder-plus',
      label: 'Qwen3 Coder Plus',
      description: 'qwen3-coder-plus',
    },
    {
      value: 'qwen3-max',
      label: 'Qwen3 Max',
      description: 'qwen3-max',
    },
    {
      value: 'qwen3-vl-plus',
      label: 'Qwen3 VL Plus',
      description: 'qwen3-vl-plus',
    },
    {
      value: 'qwen3-coder-flash',
      label: 'Qwen3 Coder Flash',
      description: 'qwen3-coder-flash',
    },
  ],
  DEFAULT: 'qwen3-coder-plus',
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
    // Qwen CLI doesn't expose a `models` command as of 0.19.x. The single
    // ground truth for what's actually accepted by the upstream is
    // `~/.qwen/settings.json#model.name` — when the user is talking to a
    // custom `modelProvider` (e.g. anthropic → api.minimax.io), the static
    // `QWEN_FALLBACK_MODELS` slugs (`qwen3-coder-plus`, …) won't be
    // recognised by the proxy and Qwen would reject them with
    // "unknown model … (2013)". Promote the configured model to DEFAULT
    // (and prepend it to OPTIONS so it's visible in the picker); keep the
    // fallback list as suggestions for users who haven't customised.
    const configuredModel = await readQwenSettingsModel();
    if (configuredModel) {
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