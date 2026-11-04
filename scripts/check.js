import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function checkJavaScript(root = new URL('../', import.meta.url), run = spawnSync) {
  for (const directory of ['src', 'game100', 'apps-script', 'web', 'scripts', 'test']) {
    for (const name of await readdir(new URL(`${directory}/`, root))) {
      if (!name.endsWith('.js')) continue;
      const path = fileURLToPath(new URL(`${directory}/${name}`, root));
      const result = run(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.error) throw result.error;
      if (result.status !== 0) return result.status ?? 1;
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await checkJavaScript();
}
