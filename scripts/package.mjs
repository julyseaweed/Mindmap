import { packager } from '@electron/packager';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageRuntime } from './stage-runtime.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const release = path.join(project, 'release');
await fs.mkdir(release, { recursive: true });
// Start empty so old hashed bundles cannot accumulate in the installed app.
const releaseRoot = await fs.realpath(release);
const stage = await fs.mkdtemp(path.join(releaseRoot, 'stage-'));
for (const folder of ['dist', 'electron', 'assets']) await fs.cp(path.join(project, folder), path.join(stage, folder), { recursive: true, force: true });
await stageRuntime(project, stage);
const source = JSON.parse(await fs.readFile(path.join(project, 'package.json'), 'utf8'));
await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify({ name: source.name, productName: source.productName, version: source.version, description: source.description, author: source.author, license: source.license, main: source.main, type: 'module' }, null, 2));
const version = JSON.parse(await fs.readFile(path.join(project, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const outputs = await packager({
  dir: stage, out: release, name: "Mindmap", executableName: "Mindmap", platform: 'win32', arch: 'x64',
  electronVersion: version, icon: path.join(project, 'assets', 'icon.ico'), asar: true, overwrite: true, prune: false,
  win32metadata: { CompanyName: 'julyseaweed', FileDescription: "Mindmap", ProductName: "Mindmap", InternalName: 'Mindmap' },
});
console.log(JSON.stringify({ outputs }));
const resolvedStage = await fs.realpath(stage);
if (path.dirname(resolvedStage) !== releaseRoot || !path.basename(resolvedStage).startsWith('stage-')) throw new Error('Unexpected packaging stage path.');
await fs.rm(resolvedStage, { recursive: true });
