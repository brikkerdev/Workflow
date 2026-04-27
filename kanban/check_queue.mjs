#!/usr/bin/env node
// SessionStart hook: check .workflow/queue/ in current project, emit a system
// reminder if non-empty. Stdout becomes additional Claude context.
//
// Project root: $WORKFLOW_PROJECT or process.cwd()

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.env.WORKFLOW_PROJECT || process.cwd());
const QUEUE = path.join(ROOT, '.workflow', 'queue');

if (!fs.existsSync(QUEUE)) process.exit(0);

const items = fs.readdirSync(QUEUE).filter(n => n.endsWith('.json')).sort();
if (!items.length) process.exit(0);

const ids = items.map(n => n.slice(0, -5));
console.log('<system-reminder>');
console.log(`There are ${ids.length} pending dispatch triggers in .workflow/queue/: ${ids.join(', ')}.`);
console.log('Run /queue to dispatch them as background agents.');
console.log('</system-reminder>');
