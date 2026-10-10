'use strict';
// Run: TZ=America/New_York node bigvault.test.js <path-to-main.js>
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

/* ---- controllable clock + timer instrumentation ---- */
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;
const advance = (ms) => { offset += ms; };
let lastWake = performance.now(), maxChunk = 0;
const realSetTimeout = global.setTimeout;
global.setTimeout = (f, ms, ...a) => {
  maxChunk = Math.max(maxChunk, performance.now() - lastWake);
  return realSetTimeout(() => { lastWake = performance.now(); f(...a); }, ms, ...a);
};
const pending = [];
global.window = {
  localStorage: { _s: { 'activity-timeline-device:Test Vault': 'desktop-test01' }, getItem(k) { return this._s[k] || null; }, setItem(k, v) { this._s[k] = v; } },
  setInterval: () => 0,
  setTimeout: (f) => { pending.push(f); return 0; },
};
global.document = { hasFocus: () => true };

const obs = require('obsidian');
const moment = obs.moment;
const Plugin = require(path.resolve(process.argv[2]));
const T = Plugin._test;

const results = [];
const ok = (name, cond, detail) => { results.push([cond ? 'PASS' : 'FAIL', name, detail || '']); };
const time = async (f) => { const t0 = performance.now(); const r = await f(); return [performance.now() - t0, r]; };

/* ---- generate vault ---- */
function rnd(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
const R = rnd(42);
const pick = (a) => a[Math.floor(R() * a.length)];
const N = 10000;
const NOW = Date.now();
const YEAR = 365 * 86400000;
const MIG = moment('2025-03-15 14:00', 'YYYY-MM-DD HH:mm').valueOf();   // vault copied to a new machine
const SYNC = moment('2026-06-01 09:30', 'YYYY-MM-DD HH:mm').valueOf();  // a sync touched many files
const TAGS = Array.from({ length: 30 }, (_, i) => '#tag' + i);
const TOPS = ['Projects', 'Areas', 'Resources', 'Archive', 'Daily', 'Journal', 'Work', 'Music'];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atl-'));
const app = obs.makeApp(root);
const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20);
let withTasks = 0, migNoProp = 0, propNotes = [];
for (let i = 0; i < N; i++) {
  const top = pick(TOPS);
  const sub = 'Sub' + Math.floor(R() * 5);
  const deep = R() < 0.3 ? '/Deep' + Math.floor(R() * 3) : '';
  const p = `${top}/${sub}${deep}/Note ${i}.md`;
  const mig = R() < 0.4;
  let ctime = mig ? MIG : NOW - Math.floor(R() * 4 * YEAR) - 86400000;
  const hasProp = R() < 0.2;
  const propDate = moment(NOW - Math.floor(R() * 4 * YEAR) - 2 * 86400000).format('YYYY-MM-DD');
  let mtime = Math.min(NOW - 86400000, ctime + Math.floor(R() * YEAR));
  if (R() < 0.15) mtime = SYNC;
  const tags = [pick(TAGS), pick(TAGS)];
  const tasks = R() < 0.3;
  let body = `---\n${hasProp ? 'created: ' + propDate + '\n' : ''}tags: [${tags.map((t) => t.slice(1)).join(', ')}]\n---\n# Note ${i}\n${filler}\n`;
  const listItems = [];
  if (tasks) {
    withTasks++;
    for (let k = 0; k < 5; k++) {
      const r = R();
      const d = moment(NOW - Math.floor(R() * 3 * YEAR)).format('YYYY-MM-DD');
      if (r < 0.4) body += `- [x] Task ${i}-${k} ✅ ${d}\n`;
      else if (r < 0.5) body += `- [-] Task ${i}-${k} ❌ ${d}\n`;
      else body += `- [ ] Task ${i}-${k} 📅 ${d}\n`;
      listItems.push({ task: r < 0.4 ? 'x' : r < 0.5 ? '-' : ' ' });
    }
  }
  if (mig && !hasProp) migNoProp++;
  if (hasProp) propNotes.push({ p, propDate });
  const f = app.vault.addFile(p, body, { ctime, mtime });
  app.metadataCache.caches.set(p, { frontmatter: Object.assign({ tags }, hasProp ? { created: propDate } : {}), listItems: listItems.length ? listItems : undefined, tags: [] });
}
// two years of logs from this device and a phone (~40 events/day each)
const logDir = path.join(root, '.activity-log');
fs.mkdirSync(logDir, { recursive: true });
let logBytes = 0;
for (const dev of ['desktop-test01', 'mobile-abc123']) {
  for (let m = 0; m < 24; m++) {
    const month = moment(NOW).startOf('month').subtract(m, 'months');
    const lines = [];
    const days = m === 0 ? Number(moment(NOW).format('D')) - 1 : 28;
    for (let d = 0; d < days; d++) for (let k = 0; k < 40; k++) {
      const t = month.clone().add(d, 'days').valueOf() + 8 * 3600000 + k * 600000;
      lines.push(JSON.stringify({ id: `${dev}-${m}-${d}-${k}`, t, type: 'edited', path: `Projects/Sub1/Note ${k}.md`, title: `Note ${k}`, ext: 'md', d: dev, snippet: 'changed line ' + k, lines: 1, void: false }));
    }
    const fname = path.join(logDir, `${month.format('YYYY-MM')}-${dev}.jsonl`);
    fs.writeFileSync(fname, lines.join('\n') + '\n');
    logBytes += fs.statSync(fname).size;
  }
}

