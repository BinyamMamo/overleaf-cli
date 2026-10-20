// Build dist-extension/olf-extension.zip from extension/ (without any pairing code).
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

const zip = new AdmZip();
for (const name of readdirSync('extension')) {
  if (name === 'pairing.json') continue;
  const path = join('extension', name);
  if (statSync(path).isDirectory()) zip.addLocalFolder(path, join('olf-extension', name));
  else zip.addLocalFile(path, 'olf-extension');
}
mkdirSync('dist-extension', { recursive: true });
zip.writeZip('dist-extension/olf-extension.zip');
console.log('dist-extension/olf-extension.zip');
