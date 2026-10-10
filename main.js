'use strict';
/*
 * Activity Timeline — Obsidian plugin v0.1.2
 * Logs what you do in your vault (notes created/edited with change previews,
 * Tasks-plugin tasks completed/dropped, tags added/removed) and shows it as a
 * filterable timeline. Plain JavaScript, no build step. Works on desktop and mobile.
 */
const obsidian = require('obsidian');
const { Plugin, ItemView, Modal, PluginSettingTab, Setting, TFile, TFolder, setIcon, moment, getAllTags, debounce, Platform } = obsidian;

const VIEW_TYPE = 'dorn-activity-timeline-view';
const LOG_DIR = '.activity-log';
const BASELINE = LOG_DIR + '/baseline.json';
const FLUSH_MS = 30000;
const DAY = 'YYYY-MM-DD';
const DAY_MS = 86400000;
const HEAT_WEEKS = 10;

// Bulk changes: this many different notes changed within the window = one "bulk change" card
const BULK_THRESHOLD = 15;
const BULK_WINDOW_MS = 8000;
const BULK_QUIET_MS = 6000;

const LOOKBACK = [
  [0, 'Only from today'],
  [30, 'Last month'],
  [182, 'Last 6 months'],
  [365, 'Last year'],
  [-1, 'Everything'],
];
const KEEP_LOG = [[0, 'Forever'], [12, '1 year'], [24, '2 years'], [60, '5 years']];

const DEFAULT_SETTINGS = {
  excludeFolders: '',
  captureFolders: '',
  groupMinutes: 30,
  snippetLines: 4,
  historyDays: 365,
  keepLogMonths: 0,
  onboarded: false,
  installedAt: 0,
};

/* ------------------------------------------------------------------ helpers */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function basename(path) {
  return path.split('/').pop().replace(/\.(md|canvas)$/, '');
}

function dayKey(t) {
  return moment(t).format(DAY);
}

function nonEmpty(lines, n) {
  return lines.filter((l) => l.trim()).slice(0, n).join('\n');
}

function stripFrontmatter(content) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function bodyPreview(content, n) {
  return nonEmpty(stripFrontmatter(content).split('\n'), n);
}

function uniqTags(cache) {
  return cache ? Array.from(new Set(getAllTags(cache) || [])) : [];
}

function topFolder(path) {
  return path.includes('/') ? path.split('/')[0] : '(vault root)';
}

function folderSummary(counts, n) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n || 3).map(([f, c]) => `${f} (${c})`).join(' · ');
}

/** Smallest changed block between two texts (common prefix/suffix trimmed). */
function changedRegion(oldText, newText) {
  const a = oldText.split('\n');
  const b = newText.split('\n');
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { start: p, added: b.slice(p, b.length - s), removed: a.slice(p, a.length - s) };
}

/** A note's own creation date from its properties, if it has one. */
const CREATED_KEYS = ['created', 'created_at', 'createdat', 'date created', 'date-created', 'date_created', 'creation date', 'creation_date', 'creation-date'];
const DATE_FORMATS = ['YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DDTHH:mm', 'YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD'];
function propCreated(cache) {
  const fm = cache && cache.frontmatter;
  if (!fm) return null;
  for (const k of Object.keys(fm)) {
    if (!CREATED_KEYS.includes(k.toLowerCase())) continue;
    let v = fm[k];
    if (Array.isArray(v)) v = v[0];
    if (typeof v !== 'string') continue;
    v = v.trim().replace(/^\[\[|\]\]$/g, '');
    let m = moment(v, DATE_FORMATS, true);
    if (!m.isValid()) m = moment(v, moment.ISO_8601, true);
    if (m.isValid()) return { t: m.valueOf(), dateOnly: /^\d{4}-\d{2}-\d{2}$/.test(v) };
  }
  return null;
}

/** Map of day -> Set of ids. */
class DayIndex {
  constructor() { this.days = new Map(); }
  add(day, id) {
    let s = this.days.get(day);
    if (!s) { s = new Set(); this.days.set(day, s); }
    s.add(id);
  }
  remove(day, id) {
    const s = this.days.get(day);
    if (s) { s.delete(id); if (!s.size) this.days.delete(day); }
  }
  get(day) { return this.days.get(day); }
  clear() { this.days.clear(); }
}

/* ---------------------------------------------------- Tasks plugin parsing */

const TASK_RE = /^\s*(?:[-*+]|\d+[.)])\s+\[(.)\]\s+(.*)$/;
const PRIORITIES = [['🔺', 'highest'], ['⏫', 'high'], ['🔼', 'medium'], ['🔽', 'low'], ['⏬', 'lowest']];

function field(raw, emoji, name) {
  const re = new RegExp('(?:' + emoji + '\\uFE0F?\\s*(\\d{4}-\\d{2}-\\d{2})|\\[' + name + '::\\s*(\\d{4}-\\d{2}-\\d{2})\\])', 'u');
  const m = re.exec(raw);
  return m ? m[1] || m[2] : null;
}

