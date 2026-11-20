// The build bundles third-party code, so every unpacked build and release zip carries the licenses.
// Called from the build:done hook in wxt.config.ts, before `wxt zip` packs the output directory.
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @param {string} root project root  @param {string} outDir build output directory */
export async function copyLicenses(root, outDir) {
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await copyFile(join(root, file), join(outDir, file));
}