(async () => {
  console.log(`vault: ${N} notes (${withTasks} with tasks, ${migNoProp} copied without a created property), logs: ${(logBytes / 1e6).toFixed(1)} MB over 24 months × 2 devices`);

  /* 1. startup */
  const plugin = new Plugin(app);
  const [tLoad] = await time(() => plugin.onload());
  const [tReady] = await time(() => app.workspace._ready());
  ok('startup is quick', tLoad + tReady < 1500, `${(tLoad + tReady).toFixed(0)} ms`);
  ok('only recent log months loaded at startup', plugin.loadedMonths.size <= 4, `${plugin.loadedMonths.size} months, ${plugin.events.size} events`);
  ok('first-run lookback question shown', app._modals.length === 1 && app._modals[0].contentEl.allText().includes('How far back'));
  const optionLabels = app._modals[0].contentEl.find((e) => e.tagName === 'button').map((b) => b.text);
  ok('lookback options offered', optionLabels.join('|') === 'Only from today|Last month|Last 6 months|Last year|Everything', optionLabels.join(', '));
  // pick "Everything" via the button
  const everything = app._modals[0].contentEl.find((e) => e.tagName === 'button' && e.text === 'Everything')[0];
  await everything.onclick();
  ok('choice saved', plugin.settings.historyDays === -1 && plugin.settings.onboarded === true);

  /* 2. background indexing */
  maxChunk = 0; lastWake = performance.now();
  const [tIndex] = await time(() => pending.shift()());
  ok('background indexing completes', plugin.indexed, `${(tIndex / 1000).toFixed(1)} s wall time, ${app.vault.reads} note reads`);
  ok('indexing never blocks Obsidian for long', maxChunk < 400, `longest uninterrupted stretch ${maxChunk.toFixed(0)} ms`);
  ok('only notes with tasks were read', app.vault.reads <= withTasks + 5, `${app.vault.reads} reads for ${withTasks} task notes`);
  ok('baseline saved', fs.existsSync(path.join(logDir, 'baseline.json')), `${(fs.statSync(path.join(logDir, 'baseline.json')).size / 1e6).toFixed(2)} MB`);

  /* 3. views */
  const leaf = { app };
  const view = plugin._viewFactory(leaf);
  leaf.view = view;
  app.workspace.leaves.push(leaf);
  await view.onOpen();
  for (const range of ['day', 'week', 'month', 'year']) {
    view.range = range; view.anchor = moment();
    const n0 = obs.nodeCounter();
    const [t] = await time(() => view.render());
    ok(`${range} view renders fast`, t < 300, `${t.toFixed(0)} ms, ${obs.nodeCounter() - n0} elements`);
  }
  // Year 2025 (older months load on demand, then redraw)
  view.range = 'year'; view.anchor = moment('2025-06-01', 'YYYY-MM-DD');
  const before = plugin.loadedMonths.size;
  view.render();
  await plugin.ensureMonths(moment('2025-01-01', 'YYYY-MM-DD').valueOf(), moment('2025-12-31', 'YYYY-MM-DD').valueOf());
  const [tY] = await time(() => view.render());
  ok('older months load only when viewed', plugin.loadedMonths.size > before, `${before} → ${plugin.loadedMonths.size} months`);
  ok('2025 year view renders fast', tY < 400, `${tY.toFixed(0)} ms`);

  /* 4. copied-vault spike folded into one entry */
  const migDay = plugin.eventsForDay(moment(MIG).format('YYYY-MM-DD'), () => true);
  const imported = migDay.filter((e) => e.type === 'imported');
  ok('copy day folded into one "imported" entry', imported.length === 1 && imported[0].count >= migNoProp && imported[0].count <= migNoProp + 10, imported.length ? `${imported[0].count} notes in 1 entry (${migNoProp} copied + notes genuinely created that day)` : 'none');
  ok('no individual created cards that day', !migDay.some((e) => e.type === 'created' && !e.prop));
  const syncDay = plugin.eventsForDay(moment(SYNC).format('YYYY-MM-DD'), () => true);
  const touched = syncDay.filter((e) => e.type === 'touched');
  ok('mass "modified" day folded into one entry', touched.length === 1, touched.length ? `${touched[0].count} notes` : 'none');
  // folder-filtered spike still folds
  const proj = plugin.eventsForDay(moment(MIG).format('YYYY-MM-DD'), (e) => (e.path || '').startsWith('Projects/'));
  ok('spike respects folder filter', proj.length >= 1 && proj.every((e) => e.type === 'imported' ? e.count < migNoProp : true), proj.map((e) => e.type + ':' + (e.count || 1)).join(', '));

  /* 5. created property wins */
  const pn = propNotes[0];
  const propDay = plugin.eventsForDay(pn.propDate, () => true);
  ok('created property used as creation date', propDay.some((e) => e.type === 'created' && e.path === pn.p && e.prop), `${pn.p} on ${pn.propDate}`);

  /* 6. task history */
  const taskHist = Array.from(plugin.hist.values()).filter((e) => e.type === 'task-done').length;
  ok('Tasks completion dates in history', taskHist > withTasks, `${taskHist} completed tasks`);

  /* 7. lookback 30 days */
  const [tLb] = await time(() => plugin.setLookback(30));
  const from30 = plugin.settings.installedAt - 30 * 86400000;
  const older = Array.from(plugin.hist.values()).filter((e) => e.t < from30).length;
  ok('"last month" hides older history', older === 0, `${plugin.hist.size} history entries left, rebuilt in ${tLb.toFixed(0)} ms`);
  await plugin.setLookback(0);
  ok('"only from today" shows no history', plugin.hist.size === 0);
  await plugin.setLookback(-1);

  /* 8. normal edits are logged individually */
  advance(60000);
  plugin.lastInput = Date.now();
  const edit = (p, newBody) => {
    const f = app.vault.files.get(p);
    app.vault.contents.set(p, newBody);
    plugin.onChanged(f, newBody, app.metadataCache.caches.get(p));
  };
  const today = moment().format('YYYY-MM-DD');
  const notesToday = () => plugin.eventsForDay(today, () => true);
  const n1 = 'Projects/Sub1/Note 1.md' in {} ? null : Array.from(app.vault.files.keys())[1];
  const n2 = Array.from(app.vault.files.keys())[2];
  await plugin.snapshot(app.vault.files.get(n1), true);
  await plugin.snapshot(app.vault.files.get(n2), true);
  edit(n1, app.vault.contents.get(n1) + '\nA new idea about the arp settings\n');
  edit(n2, app.vault.contents.get(n2) + '\nCalled the supplier\n');
  const edits = notesToday().filter((e) => e.type === 'edited' && !e.history && (e.path === n1 || e.path === n2));
  ok('two ordinary edits → two cards with previews', edits.length === 2 && edits.every((e) => e.snippet), edits.map((e) => JSON.stringify(e.snippet)).join(' | '));

  /* 9. ticking a task */
  const taskNote = Array.from(app.vault.files.keys()).find((p) => /- \[ \] Task/.test(app.vault.contents.get(p)));
  const body = app.vault.contents.get(taskNote);
  const line = body.split('\n').find((l) => l.startsWith('- [ ] Task'));
  const desc = /Task \S+/.exec(line)[0];
  edit(taskNote, body.replace(line, line.replace('- [ ]', '- [x]') + ` ✅ ${today}`));
  const tickCards = notesToday().filter((e) => e.type === 'task-done' && e.title === desc);
  ok('ticking a task → exactly one "completed" card', tickCards.length === 1 && !tickCards[0].history, `${tickCards.length} card(s) for ${desc}`);

  /* 10. bulk change: folder rename + link updates */
  advance(60000);
  plugin.lastInput = Date.now();
  const before10 = new Set(notesToday().map((e) => e.id));
  const moved = Array.from(app.vault.files.keys()).filter((p) => p.startsWith('Music/Sub2/')).slice(0, 300);
  for (const old of moved) {
    const f = app.vault.files.get(old);
    const np = old.replace('Music/Sub2/', 'Music/Synths/');
    app.vault.files.delete(old);
    const nf = app.vault.addFile(np, app.vault.contents.get(old), f.stat);
    app.metadataCache.caches.set(np, app.metadataCache.caches.get(old));
    plugin.onRename(nf, old);
  }
  const linkers = Array.from(app.vault.files.keys()).filter((p) => p.startsWith('Areas/')).slice(0, 200);
  for (const p of linkers) edit(p, app.vault.contents.get(p).replace('# Note', '# Note [[Synths]]'));
  const new10 = notesToday().filter((e) => !before10.has(e.id));
  const bulks = new10.filter((e) => e.type === 'bulk');
  ok('folder rename + link updates → one bulk card', bulks.length === 1 && new10.length === 1, `${new10.length} new card(s): ${bulks.map((b) => b.count + ' notes, ' + JSON.stringify(b.kinds)).join('; ')}`);
  if (bulks[0]) ok('bulk card title reads well', new RegExp('^' + bulks[0].count + ' notes moved or renamed at once$').test(T.titleFor(bulks[0])), T.titleFor(bulks[0]));
  // after things go quiet, normal tracking resumes
  advance(60000);
  plugin.lastInput = Date.now();
  const n3 = Array.from(app.vault.files.keys())[3];
  await plugin.snapshot(app.vault.files.get(n3), true);
  edit(n3, app.vault.contents.get(n3) + '\nBack to normal\n');
  ok('normal tracking resumes after a bulk change', notesToday().some((e) => e.path === n3 && e.type === 'edited' && !e.history));

  /* 11. log persistence */
  await plugin.flush();
  const p2 = new Plugin(app);
  p2._data = plugin._data;
  app._codeblocks = {};
  await p2.onload();
  await app.workspace._ready();
  const reloaded = p2.eventsForDay(today, () => true);
  ok('bulk + edits survive a restart', reloaded.filter((e) => e.type === 'bulk').length === 1 && reloaded.some((e) => e.path === n3), `${reloaded.length} cards today after reload`);

  /* 12. trimming */
  plugin.settings.keepLogMonths = 12;
  const removed = await plugin.pruneLogs();
  const left = fs.readdirSync(logDir);
  ok('trimming removes only this device\'s old months', removed >= 11 && left.filter((f) => f.includes('mobile')).length === 24, `${removed} files removed; phone files kept: ${left.filter((f) => f.includes('mobile')).length}`);

  /* 13. hidden view doesn't redraw */
  let renders = 0;
  const orig = view.render.bind(view);
  view.render = () => { renders++; orig(); };
  view.containerEl.shown = false;
  plugin.renderViews(false);
  ok('hidden timeline is not redrawn', renders === 0 && view.stale === true);
  view.containerEl.shown = true;
  plugin.renderViews(true);
  ok('redraws once shown again', renders === 1 && view.stale === false);

  /* 14. daily-note embed */
  const el = new obs.El('div');
  const [tEmb] = await time(() => app._codeblocks['activity-timeline']('', el, { sourcePath: `Daily/${today}.md` }));
  ok('daily-note block renders', el.allText().includes('Activity ·'), `${tEmb.toFixed(0)} ms`);

  /* 15. earlier unit checks still hold */
  const D = (o, n) => T.diffTasks(T.taskLines(o), T.taskLines(n), '2026-10-06').map((x) => x.type);
  ok('task diff: tick', D('- [ ] Water 📅 2026-10-06', '- [x] Water 📅 2026-10-06 ✅ 2026-10-06').join() === 'task-done');
  ok('task diff: recurring', D('- [ ] W 🔁 every week 📅 2026-10-06', '- [ ] W 🔁 every week 📅 2026-10-13\n- [x] W 🔁 every week 📅 2026-10-06 ✅ 2026-10-06').join() === 'task-done');
  ok('created property parsing', T.propCreated({ frontmatter: { Created: '2023-05-01T09:30' } }).t === moment('2023-05-01 09:30', 'YYYY-MM-DD HH:mm').valueOf());

  console.log('');
  for (const [s, n, d] of results) console.log(`${s}  ${n}${d ? '  — ' + d : ''}`);
  const fails = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - fails}/${results.length} passed`);
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
