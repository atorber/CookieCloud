#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { input, select } from '@inquirer/prompts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const extDir = resolve(__dirname, '..');
const repoRoot = resolve(extDir, '..');
const pkgPath = resolve(extDir, 'package.json');

const args = new Set(process.argv.slice(2));
const defaultMode = args.has('--mode=release') ? 'release' : 'build';

function run(cmd, argv, opts = {}) {
  const result = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  return result;
}

function capture(cmd, argv, opts = {}) {
  const result = spawnSync(cmd, argv, { encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

function bumpPatch(version) {
  const parts = version.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 3 || parts.some((n) => Number.isNaN(n))) {
    return version;
  }
  parts[2] += 1;
  return parts.join('.');
}

function isValidSemver(v) {
  return /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(v);
}

function tagExists(tag) {
  const out = capture('git', ['tag', '-l', tag], { cwd: repoRoot });
  return out === tag;
}

function ensureCleanWorktree() {
  const status = capture('git', ['status', '--porcelain'], { cwd: repoRoot });
  if (status === null) {
    console.error('git status failed — are you inside a git repo?');
    process.exit(1);
  }
  if (status.length > 0) {
    console.error('Working tree is not clean. Commit or stash changes first:');
    console.error(status);
    process.exit(1);
  }
}

async function main() {
  ensureCleanWorktree();

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const currentVersion = pkg.version;
  const suggested = bumpPatch(currentVersion);

  console.log(`Current version: ${currentVersion}`);

  const newVersion = await input({
    message: 'New version:',
    default: suggested,
    validate: (v) => {
      if (!isValidSemver(v)) return 'Must be valid semver (e.g. 1.2.3)';
      if (v === currentVersion) return 'Same as current version';
      return true;
    },
  });

  const mode = await select({
    message: 'What to do?',
    default: defaultMode,
    choices: [
      { name: 'Build only (no store publish)', value: 'build' },
      { name: 'Build + publish to Chrome / Edge stores', value: 'release' },
    ],
  });

  const tagPrefix = mode === 'release' ? 'release-v' : 'build-v';
  const tagName = `${tagPrefix}${newVersion}`;

  if (tagExists(tagName)) {
    console.error(`Tag ${tagName} already exists.`);
    process.exit(1);
  }

  console.log('');
  console.log('About to do:');
  console.log(`  Version:   ${currentVersion} -> ${newVersion}`);
  console.log(`  Tag:       ${tagName}`);
  console.log(`  Action:    ${mode === 'release' ? 'Build + publish to stores' : 'Build only'}`);
  console.log(`  Commit:    chore: release ${tagName}`);
  console.log(`  Push:      git push && git push origin ${tagName}`);
  console.log('');

  await input({ message: 'Press Enter to continue (Ctrl+C to abort)' });

  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

  const commitMsg = `chore: release ${tagName}`;
  run('git', ['add', pkgPath], { cwd: repoRoot });
  run('git', ['commit', '-m', commitMsg], { cwd: repoRoot });
  run('git', ['tag', '-a', tagName, '-m', commitMsg], { cwd: repoRoot });

  run('git', ['push'], { cwd: repoRoot });
  run('git', ['push', 'origin', tagName], { cwd: repoRoot });

  console.log('');
  console.log(`Pushed ${tagName}. Track progress at:`);
  const remote = capture('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot });
  if (remote) {
    const repoMatch = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (repoMatch) {
      console.log(`  https://github.com/${repoMatch[1]}/actions`);
    }
  }
}

main().catch((err) => {
  if (err && (err.name === 'ExitPromptError' || err.message?.includes('force closed'))) {
    console.log('\nAborted.');
    process.exit(130);
  }
  console.error(err);
  process.exit(1);
});
