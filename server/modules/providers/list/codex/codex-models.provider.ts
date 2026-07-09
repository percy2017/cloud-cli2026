import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import TOML from '@iarna/toml';

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

export const CODEX_FALLBACK_MODELS: ProviderModelsDefinition = {
  OPTIONS: [
    { value: 'gpt-5.5', label: 'gpt-5.5' },
    { value: 'MiniMax-M3', label: 'MiniMax-M3' },
    { value: 'gpt-5.4', label: 'gpt-5.4' },
    { value: 'gpt-5.4-mini', label: 'gpt-5.4-mini' },
    { value: 'gpt-5.3-codex', label: 'gpt-5.3-codex' },
    { value: 'gpt-5.2', label: 'gpt-5.2' },
  ],
  DEFAULT: 'gpt-5.4',
};

type CodexCachedModel = {
  slug?: string;
  display_name?: string;
  description?: string;
  priority?: number;
  visibility?: string;
  supported_in_api?: boolean;
};

const CODEX_MODELS_CACHE_PATH = path.join(os.homedir(), '.codex', 'models_cache.json');
const CODEX_CONFIG_PATH = path.join(os.homedir(), '.codex', 'config.toml');

const isCodexCachedModel = (value: unknown): value is CodexCachedModel => {
  const record = readObjectRecord(value);
  return Boolean(record && readOptionalString(record.slug));
};

const readCodexPriority = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
);

const mapCodexModel = (model: CodexCachedModel): ProviderModelOption => ({
  value: model.slug as string,
  label: readOptionalString(model.display_name) ?? (model.slug as string),
  description: readOptionalString(model.description),
});

type CodexConfig = {
  model: string | null;
  modelProvider: string | null;
};

const readCodexConfig = async (): Promise<CodexConfig> => {
  try {
    const raw = await readFile(CODEX_CONFIG_PATH, 'utf8');
    const parsed = readObjectRecord(TOML.parse(raw));
    return {
      model: readOptionalString(parsed?.model) ?? null,
      modelProvider: readOptionalString(parsed?.model_provider) ?? null,
    };
  } catch {
    return { model: null, modelProvider: null };
  }
};

const readCodexConfigModel = async (): Promise<string | null> => (await readCodexConfig()).model;

const buildCodexModelsDefinition = async (models: CodexCachedModel[]): Promise<ProviderModelsDefinition> => {
  // Read the user's `config.toml` first so we always know whether they are
  // routing Codex through a custom provider (MiniMax, Azure, internal proxy,
  // etc.). When that is the case, the local `models_cache.json` is poisoned:
  // it was populated against OpenAI's `/v1/models` and every slug it contains
  // will be rejected by the proxy with `invalid params, unknown model … (2013)`.
  // We must therefore *ignore* the cache entirely and use `config.toml#model`
  // as the only ground truth about what the proxy accepts.
  const { model: configModel, modelProvider } = await readCodexConfig();
  const hasCustomProvider = Boolean(modelProvider && modelProvider !== 'openai');

  if (hasCustomProvider) {
    const customOptions: ProviderModelOption[] = [];
    if (configModel) {
      customOptions.push({ value: configModel, label: configModel });
    }
    // Even with a custom provider, fall back to the static OpenAI list so the
    // picker is never empty. The user can pick `gpt-5.x` if their proxy happens
    // to forward those (Azure / vLLM often do), and the custom option stays as
    // DEFAULT so the chat composer starts on a model we *know* the proxy likes.
    const remainingFallback = CODEX_FALLBACK_MODELS.OPTIONS.filter(
      (option) => option.value !== configModel,
    );
    return {
      OPTIONS: [...customOptions, ...remainingFallback],
      DEFAULT: configModel ?? CODEX_FALLBACK_MODELS.DEFAULT,
    };
  }

  const sortedModels = [...models]
    .filter((model) => model.visibility !== 'hidden' && model.supported_in_api !== false)
    .sort((left, right) => readCodexPriority(left.priority) - readCodexPriority(right.priority));

  const options: ProviderModelOption[] = [];
  const seenValues = new Set<string>();

  for (const model of sortedModels) {
    const mappedModel = mapCodexModel(model);
    if (seenValues.has(mappedModel.value)) {
      continue;
    }

    seenValues.add(mappedModel.value);
    options.push(mappedModel);
  }

  if (options.length === 0) {
    // No dynamic cache and the user is on stock OpenAI: Codex hasn't populated
    // its cache yet. Use the static fallback list, and prefer the model the
    // user pinned in config.toml as DEFAULT so we don't override their choice.
    if (configModel && !seenValues.has(configModel)) {
      return {
        OPTIONS: [{ value: configModel, label: configModel }, ...CODEX_FALLBACK_MODELS.OPTIONS],
        DEFAULT: configModel,
      };
    }
    return CODEX_FALLBACK_MODELS;
  }

  // Stock OpenAI with a populated cache: still respect the user's pinned
  // model if it isn't already in the list — the cache can be stale.
  if (configModel && !seenValues.has(configModel)) {
    options.unshift({ value: configModel, label: configModel });
  }

  return {
    OPTIONS: options,
    DEFAULT: configModel
      ?? options[0]?.value
      ?? CODEX_FALLBACK_MODELS.DEFAULT,
  };
};

export class CodexProviderModels implements IProviderModels {
  async getSupportedModels(): Promise<ProviderModelsDefinition> {
    try {
      const raw = await readFile(CODEX_MODELS_CACHE_PATH, 'utf8');
      const parsed = readObjectRecord(JSON.parse(raw));
      const models = Array.isArray(parsed?.models)
        ? parsed.models.filter(isCodexCachedModel)
        : [];

      return await buildCodexModelsDefinition(models);
    } catch {
      // No cache: fall through to the config-aware fallback path so the
      // user can still pick a model their proxy actually accepts.
      return await buildCodexModelsDefinition([]);
    }
  }

  async getCurrentActiveModel(): Promise<ProviderCurrentActiveModel> {
    try {
      const raw = await readFile(CODEX_CONFIG_PATH, 'utf8');
      const parsed = readObjectRecord(TOML.parse(raw));
      const model = readOptionalString(parsed?.model);
      if (!model) {
        return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
      }

      return {
        model,
      };
    } catch {
      return buildDefaultProviderCurrentActiveModel(await this.getSupportedModels());
    }
  }

  async changeActiveModel(
    input: ProviderChangeActiveModelInput,
  ): Promise<ProviderSessionActiveModelChange> {
    return writeProviderSessionActiveModelChange('codex', input);
  }
}
