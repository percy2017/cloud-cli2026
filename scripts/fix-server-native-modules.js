#!/usr/bin/env node
/**
 * Recompile the server's native module bindings against the Node ABI used by
 * the runtime (PM2 / production `node`).
 *
 * Background: this project pins the runtime Node via `NODE_BINARY` in `.env`
 * (default `/opt/node22/bin/node`). When someone runs `npm install` with a
 * different `node` on PATH (for example the system Node 24) the native
 * modules — `better-sqlite3`, `node-pty`, etc. — get compiled against that
 * other ABI. PM2 then fails to `dlopen` them on boot with:
 *
 *   Error: Module did not self-register: '.../better_sqlite3.node'.
 *     code: 'ERR_DLOPEN_FAILED'
 *
 * This script reads `NODE_BINARY` from `.env` (falling back to
 * `process.execPath`) and runs `npm rebuild <pkg>` for every native package
 * installed in the server's own `node_modules/`, using THAT exact binary.
 * Idempotent: when the binding already matches the target ABI, `npm rebuild`
 * is a no-op and exits quickly.
 *
 * Mirrors `scripts/fix-plugin-native-modules.js` (which targets plugins under
 * `~/.claude-code-ui/plugins/*`).
 *
 * Usage:
 *   node scripts/fix-server-native-modules.js            # auto-detect target Node
 *   node scripts/fix-server-native-modules.js --dry-run  # show what would run
 *   node scripts/fix-server-native-modules.js --target /opt/node22/bin/node
 */

import { spawn, spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const NODE_MODULES = path.join(PROJECT_ROOT, 'node_modules');

// Same set as fix-plugin-native-modules.js — keep them in sync.
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

const REBUILD_TIMEOUT_MS = 5 * 60_000;

/**
 * Read the `.env` file at the project root and return a plain key→value map.
 * Comments and blank lines are skipped. Values wrapped in " or ' are unquoted.
 */
function loadDotEnv() {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!existsSync(envPath)) return {};
  const map = {};
  for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map[key] = value;
  }
  return map;
}

/**
 * Pick the Node binary the runtime will use. Order:
 *   1. --target CLI flag
 *   2. NODE_BINARY env var (already exported in the shell)
 *   3. NODE_BINARY from .env (this is what ecosystem.config.cjs consumes)
 *   4. process.execPath (the node running this script)
 */
function resolveTargetNode(cliArgs) {
  const flagIndex = cliArgs.indexOf('--target');
  if (flagIndex !== -1 && cliArgs[flagIndex + 1]) {
    return { node: cliArgs[flagIndex + 1], source: '--target flag' };
  }
  if (process.env.NODE_BINARY) {
    return { node: process.env.NODE_BINARY, source: 'NODE_BINARY env' };
  }
  const dotenv = loadDotEnv();
  if (dotenv.NODE_BINARY) {
    return { node: dotenv.NODE_BINARY, source: '.env NODE_BINARY' };
  }
  return { node: process.execPath, source: 'process.execPath' };
}

/**
 * Detect native packages in the server's own node_modules.
 * A package is "native" if it has a binding.gyp, ships a prebuilds dir,
 * or is in KNOWN_NATIVE_PACKAGES.
 */
