import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { buildAppsScript } from '../scripts/build-apps-script.js';
import { checkJavaScript } from '../scripts/check.js';

const directories = ['src', 'game100', 'apps-script', 'web', 'scripts', 'test'];
const manifest = '{\n  "runtimeVersion": "V8",\n  "timeZone": "Etc/UTC"\n}\n';

async function project(t) {
  const path = await mkdtemp(join(tmpdir(), 'game100-tooling-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const root = pathToFileURL(path + sep);
  await Promise.all(directories.map(directory => mkdir(new URL(`${directory}/`, root))));
  await writeFile(new URL('package.json', root), '{"type":"module"}');
  return root;
}

async function buildProject(t) {
  const root = await project(t);
  await Promise.all([
    writeFile(new URL('game100/domain.js', root), 'export const marker = "domain";\r\n'),
    writeFile(new URL('apps-script/runtime.js', root),
      'import { marker } from "../game100/domain.js";\r\nexport const runtime = marker + ":runtime";\r\n'),
    writeFile(new URL('apps-script/entry.js', root), 'function doPost() { return runtime; }\n'),
    writeFile(new URL('apps-script/appsscript.json', root), manifest),
  ]);
  return root;
}

test('build concatenates shared sources in order, strips ESM, and copies the manifest exactly', async t => {
  const root = await buildProject(t);
  const output = await buildAppsScript(root);
  assert.equal(output.href, new URL('dist/apps-script/', root).href);
  const source = await readFile(new URL('Code.gs', output), 'utf8');
  assert.equal(source,
    'const marker = "domain";\r\n\nconst runtime = marker + ":runtime";\r\n\nfunction doPost() { return runtime; }\n');
  assert.equal(vm.runInNewContext(source + '\ndoPost()'), 'domain:runtime');
  assert.equal(await readFile(new URL('appsscript.json', output), 'utf8'), manifest);
  await writeFile(new URL('Code.gs', output), 'obsolete artifact');
  await writeFile(new URL('appsscript.json', output), '{}');
  await buildAppsScript(root);
  assert.equal(await readFile(new URL('Code.gs', output), 'utf8'), source);
  assert.equal(await readFile(new URL('appsscript.json', output), 'utf8'), manifest);
});

test('build strips LF imports too and does not change nested export-like text', async t => {
  const root = await buildProject(t);
  await writeFile(new URL('apps-script/runtime.js', root),
    'import { marker } from "../game100/domain.js";\nexport const text = "export marker";\n');
  const output = await buildAppsScript(root);
  const source = await readFile(new URL('Code.gs', output), 'utf8');
  assert.doesNotMatch(source, /^import |^export /m);
  assert.match(source, /const text = "export marker";/);
});

test('missing build inputs fail explicitly rather than reporting a successful artifact', async t => {
  for (const missing of ['game100/domain.js', 'apps-script/appsscript.json']) {
    const root = await buildProject(t);
    await rm(new URL(missing, root));
    await assert.rejects(buildAppsScript(root), { code: 'ENOENT' });
    await assert.rejects(stat(new URL(`dist/apps-script/${missing.endsWith('.json') ? 'appsscript.json' : 'Code.gs'}`, root)),
      { code: 'ENOENT' });
  }
});

test('syntax checker selects JavaScript from every code directory and ignores other assets', async t => {
  const root = await project(t), calls = [];
  await Promise.all(directories.flatMap(directory => [
    writeFile(new URL(`${directory}/module.js`, root), 'export const value = 1;\n'),
    writeFile(new URL(`${directory}/notes.txt`, root), 'not JavaScript }'),
  ]));
  const result = await checkJavaScript(root, (executable, args, options) => {
    calls.push({ executable, args, options });
    return { status: 0 };
  });
  assert.equal(result, 0);
  assert.deepEqual(calls.map(call => relative(fileURLToPath(root), call.args[1])),
    directories.map(directory => join(directory, 'module.js')));
  assert.ok(calls.every(call => call.executable === process.execPath
    && call.args[0] === '--check' && call.options.stdio === 'inherit'));
});

test('syntax checker stops at the first failed or interrupted command and surfaces spawn errors', async t => {
  const root = await project(t);
  await writeFile(new URL('src/first.js', root), '');
  await writeFile(new URL('web/later.js', root), '');
  for (const status of [7, null]) {
    let calls = 0;
    assert.equal(await checkJavaScript(root, () => { calls++; return { status }; }), status ?? 1);
    assert.equal(calls, 1);
  }
  const error = Error('cannot start syntax checker');
  await assert.rejects(checkJavaScript(root, () => ({ status: null, error })), failure => failure === error);
  await rm(new URL('src/', root), { recursive: true });
  await assert.rejects(checkJavaScript(root), { code: 'ENOENT' });
});

test('syntax checker detects actual invalid JavaScript without executing source side effects', async t => {
  const root = await project(t), results = [];
  await writeFile(new URL('src/module.js', root), 'throw Error("must not execute");\n');
  const run = (executable, args) => {
    const result = spawnSync(executable, args, { encoding: 'utf8' });
    results.push(result);
    return result;
  };
  assert.equal(await checkJavaScript(root, run), 0);
  await writeFile(new URL('web/broken.js', root), 'export const = ;\n');
  assert.equal(await checkJavaScript(root, run), 1);
  assert.match(results.at(-1).stderr, /SyntaxError/);
});

test('tooling CLI entry points work outside the project working directory and preserve failure exits', async t => {
  const root = await buildProject(t);
  await Promise.all(['check.js', 'build-apps-script.js'].map(name =>
    copyFile(new URL(`../scripts/${name}`, import.meta.url), new URL(`scripts/${name}`, root))));
  const cwd = fileURLToPath(new URL('web/', root));
  const run = name => spawnSync(process.execPath, [fileURLToPath(new URL(`scripts/${name}`, root))],
    { cwd, encoding: 'utf8' });
  const build = run('build-apps-script.js');
  assert.equal(build.status, 0, build.stderr);
  assert.ok(build.stdout.includes(fileURLToPath(new URL('dist/apps-script/', root))));
  assert.equal(await readFile(new URL('dist/apps-script/appsscript.json', root), 'utf8'), manifest);
  const check = run('check.js');
  assert.equal(check.status, 0, check.stderr);
  await writeFile(new URL('web/broken.js', root), 'const = ;');
  assert.equal(run('check.js').status, 1);
  await rm(new URL('apps-script/appsscript.json', root));
  const failedBuild = run('build-apps-script.js');
  assert.notEqual(failedBuild.status, 0);
  assert.match(failedBuild.stderr, /ENOENT/);
  assert.equal(failedBuild.stdout, '');
});
