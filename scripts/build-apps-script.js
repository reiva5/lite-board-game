import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function buildAppsScript(root = new URL('../', import.meta.url)) {
  const output = new URL('dist/apps-script/', root);
  await mkdir(output, { recursive: true });
  const sources = await Promise.all(['game100/domain.js', 'apps-script/runtime.js', 'apps-script/entry.js']
    .map(path => readFile(new URL(path, root), 'utf8')));
  const code = sources.map(source => source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')).join('\n');
  await writeFile(new URL('Code.gs', output), code);
  await copyFile(new URL('apps-script/appsscript.json', root), new URL('appsscript.json', output));
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = await buildAppsScript();
  console.log(`Apps Script artifact: ${fileURLToPath(output)}`);
}