function findNativePackages() {
  const found = new Set();
  if (!existsSync(NODE_MODULES)) return found;

  for (const entry of readdirSync(NODE_MODULES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;

    const pkgDir = path.join(NODE_MODULES, entry.name);
    const packageJsonPath = path.join(pkgDir, 'package.json');

    // @types/* is type-only — never has native bindings.
    if (entry.name === '@types') continue;

    if (entry.name.startsWith('@')) {
      // Scoped: walk one level deeper. Require a real native signal
      // (binding.gyp or prebuilds/) — the KNOWN_NATIVE_PACKAGES list is
      // only consulted for top-level packages where the name *is* the
      // runtime dep, not a @types alias.
      for (const sub of readdirSync(pkgDir, { withFileTypes: true })) {
        if (!sub.isDirectory()) continue;
        const subDir = path.join(pkgDir, sub.name);
        if (
          existsSync(path.join(subDir, 'binding.gyp')) ||
          existsSync(path.join(subDir, 'prebuilds'))
        ) {
          if (existsSync(path.join(subDir, 'package.json'))) {
            found.add(`${entry.name}/${sub.name}`);
          }
        }
      }
      continue;
    }

    if (
      existsSync(path.join(pkgDir, 'binding.gyp')) ||
      existsSync(path.join(pkgDir, 'prebuilds')) ||
      isKnownNative(entry.name)
    ) {
      if (existsSync(packageJsonPath)) {
        found.add(entry.name);
      }
    }
  }
  return found;
}

function isKnownNative(name) {
  return KNOWN_NATIVE_PACKAGES.has(name);
}

function runRebuild(pkgName, targetNode, dryRun) {
  return new Promise((resolve) => {
    const args = ['rebuild', pkgName, '--build-from-source'];
    if (dryRun) {
      console.log(`  [dry-run] would run: npm ${args.join(' ')}  (node: ${targetNode})`);
      return resolve({ ok: true, skipped: true });
    }

    console.log(`  → npm ${args.join(' ')}   (node: ${targetNode})`);
    // Put the target Node first on PATH so npm picks it up for node-gyp too.
    const targetDir = path.dirname(targetNode);
    const env = {
      ...process.env,
      PATH: `${targetDir}${path.delimiter}${process.env.PATH || ''}`,
      NODE_ENV: process.env.NODE_ENV || 'development',
    };

    const child = spawn('npm', args, {
      cwd: PROJECT_ROOT,
      env,
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
        resolve({ ok: false, error: `exit ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}` });
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

function checkToolchain(targetNode) {
  // Confirm the target binary exists and is executable.
  if (!existsSync(targetNode)) {
    return { ok: false, error: `target node not found: ${targetNode}` };
  }
  const probe = spawnSync(targetNode, ['-v'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    return { ok: false, error: `target node not executable: ${targetNode} (${probe.stderr.trim()})` };
  }
  // node-gyp needs gcc / python / make. We don't fail hard here — the actual
  // npm rebuild will surface the real error if the toolchain is missing.
  return { ok: true, version: probe.stdout.trim() };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const { node: targetNode, source } = resolveTargetNode(args);
  console.log(`Target Node: ${targetNode}  (from ${source})`);

  const toolchain = checkToolchain(targetNode);
  if (!toolchain.ok) {
    console.error(`✗ ${toolchain.error}`);
    console.error('  Set NODE_BINARY in .env to a valid node binary, or pass --target /path/to/node');
    process.exit(1);
  }
  console.log(`Target Node version: ${toolchain.version}`);

  if (process.execPath === targetNode) {
    console.log('(npm is already running under the target Node — ABI matches by construction)');
  } else {
    console.log(`(npm is running under ${process.execPath}; will rebuild for ${targetNode})`);
  }

  const packages = findNativePackages();
  if (packages.size === 0) {
    console.log('No native packages detected — nothing to do.');
    process.exit(0);
  }

  console.log(`\nFound ${packages.size} native package${packages.size === 1 ? '' : 's'}: ${[...packages].sort().join(', ')}`);
  if (dryRun) console.log('(dry run — no changes will be made)');
  console.log('');

  let rebuilt = 0;
  let failed = 0;
  let skipped = 0;

  for (const pkg of [...packages].sort()) {
    const result = await runRebuild(pkg, targetNode, dryRun);
    if (result.ok) {
      if (result.skipped) skipped += 1;
      else rebuilt += 1;
      console.log(`  ✓ ${pkg}${result.skipped ? ' (dry-run)' : ''}`);
    } else {
      failed += 1;
      console.error(`  ✗ ${pkg}: ${result.error}`);
    }
  }

  console.log('');
  console.log('—'.repeat(60));
  console.log(`Rebuilt: ${rebuilt}  Skipped: ${skipped}  Failed: ${failed}`);

  if (failed > 0) {
    console.error('\nSome rebuilds failed. Common causes:');
    console.error('  • Missing build toolchain (gcc, python, make) — install build-essential');
    console.error('  • Target node not executable — check NODE_BINARY');
    console.error('  • Network blocked — npm needs to fetch prebuilt binaries or compile from source');
    process.exit(1);
  }
}

// `createRequire` is only imported so future contributors can `require()`
// binding.gyp introspection without an extra import line; silences unused.
void createRequire;
main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});