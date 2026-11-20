// One private scratch directory per listener. Never clear a directory supplied by the user.
// pi 018634af · 2026-11-20T15:53+01:00
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });

export function openCheckouts(state, remote) {
  const root = mkdtempSync(join(state, 'checkouts-'));
  const main = join(root, 'main'), work = join(root, 'work'), base = join(root, 'base');
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    git('clone', '-q', remote, main);
  } catch (error) {
    cleanup();
    throw error;
  }
  return {
    main, work, base, [Symbol.dispose]: cleanup,
    prepareFix(branch) {
      // Clone the revision triage inspected, not the moving default branch on GitHub.
      for (const directory of [work, base]) {
        rmSync(directory, { recursive: true, force: true });
        git('clone', '-q', '--no-local', main, directory);
      }
      git('-C', work, 'remote', 'set-url', 'origin', remote);
      git('-C', work, 'checkout', '-q', '-b', branch);
    },
  };
}