function cleanDesc(raw) {
  return raw
    .replace(/(?:📅|⏳|🛫|➕|✅|❌)️?\s*\d{4}-\d{2}-\d{2}/gu, '')
    .replace(/🔁️?[^📅⏳🛫➕✅❌🆔⛔]*/gu, '')
    .replace(/(?:🆔|⛔)️?\s*\S+/gu, '')
    .replace(/🔺|⏫|🔼|🔽|⏬/gu, '')
    .replace(/\[[\w-]+::[^\]]*\]/g, '')
    .replace(/\s\^[\w-]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTask(line) {
  const m = TASK_RE.exec(line);
  if (!m) return null;
  const raw = m[2];
  let priority = null;
  for (const [emoji, name] of PRIORITIES) if (raw.includes(emoji)) { priority = name; break; }
  if (!priority) { const pm = /\[priority::\s*(\w+)\]/.exec(raw); if (pm) priority = pm[1]; }
  return {
    status: m[1],
    desc: cleanDesc(raw),
    done: field(raw, '✅', 'completion'),
    cancelled: field(raw, '❌', 'cancelled'),
    due: field(raw, '📅', 'due'),
    priority,
    recurring: raw.includes('🔁') || /\[repeat::/.test(raw),
  };
}

function taskLines(content) {
  const out = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = parseTask(lines[i]);
    if (t) { t.line = i; out.push(t); }
  }
  return out;
}

const isDone = (s) => s === 'x' || s === 'X';

/** Status changes between two versions of a note's tasks. */
function diffTasks(oldTasks, newTasks, today) {
  const pool = new Map();
  for (const t of oldTasks) {
    if (!pool.has(t.desc)) pool.set(t.desc, []);
    pool.get(t.desc).push(t);
  }
  const out = [];
  for (const t of newTasks) {
    if (!t.desc) continue;
    const arr = pool.get(t.desc);
    if (arr && arr.length) {
      let i = arr.findIndex((o) => o.status === t.status);
      if (i < 0) i = 0;
      const o = arr.splice(i, 1)[0];
      if (o.status === t.status) continue;
      if (isDone(t.status)) out.push({ type: 'task-done', task: t });
      else if (t.status === '-') out.push({ type: 'task-cancelled', task: t });
      if (isDone(o.status) || o.status === '-') out.push({ type: 'task-undo', task: t, was: isDone(o.status) ? 'task-done' : 'task-cancelled' });
    } else if (isDone(t.status) && t.done === today) {
      // e.g. a recurring task: Tasks inserts the completed copy as a new line
      out.push({ type: 'task-done', task: t });
    } else if (t.status === '-' && t.cancelled === today) {
      out.push({ type: 'task-cancelled', task: t });
    }
  }
  return out;
}

function taskMeta(t) {
  return { priority: t.priority, due: t.due, recurring: t.recurring, line: t.line };
}

/* ------------------------------------------------------------------ plugin */

class ActivityTimelinePlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    if (!this.settings.installedAt) this.settings.installedAt = Date.now();
    await this.saveSettings();

    this.deviceId = this.getDeviceId();
    // logged events
    this.events = new Map();
    this.logDay = new DayIndex();
    this.dirty = new Map();
    this.loadedMonths = new Set();
    this.logList = null;
    this.logListAt = 0;
    // reconstructed history (from before install)
    this.hist = new Map();
    this.histDay = new DayIndex();
    this.histByPath = new Map();
    this.baseline = null;
    this.baselineDirty = false;
    this.indexed = false;
    this.spikeMin = BULK_THRESHOLD;
    // change tracking
    this.snap = new Map();
    this.sessions = new Map();
    this.createdRecent = new Map();
    this.touched = new Map();
    this.burst = { recent: [], active: null };
    this.bulkPaths = new Map();
    this.lastInput = 0;

    this.ready = new Promise((r) => (this._resolveReady = r));
    this.refreshViews = debounce(() => this.renderViews(false), 1500, true);

    this.registerView(VIEW_TYPE, (leaf) => new TimelineView(leaf, this));
    this.addRibbonIcon('history', 'Open activity timeline', () => this.activateView());
    this.addCommand({ id: 'open', name: 'Open activity timeline', callback: () => this.activateView() });
    this.addCommand({ id: 'open-today', name: "Show today's activity", callback: () => this.activateView('day') });
    this.addCommand({ id: 'lookback', name: 'Choose how far back the timeline goes', callback: () => new LookbackModal(this.app, this).open() });
    this.addSettingTab(new TimelineSettingTab(this.app, this));
    // another plugin may already own the `activity-timeline` block name; don't fail to load if so
    for (const lang of ['activity-timeline', 'day-activity']) {
      try { this.registerMarkdownCodeBlockProcessor(lang, (src, el, ctx) => this.renderEmbed(src, el, ctx)); }
      catch (e) { console.warn('Activity Timeline: code block "' + lang + '" is taken by another plugin'); }
    }

    // "Was this change made by me, on this device?" signals
    const mark = () => (this.lastInput = Date.now());
    this.registerDomEvent(document, 'keydown', mark, true);
    this.registerDomEvent(document, 'pointerdown', mark, true);
    this.registerDomEvent(document, 'visibilitychange', () => { if (document.hidden) this.flush(); });
    this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
      if (info && info.file) this.touched.set(info.file.path, Date.now());
    }));
    this.registerEvent(this.app.workspace.on('file-open', (f) => f && this.snapshot(f, true)));
    this.registerEvent(this.app.workspace.on('quit', () => this.flush()));
    // timeline hidden behind another tab doesn't redraw; catch up when it's shown again
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.renderViews(true)));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.renderViews(true)));

    this.app.workspace.onLayoutReady(async () => {
      await this.pruneLogs();
      await this.ensureMonths(moment().subtract(HEAT_WEEKS + 1, 'weeks').valueOf(), Date.now());
      this.registerEvent(this.app.vault.on('create', (f) => this.onCreate(f)));
      this.registerEvent(this.app.vault.on('delete', (f) => this.onDelete(f)));
      this.registerEvent(this.app.vault.on('rename', (f, old) => this.onRename(f, old)));
      this.registerEvent(this.app.vault.on('modify', (f) => {
        if (f instanceof TFile && f.extension === 'canvas') this.onCanvas(f);
      }));
      this.registerEvent(this.app.metadataCache.on('changed', (f, data, cache) => this.onChanged(f, data, cache)));
      const active = this.app.workspace.getActiveFile();
      if (active) await this.snapshot(active, true);
      this._resolveReady();
      this.refreshViews();
      if (!this.settings.onboarded) new LookbackModal(this.app, this).open();
      // index older history gently in the background, after Obsidian has settled
      this.registerInterval(window.setTimeout(() => this.backgroundIndex(), 2000));
    });

    this.registerInterval(window.setInterval(() => this.flush(), FLUSH_MS));
    this.registerInterval(window.setInterval(() => this.refreshOtherDevices(), 120000));
  }

  onunload() {
    this.flush();
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // 0.1.0/0.1.1 had an on/off "showHistory" switch
    if (data.historyDays === undefined && data.showHistory === false) this.settings.historyDays = 0;
    delete this.settings.showHistory;
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getDeviceId() {
    const key = 'activity-timeline-device:' + this.app.vault.getName();
    let id = window.localStorage.getItem(key);
    if (!id) {
      id = (Platform.isMobile ? 'mobile-' : 'desktop-') + Math.random().toString(36).slice(2, 8);
      window.localStorage.setItem(key, id);
    }
    return id;
  }

  async activateView(range) {
    const ws = this.app.workspace;
    let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = ws.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    ws.revealLeaf(leaf);
    if (range && leaf.view instanceof TimelineView) {
      leaf.view.range = range;
      leaf.view.anchor = moment();
      leaf.view.render();
    }
  }

  /** Redraw open timelines that are on screen; mark hidden ones to redraw when shown. */
  renderViews(onlyStale) {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const v = leaf.view;
      if (!(v instanceof TimelineView)) continue;
      if (onlyStale && !v.stale) continue;
      if (v.isVisible()) v.render();
      else v.stale = true;
    }
  }

  async setLookback(days) {
    this.settings.historyDays = days;
    this.settings.onboarded = true;
    await this.saveSettings();
    if (this.baseline) await this.rebuildAllHistory();
    this.renderViews(false);
  }

  historyFrom() {
    const d = this.settings.historyDays;
    if (d < 0) return 0;
    return this.settings.installedAt - d * DAY_MS;
  }

  /* ----- filters ----- */

  folderList(text) {
    return text.split('\n').map((l) => l.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean);
  }

  excluded(path) {
    if (path.startsWith(LOG_DIR + '/') || path.startsWith(this.app.vault.configDir + '/')) return true;
    return this.folderList(this.settings.excludeFolders).some((f) => path === f || path.startsWith(f + '/'));
  }

  captureFor(path) {
    for (const line of this.settings.captureFolders.split('\n')) {
      if (!line.trim()) continue;
      const [folderRaw, labelRaw] = line.split(/[:=]/);
      const folder = folderRaw.trim().replace(/^\/+|\/+$/g, '');
      if (folder && path.startsWith(folder + '/')) return (labelRaw || folder.split('/').pop()).trim();
    }
    return null;
  }

  isLocal(path) {
    const now = Date.now();
    return now - (this.touched.get(path) || 0) < 15000 || (now - this.lastInput < 5000 && document.hasFocus());
  }

  tracked(file) {
    return file instanceof TFile && (file.extension === 'md' || file.extension === 'canvas') && !this.excluded(file.path);
  }

  /* ----- snapshots (previous version of each note, for diffs) ----- */

  async snapshot(file, withContent) {
    if (!this.tracked(file)) return;
    const content = await this.app.vault.cachedRead(file);
    this.setSnap(file.path, content, this.app.metadataCache.getFileCache(file), withContent);
  }

  setSnap(path, content, cache, withContent) {
    const prev = this.snap.get(path);
    const keep = withContent || (prev && prev.content != null);
    const isMd = path.endsWith('.md');
    const tasks = isMd ? taskLines(content) : [];
    this.snap.set(path, { content: keep ? content : null, tasks, tags: isMd ? uniqTags(cache) : [] });
    if (keep) {
      // keep full text for at most ~40 notes
      let withText = 0;
      for (const [p, s] of Array.from(this.snap.entries()).reverse()) {
        if (s.content == null) continue;
        if (++withText > 40 && p !== path) s.content = null;
      }
    }
    // task completion dates feed the history; refresh this note's entries
    if (this.baseline && (tasks.length || (prev && prev.tasks.length))) this.updatePathHistory(path);
  }

  /** Read notes that contain tasks, a few at a time, so later ticks can be detected. */
  async primeSnapshots() {
    const files = this.app.vault.getMarkdownFiles();
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (this.snap.has(f.path) || this.excluded(f.path)) continue;
      const cache = this.app.metadataCache.getFileCache(f);
      const hasTasks = cache && cache.listItems && cache.listItems.some((li) => li.task !== undefined);
      if (hasTasks) {
        const content = await this.app.vault.cachedRead(f);
        if (!this.snap.has(f.path)) this.setSnap(f.path, content, cache, false);
      } else {
        this.snap.set(f.path, { content: null, tasks: [], tags: uniqTags(cache) });
      }
      if (i % 50 === 49) await sleep(16);
    }
  }

  async backgroundIndex() {
    try {
      await this.loadBaseline();
      await this.rebuildAllHistory();
      this.renderViews(false);
      await this.primeSnapshots();
    } catch (err) {
      console.error('Activity Timeline: indexing failed', err);
    }
    this.indexed = true;
    this.renderViews(false);
  }

  /* ----- history from before install ----- */

  /** Created/modified dates of every note as first seen, so later edits don't erase them. */
  async loadBaseline() {
    const a = this.app.vault.adapter;
    try {
      if (await a.exists(BASELINE)) {
        const b = JSON.parse(await a.read(BASELINE));
        if (b && b.files) { this.baseline = b; return; }
      }
    } catch (e) { /* rebuild below */ }
    const files = {};
    for (const f of this.app.vault.getFiles()) {
      if (f.extension === 'md' || f.extension === 'canvas') files[f.path] = [f.stat.ctime, f.stat.mtime];
    }
    this.baseline = { v: 1, at: Date.now(), files };
    this.baselineDirty = true;
    await this.flush();
  }

  computePathHistory(path) {
    const s = this.settings;
    if (!s.historyDays) return [];
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!this.tracked(file)) return [];
    const from = this.historyFrom();
    const inst = s.installedAt;
    const cache = this.app.metadataCache.getFileCache(file);
    const tags = uniqTags(cache);
    const base = { history: true, path, title: file.basename, ext: file.extension, tags };
    const out = [];
    const b = this.baseline && this.baseline.files[path];
    const prop = propCreated(cache);
    const cT = prop ? prop.t : b ? b[0] : null;
    if (cT && cT < inst && cT >= from) {
      out.push(Object.assign({ id: 'h:c:' + path, t: cT, type: 'created', prop: !!prop, approx: prop ? prop.dateOnly : false }, base));
    }
    if (b && b[1] < inst && b[1] >= from && (!cT || b[1] - cT > 60000)) {
      out.push(Object.assign({ id: 'h:m:' + path, t: b[1], type: 'edited' }, base));
    }
    const sn = this.snap.get(path);
    if (sn) {
      for (const t of sn.tasks) {
        const add = (type, date) => {
          const t0 = moment(date, DAY).valueOf();
          if (t0 < from) return;
          const key = hashStr(path + '|' + t.desc + '|' + date);
          out.push(Object.assign({}, base, { id: 'h:' + type + ':' + key, key, t: t0, approx: true, type, title: t.desc, note: file.basename, task: taskMeta(t) }));
        };
        if (isDone(t.status) && t.done) add('task-done', t.done);
        if (t.status === '-' && t.cancelled) add('task-cancelled', t.cancelled);
      }
    }
    return out;
  }

  setPathHistory(path, evs) {
    const old = this.histByPath.get(path);
    if (old) {
      for (const id of old) {
        const h = this.hist.get(id);
        if (h) { this.histDay.remove(h.day, id); this.hist.delete(id); }
      }
      this.histByPath.delete(path);
    }
    if (!evs.length) return;
    const ids = [];
    for (const e of evs) {
      e.day = dayKey(e.t);
      this.hist.set(e.id, e);
      this.histDay.add(e.day, e.id);
      ids.push(e.id);
    }
    this.histByPath.set(path, ids);
  }

  updatePathHistory(path) {
    this.setPathHistory(path, this.computePathHistory(path));
  }

  async rebuildAllHistory() {
    this.hist.clear();
    this.histDay.clear();
    this.histByPath.clear();
    const files = this.app.vault.getFiles();
    let md = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (f.extension === 'md') md++;
      if (f.extension === 'md' || f.extension === 'canvas') this.updatePathHistory(f.path);
      if (i % 500 === 499) await sleep(0);
    }
    // a day where this many notes all claim to be created is an import or copy, not real work
    this.spikeMin = Math.max(BULK_THRESHOLD, Math.round(md * 0.03));
  }

  /* ----- events ----- */

  setLogged(e) {
    const prev = this.events.get(e.id);
    const m = prev ? Object.assign({}, prev, e) : Object.assign({}, e);
    if (prev && prev.day && m.t != null && prev.day !== dayKey(m.t)) this.logDay.remove(prev.day, m.id);
    if (m.t != null) {
      m.day = dayKey(m.t);
      this.logDay.add(m.day, m.id);
    }
    this.events.set(m.id, m);
    return m;
  }

  upsert(ev) {
    const m = this.setLogged(ev);
    this.dirty.set(m.id, m);
    this.refreshViews();
    return m;
  }

  recentCreate(path) {
    const c = this.createdRecent.get(path);
    return c && Date.now() - c.t < this.settings.groupMinutes * 60000 ? c : null;
  }

  /* ----- bulk changes (folder renames, find & replace, importers...) ----- */

  activeBulk() {
    const a = this.burst.active;
    if (a && Date.now() - a.end > BULK_QUIET_MS) this.burst.active = null;
    return this.burst.active;
  }

  addToBulk(bulk, path, kind, quiet) {
    let set = this.bulkPaths.get(bulk.id);
    if (!set) { set = new Set(bulk.paths); this.bulkPaths.set(bulk.id, set); }
    if (!set.has(path)) {
      set.add(path);
      bulk.count++;
      const top = topFolder(path);
      bulk.folders[top] = (bulk.folders[top] || 0) + 1;
      if (bulk.paths.length < 40) bulk.paths.push(path);
    }
    bulk.kinds[kind] = (bulk.kinds[kind] || 0) + 1;
    bulk.end = Date.now();
    if (!quiet) this.burst.active = this.upsert(bulk);
  }

  /** Note a change; if many different notes change at once, fold them into one bulk card. */
  trackRecent(path, kind, id, isNew) {
    const now = Date.now();
    const b = this.burst;
    b.recent = b.recent.filter((r) => now - r.t < BULK_WINDOW_MS);
    b.recent.push({ t: now, path, kind, id, isNew });
    const distinct = new Set(b.recent.map((r) => r.path));
    if (distinct.size < BULK_THRESHOLD) return;
    const bulk = { id: 'bulk:' + uid(), t: b.recent[0].t, end: now, type: 'bulk', count: 0, kinds: {}, folders: {}, paths: [], d: this.deviceId, void: false };
    for (const r of b.recent) {
      if (r.isNew && r.id) this.upsert({ id: r.id, void: true });
      this.addToBulk(bulk, r.path, r.kind, true);
    }
    b.recent = [];
    b.active = this.upsert(bulk);
  }

  onCreate(f) {
    if (!this.tracked(f)) return;
    const capture = this.captureFor(f.path);
    if (!capture && !this.isLocal(f.path)) return;
    if (f.stat.size === 0) this.snap.set(f.path, { content: '', tasks: [], tags: [] });
    const bulk = this.activeBulk();
    if (bulk) return this.addToBulk(bulk, f.path, 'created');
    const now = Date.now();
    const id = uid();
    this.createdRecent.set(f.path, { id, t: now });
    this.upsert({ id, t: now, type: 'created', path: f.path, title: f.basename, ext: f.extension, d: this.deviceId, void: false });
    this.trackRecent(f.path, 'created', id, true);
  }

  onDelete(f) {
    if (!(f instanceof TFile)) return;
    this.snap.delete(f.path);
    this.sessions.delete(f.path);
    this.setPathHistory(f.path, []);
    if (this.baseline && this.baseline.files[f.path]) { delete this.baseline.files[f.path]; this.baselineDirty = true; }
    if (!this.tracked(f) || !this.isLocal(f.path)) return;
    const bulk = this.activeBulk();
    if (bulk) return this.addToBulk(bulk, f.path, 'deleted');
    const id = uid();
    this.upsert({ id, t: Date.now(), type: 'deleted', path: f.path, title: f.basename, ext: f.extension, d: this.deviceId, void: false });
    this.trackRecent(f.path, 'deleted', id, true);
  }

  onRename(f, oldPath) {
    if (!(f instanceof TFile)) return;
    for (const m of [this.snap, this.sessions, this.createdRecent]) {
      if (m.has(oldPath)) { m.set(f.path, m.get(oldPath)); m.delete(oldPath); }
    }
    if (this.baseline && this.baseline.files[oldPath]) {
      this.baseline.files[f.path] = this.baseline.files[oldPath];
      delete this.baseline.files[oldPath];
      this.baselineDirty = true;
    }
    this.setPathHistory(oldPath, []);
    if (this.baseline) this.updatePathHistory(f.path);
    if (!this.tracked(f) || !this.isLocal(f.path)) return;
    const bulk = this.activeBulk();
    if (bulk) return this.addToBulk(bulk, f.path, 'renamed');
    const id = uid();
    this.upsert({ id, t: Date.now(), type: 'renamed', path: f.path, from: oldPath, title: f.basename, ext: f.extension, d: this.deviceId, void: false });
    this.trackRecent(f.path, 'renamed', id, true);
  }

  session(path, prev, now) {
    let s = this.sessions.get(path);
    let fresh = false;
    if (!s || now - s.last > this.settings.groupMinutes * 60000) {
      s = {
        id: uid(),
        start: now,
        last: now,
        base: prev && prev.content != null ? prev.content : null,
        baseTasks: prev ? prev.tasks : [],
        baseTags: prev ? prev.tags : null,
      };
      this.sessions.set(path, s);
      fresh = true;
    }
    s.last = now;
    return { s, fresh };
  }

  onChanged(file, data, cache) {
    if (!(file instanceof TFile) || file.extension !== 'md' || this.excluded(file.path)) return;
    const prev = this.snap.get(file.path);
    if (!this.isLocal(file.path)) {
      // most likely a sync from another device — that device logs it itself
      this.setSnap(file.path, data, cache, false);
      return;
    }
    const bulk = this.activeBulk();
    if (bulk) {
      this.addToBulk(bulk, file.path, 'edited');
      this.setSnap(file.path, data, cache, false);
      return;
    }
    const now = Date.now();
    const today = moment(now).format(DAY);
    const newTasks = taskLines(data);
    const newTags = uniqTags(cache);

    if (prev) {
      for (const ch of diffTasks(prev.tasks, newTasks, today)) this.logTask(file, ch, now, today, newTags);
    }

    const { s, fresh } = this.session(file.path, prev, now);
    if (s.baseTags == null) s.baseTags = newTags;
    const created = this.recentCreate(file.path);
    const lines = this.settings.snippetLines;
    const fmEnd = cache && cache.frontmatterPosition ? cache.frontmatterPosition.end.line : -1;

    const ev = {
      id: created ? created.id : s.id,
      t: created ? created.t : s.start,
      end: now,
      type: created ? 'created' : 'edited',
      path: file.path,
      title: file.basename,
      ext: 'md',
      d: this.deviceId,
      hash: hashStr(data),
      tags: newTags,
      void: false,
    };

    if (s.base != null && !created) {
      const r = changedRegion(s.base, data);
      if (!r.added.length && !r.removed.length) {
        ev.void = true; // edited and then changed back — nothing to show
      } else {
        ev.lines = Math.max(r.added.length, r.removed.length);
        ev.propsOnly = fmEnd >= 0 && r.start + ev.lines - 1 <= fmEnd;
        ev.snippet = nonEmpty(r.added, lines);
        ev.removed = ev.snippet ? '' : nonEmpty(r.removed, lines);
      }
    } else {
      ev.snippet = bodyPreview(data, lines);
    }

    const baseDescs = new Set(s.baseTasks.map((t) => t.desc));
    ev.tasksAdded = newTasks.filter((t) => t.desc && t.status === ' ' && !baseDescs.has(t.desc)).map((t) => t.desc).slice(0, 10);
    ev.tagsAdded = newTags.filter((t) => !s.baseTags.includes(t));
    ev.tagsRemoved = s.baseTags.filter((t) => !newTags.includes(t));
    if (ev.void && (ev.tasksAdded.length || ev.tagsAdded.length || ev.tagsRemoved.length)) ev.void = false;

    this.upsert(ev);
    this.setSnap(file.path, data, cache, true);
    this.trackRecent(file.path, 'edited', ev.id, fresh && !created);
  }

  logTask(file, ch, now, today, tags) {
    const t = ch.task;
    const type = ch.type === 'task-undo' ? ch.was : ch.type;
    const key = hashStr(file.path + '|' + t.desc + '|' + today);
    const id = 'task:' + type + ':' + key;
    if (ch.type === 'task-undo') {
      if (this.events.has(id)) this.upsert({ id, void: true });
      return;
    }
    this.upsert({
      id, key, t: now, type, path: file.path, title: t.desc, note: file.basename, ext: 'md',
      task: taskMeta(t), tags, d: this.deviceId, void: false,
    });
  }

  async onCanvas(f) {
    if (this.excluded(f.path) || !this.isLocal(f.path)) return;
    const bulk = this.activeBulk();
    if (bulk) return this.addToBulk(bulk, f.path, 'edited');
    const prev = this.snap.get(f.path);
    const data = await this.app.vault.read(f);
    const now = Date.now();
    const { s, fresh } = this.session(f.path, prev, now);
    const created = this.recentCreate(f.path);
    const texts = (json) => {
      try { return (JSON.parse(json).nodes || []).filter((n) => n.type === 'text' && n.text).map((n) => n.text.trim()); }
      catch (e) { return []; }
    };
    const before = new Set(s.base != null ? texts(s.base) : []);
    const now_ = texts(data);
    const changed = now_.filter((t) => !before.has(t));
    const ev = this.upsert({
      id: created ? created.id : s.id, t: created ? created.t : s.start, end: now,
      type: created ? 'created' : 'edited', path: f.path, title: f.basename, ext: 'canvas',
      snippet: nonEmpty(changed.join('\n').split('\n'), this.settings.snippetLines),
      lines: changed.length, cards: now_.length, d: this.deviceId, void: false,
    });
    this.snap.set(f.path, { content: data, tasks: [], tags: [] });
    this.trackRecent(f.path, 'edited', ev.id, fresh && !created);
  }

  /* ----- log storage: .activity-log/YYYY-MM-<device>.jsonl ----- */

  logPath(t) {
    return `${LOG_DIR}/${moment(t).format('YYYY-MM')}-${this.deviceId}.jsonl`;
  }

  isMine(file) {
    return file.endsWith('-' + this.deviceId + '.jsonl');
  }

  async flush() {
    const a = this.app.vault.adapter;
    const batch = Array.from(this.dirty.values());
    this.dirty.clear();
    try {
      if ((batch.length || this.baselineDirty) && !(await a.exists(LOG_DIR))) await a.mkdir(LOG_DIR);
      const byFile = {};
      for (const e of batch) {
        if (e.t == null) continue;
        const f = this.logPath(e.t);
        const { day, ...rest } = e;
        (byFile[f] = byFile[f] || []).push(JSON.stringify(rest));
      }
      for (const f of Object.keys(byFile)) {
        const text = byFile[f].join('\n') + '\n';
        if (await a.exists(f)) await a.append(f, text);
        else await a.write(f, text);
      }
      if (this.baselineDirty && this.baseline) {
        this.baselineDirty = false;
        await a.write(BASELINE, JSON.stringify(this.baseline));
      }
    } catch (err) {
      console.error('Activity Timeline: could not write log', err);
      for (const e of batch) if (!this.dirty.has(e.id)) this.dirty.set(e.id, e);
    }
  }

  async listLogs(force) {
    if (!force && this.logList && Date.now() - this.logListAt < 60000) return this.logList;
    const a = this.app.vault.adapter;
    let files = [];
    try {
      if (await a.exists(LOG_DIR)) files = (await a.list(LOG_DIR)).files.filter((f) => /\/\d{4}-\d{2}-[^/]+\.jsonl$/.test(f));
    } catch (e) { /* none yet */ }
    this.logList = files;
    this.logListAt = Date.now();
    return files;
  }

  async readLogFile(f) {
    const a = this.app.vault.adapter;
    let text;
    try { text = await a.read(f); } catch (e) { return; }
    const local = new Map();
    let count = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        count++;
        local.set(e.id, Object.assign(local.get(e.id) || {}, e));
      } catch (e) { /* skip a broken line */ }
    }
    for (const [id, e] of local) {
      if (this.dirty.has(id)) continue;
      this.setLogged(e);
    }
    // compact our own files when they hold many superseded updates
    if (this.isMine(f) && count > local.size * 3 + 50) {
      await a.write(f, Array.from(local.values()).map((e) => JSON.stringify(e)).join('\n') + '\n');
    }
  }

  /** Load the log months covering [from, to]. Resolves true if anything new was read. */
  async ensureMonths(from, to) {
    const need = [];
    const m = moment(from).startOf('month');
    const end = moment(to);
    while (!m.isAfter(end, 'month')) {
      const key = m.format('YYYY-MM');
      if (!this.loadedMonths.has(key)) need.push(key);
      m.add(1, 'month');
    }
    if (!need.length) return false;
    need.forEach((k) => this.loadedMonths.add(k));
    let any = false;
    for (const f of await this.listLogs()) {
      const month = f.split('/').pop().slice(0, 7);
      if (!need.includes(month)) continue;
      await this.readLogFile(f);
      any = true;
    }
    return any;
  }

  async refreshOtherDevices() {
    const month = moment().format('YYYY-MM');
    for (const f of await this.listLogs(true)) {
      if (this.isMine(f) || !f.split('/').pop().startsWith(month)) continue;
      await this.readLogFile(f);
    }
    this.refreshViews();
  }

  /** Delete this device's log months older than the "keep" setting. */
  async pruneLogs() {
    const keep = this.settings.keepLogMonths;
    if (!keep) return 0;
    const cutoff = moment().subtract(keep, 'months').format('YYYY-MM');
    let removed = 0;
    for (const f of await this.listLogs(true)) {
      const month = f.split('/').pop().slice(0, 7);
      if (!this.isMine(f) || month >= cutoff) continue;
      try { await this.app.vault.adapter.remove(f); removed++; } catch (e) { /* ignore */ }
    }
    if (removed) await this.listLogs(true);
    return removed;
  }

  /* ----- events for display ----- */

  /** Everything for one day, after scope filtering; mass "created"/"modified" dates are folded into one entry. */
  eventsForDay(day, scope) {
    const out = [];
    const keys = new Set();
    const hashes = new Map();
    const ids = this.logDay.get(day);
    if (ids) {
      for (const id of ids) {
        const e = this.events.get(id);
        if (!e || e.void || !e.type) continue;
        // the same edit seen arriving via sync on another device: keep the earliest
        if (e.type === 'edited' && e.hash) {
          const k = e.path + '|' + e.hash;
          const o = hashes.get(k);
          if (o && o.d !== e.d) {
            if (o.t <= e.t) continue;
            const i = out.indexOf(o);
            if (i >= 0) out.splice(i, 1);
          }
          hashes.set(k, e);
        }
        if (e.key) keys.add(e.key);
        if (!e.tags) { const s = this.snap.get(e.path); e.tags = s ? s.tags : []; }
        if (scope(e)) out.push(e);
      }
    }
    const hids = this.histDay.get(day);
    if (hids) {
      const groups = { created: [], edited: [] };
      for (const id of hids) {
        const h = this.hist.get(id);
        if (!h || (h.key && keys.has(h.key))) continue;
        if (h.type === 'created' && !h.prop) groups.created.push(h);
        else if (h.type === 'edited') groups.edited.push(h);
        else if (scope(h)) out.push(h);
      }
      for (const kind of ['created', 'edited']) {
        const list = groups[kind];
        const inScope = list.filter(scope);
        if (!inScope.length) continue;
        if (list.length >= this.spikeMin) out.push(this.spikeEvent(day, kind, inScope));
        else out.push(...inScope);
      }
    }
    return out;
  }

  spikeEvent(day, kind, list) {
    const folders = {};
    for (const e of list) folders[topFolder(e.path)] = (folders[topFolder(e.path)] || 0) + 1;
    return {
      id: 'h:spike:' + kind + ':' + day, t: moment(day, DAY).valueOf(), approx: true, history: true,
      type: kind === 'created' ? 'imported' : 'touched', count: list.length, folders,
      paths: list.slice(0, 40).map((e) => e.path), path: '', tags: [],
    };
  }

  getRange(from, to, scope) {
    const out = [];
    const d = moment(from).startOf('day');
    const end = moment(to);
    while (!d.isAfter(end, 'day')) {
      const evs = this.eventsForDay(d.format(DAY), scope);
      for (const e of evs) out.push(e);
      d.add(1, 'day');
    }
    return out;
  }

  /* ----- ```activity-timeline``` block for daily notes ----- */

  async renderEmbed(src, el, ctx) {
    await this.ready;
    let day = null;
    const m = /date:\s*(\d{4}-\d{2}-\d{2})/.exec(src);
    if (m) day = moment(m[1], DAY);
    if (!day) {
      const d = moment(basename(ctx.sourcePath), [DAY, 'YYYY.MM.DD', 'YYYY_MM_DD', 'DD-MM-YYYY'], true);
      day = d.isValid() ? d : moment();
    }
    await this.ensureMonths(day.valueOf(), day.valueOf());
    const evs = this.getRange(day.valueOf(), day.valueOf(), (e) => e.path !== ctx.sourcePath).sort((a, b) => b.t - a.t);
    el.addClass('at-embed');
    el.createDiv({ cls: 'at-embed-head', text: `Activity · ${day.format('ddd, MMM D')} · ${evs.length} event${evs.length === 1 ? '' : 's'}` });
    if (!evs.length) el.createDiv({ cls: 'at-empty', text: 'Nothing logged for this day.' });
    for (const e of evs.slice(0, 100)) {
      const row = el.createDiv('at-embed-row');
      const kind = describe(this, e);
      row.createSpan({ cls: 'at-embed-time', text: e.approx ? '—' : moment(e.t).format('LT') });
      row.createSpan({ cls: 'at-embed-kind at-c-' + kind.cat, text: kind.short });
      if (e.path) {
        const link = row.createEl('a', { cls: 'internal-link', text: e.title, href: e.path });
        link.addEventListener('click', (ev) => { ev.preventDefault(); openEvent(this.app, e); });
      } else {
        row.createSpan({ text: titleFor(e) });
      }
      const snip = (e.snippet || e.removed || '').split('\n')[0];
      if (snip) row.createSpan({ cls: 'at-embed-snip', text: snip });
    }
  }
}

