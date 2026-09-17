import fs from 'node:fs/promises';
import path from 'node:path';

export async function stageRuntime(project, stage) {
  await fs.mkdir(path.join(stage, 'src'), { recursive: true });
  for (const file of ['core.mjs', 'document-import.mjs', 'mermaid-import.mjs', 'text-entities.mjs', 'html-entities.json']) {
    await fs.copyFile(path.join(project, 'src', file), path.join(stage, 'src', file));
  }
  // Marked is used only as a text tokenizer. Include its runtime and license offline.
  await fs.mkdir(path.join(stage, 'node_modules'), { recursive: true });
  await fs.cp(path.join(project, 'node_modules', 'marked'), path.join(stage, 'node_modules', 'marked'), { recursive: true });
}
