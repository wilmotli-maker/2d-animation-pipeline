// src/studio/contain.js
// Real-path (symlink-aware) containment. resolveWithin() in media.js only checks
// the lexical path; the filesystem follows symlinks, so an in-project link
// `escape -> /elsewhere` would otherwise let reads and writes leave the project.
// Policy is strict: anything whose real path is outside the project's real path
// is refused. Every failure (missing, unreadable, loop, ...) returns null.
import { realpath, lstat } from 'node:fs/promises';
import path from 'node:path';

function inside(realBase, real) {
  const r = path.relative(realBase, real);
  return r === '' || (r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r));
}

// Returns the real path of `abs` if it is `base` or inside it (comparing REAL
// paths of both, so a symlinked base like macOS /var -> /private/var still
// works), else null.
//   default:   `abs` must exist (reads). Missing -> null.
//   forWrite:  `abs` may not exist yet. The nearest existing ancestor is
//              resolved and must be inside; the returned path is that real
//              ancestor + the missing tail. A dangling symlink anywhere on the
//              way is refused (mkdir/write would follow it out).
export async function realWithin(base, abs, { forWrite = false } = {}) {
  let realBase;
  try { realBase = await realpath(base); } catch { return null; }
  let cur = path.resolve(abs);
  const tail = [];
  for (let retries = 0; ;) {
    try {
      const real = await realpath(cur);
      return inside(realBase, real) ? path.join(real, ...tail) : null;
    } catch (err) {
      if (!forWrite || err.code !== 'ENOENT') return null;
      let st = null;
      try { st = await lstat(cur); } catch { /* truly missing: keep walking up */ }
      if (st) {
        // ENOENT on a symlink that exists -> dangling: refuse. Anything else was
        // created concurrently (e.g. a mkdir racing us): resolve it again.
        if (st.isSymbolicLink() || ++retries > 3) return null;
        continue;
      }
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}