/* -------------------------------------------------------- display helpers */

const BULK_VERBS = [['created', 'created'], ['deleted', 'deleted'], ['renamed', 'moved or renamed'], ['edited', 'updated']];

function titleFor(e) {
  const n = e.count || 0;
  const notes = n.toLocaleString() + ' note' + (n === 1 ? '' : 's');
  if (e.type === 'bulk') {
    const k = e.kinds || {};
    const verb = (BULK_VERBS.find(([kind]) => k[kind]) || [null, 'changed'])[1];
    return `${notes} ${verb} at once`;
  }
  if (e.type === 'imported') return `${notes} imported or copied — original creation dates unknown`;
  if (e.type === 'touched') return `${notes} last modified this day — likely a sync or bulk change`;
  return e.title || basename(e.path || '');
}

function describe(plugin, e) {
  const capture = e.type === 'created' && e.path && plugin.captureFor(e.path);
  if (e.type === 'task-done') return { cat: 'done', icon: 'check', label: 'Task completed', short: 'Done' };
  if (e.type === 'task-cancelled') return { cat: 'dropped', icon: 'x', label: 'Task dropped', short: 'Dropped' };
  if (e.type === 'deleted') return { cat: 'moved', icon: 'trash-2', label: 'Deleted', short: 'Deleted' };
  if (e.type === 'renamed') return { cat: 'moved', icon: 'file-symlink', label: 'Moved / renamed', short: 'Moved' };
  if (e.type === 'bulk') return { cat: 'moved', icon: 'layers', label: 'Bulk change', short: 'Bulk' };
  if (e.type === 'imported') return { cat: 'moved', icon: 'package', label: 'Imported or copied', short: 'Imported' };
  if (e.type === 'touched') return { cat: 'moved', icon: 'layers', label: 'Many notes modified', short: 'Modified' };
  if (e.ext === 'canvas') return { cat: 'canvas', icon: 'layout-dashboard', label: e.type === 'created' ? 'Canvas created' : 'Canvas edited', short: 'Canvas' };
  if (capture) return { cat: 'capture', icon: 'bookmark', label: 'Captured · ' + capture, short: 'Captured' };
  if (e.type === 'created') return { cat: 'created', icon: 'file-plus', label: e.prop ? 'Note created' : e.history ? 'Note created (file date)' : 'Note created', short: 'Created' };
  if (e.history) return { cat: 'edited', icon: 'pencil', label: 'Last edited', short: 'Edited' };
  return { cat: 'edited', icon: 'pencil', label: e.propsOnly ? 'Properties edited' : 'Note edited', short: 'Edited' };
}

