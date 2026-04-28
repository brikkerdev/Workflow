#!/usr/bin/env node
// Migrate old workflow layout to track-as-timeline.
//
// Old:
//   .workflow/iterations/<id>-<slug>/{README.md,tasks/}
//   .workflow/ACTIVE                (single global)
//   .workflow/tracks/<slug>/{README.md,tasks/}
//
// New:
//   .workflow/tracks/<slug>/iterations/<id>-<slug>/{README.md,tasks/}
//   .workflow/tracks/<slug>/ACTIVE  (per-track)
//   .workflow/tracks/<slug>/README.md   (kept; track-level tasks/ dropped)
//
// Iteration ids are renumbered per-track starting from 001, in their original
// global order (lowest first → 001 in its target track).
//
// Idempotent: if no old layout is present, exits cleanly.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, WORKFLOW, TRACKS_DIR } from './lib/config.mjs';
import { parseTask, serializeTask } from './lib/frontmatter.mjs';

const OLD_ITERS = path.join(WORKFLOW, 'iterations');
const OLD_ACTIVE = path.join(WORKFLOW, 'ACTIVE');

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function readText(p) { return fs.readFileSync(p, 'utf-8'); }
function log(...a) { console.log('[migrate]', ...a); }

function moveDir(src, dst) {
  if (exists(dst)) {
    log(`SKIP move (target exists): ${dst}`);
    return false;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
  return true;
}

export function needsMigration() {
  if (exists(OLD_ITERS) && fs.readdirSync(OLD_ITERS).some(n => /^\d{3}-/.test(n))) return true;
  if (exists(OLD_ACTIVE) && readText(OLD_ACTIVE).trim()) return true;
  // track-level tasks/ dirs are vestigial and need to go
  if (exists(TRACKS_DIR)) {
    for (const slug of fs.readdirSync(TRACKS_DIR)) {
      const td = path.join(TRACKS_DIR, slug, 'tasks');
      if (exists(td)) return true;
    }
  }
  return false;
}

export function migrate({ apply = false } = {}) {
  if (!needsMigration()) {
    log('nothing to migrate.');
    return { migrated: false };
  }

  log(`project: ${ROOT}`);
  log(apply ? 'APPLY mode (changes will be written)' : 'DRY-RUN mode (no changes written)');

  // 1. Read global ACTIVE
  let globalActive = null;
  if (exists(OLD_ACTIVE)) {
    globalActive = readText(OLD_ACTIVE).trim() || null;
    log(`global ACTIVE = ${globalActive || '(empty)'}`);
  }

  // 2. Plan moves: old .workflow/iterations/<gid>-<slug> → tracks/<track>/iterations/<newId>-<slug>
  //    track resolved from iter README frontmatter `track:` field.
  //    If missing, fall back to track named `_unsorted`.
  const moves = []; // [{ srcDir, oldGid, oldSlug, fm, body, track }]
  if (exists(OLD_ITERS)) {
    for (const name of fs.readdirSync(OLD_ITERS).sort()) {
      const m = /^(\d{3})-(.+)$/.exec(name);
      if (!m) continue;
      const srcDir = path.join(OLD_ITERS, name);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const readmePath = path.join(srcDir, 'README.md');
      let fm = {}, body = '';
      if (exists(readmePath)) [fm, body] = parseTask(readText(readmePath));
      fm = fm || {};
      const track = fm.track || '_unsorted';
      moves.push({ srcDir, oldGid: m[1], oldSlug: m[2], fm, body, track });
    }
  }

  // 3. Group by track and assign new per-track ids in original-order.
  const byTrack = new Map();
  for (const m of moves) {
    if (!byTrack.has(m.track)) byTrack.set(m.track, []);
    byTrack.get(m.track).push(m);
  }
  for (const [track, list] of byTrack) {
    list.sort((a, b) => a.oldGid.localeCompare(b.oldGid));
    list.forEach((m, i) => { m.newId = String(i + 1).padStart(3, '0'); });
    log(`track "${track}": ${list.length} iterations`);
    for (const m of list) log(`  ${m.oldGid}-${m.oldSlug}  →  tracks/${track}/iterations/${m.newId}-${m.oldSlug}`);
  }

  // 4. Plan track-level tasks/ removal (already-vestigial — old code had it but
  //    new layout drops it; tasks live in iterations now).
  const taskDirsToRemove = [];
  if (exists(TRACKS_DIR)) {
    for (const slug of fs.readdirSync(TRACKS_DIR)) {
      const td = path.join(TRACKS_DIR, slug, 'tasks');
      if (exists(td)) taskDirsToRemove.push({ slug, dir: td, files: fs.readdirSync(td) });
    }
  }
  for (const t of taskDirsToRemove) {
    if (t.files.length) log(`WARN: track "${t.slug}" has ${t.files.length} task(s) in legacy tracks/${t.slug}/tasks/ — will be relocated to ${t.slug}/iterations/000-legacy/tasks/`);
    else log(`will remove empty legacy dir: tracks/${t.slug}/tasks/`);
  }

  if (!apply) {
    log('dry-run complete. re-run with --apply to migrate.');
    return { migrated: false, dryRun: true };
  }

  // 5. Apply moves.
  // 5a. Ensure target track dirs exist (auto-create stub README if track missing
  //     entirely, e.g. the synthetic _unsorted)
  for (const track of byTrack.keys()) {
    const td = path.join(TRACKS_DIR, track);
    fs.mkdirSync(path.join(td, 'iterations'), { recursive: true });
    if (!exists(path.join(td, 'README.md'))) {
      const stubFm = { slug: track, status: 'active', started: new Date().toISOString().slice(0, 10) };
      const stubBody = `\n# Track ${track}\n\nAuto-created during migration. Update goal and scope.\n`;
      fs.writeFileSync(path.join(td, 'README.md'), serializeTask(stubFm, stubBody), 'utf-8');
      log(`created stub track README for ${track}`);
    }
  }

  // 5b. Move iteration dirs and rewrite their READMEs (id field, track field).
  let activeMappedTo = null;
  for (const [track, list] of byTrack) {
    for (const m of list) {
      const dst = path.join(TRACKS_DIR, track, 'iterations', `${m.newId}-${m.oldSlug}`);
      if (moveDir(m.srcDir, dst)) {
        const newReadme = path.join(dst, 'README.md');
        if (exists(newReadme)) {
          const [fm2, body2] = parseTask(readText(newReadme));
          const fm3 = { ...(fm2 || {}), id: m.newId, slug: m.oldSlug, track };
          // map old global ACTIVE to per-track ACTIVE
          if (globalActive && m.oldGid === globalActive) {
            fm3.status = fm3.status || 'active';
            activeMappedTo = { track, id: m.newId };
          }
          fs.writeFileSync(newReadme, serializeTask(fm3, body2 || ''), 'utf-8');
        }
        // rewrite each task frontmatter so iteration field reflects new id
        const tasksDir = path.join(dst, 'tasks');
        if (exists(tasksDir)) {
          for (const tf of fs.readdirSync(tasksDir)) {
            const tp = path.join(tasksDir, tf);
            if (!tp.endsWith('.md')) continue;
            const [tfm, tb] = parseTask(readText(tp));
            if (!tfm) continue;
            tfm.iteration = m.newId;
            tfm.track = track;
            if (tfm.attempts == null) tfm.attempts = 0;
            fs.writeFileSync(tp, serializeTask(tfm, tb || ''), 'utf-8');
          }
        }
        log(`moved iter ${m.oldGid}-${m.oldSlug} → tracks/${track}/iterations/${m.newId}-${m.oldSlug}`);
      }
    }
  }

  // 5c. Per-track ACTIVE files
  if (activeMappedTo) {
    const f = path.join(TRACKS_DIR, activeMappedTo.track, 'ACTIVE');
    fs.writeFileSync(f, activeMappedTo.id, 'utf-8');
    log(`set tracks/${activeMappedTo.track}/ACTIVE = ${activeMappedTo.id}`);
  }

  // 5d. Remove or relocate legacy track-level tasks
  for (const t of taskDirsToRemove) {
    if (t.files.length) {
      const legacyIter = path.join(TRACKS_DIR, t.slug, 'iterations', '000-legacy');
      fs.mkdirSync(path.join(legacyIter, 'tasks'), { recursive: true });
      const legacyReadme = path.join(legacyIter, 'README.md');
      if (!exists(legacyReadme)) {
        const fm = { id: '000', slug: 'legacy', track: t.slug, status: 'active', started: new Date().toISOString().slice(0, 10) };
        fs.writeFileSync(legacyReadme, serializeTask(fm, '\n# Legacy track tasks\n\nMoved here from `tracks/' + t.slug + '/tasks/` during migration.\n'), 'utf-8');
      }
      for (const f of t.files) {
        const src = path.join(t.dir, f);
        const dst = path.join(legacyIter, 'tasks', f);
        fs.renameSync(src, dst);
        // update task frontmatter
        if (dst.endsWith('.md')) {
          const [tfm, tb] = parseTask(readText(dst));
          if (tfm) {
            tfm.iteration = '000';
            tfm.track = t.slug;
            if (tfm.attempts == null) tfm.attempts = 0;
            fs.writeFileSync(dst, serializeTask(tfm, tb || ''), 'utf-8');
          }
        }
      }
    }
    fs.rmSync(t.dir, { recursive: true, force: true });
    log(`removed legacy tracks/${t.slug}/tasks/`);
  }

  // 5e. Drop top-level iterations/ + ACTIVE
  if (exists(OLD_ITERS)) {
    const remaining = fs.readdirSync(OLD_ITERS);
    if (!remaining.length) {
      fs.rmdirSync(OLD_ITERS);
      log('removed empty .workflow/iterations/');
    } else {
      log(`WARN: .workflow/iterations/ still has entries: ${remaining.join(', ')}`);
    }
  }
  if (exists(OLD_ACTIVE)) {
    fs.unlinkSync(OLD_ACTIVE);
    log('removed legacy .workflow/ACTIVE');
  }

  log('migration complete.');
  return { migrated: true };
}

// CLI
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('migrate.mjs')) {
  const apply = process.argv.includes('--apply');
  const r = migrate({ apply });
  process.exit(r.migrated || r.dryRun || !needsMigration() ? 0 : 1);
}
