import { providerRegistry } from '@/modules/providers/provider.registry.js';
import { skillStateService } from '@/modules/providers/services/skill-state.service.js';
import type {
  LLMProvider,
  ProviderSkill,
  ProviderSkillCreateInput,
  ProviderSkillListOptions,
  ProviderSkillRemoveInput,
} from '@/shared/types.js';

export const providerSkillsService = {
  /**
   * Lists normalized skills visible to one provider.
   */
  async listProviderSkills(
    providerName: string,
    options?: ProviderSkillListOptions,
  ): Promise<ProviderSkill[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.listSkills(options);
  },

  /**
   * Writes one or more global skills for one provider.
   */
  async addProviderSkills(
    providerName: string,
    input: ProviderSkillCreateInput,
  ): Promise<ProviderSkill[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.addSkills(input);
  },

  async removeProviderSkill(
    providerName: string,
    input: ProviderSkillRemoveInput,
  ): Promise<{ removed: boolean; provider: string; directoryName: string }> {
    const provider = providerRegistry.resolveProvider(providerName);
    return provider.skills.removeSkill(input);
  },

  /**
   * Toggles the user's disable preference for a single skill, identified by its
   * `sourcePath` (canonical unique key). Does NOT touch the underlying file —
   * the skill is simply hidden from the listing with `enabled: false`.
   */
  async setSkillEnabled(
    providerName: string,
    sourcePath: string,
    enabled: boolean,
  ): Promise<{ provider: LLMProvider; sourcePath: string; enabled: boolean }> {
    const provider = providerRegistry.resolveProvider(providerName);
    const decoded = decodeURIComponent(sourcePath);
    skillStateService.setSkillEnabled(provider.id, decoded, enabled);
    return { provider: provider.id, sourcePath: decoded, enabled };
  },

  /**
   * Bulk enable/disable every skill currently listed for the provider. With
   * `enabled: true` the disabled set is emptied; with `enabled: false` every
   * currently-listed skill's `sourcePath` is added to the disabled set.
   *
   * Skills not in the supplied list are left untouched when enabling (only
   * listed skills are removed from the set, not arbitrary entries).
   */
  async setAllSkillsEnabled(
    providerName: string,
    enabled: boolean,
    options?: ProviderSkillListOptions,
  ): Promise<{ provider: LLMProvider; disabledKeys: string[] }> {
    const provider = providerRegistry.resolveProvider(providerName);
    const skills = await provider.skills.listSkills(options);
    skillStateService.setAllSkillsEnabled(provider.id, skills, enabled);
    return { provider: provider.id, disabledKeys: skillStateService.listDisabledKeys(provider.id) };
  },

  /** Returns the current disabled-key set for a provider (useful for the UI). */
  async listDisabledKeys(providerName: string): Promise<string[]> {
    const provider = providerRegistry.resolveProvider(providerName);
    return skillStateService.listDisabledKeys(provider.id);
  },
};
