// Load .env from the same directory so NODE_BINARY (and friends) are picked up
// before PM2 forks the app. Mirrors the loader in server/load-env.js but uses
// a tiny inline parser because this file runs in the PM2 daemon, before the
// app's own env-loading has executed.
const path = require('path');
const fs = require('fs');
try {
  const envPath = path.join(__dirname, '.env');
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
} catch {
  // .env is optional
}

module.exports = {
  apps: [
    {
      name: 'cloud-cli2026',
      // Use Node 22 from /opt/node22 — native modules (better-sqlite3, node-pty)
      // were rebuilt against the Node 22 ABI after `npm ci`, so the system Node 24
      // cannot dlopen them. Overridable via NODE_BINARY in .env; falls back to
      // "node" from PATH when unset.
      exec_interpreter: process.env.NODE_BINARY || 'node',
      script: 'dist-server/server/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      watch: false,

      kill_timeout: 10000,
      kill_signal: 'SIGTERM',

      max_restarts: 10,
      exp_backoff_restart_delay: 100,
      autorestart: true,

      max_memory_restart: '512M'
    },
  ],
};
