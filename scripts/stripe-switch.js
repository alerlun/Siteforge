#!/usr/bin/env node
// stripe-switch — swaps active .env Stripe keys + syncs config table in Supabase.
// Usage:
//   node scripts/stripe-switch.js --mode test
//   node scripts/stripe-switch.js --mode live
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const STRIPE_KEYS = [
  'VITE_STRIPE_PUBLISHABLE_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRO_PRICE_ID',
];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode' && argv[i + 1]) {
      out.mode = argv[i + 1];
      i++;
    }
  }
  return out;
}

function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    out[k] = v;
  }
  return out;
}

function writeEnv(file, env, original) {
  // Preserve original ordering and comments where possible.
  const lines = [];
  const seen = new Set();
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        lines.push(line);
        continue;
      }
      const eq = trimmed.indexOf('=');
      if (eq === -1) {
        lines.push(line);
        continue;
      }
      const k = trimmed.slice(0, eq).trim();
      if (k in env) {
        lines.push(`${k}=${env[k] ?? ''}`);
        seen.add(k);
      } else {
        lines.push(line);
      }
    }
  }
  for (const k of Object.keys(env)) {
    if (!seen.has(k)) lines.push(`${k}=${env[k] ?? ''}`);
  }
  fs.writeFileSync(file, lines.join('\n').replace(/\n+$/, '') + '\n');
}

async function syncSupabase(mode, env) {
  const url = env.VITE_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    console.warn('! Skipping Supabase sync: VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing.');
    return;
  }
  const updates = [
    { key: 'stripe_mode', value: mode },
    { key: 'stripe_publishable_key', value: env.VITE_STRIPE_PUBLISHABLE_KEY ?? '' },
    { key: 'stripe_webhook_secret', value: env.STRIPE_WEBHOOK_SECRET ?? '' },
  ];
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/config`;
  for (const row of updates) {
    const res = await fetch(`${endpoint}?on_conflict=key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Supabase upsert failed for ${row.key}: ${res.status} ${body}`);
    }
  }
  console.log(`  synced config table (stripe_mode=${mode})`);
}

async function main() {
  const { mode } = parseArgs(process.argv.slice(2));
  if (mode !== 'test' && mode !== 'live') {
    console.error('Usage: node scripts/stripe-switch.js --mode <test|live>');
    process.exit(1);
  }
  const sourceFile = path.join(ROOT, mode === 'test' ? '.env.test' : '.env.live');
  const targetFile = path.join(ROOT, '.env');
  if (!fs.existsSync(sourceFile)) {
    console.error(`Missing ${path.basename(sourceFile)}. Create it from .env.example with Stripe ${mode} keys.`);
    process.exit(1);
  }
  const stripeEnv = readEnv(sourceFile);
  const merged = {};
  for (const k of STRIPE_KEYS) {
    if (k in stripeEnv) merged[k] = stripeEnv[k];
  }
  writeEnv(targetFile, merged, readEnv(targetFile));
  const finalEnv = readEnv(targetFile);
  try {
    await syncSupabase(mode, finalEnv);
  } catch (err) {
    console.error(`! Supabase sync failed: ${err.message}`);
    process.exit(1);
  }
  console.log(`✓ Switched to ${mode.toUpperCase()} mode`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
