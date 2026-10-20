// Build dist-extension/olf-extension.zip from extension/ (without any pairing code).
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import AdmZip from 'adm-zip';

const zip = new AdmZip();
for (const name of readdirSync('extension')) {
  if (name === 'pairing.json') continue;
  zip.addLocalFile(join('extension', name), 'olf-extension');
}
mkdirSync('dist-extension', { recursive: true });
zip.writeZip('dist-extension/olf-extension.zip');
console.log('dist-extension/olf-extension.zip');
