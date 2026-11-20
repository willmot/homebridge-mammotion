import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

it('ships a loadable native client and diagnostic script without Python or private data', () => {
  const temp = mkdtempSync(join(tmpdir(), 'mammotion-package-'));
  try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp, '--cache', join(temp, 'cache')], { encoding: 'utf8' }))[0];
    const files = packed.files.map((file: { path: string }) => file.path);
    expect(files).toEqual(expect.arrayContaining(['dist/index.js', 'dist/mammotion-client.js', 'dist/state-mapper.js', 'scripts/probe-official-api.js']));
    expect(files.some((name: string) => /\.test\.|python|bootstrap|node_modules|\.env$|config\.json$/.test(name))).toBe(false);
    execFileSync('tar', ['-xzf', join(temp, packed.filename), '-C', temp]);
    const entry = createRequire(join(temp, 'package/package.json'))('./dist/index.js');
    expect(typeof entry).toBe('function');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
