import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Upstream is a private source workspace, not a published npm package.
const commit = 'd6f39f3bc9a126aa418a1ac74825d84d6144183e';
const project = fileURLToPath(new URL('..', import.meta.url));
const destination = path.join(project, 'vendor');
const require = createRequire(import.meta.url);
const upstreamRequire = createRequire(require.resolve('@telegram/widget-sandbox/vite'));
const { transform } = upstreamRequire('esbuild');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'televecha-widget-'));
const run = (command, args, cwd = temporary) =>
  execFileSync(command, args, { cwd, stdio: 'pipe' }).toString().trim();
async function transpile(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await transpile(file);
    else if (file.endsWith('.ts') && !file.endsWith('.d.ts')) {
      const output = await transform(await fs.readFile(file, 'utf8'), {
        loader: 'ts',
        target: 'es2022',
        format: 'esm',
      });
      // Rewrite quoted file extensions only, never identifiers such as (...ts).
      await fs.writeFile(file.slice(0, -3) + '.js', output.code.replace(/\.ts(?=['"`])/gu, '.js'));
      await fs.unlink(file);
    }
  }
}
try {
  run('git', ['init', '-q']);
  run('git', [
    'fetch',
    '--depth=1',
    'https://github.com/TelegramMessenger/widget-sandbox.git',
    commit,
  ]);
  run('git', ['checkout', '-q', '--detach', 'FETCH_HEAD']);
  if (run('git', ['rev-parse', 'HEAD']) !== commit) throw new Error('Unexpected upstream revision');
  const core = path.join(temporary, 'packages/core');
  await transpile(core);
  const manifestPath = path.join(core, 'package.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  for (const name of Object.keys(manifest.exports)) {
    manifest.exports[name] = manifest.exports[name].replace(/\.ts$/u, '.js');
  }
  manifest.dependencies['@telegram/widget-sandbox-quickjs'] = '0.32.0-fork';
  manifest.files = manifest.files.map((file) => (file === 'vite.ts' ? 'vite.js' : file));
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  await fs.mkdir(destination, { recursive: true });
  for (const directory of [core, path.join(temporary, 'packages/quickjs-wasm')]) {
    run('npm', ['pack', directory, '--ignore-scripts', '--pack-destination', destination]);
  }
  await fs.copyFile(
    path.join(temporary, 'THIRD_PARTY_NOTICES.md'),
    path.join(destination, 'widget-sandbox-THIRD_PARTY_NOTICES.md'),
  );
  console.info(
    `Packaged widget-sandbox v0.6.0 (${commit}). Run npm install to refresh the lockfile.`,
  );
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
