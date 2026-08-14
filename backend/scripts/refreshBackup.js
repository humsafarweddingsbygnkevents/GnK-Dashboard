#!/usr/bin/env node
// Manually refreshes the "backup" Neon branch from the live "main" branch.
// Never called from app code, a route, or a cron — only ever run by hand,
// with NEON_API_KEY exported in the operator's own shell. That's the whole
// safety model: the backup can't move unless a human runs this file.
'use strict';

const readline = require('node:readline');

const API_BASE = 'https://console.neon.tech/api/v2';
const PROJECT_ID = process.env.NEON_PROJECT_ID || 'odd-glitter-50660959';
const PRIMARY_BRANCH_NAME = process.env.NEON_PRIMARY_BRANCH || 'main';
const BACKUP_BRANCH_NAME = process.env.NEON_BACKUP_BRANCH || 'backup';
const API_KEY = process.env.NEON_API_KEY;

if (!API_KEY) {
  console.error('NEON_API_KEY is not set.');
  console.error('Export it in this shell first — see backend/scripts/BACKUP.md.');
  process.exit(1);
}

async function neon(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Neon API ${res.status} ${path}: ${JSON.stringify(body)}`);
  }
  return body;
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toUpperCase() === 'YES');
    });
  });
}

async function waitForOperations(operations) {
  for (const op of operations || []) {
    let status = op.status;
    let attempts = 0;
    while (status === 'running' || status === 'scheduling') {
      if (attempts++ > 60) throw new Error(`Timed out waiting on Neon operation ${op.id}`);
      await new Promise((r) => setTimeout(r, 2000));
      const { operation } = await neon(`/projects/${PROJECT_ID}/operations/${op.id}`);
      status = operation.status;
    }
    if (status !== 'finished') {
      throw new Error(`Neon operation ${op.id} ended with status "${status}"`);
    }
  }
}

async function connectionStringFor(branchId, primaryBranchId) {
  const [{ databases }, { roles }] = await Promise.all([
    neon(`/projects/${PROJECT_ID}/branches/${primaryBranchId}/databases`),
    neon(`/projects/${PROJECT_ID}/branches/${primaryBranchId}/roles`),
  ]);
  const database = databases[0]?.name;
  const role = roles.find((r) => !r.protected)?.name || roles[0]?.name;
  if (!database || !role) return null;
  const { uri } = await neon(
    `/projects/${PROJECT_ID}/connection_uri?branch_id=${branchId}&database_name=${database}&role_name=${role}&pooled=false`
  );
  return uri;
}

async function main() {
  const { branches } = await neon(`/projects/${PROJECT_ID}/branches`);
  const primary = branches.find((b) => b.name === PRIMARY_BRANCH_NAME);
  if (!primary) throw new Error(`Primary branch "${PRIMARY_BRANCH_NAME}" not found in project ${PROJECT_ID}`);
  const backup = branches.find((b) => b.name === BACKUP_BRANCH_NAME);

  if (!backup) {
    console.log(`No "${BACKUP_BRANCH_NAME}" branch yet — creating it as a fresh copy of "${PRIMARY_BRANCH_NAME}"...`);
    const created = await neon(`/projects/${PROJECT_ID}/branches`, {
      method: 'POST',
      body: JSON.stringify({
        branch: { parent_id: primary.id, name: BACKUP_BRANCH_NAME },
        endpoints: [{ type: 'read_write' }],
      }),
    });
    await waitForOperations(created.operations);
    console.log(`Created backup branch "${BACKUP_BRANCH_NAME}".`);
  } else {
    console.log(`This will OVERWRITE "${BACKUP_BRANCH_NAME}" with a fresh copy of "${PRIMARY_BRANCH_NAME}" as of right now.`);
    console.log('Whatever is currently in the backup branch will be replaced — it will no longer reflect an older snapshot.');
    const ok = await confirm('Type YES to continue: ');
    if (!ok) {
      console.log('Aborted. Backup branch left untouched.');
      return;
    }
    const restored = await neon(`/projects/${PROJECT_ID}/branches/${backup.id}/restore`, {
      method: 'POST',
      body: JSON.stringify({ source_branch_id: primary.id }),
    });
    await waitForOperations(restored.operations);
    console.log(`Backup branch "${BACKUP_BRANCH_NAME}" refreshed from "${PRIMARY_BRANCH_NAME}".`);
  }

  const { branches: refreshed } = await neon(`/projects/${PROJECT_ID}/branches`);
  const backupBranch = refreshed.find((b) => b.name === BACKUP_BRANCH_NAME);

  console.log('\nDone.');
  try {
    const uri = await connectionStringFor(backupBranch.id, primary.id);
    if (uri) {
      console.log('Backup branch connection string (emergency restore only — do not commit or deploy this):');
      console.log(uri);
    }
  } catch {
    console.log('Could not auto-fetch the connection string — get it from the Neon console: Branches → backup → Connection Details.');
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
