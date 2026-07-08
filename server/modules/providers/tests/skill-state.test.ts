import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { appConfigDb } from '@/modules/database/index.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { skillStateService } from '@/modules/providers/services/skill-state.service.js';

const DISABLED_KEY = 'disabled_skills';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as any).homedir = () => nextHomeDir;
  return () => {
    (os as any).homedir = original;
  };
};

const resetState = () => {
  appConfigDb.set(DISABLED_KEY, JSON.stringify({}));
};

const writeSkill = async (
  skillsRoot: string,
  directoryName: string,
  name: string,
  description: string,
): Promise<string> => {
  const skillDir = path.join(skillsRoot, directoryName);
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  await fs.writeFile(
    skillPath,
    `---\nname: ${name}\ndescription: ${description}\n---\n\n`,
    'utf8',
  );
  return skillPath;
};

test('skillStateService readDisabledSet returns empty set when no state persisted', () => {
  resetState();
  assert.equal(skillStateService.readDisabledSet('claude').size, 0);
  assert.deepEqual(skillStateService.listDisabledKeys('claude'), []);
});

test('skillStateService setSkillEnabled adds and removes keys idempotently', () => {
  resetState();
  const key = '/home/user/.claude/skills/foo/SKILL.md';

  skillStateService.setSkillEnabled('claude', key, false);
  assert.deepEqual(skillStateService.listDisabledKeys('claude'), [key]);

  // Idempotent in the disabled direction.
  skillStateService.setSkillEnabled('claude', key, false);
  assert.deepEqual(skillStateService.listDisabledKeys('claude'), [key]);

  // Re-enable removes the key.
  skillStateService.setSkillEnabled('claude', key, true);
  assert.deepEqual(skillStateService.listDisabledKeys('claude'), []);

  // Idempotent in the enabled direction.
  skillStateService.setSkillEnabled('claude', key, true);
  assert.deepEqual(skillStateService.listDisabledKeys('claude'), []);
});

test('skillStateService keeps providers independent', () => {
  resetState();
  const claudeKey = '/home/user/.claude/skills/foo/SKILL.md';
  const codexKey = '/home/user/.codex/skills/foo/SKILL.md';

  skillStateService.setSkillEnabled('claude', claudeKey, false);
  skillStateService.setSkillEnabled('codex', codexKey, false);

  assert.deepEqual(skillStateService.listDisabledKeys('claude'), [claudeKey]);
  assert.deepEqual(skillStateService.listDisabledKeys('codex'), [codexKey]);
  assert.equal(skillStateService.listDisabledKeys('gemini').length, 0);
});

test('listProviderSkills stamps enabled=false on disabled skills and enabled=true otherwise', async (t) => {
  resetState();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-stamp-'));
  const restoreHome = patchHomeDir(tempRoot);
  const skillsRoot = path.join(tempRoot, '.gemini', 'skills');
  t.after(async () => {
    restoreHome();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const fooPath = await writeSkill(skillsRoot, 'foo', 'foo', 'Foo skill');
  const barPath = await writeSkill(skillsRoot, 'bar', 'bar', 'Bar skill');

  // Pre-disable foo.
  skillStateService.setSkillEnabled('gemini', fooPath, false);

  const skills = await providerSkillsService.listProviderSkills('gemini');
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));

  assert.ok(byName.foo, 'foo should be present in the listing');
  assert.ok(byName.bar, 'bar should be present in the listing');
  assert.equal(byName.foo.enabled, false, 'foo should be stamped enabled=false');
  assert.equal(byName.bar.enabled, true, 'bar should be stamped enabled=true');
});

test('setAllSkillsEnabled bulk-disables every currently-listed skill', async (t) => {
  resetState();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-bulk-'));
  const restoreHome = patchHomeDir(tempRoot);
  const skillsRoot = path.join(tempRoot, '.cursor', 'skills');
  t.after(async () => {
    restoreHome();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const fooPath = await writeSkill(skillsRoot, 'foo', 'foo', 'Foo');
  const barPath = await writeSkill(skillsRoot, 'bar', 'bar', 'Bar');

  await providerSkillsService.setAllSkillsEnabled('cursor', false);
  const disabled = skillStateService.listDisabledKeys('cursor').sort();
  assert.deepEqual(disabled, [barPath, fooPath].sort());

  // Now re-enable all.
  await providerSkillsService.setAllSkillsEnabled('cursor', true);
  assert.equal(skillStateService.listDisabledKeys('cursor').length, 0);

  // And the listing should reflect that.
  const skills = await providerSkillsService.listProviderSkills('cursor');
  for (const s of skills) {
    assert.equal(s.enabled, true, `${s.name} should be enabled again`);
  }
});

test('disabled state survives across service instances (persistence)', () => {
  resetState();
  const key = '/some/skill.md';
  skillStateService.setSkillEnabled('claude', key, false);

  // The service is a singleton in this process, but we re-read the blob via
  // the underlying store to simulate a process restart.
  const raw = appConfigDb.get(DISABLED_KEY);
  assert.ok(raw, 'disabled_skills row should be persisted');
  const parsed = JSON.parse(raw as string);
  assert.deepEqual(parsed.claude, { [key]: true });
});
