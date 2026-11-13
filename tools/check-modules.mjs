// tools/check-modules.mjs — a quick consistency check of the game's native ES modules (there is no bundler to do it):
// every file parses, every relative import names something its module exports, and index.html preloads every module.
// usage: node tools/check-modules.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(ROOT, 'js');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
let problems = 0;
const fail = (msg) => { problems++; console.log('  ✗ ' + msg); };

const exportsOf = new Map();
const sources = new Map();
for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  sources.set(f, src);
  if (f !== 'akl-geodata.js') {
    try {
      execFileSync(process.execPath, ['--check', path.join(dir, f)], { stdio: 'pipe' });
    } catch (e) {
      fail(`${f}: ${String(e.stderr).split('\n').slice(0, 6).join(' | ')}`);
    }
  }
  const names = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  exportsOf.set(f, names);
}
for (const [f, src] of sources) {
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w-]+\.js)'/g)) {
    const target = m[2];
    if (!exportsOf.has(target)) { fail(`${f}: imports from missing module ./${target}`); continue; }
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name && !exportsOf.get(target).has(name)) fail(`${f}: "${name}" is not exported by ./${target}`);
    }
  }
}
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const preloaded = new Set([...html.matchAll(/modulepreload" href="\.\/js\/([\w-]+\.js)"/g)].map((m) => m[1]));
// modules reachable from main.js
const seen = new Set();
const walk = (f) => {
  if (seen.has(f) || !sources.has(f)) return;
  seen.add(f);
  for (const m of sources.get(f).matchAll(/from\s*'\.\/([\w-]+\.js)'/g)) walk(m[1]);
};
walk('main.js');
for (const f of seen) if (!preloaded.has(f)) fail(`index.html does not preload ./js/${f}`);
for (const f of preloaded) if (!seen.has(f)) fail(`index.html preloads ./js/${f}, which main.js never reaches`);
for (const f of files) if (!seen.has(f)) console.log(`  (unused module: js/${f})`);
console.log(problems ? `${problems} problem(s)` : `ok: ${seen.size} modules`);
process.exit(problems ? 1 : 0);
