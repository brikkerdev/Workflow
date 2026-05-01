// Project-type detection. Used to gate Unity-specific surface (MCP tools,
// frontmatter flags) so the kanban runs project-agnostic by default.
//
// A project is classified as Unity iff both `Assets/` and
// `ProjectSettings/ProjectVersion.txt` exist at its root. Result is cached
// per (process, root) — re-detection requires a server restart.

import fs from 'node:fs';
import path from 'node:path';

const cache = new Map();

export function isUnityProject(projectRoot) {
  if (!projectRoot) return false;
  if (cache.has(projectRoot)) return cache.get(projectRoot);
  let unity = false;
  try {
    const assets = fs.statSync(path.join(projectRoot, 'Assets')).isDirectory();
    const ver = fs.statSync(path.join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt')).isFile();
    unity = assets && ver;
  } catch { unity = false; }
  cache.set(projectRoot, unity);
  return unity;
}
