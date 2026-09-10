import { readdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
// pkgroll declares esbuild; resolve from that dependency rather than requiring a global CLI.
const { build } = require(require.resolve('esbuild', { paths: [dirname(require.resolve('pkgroll/package.json'))] }));
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = await mkdtemp(join(tmpdir(), 'yesimbot-regression-'));
try {
  const tests = (await readdir(join(root, 'scripts'))).filter(name => /^test-.*\.ts$/.test(name)).sort();
  for (const name of tests) {
    const outfile = join(output, name.replace(/\.ts$/, '.cjs'));
    await build({ entryPoints: [join(root, 'scripts', name)], outfile, bundle: true, platform: 'node', format: 'cjs', packages: 'external', alias: { koishi: require.resolve('koishi') }, logLevel: 'warning' });
    const code = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [outfile], { cwd: root, env: { ...process.env, NODE_PATH: join(root, 'node_modules') }, stdio: 'inherit', timeout: 60_000 });
      child.once('error', reject); child.once('exit', code => done(code));
    });
    if (code !== 0) throw new Error(`${name} failed (${code})`);
  }
  console.log(`PASS ${tests.length} isolated regression suites; no live world, LLM, Docker or chat service used.`);
} finally { await rm(output, { recursive: true, force: true }); }
