import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Download a URL to a local path. fetchImpl is injectable for tests; defaults
// to the global fetch (Node 18+). If dest has no extension, borrow the URL's.
export async function downloadTo(url, dest, { fetchImpl = fetch } = {}) {
  let out = dest;
  if (!path.extname(out)) {
    const urlExt = path.extname(new URL(url).pathname);
    if (urlExt) out += urlExt;
  }
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`download failed for ${url} (status ${res.status})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, buf);
  return out;
}
