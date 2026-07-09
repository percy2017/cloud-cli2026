import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { providerSkillsService } from '@/modules/providers/services/skills.service.js';

const patchHomeDir = (nextHomeDir: string) => {
  const original = os.homedir;
  (os as { homedir: unknown }).homedir = () => nextHomeDir;
  return () => {
    (os as { homedir: unknown }).homedir = original;
  };
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
    `---\nname: ${name}\ndescription: ${description}\n---\n\nSkill body.\n`,
    'utf8',
  );
  return skillPath;
};

test('providerSkillsService lists qwen project and user skills from .qwen/skills/ (no Claude/Agents cross-compat)', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-qwen-'));
  const repoRoot = path.join(tempRoot, 'repo');
  const workspacePath = path.join(repoRoot, 'packages', 'app');
  await fs.mkdir(path.join(repoRoot, '.git'), { recursive: true });
  await fs.mkdir(workspacePath, { recursive: true });

  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    // Project skill: <workspace>/.qwen/skills/<name>/SKILL.md
    await writeSkill(
      path.join(workspacePath, '.qwen', 'skills'),
      'qwen-cwd',
      'qwen-cwd',
      'Qwen cwd skill',
    );
    // Parent dir project skill: <repo>/.qwen/skills/<name>/SKILL.md
    await writeSkill(
      path.join(repoRoot, '.qwen', 'skills'),
      'qwen-parent',
      'qwen-parent',
      'Qwen parent skill',
    );
    // User skill: ~/.qwen/skills/<name>/SKILL.md
    await writeSkill(
      path.join(tempRoot, '.qwen', 'skills'),
      'qwen-user',
      'qwen-user',
      'Qwen user skill',
    );

    // Cross-compat that should be IGNORED in first iteration
    await writeSkill(
      path.join(workspacePath, '.claude', 'skills'),
      'qwen-shared-claude',
      'qwen-shared-claude',
      'Should not appear',
    );
    await writeSkill(
      path.join(workspacePath, '.agents', 'skills'),
      'qwen-shared-agents',
      'qwen-shared-agents',
      'Should not appear',
    );

    const skills = await providerSkillsService.listProviderSkills('qwen', { workspacePath });
    const byName = new Map(skills.map((skill) => [skill.name, skill]));

    assert.ok(byName.get('qwen-cwd'), 'qwen-cwd should be present');
    assert.equal(byName.get('qwen-cwd')?.scope, 'project');
    assert.equal(byName.get('qwen-cwd')?.command, '/qwen-cwd');

    assert.ok(byName.get('qwen-parent'), 'qwen-parent should be present');
    assert.equal(byName.get('qwen-parent')?.scope, 'project');

    assert.ok(byName.get('qwen-user'), 'qwen-user should be present');
    assert.equal(byName.get('qwen-user')?.scope, 'user');

    assert.equal(
      byName.get('qwen-shared-claude'),
      undefined,
      'qwen should NOT include Claude-shared skills in first iteration',
    );
    assert.equal(
      byName.get('qwen-shared-agents'),
      undefined,
      'qwen should NOT include Agents-shared skills in first iteration',
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('providerSkillsService rejects managed skill creation for qwen (qwen uses its own CLI install path)', { concurrency: false }, async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-skills-qwen-managed-'));
  const restoreHomeDir = patchHomeDir(tempRoot);
  try {
    await assert.rejects(
      () =>
        providerSkillsService.addProviderSkills('qwen', {
          entries: [
            {
              directoryName: 'qwen-global',
              content: '---\nname: qwen-global\ndescription: Unsupported\n---\n\nBody.\n',
            },
          ],
        }),
      /not supported|managed/i,
    );

    await assert.rejects(
      () =>
        providerSkillsService.removeProviderSkill('qwen', {
          directoryName: 'qwen-global',
        }),
      /not supported|managed/i,
    );
  } finally {
    restoreHomeDir();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});