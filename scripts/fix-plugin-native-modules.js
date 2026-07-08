#!/opt/node22/bin/node
/**
 * Recompile native module bindings for installed plugins.
 *
 * Background: plugin install runs `npm install --ignore-scripts` for security,
 * which skips `node-gyp` for native packages like node-pty / better-sqlite3.
 * After a Node upgrade or a fresh install the bindings can be missing or
 * stale, causing "Cannot find module 'node-pty'" errors at plugin startup.
 *
 * This script walks every plugin under ~/.claude-code-ui/plugins, finds
 * packages with a binding.gyp (or in a known native list), and runs
 * `npm rebuild <pkg>` against the current Node ABI.
 *
 * Usage:
 *   node scripts/fix-plugin-native-modules.js            # rebuild all plugins
 *   node scripts/fix-plugin-native-modules.js web-terminal  # rebuild one plugin
 *   node scripts/fix-plugin-native-modules.js --dry-run  # show what would run
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Native packages the runtime depends on. Add to this list as new plugins
// ship native deps; binding.gyp detection below also catches anything we
// don't list explicitly.
const KNOWN_NATIVE_PACKAGES = new Set([
  'node-pty',
  'better-sqlite3',
  'bcrypt',
  'bcryptjs',
  'sqlite3',
  'canvas',
  'node-canvas',
  'sharp',
  'fsevents',
]);

const PLUGINS_DIR = path.join(os.homedir(), '.claude-code-ui', 'plugins');
const REBUILD_TIMEOUT_MS = 5 * 60_000;

function findNativePackages(pluginNodeModules) {
  const found = new Set();

  if (!fs.existsSync(pluginNodeModules)) {
    return found;
  }

  for (const entry of fs.readdirSync(pluginNodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const pkgDir = path.join(pluginNodeModules, entry.name);
    const packageJsonPath = path.join(pkgDir, 'package.json');

    // Skip scoped packages — handled recursively if they have binding.gyp
    if (entry.name.startsWith('@')) {
      for (const sub of fs.readdirSync(pkgDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const subDir = path.join(pkgDir, sub.name);
        if (
          fs.existsSync(path.join(subDir, 'binding.gyp')) ||
          isKnownNative(sub.name)
        ) {
          found.add(`${entry.name}/${sub.name}`);
        }
      }
      continue;
    }

    if (
      fs.existsSync(path.join(pkgDir, 'binding.gyp')) ||
      isKnownNative(entry.name)
    ) {
      // Confirm it's a real package, not an empty dir
      if (fs.existsSync(packageJsonPath) || fs.existsSync(path.join(pkgDir, 'index.js'))) {
        found.add(entry.name);
      }
    }
  }

  return found;
}

function isKnownNative(name) {
  return KNOWN_NATIVE_PACKAGES.has(name);
}

function listPlugins(filterName) {
  if (!fs.existsSync(PLUGINS_DIR)) {
    console.error(`Plugin directory not found: ${PLUGINS_DIR}`);
    process.exit(1);
  }

  const entries = fs.readdirSync(PLUGINS_DIR, { withFileTypes: true });
  const plugins = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.tmp-')) continue;

    if (filterName) {
      const manifestPath = path.join(PLUGINS_DIR, entry.name, 'manifest.json');
      let manifestName = null;
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        manifestName = manifest.name || null;
      } catch { /* unreadable manifest — won't match anyway */ }
      // Accept either the directory name (cloudcli-plugin-terminal) or the
      // manifest name (web-terminal) so users don't have to know which is which.
      if (entry.name !== filterName && manifestName !== filterName) continue;
    }

    const manifestPath = path.join(PLUGINS_DIR, entry.name, 'manifest.json');
    const nodeModulesPath = path.join(PLUGINS_DIR, entry.name, 'node_modules');

    if (!fs.existsSync(manifestPath)) continue;

    let displayName = entry.name;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      if (manifest.displayName) displayName = `${manifest.displayName} (${entry.name})`;
    } catch {
      // Corrupted manifest — skip the parsing but still allow rebuilding
    }

    plugins.push({
      dirName: entry.name,
      displayName,
      nodeModulesPath,
    });
  }

  return plugins;
}

function runRebuild(pluginDir, pkgName, dryRun) {
  return new Promise((resolve) => {
    const args = ['rebuild', pkgName];
    if (dryRun) {
      console.log(`  [dry-run] would run: npm ${args.join(' ')}  (cwd: ${pluginDir})`);
      return resolve({ ok: true, skipped: true });
    }

    console.log(`  → npm ${args.join(' ')}`);
    const child = spawn('npm', args, {
      cwd: pluginDir,
      env: { ...process.env, NODE_ENV: 'development' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.removeAllListeners();
      child.kill();
      resolve({ ok: false, error: 'timeout' });
    }, REBUILD_TIMEOUT_MS);

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: `exit ${code}: ${stderr.trim()}` });
      }
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const positional = args.filter((a) => !a.startsWith('--'));

  const filterName = positional[0] || null;
  const plugins = listPlugins(filterName);

  if (plugins.length === 0) {
    console.log(filterName
      ? `Plugin "${filterName}" not found in ${PLUGINS_DIR}`
      : `No plugins found in ${PLUGINS_DIR}`);
    process.exit(0);
  }

  console.log(`Found ${plugins.length} plugin${plugins.length === 1 ? '' : 's'}`);
  if (dryRun) console.log('(dry run — no changes will be made)');
  console.log('');

  let rebuilt = 0;
  let failed = 0;
  let skipped = 0;

  for (const plugin of plugins) {
    console.log(`▸ ${plugin.displayName}`);

    const packages = findNativePackages(plugin.nodeModulesPath);
    if (packages.size === 0) {
      console.log('  (no native packages detected)');
      skipped += 1;
      console.log('');
      continue;
    }

    for (const pkg of packages) {
      const result = await runRebuild(plugin.nodeModulesPath, pkg, dryRun);
      if (result.ok) {
        if (!result.skipped) rebuilt += 1;
        else skipped += 1;
        console.log(`  ✓ ${pkg}${result.skipped ? ' (dry-run)' : ''}`);
      } else {
        failed += 1;
        console.error(`  ✗ ${pkg}: ${result.error}`);
      }
    }
    console.log('');
  }

  console.log('—'.repeat(60));
  console.log(`Rebuilt: ${rebuilt}  Skipped: ${skipped}  Failed: ${failed}`);

  if (failed > 0) {
    console.error('\nSome rebuilds failed. Common causes:');
    console.error('  • Missing build toolchain (gcc, python, make) — install build-essential');
    console.error('  • Node ABI mismatch — check that npm and node have the same major version');
    console.error('  • Permission denied — make sure you own the plugin directory');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});