function eventTags(e) {
  const tags = new Set((e.tags || []).map((t) => t.toLowerCase()));
  for (const t of e.tagsAdded || []) tags.add(t.toLowerCase());
  if (e.type && e.type.startsWith('task')) for (const t of (e.title || '').match(/#[^\s#]+/g) || []) tags.add(t.toLowerCase());
  return tags;
}

async function openEvent(app, e) {
  if (!e.path) return;
  const file = app.vault.getAbstractFileByPath(e.path);
  if (!(file instanceof TFile)) return;
  const leaf = app.workspace.getLeaf('tab');
  const line = e.task && typeof e.task.line === 'number' ? e.task.line : undefined;
  await leaf.openFile(file, line !== undefined ? { eState: { line } } : {});
}

/* -------------------------------------------------------------------- view */

const RANGES = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
const CHIPS = [['all', 'All'], ['notes', 'Notes'], ['tasks', 'Tasks'], ['tags', 'Tags'], ['captures', 'Captures'], ['canvas', 'Canvas']];

class TimelineView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.range = 'week';
    this.anchor = moment();
    this.chip = 'all';
    this.folder = '';
    this.tag = '';
    this.limit = 150;
    this.stale = false;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Activity timeline'; }
  getIcon() { return 'history'; }

  async onOpen() {
    await this.plugin.ready;
    this.render();
  }

  isVisible() {
    const el = this.containerEl;
    if (typeof el.isShown === 'function') return el.isShown();
    return !!el.offsetParent;
  }

  bounds() {
    return [this.anchor.clone().startOf(this.range), this.anchor.clone().endOf(this.range)];
  }

  heatBounds() {
    const end = moment().endOf('week');
    return [end.clone().subtract(HEAT_WEEKS, 'weeks').add(1, 'day').startOf('day'), end];
  }

  matchChip(e, cat) {
    switch (this.chip) {
      case 'notes': return ['created', 'edited', 'moved'].includes(cat);
      case 'tasks': return cat === 'done' || cat === 'dropped' || (e.tasksAdded && e.tasksAdded.length > 0);
      case 'tags': return (e.tagsAdded && e.tagsAdded.length > 0) || (e.tagsRemoved && e.tagsRemoved.length > 0);
      case 'captures': return cat === 'capture';
      case 'canvas': return cat === 'canvas';
      default: return true;
    }
  }

  scope() {
    const folder = this.folder;
    const tag = this.tag.toLowerCase();
    return (e) => {
      if (folder && !(e.path || '').startsWith(folder + '/')) return false;
      if (tag && !eventTags(e).has(tag)) return false;
      return true;
    };
  }

  render() {
    this.stale = false;
    const root = this.contentEl;
    const scroll = root.scrollTop;
    root.empty();
    root.addClass('at-root');
    const wrap = root.createDiv('at-wrap');
    const main = wrap.createDiv('at-main');
    const side = wrap.createDiv('at-side');

    const [from, to] = this.bounds();
    const [hFrom, hTo] = this.heatBounds();
    // make sure the log months on screen are loaded; redraw once they are
    this.plugin.ensureMonths(Math.min(from.valueOf(), hFrom.valueOf()), Math.max(to.valueOf(), hTo.valueOf()))
      .then((loaded) => { if (loaded) this.render(); });

    const scope = this.scope();
    const inRange = this.plugin.getRange(from.valueOf(), to.valueOf(), scope);

    /* header */
    const head = main.createDiv('at-head');
    head.createEl('h2', { text: 'Activity timeline' });
    const seg = head.createDiv('at-seg');
    for (const [key, label] of RANGES) {
      const b = seg.createEl('button', { text: label, cls: key === this.range ? 'is-active' : '' });
      b.onclick = () => { this.range = key; this.limit = 150; this.render(); };
    }

    const nav = main.createDiv('at-nav');
    const prev = nav.createEl('button', { cls: 'at-icon-btn', attr: { 'aria-label': 'Previous' } });
    setIcon(prev, 'chevron-left');
    prev.onclick = () => { this.anchor.subtract(1, this.range); this.render(); };
    nav.createDiv({ cls: 'at-range-label', text: this.rangeLabel(from, to) });
    const next = nav.createEl('button', { cls: 'at-icon-btn', attr: { 'aria-label': 'Next' } });
    setIcon(next, 'chevron-right');
    next.onclick = () => { this.anchor.add(1, this.range); this.render(); };
    const today = nav.createEl('button', { text: 'Today', cls: 'at-today' });
    today.onclick = () => { this.anchor = moment(); this.render(); };

    const chips = main.createDiv('at-chips');
    for (const [key, label] of CHIPS) {
      const c = chips.createEl('button', { text: label, cls: 'at-chip' + (key === this.chip ? ' is-active' : '') });
      c.onclick = () => { this.chip = key; this.render(); };
    }
    if (this.tag || this.folder) {
      const f = main.createDiv('at-active-filter');
      f.setText('Filtered: ' + [this.folder && 'folder ' + this.folder, this.tag].filter(Boolean).join(' · ') + '  ');
      const clear = f.createEl('a', { text: 'clear' });
      clear.onclick = () => { this.tag = ''; this.folder = ''; this.render(); };
    }
    if (!this.plugin.indexed) main.createDiv({ cls: 'at-note', text: 'Indexing older history in the background…' });

    /* timeline */
    const shown = inRange
      .map((e) => ({ e, k: describe(this.plugin, e) }))
      .filter(({ e, k }) => this.matchChip(e, k.cat));
    // newest day first; date-only (approx) items go to the end of their day
    shown.sort((a, b) => {
      if (a.e.day !== b.e.day) return (b.e.day || dayKey(b.e.t)).localeCompare(a.e.day || dayKey(a.e.t));
      if (!!a.e.approx !== !!b.e.approx) return a.e.approx ? 1 : -1;
      return b.e.t - a.e.t;
    });

    const tl = main.createDiv('at-timeline');
    if (!shown.length) {
      tl.createDiv({ cls: 'at-empty', text: 'Nothing here for this period.' });
    }
    let lastMonth = '', lastDay = '';
    const perDay = {};
    for (const { e } of shown) { const d = e.day || dayKey(e.t); perDay[d] = (perDay[d] || 0) + 1; }
    for (const { e, k } of shown.slice(0, this.limit)) {
      const m = moment(e.t);
      const month = m.format('MMMM YYYY');
      if (this.range !== 'day' && month !== lastMonth) {
        tl.createDiv({ cls: 'at-month', text: month.toUpperCase() });
        lastMonth = month;
      }
      const dk = e.day || dayKey(e.t);
      if (dk !== lastDay) {
        const h = tl.createDiv('at-day');
        h.createSpan({ cls: 'at-day-name', text: m.format('ddd, MMM D') });
        const isToday = m.isSame(moment(), 'day');
        h.createSpan({ cls: 'at-day-meta', text: ' · ' + (isToday ? 'Today · ' : '') + perDay[dk] + ' event' + (perDay[dk] === 1 ? '' : 's') });
        lastDay = dk;
      }
      this.renderCard(tl, e, k);
    }
    if (shown.length > this.limit) {
      const more = tl.createEl('button', { text: `Show more (${shown.length - this.limit} left)`, cls: 'at-more' });
      more.onclick = () => { this.limit += 150; this.render(); };
    }

    /* sidebar */
    const heat = this.plugin.getRange(hFrom.valueOf(), hTo.valueOf(), scope);
    this.renderSide(side, heat, inRange, hFrom);
    root.scrollTop = scroll;
  }

  rangeLabel(from, to) {
    if (this.range === 'day') return from.format('dddd, MMM D, YYYY');
    if (this.range === 'week') return from.format('MMM D') + ' – ' + to.format(from.month() === to.month() ? 'D, YYYY' : 'MMM D, YYYY');
    if (this.range === 'month') return from.format('MMMM YYYY');
    return from.format('YYYY');
  }

  renderCard(parent, e, k) {
    const row = parent.createDiv('at-row');
    row.createDiv({ cls: 'at-time', text: e.approx ? '—' : moment(e.t).format('LT') });
    const dot = row.createDiv('at-dot at-c-' + k.cat);
    setIcon(dot, k.icon);
    const card = row.createDiv('at-card');
    card.createDiv({ cls: 'at-label at-c-' + k.cat, text: k.label.toUpperCase() });
    const title = card.createDiv({ cls: 'at-title', text: titleFor(e) });
    if (e.path) title.onclick = () => openEvent(this.app, e);
    else title.addClass('is-plain');

    // meta line
    const meta = card.createDiv('at-meta');
    if (e.type === 'renamed') meta.setText((e.from || '') + ' → ' + e.path);
    else if (e.task) {
      meta.setText(e.note || basename(e.path));
      if (e.task.priority) meta.createSpan({ cls: 'at-pill', text: e.task.priority });
      if (e.task.due) meta.createSpan({ cls: 'at-pill', text: 'due ' + e.task.due });
      if (e.task.recurring) meta.createSpan({ cls: 'at-pill', text: 'recurring' });
    } else if (e.folders) {
      meta.setText(folderSummary(e.folders, 4));
    } else {
      let s = e.path;
      if (e.ext === 'canvas' && e.cards) s += ` · ${e.cards} cards`;
      else if (e.lines) s += ` · ${e.lines} line${e.lines === 1 ? '' : 's'} changed`;
      meta.setText(s);
    }

    // list of notes for bulk / imported cards
    if (e.paths && e.paths.length) {
      const det = card.createEl('details', { cls: 'at-details' });
      det.createEl('summary', { text: e.count > e.paths.length ? `Show the first ${e.paths.length}` : 'Show notes' });
      const list = det.createDiv('at-snippet');
      for (const p of e.paths) {
        const a = list.createDiv({ cls: 'at-path', text: p });
        a.onclick = () => openEvent(this.app, { path: p });
      }
    }

    // preview
    if (e.snippet) card.createDiv({ cls: 'at-snippet', text: e.snippet });
    else if (e.removed) {
      const box = card.createDiv('at-snippet at-removed');
      box.createDiv({ cls: 'at-removed-label', text: 'Removed' });
      box.createDiv({ text: e.removed });
    } else if (e.path && (e.ext === 'md' || (!e.ext && e.path.endsWith('.md')))) {
      if (['created', 'edited', 'capture'].includes(k.cat)) this.lazyPreview(card, e.path);
    }

    if (e.tasksAdded && e.tasksAdded.length) {
      const box = card.createDiv('at-sub');
      box.createDiv({ cls: 'at-sub-label', text: `Added ${e.tasksAdded.length} task${e.tasksAdded.length === 1 ? '' : 's'}` });
      for (const t of e.tasksAdded.slice(0, 5)) box.createDiv({ cls: 'at-sub-item', text: '☐ ' + t });
    }

    const tagRow = card.createDiv('at-tags');
    for (const t of e.tagsAdded || []) this.tagChip(tagRow, t, 'added', '+');
    for (const t of e.tagsRemoved || []) this.tagChip(tagRow, t, 'removed', '−');
    const changed = new Set([...(e.tagsAdded || []), ...(e.tagsRemoved || [])]);
    for (const t of (e.tags || []).filter((t) => !changed.has(t)).slice(0, 6)) this.tagChip(tagRow, t, '', '');
    if (!tagRow.childElementCount) tagRow.remove();
  }

  tagChip(parent, tag, kind, prefix) {
    const c = parent.createSpan({ cls: 'at-tag ' + (kind ? 'at-tag-' + kind : ''), text: prefix + tag });
    c.onclick = () => { this.tag = tag; this.render(); };
  }

  async lazyPreview(card, path) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const box = card.createDiv('at-snippet at-faint');
    const text = bodyPreview(await this.app.vault.cachedRead(file), this.plugin.settings.snippetLines);
    if (text) box.setText(text);
    else box.remove();
  }

  renderSide(side, heat, inRange, start) {
    /* heatmap: last 10 weeks */
    side.createDiv({ cls: 'at-side-h', text: 'ACTIVITY · LAST 10 WEEKS' });
    const counts = {};
    for (const e of heat) { const d = e.day || dayKey(e.t); counts[d] = (counts[d] || 0) + 1; }
    // scale to the busy-but-normal days (90th percentile), so one huge day doesn't wash out the rest
    const vals = Object.values(counts).sort((a, b) => a - b);
    const max = Math.max(1, vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.9))] : 1);
    const grid = side.createDiv('at-heat');
    for (let w = 0; w < HEAT_WEEKS; w++) {
      const col = grid.createDiv('at-heat-col');
      for (let i = 0; i < 7; i++) {
        const d = start.clone().add(w * 7 + i, 'days');
        const n = counts[d.format(DAY)] || 0;
        const lvl = n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4));
        const cell = col.createDiv('at-heat-cell at-l' + lvl + (d.isAfter(moment(), 'day') ? ' is-future' : ''));
        cell.setAttr('aria-label', `${d.format('ddd, MMM D')}: ${n} event${n === 1 ? '' : 's'}`);
        cell.onclick = () => { this.range = 'day'; this.anchor = d.clone(); this.render(); };
      }
    }

    /* by type */
    side.createDiv({ cls: 'at-side-h', text: 'BY TYPE · THIS ' + this.range.toUpperCase() });
    const tally = { 'Notes edited': 0, 'Notes created': 0, Captures: 0, 'Tasks completed': 0, 'Tasks dropped': 0, 'Tags added': 0 };
    const colors = { 'Notes edited': 'edited', 'Notes created': 'created', Captures: 'capture', 'Tasks completed': 'done', 'Tasks dropped': 'dropped', 'Tags added': 'tag' };
    for (const e of inRange) {
      const cat = describe(this.plugin, e).cat;
      if (cat === 'edited' || cat === 'canvas') tally['Notes edited']++;
      if (cat === 'created') tally['Notes created']++;
      if (cat === 'capture') tally.Captures++;
      if (cat === 'done') tally['Tasks completed']++;
      if (cat === 'dropped') tally['Tasks dropped']++;
      tally['Tags added'] += (e.tagsAdded || []).length;
    }
    const top = Math.max(1, ...Object.values(tally));
    for (const [name, n] of Object.entries(tally)) {
      if (name === 'Captures' && !n && !this.plugin.settings.captureFolders.trim()) continue;
      const r = side.createDiv('at-bar');
      const line = r.createDiv('at-bar-line');
      line.createSpan({ text: name });
      line.createSpan({ cls: 'at-bar-n', text: String(n) });
      const track = r.createDiv('at-bar-track');
      const fill = track.createDiv('at-bar-fill at-bg-' + colors[name]);
      fill.style.width = Math.round((n / top) * 100) + '%';
    }

    /* top tags */
    const tagCounts = {};
    for (const e of inRange) for (const t of eventTags(e)) tagCounts[t] = (tagCounts[t] || 0) + 1;
    const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (topTags.length) {
      side.createDiv({ cls: 'at-side-h', text: 'TOP TAGS' });
      const box = side.createDiv('at-tags');
      for (const [t, n] of topTags) {
        const c = box.createSpan({ cls: 'at-tag' + (t === this.tag.toLowerCase() ? ' is-active' : ''), text: `${t} ${n}` });
        c.onclick = () => { this.tag = this.tag.toLowerCase() === t ? '' : t; this.render(); };
      }
    }

    /* folder (any depth) */
    side.createDiv({ cls: 'at-side-h', text: 'FOLDER' });
    const sel = side.createEl('select', { cls: 'dropdown at-select' });
    sel.createEl('option', { text: 'All folders', value: '' });
    const folders = this.app.vault.getAllLoadedFiles()
      .filter((f) => f instanceof TFolder && f.path !== '/' && !f.path.startsWith('.') && !this.plugin.excluded(f.path))
      .map((f) => f.path)
      .sort((a, b) => a.localeCompare(b));
    for (const p of folders) {
      const depth = p.split('/').length - 1;
      sel.createEl('option', { text: ' '.repeat(depth) + p.split('/').pop(), value: p });
    }
    sel.value = this.folder;
    sel.onchange = () => { this.folder = sel.value; this.render(); };
  }
}

/* ---------------------------------------------------- first-run question */

class LookbackModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.addClass('at-modal');
    contentEl.createEl('h2', { text: 'How far back should the timeline go?' });
    contentEl.createEl('p', {
      text: 'Activity Timeline records everything you do from now on. For earlier days it can fill in what your vault already knows: ' +
        'when notes were created, when each was last edited, and when Tasks were completed or dropped.',
    });
    contentEl.createEl('p', {
      cls: 'at-modal-faint',
      text: 'In large or old vaults these older dates can be unreliable (copying or syncing a vault often resets them), and a shorter window keeps things quick.',
    });
    const current = this.plugin.settings.onboarded ? this.plugin.settings.historyDays : null;
    const box = contentEl.createDiv('at-modal-options');
    for (const [days, label] of LOOKBACK) {
      const b = box.createEl('button', { text: label, cls: days === current ? 'mod-cta' : '' });
      b.onclick = async () => {
        this.close();
        await this.plugin.setLookback(days);
      };
    }
    contentEl.createEl('p', { cls: 'at-modal-faint', text: 'You can change this any time in Settings → Activity Timeline.' });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ---------------------------------------------------------------- settings */

class TimelineSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const p = this.plugin;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Show history from before install')
      .setDesc('How far back to fill in older days from note dates and Tasks completion dates. Your logged activity is always kept.')
      .addDropdown((d) => {
        for (const [days, label] of LOOKBACK) d.addOption(String(days), label);
        d.setValue(String(p.settings.historyDays)).onChange(async (v) => { await p.setLookback(Number(v)); });
      });

    new Setting(containerEl)
      .setName('Excluded folders')
      .setDesc('One folder per line. Nothing in these folders is logged or shown.')
      .addTextArea((t) => t.setPlaceholder('Templates\nArchive/Old').setValue(p.settings.excludeFolders)
        .onChange(async (v) => { p.settings.excludeFolders = v; await p.saveSettings(); }));

    new Setting(containerEl)
      .setName('Capture folders (optional)')
      .setDesc('Folders where other apps save notes for you. New notes there show as "Captured". One per line, as "Folder: Label".')
      .addTextArea((t) => t.setPlaceholder('Clippings: Web clipper\nTranscripts: Voice memo').setValue(p.settings.captureFolders)
        .onChange(async (v) => { p.settings.captureFolders = v; await p.saveSettings(); }));

    new Setting(containerEl)
      .setName('Group edits within (minutes)')
      .setDesc('Edits to the same note within this many minutes become one card.')
      .addSlider((s) => s.setLimits(5, 120, 5).setValue(p.settings.groupMinutes).setDynamicTooltip()
        .onChange(async (v) => { p.settings.groupMinutes = v; await p.saveSettings(); }));

    new Setting(containerEl)
      .setName('Preview lines')
      .setDesc('How many lines of changed text each card shows.')
      .addSlider((s) => s.setLimits(1, 10, 1).setValue(p.settings.snippetLines).setDynamicTooltip()
        .onChange(async (v) => { p.settings.snippetLines = v; await p.saveSettings(); }));

    new Setting(containerEl)
      .setName('Keep the detailed log for')
      .setDesc('Older months of this device\'s log are deleted the next time Obsidian starts. Deleted months can\'t be recovered.')
      .addDropdown((d) => {
        for (const [m, label] of KEEP_LOG) d.addOption(String(m), label);
        d.setValue(String(p.settings.keepLogMonths)).onChange(async (v) => { p.settings.keepLogMonths = Number(v); await p.saveSettings(); });
      });

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: `Logging since ${moment(p.settings.installedAt).format('LL')}. Log files live in the hidden "${LOG_DIR}" folder of your vault and sync with it. This device: ${p.deviceId}.`,
    });
  }
}

module.exports = ActivityTimelinePlugin;
module.exports._test = { changedRegion, parseTask, taskLines, diffTasks, cleanDesc, bodyPreview, propCreated, DayIndex, titleFor };
