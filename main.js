'use strict';
/*
 * Activity Timeline — Obsidian plugin v0.1.1
 * Logs what you do in your vault (notes created/edited with change previews,
 * Tasks-plugin tasks completed/dropped, tags added/removed) and shows it as a
 * filterable timeline. Plain JavaScript, no build step. Works on desktop and mobile.
 */
const obsidian = require('obsidian');
const { Plugin, ItemView, PluginSettingTab, Setting, TFile, TFolder, setIcon, moment, getAllTags, debounce, Platform } = obsidian;

const VIEW_TYPE = 'dorn-activity-timeline-view';
const LOG_DIR = '.activity-log';
const FLUSH_MS = 30000;

const DEFAULT_SETTINGS = {
  excludeFolders: '',
  captureFolders: '',
  groupMinutes: 30,
  snippetLines: 4,
  showHistory: true,
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

function nonEmpty(lines, n) {
  return lines.filter((l) => l.trim()).slice(0, n).join('\n');
}

function stripFrontmatter(content) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function bodyPreview(content, n) {
  return nonEmpty(stripFrontmatter(content).split('\n'), n);
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
    .replace(/(?:📅|⏳|🛫|➕|✅|❌)\uFE0F?\s*\d{4}-\d{2}-\d{2}/gu, '')
    .replace(/🔁\uFE0F?[^📅⏳🛫➕✅❌🆔⛔]*/gu, '')
    .replace(/(?:🆔|⛔)\uFE0F?\s*\S+/gu, '')
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
    if (!this.settings.installedAt) {
      this.settings.installedAt = Date.now();
      await this.saveSettings();
    }
    this.deviceId = this.getDeviceId();
    this.events = new Map();
    this.dirty = new Map();
    this.snap = new Map();
    this.sessions = new Map();
    this.createdRecent = new Map();
    this.touched = new Map();
    this.lastInput = 0;
    this.ready = new Promise((r) => (this._resolveReady = r));
    this.refreshViews = debounce(() => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view instanceof TimelineView) leaf.view.render();
      }
    }, 1500, true);

    this.registerView(VIEW_TYPE, (leaf) => new TimelineView(leaf, this));
    this.addRibbonIcon('history', 'Open activity timeline', () => this.activateView());
    this.addCommand({ id: 'open', name: 'Open activity timeline', callback: () => this.activateView() });
    this.addCommand({ id: 'open-today', name: "Show today's activity", callback: () => this.activateView('day') });
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

    this.app.workspace.onLayoutReady(async () => {
      await this.loadLog(true);
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
      await this.primeSnapshots();
      this.refreshViews();
    });

    this.registerInterval(window.setInterval(() => this.flush(), FLUSH_MS));
    this.registerInterval(window.setInterval(() => this.loadLog(false), 120000));
  }

  onunload() {
    this.flush();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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

  /* ----- snapshots (previous version of each note, for diffs) ----- */

  async snapshot(file, withContent) {
    if (!(file instanceof TFile) || this.excluded(file.path)) return;
    if (file.extension !== 'md' && file.extension !== 'canvas') return;
    const content = await this.app.vault.cachedRead(file);
    this.setSnap(file.path, content, this.app.metadataCache.getFileCache(file), withContent);
  }

  setSnap(path, content, cache, withContent) {
    const prev = this.snap.get(path);
    const keep = withContent || (prev && prev.content != null);
    const isMd = path.endsWith('.md');
    this.snap.set(path, {
      content: keep ? content : null,
      tasks: isMd ? taskLines(content) : [],
      tags: isMd && cache ? Array.from(new Set(getAllTags(cache) || [])) : [],
    });
    if (keep) {
      // keep full text for at most ~40 notes
      let withText = 0;
      for (const [p, s] of Array.from(this.snap.entries()).reverse()) {
        if (s.content == null) continue;
        if (++withText > 40 && p !== path) s.content = null;
      }
    }
  }

  async primeSnapshots() {
    let n = 0;
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (this.snap.has(f.path) || this.excluded(f.path)) continue;
      const cache = this.app.metadataCache.getFileCache(f);
      const hasTasks = cache && cache.listItems && cache.listItems.some((li) => li.task !== undefined);
      if (hasTasks) {
        const content = await this.app.vault.cachedRead(f);
        if (!this.snap.has(f.path)) this.setSnap(f.path, content, cache, false);
      } else {
        this.snap.set(f.path, { content: null, tasks: [], tags: cache ? Array.from(new Set(getAllTags(cache) || [])) : [] });
      }
      if (++n % 150 === 0) await sleep(15);
    }
  }

  /* ----- event capture ----- */

  upsert(ev) {
    const prev = this.events.get(ev.id);
    const merged = prev ? Object.assign({}, prev, ev) : ev;
    this.events.set(ev.id, merged);
    this.dirty.set(ev.id, merged);
    this.refreshViews();
  }

  recentCreate(path) {
    const c = this.createdRecent.get(path);
    return c && Date.now() - c.t < this.settings.groupMinutes * 60000 ? c : null;
  }

  onCreate(f) {
    if (!(f instanceof TFile) || this.excluded(f.path)) return;
    if (f.extension !== 'md' && f.extension !== 'canvas') return;
    const capture = this.captureFor(f.path);
    if (!capture && !this.isLocal(f.path)) return;
    const now = Date.now();
    const id = uid();
    this.createdRecent.set(f.path, { id, t: now });
    if (f.stat.size === 0) this.snap.set(f.path, { content: '', tasks: [], tags: [] });
    this.upsert({ id, t: now, type: 'created', path: f.path, title: f.basename, ext: f.extension, d: this.deviceId, void: false });
  }

  onDelete(f) {
    if (!(f instanceof TFile)) return;
    this.snap.delete(f.path);
    this.sessions.delete(f.path);
    if (this.excluded(f.path) || !this.isLocal(f.path)) return;
    if (f.extension !== 'md' && f.extension !== 'canvas') return;
    this.upsert({ id: uid(), t: Date.now(), type: 'deleted', path: f.path, title: f.basename, ext: f.extension, d: this.deviceId, void: false });
  }

  onRename(f, oldPath) {
    if (!(f instanceof TFile)) return;
    for (const m of [this.snap, this.sessions, this.createdRecent]) {
      if (m.has(oldPath)) { m.set(f.path, m.get(oldPath)); m.delete(oldPath); }
    }
    if (this.excluded(f.path) || !this.isLocal(f.path)) return;
    if (f.extension !== 'md' && f.extension !== 'canvas') return;
    this.upsert({ id: uid(), t: Date.now(), type: 'renamed', path: f.path, from: oldPath, title: f.basename, ext: f.extension, d: this.deviceId, void: false });
  }

  session(path, prev, now) {
    let s = this.sessions.get(path);
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
    }
    s.last = now;
    return s;
  }

  onChanged(file, data, cache) {
    if (!(file instanceof TFile) || file.extension !== 'md' || this.excluded(file.path)) return;
    const prev = this.snap.get(file.path);
    if (!this.isLocal(file.path)) {
      // most likely a sync from another device — that device logs it itself
      this.setSnap(file.path, data, cache, false);
      return;
    }
    const now = Date.now();
    const today = moment(now).format('YYYY-MM-DD');
    const newTasks = taskLines(data);
    const newTags = Array.from(new Set(getAllTags(cache) || []));

    if (prev) {
      for (const ch of diffTasks(prev.tasks, newTasks, today)) this.logTask(file, ch, now, today, newTags);
    }

    const s = this.session(file.path, prev, now);
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
    const prev = this.snap.get(f.path);
    const data = await this.app.vault.read(f);
    const now = Date.now();
    const s = this.session(f.path, prev, now);
    const created = this.recentCreate(f.path);
    const texts = (json) => {
      try { return (JSON.parse(json).nodes || []).filter((n) => n.type === 'text' && n.text).map((n) => n.text.trim()); }
      catch (e) { return []; }
    };
    const before = new Set(s.base != null ? texts(s.base) : []);
    const now_ = texts(data);
    const changed = now_.filter((t) => !before.has(t));
    this.upsert({
      id: created ? created.id : s.id, t: created ? created.t : s.start, end: now,
      type: created ? 'created' : 'edited', path: f.path, title: f.basename, ext: 'canvas',
      snippet: nonEmpty(changed.join('\n').split('\n'), this.settings.snippetLines),
      lines: changed.length, cards: now_.length, d: this.deviceId, void: false,
    });
    this.snap.set(f.path, { content: data, tasks: [], tags: [] });
  }

  /* ----- log storage: .activity-log/YYYY-MM-<device>.jsonl ----- */

  logPath(t) {
    return `${LOG_DIR}/${moment(t).format('YYYY-MM')}-${this.deviceId}.jsonl`;
  }

  async flush() {
    if (!this.dirty.size) return;
    const batch = Array.from(this.dirty.values());
    this.dirty.clear();
    const byFile = {};
    for (const e of batch) (byFile[this.logPath(e.t)] = byFile[this.logPath(e.t)] || []).push(JSON.stringify(e));
    const a = this.app.vault.adapter;
    try {
      if (!(await a.exists(LOG_DIR))) await a.mkdir(LOG_DIR);
      for (const f of Object.keys(byFile)) {
        const text = byFile[f].join('\n') + '\n';
        if (await a.exists(f)) await a.append(f, text);
        else await a.write(f, text);
      }
    } catch (err) {
      console.error('Activity Timeline: could not write log', err);
      for (const e of batch) if (!this.dirty.has(e.id)) this.dirty.set(e.id, e);
    }
  }

  async loadLog(full) {
    const a = this.app.vault.adapter;
    try {
      if (!(await a.exists(LOG_DIR))) return;
      const thisMonth = moment().format('YYYY-MM');
      const files = (await a.list(LOG_DIR)).files.filter((f) => f.endsWith('.jsonl'));
      for (const f of files) {
        const name = f.split('/').pop();
        const mine = name.endsWith('-' + this.deviceId + '.jsonl');
        if (!full && (mine || !name.startsWith(thisMonth))) continue;
        let text;
        try { text = await a.read(f); } catch (e) { continue; }
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
          this.events.set(id, Object.assign(this.events.get(id) || {}, e));
        }
        // compact our own files when they hold many superseded updates
        if (mine && count > local.size * 3 + 50) {
          await a.write(f, Array.from(local.values()).map((e) => JSON.stringify(e)).join('\n') + '\n');
        }
      }
      if (!full) this.refreshViews();
    } catch (err) {
      console.error('Activity Timeline: could not read log', err);
    }
  }

  /* ----- events for display (logged + reconstructed history) ----- */

  getEvents() {
    const out = [];
    const keys = new Set();
    const hashes = new Map();
    for (const e of this.events.values()) {
      if (e.void || !e.type) continue;
      // the same edit seen arriving via sync on another device: keep the earliest
      if (e.type === 'edited' && e.hash) {
        const k = e.path + '|' + e.hash;
        const other = hashes.get(k);
        if (other && other.d !== e.d) { if (other.t <= e.t) continue; out.splice(out.indexOf(other), 1); }
        hashes.set(k, e);
      }
      if (e.key) keys.add(e.key);
      out.push(e);
    }
    if (this.settings.showHistory) {
      for (const [path, s] of this.snap) {
        for (const t of s.tasks || []) {
          const add = (type, date) => {
            const key = hashStr(path + '|' + t.desc + '|' + date);
            if (keys.has(key)) return;
            keys.add(key);
            out.push({
              id: 'h:' + type + ':' + key, t: moment(date, 'YYYY-MM-DD').valueOf(), approx: true, type, path,
              title: t.desc, note: basename(path), ext: 'md', task: taskMeta(t), tags: s.tags,
            });
          };
          if (isDone(t.status) && t.done) add('task-done', t.done);
          if (t.status === '-' && t.cancelled) add('task-cancelled', t.cancelled);
        }
      }
      const inst = this.settings.installedAt;
      for (const f of this.app.vault.getFiles()) {
        if ((f.extension !== 'md' && f.extension !== 'canvas') || this.excluded(f.path)) continue;
        if (f.stat.ctime && f.stat.ctime < inst) {
          out.push({ id: 'h:c:' + f.path, t: f.stat.ctime, history: true, type: 'created', path: f.path, title: f.basename, ext: f.extension });
        }
        if (f.stat.mtime && f.stat.mtime < inst && f.stat.mtime - f.stat.ctime > 60000) {
          out.push({ id: 'h:m:' + f.path, t: f.stat.mtime, history: true, type: 'edited', path: f.path, title: f.basename, ext: f.extension });
        }
      }
    }
    for (const e of out) {
      if (!e.tags) { const s = this.snap.get(e.path); e.tags = s ? s.tags : []; }
    }
    return out;
  }

  /* ----- ```activity-timeline``` block for daily notes ----- */

  async renderEmbed(src, el, ctx) {
    await this.ready;
    let day = null;
    const m = /date:\s*(\d{4}-\d{2}-\d{2})/.exec(src);
    if (m) day = moment(m[1], 'YYYY-MM-DD');
    if (!day) {
      const d = moment(basename(ctx.sourcePath), ['YYYY-MM-DD', 'YYYY.MM.DD', 'YYYY_MM_DD', 'DD-MM-YYYY'], true);
      day = d.isValid() ? d : moment();
    }
    const evs = this.getEvents()
      .filter((e) => moment(e.t).isSame(day, 'day') && e.path !== ctx.sourcePath)
      .sort((a, b) => b.t - a.t);
    el.addClass('at-embed');
    el.createDiv({ cls: 'at-embed-head', text: `Activity · ${day.format('ddd, MMM D')} · ${evs.length} event${evs.length === 1 ? '' : 's'}` });
    if (!evs.length) el.createDiv({ cls: 'at-empty', text: 'Nothing logged for this day.' });
    for (const e of evs.slice(0, 100)) {
      const row = el.createDiv('at-embed-row');
      const kind = describe(this, e);
      row.createSpan({ cls: 'at-embed-time', text: e.approx ? '—' : moment(e.t).format('LT') });
      row.createSpan({ cls: 'at-embed-kind at-c-' + kind.cat, text: kind.short });
      const link = row.createEl('a', { cls: 'internal-link', text: e.title, href: e.path });
      link.addEventListener('click', (ev) => { ev.preventDefault(); openEvent(this.app, e); });
      const snip = (e.snippet || e.removed || '').split('\n')[0];
      if (snip) row.createSpan({ cls: 'at-embed-snip', text: snip });
    }
  }
}

/* -------------------------------------------------------- display helpers */

function describe(plugin, e) {
  const capture = e.type === 'created' && plugin.captureFor(e.path);
  if (e.type === 'task-done') return { cat: 'done', icon: 'check', label: 'Task completed', short: 'Done' };
  if (e.type === 'task-cancelled') return { cat: 'dropped', icon: 'x', label: 'Task dropped', short: 'Dropped' };
  if (e.type === 'deleted') return { cat: 'moved', icon: 'trash-2', label: 'Deleted', short: 'Deleted' };
  if (e.type === 'renamed') return { cat: 'moved', icon: 'file-symlink', label: 'Moved / renamed', short: 'Moved' };
  if (e.ext === 'canvas') return { cat: 'canvas', icon: 'layout-dashboard', label: e.type === 'created' ? 'Canvas created' : 'Canvas edited', short: 'Canvas' };
  if (capture) return { cat: 'capture', icon: 'bookmark', label: 'Captured · ' + capture, short: 'Captured' };
  if (e.type === 'created') return { cat: 'created', icon: 'file-plus', label: 'Note created', short: 'Created' };
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
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Activity timeline'; }
  getIcon() { return 'history'; }

  async onOpen() {
    await this.plugin.ready;
    this.render();
  }

  bounds() {
    return [this.anchor.clone().startOf(this.range), this.anchor.clone().endOf(this.range)];
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

  matchScope(e) {
    if (this.folder && !(e.path.startsWith(this.folder + '/'))) return false;
    if (this.tag && !eventTags(e).has(this.tag.toLowerCase())) return false;
    return true;
  }

  render() {
    const root = this.contentEl;
    const scroll = root.scrollTop;
    root.empty();
    root.addClass('at-root');
    const wrap = root.createDiv('at-wrap');
    const main = wrap.createDiv('at-main');
    const side = wrap.createDiv('at-side');

    const all = this.plugin.getEvents().filter((e) => this.matchScope(e));
    const [from, to] = this.bounds();
    const inRange = all.filter((e) => e.t >= from.valueOf() && e.t <= to.valueOf());

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

    /* timeline */
    const shown = inRange
      .map((e) => ({ e, k: describe(this.plugin, e) }))
      .filter(({ e, k }) => this.matchChip(e, k.cat));
    // newest day first; date-only (approx) items go to the end of their day
    shown.sort((a, b) => {
      const da = moment(a.e.t).format('YYYYMMDD'), db = moment(b.e.t).format('YYYYMMDD');
      if (da !== db) return db.localeCompare(da);
      if (!!a.e.approx !== !!b.e.approx) return a.e.approx ? 1 : -1;
      return b.e.t - a.e.t;
    });

    const tl = main.createDiv('at-timeline');
    if (!shown.length) {
      tl.createDiv({ cls: 'at-empty', text: 'Nothing here for this period.' });
    }
    let lastMonth = '', lastDay = '';
    const perDay = {};
    for (const { e } of shown) { const d = moment(e.t).format('YYYY-MM-DD'); perDay[d] = (perDay[d] || 0) + 1; }
    for (const { e, k } of shown.slice(0, this.limit)) {
      const m = moment(e.t);
      const month = m.format('MMMM YYYY');
      if (this.range !== 'day' && month !== lastMonth) {
        tl.createDiv({ cls: 'at-month', text: month.toUpperCase() });
        lastMonth = month;
      }
      const dayKey = m.format('YYYY-MM-DD');
      if (dayKey !== lastDay) {
        const h = tl.createDiv('at-day');
        h.createSpan({ cls: 'at-day-name', text: m.format('ddd, MMM D') });
        const isToday = m.isSame(moment(), 'day');
        h.createSpan({ cls: 'at-day-meta', text: ' · ' + (isToday ? 'Today · ' : '') + perDay[dayKey] + ' event' + (perDay[dayKey] === 1 ? '' : 's') });
        lastDay = dayKey;
      }
      this.renderCard(tl, e, k);
    }
    if (shown.length > this.limit) {
      const more = tl.createEl('button', { text: `Show more (${shown.length - this.limit} left)`, cls: 'at-more' });
      more.onclick = () => { this.limit += 150; this.render(); };
    }

    /* sidebar */
    this.renderSide(side, all, inRange);
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
    const title = card.createDiv({ cls: 'at-title', text: e.title || basename(e.path) });
    title.onclick = () => openEvent(this.app, e);

    // meta line
    const meta = card.createDiv('at-meta');
    if (e.type === 'renamed') meta.setText((e.from || '') + ' → ' + e.path);
    else if (e.task) {
      meta.setText(e.note || basename(e.path));
      if (e.task.priority) meta.createSpan({ cls: 'at-pill', text: e.task.priority });
      if (e.task.due) meta.createSpan({ cls: 'at-pill', text: 'due ' + e.task.due });
      if (e.task.recurring) meta.createSpan({ cls: 'at-pill', text: 'recurring' });
    } else {
      let s = e.path;
      if (e.ext === 'canvas' && e.cards) s += ` · ${e.cards} cards`;
      else if (e.lines) s += ` · ${e.lines} line${e.lines === 1 ? '' : 's'} changed`;
      meta.setText(s);
    }

    // preview
    if (e.snippet) card.createDiv({ cls: 'at-snippet', text: e.snippet });
    else if (e.removed) {
      const box = card.createDiv('at-snippet at-removed');
      box.createDiv({ cls: 'at-removed-label', text: 'Removed' });
      box.createDiv({ text: e.removed });
    } else if (e.ext === 'md' || (!e.ext && e.path.endsWith('.md'))) {
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

  renderSide(side, all, inRange) {
    /* heatmap: last 10 weeks */
    side.createDiv({ cls: 'at-side-h', text: 'ACTIVITY · LAST 10 WEEKS' });
    const counts = {};
    for (const e of all) { const d = moment(e.t).format('YYYY-MM-DD'); counts[d] = (counts[d] || 0) + 1; }
    const end = moment().endOf('week');
    const start = end.clone().subtract(10, 'weeks').add(1, 'day').startOf('day');
    let max = 1;
    for (let d = start.clone(); d.isBefore(end); d.add(1, 'day')) max = Math.max(max, counts[d.format('YYYY-MM-DD')] || 0);
    const grid = side.createDiv('at-heat');
    for (let w = 0; w < 10; w++) {
      const col = grid.createDiv('at-heat-col');
      for (let i = 0; i < 7; i++) {
        const d = start.clone().add(w * 7 + i, 'days');
        const n = counts[d.format('YYYY-MM-DD')] || 0;
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

    /* folder */
    side.createDiv({ cls: 'at-side-h', text: 'FOLDER' });
    const sel = side.createEl('select', { cls: 'dropdown at-select' });
    sel.createEl('option', { text: 'All folders', value: '' });
    const folders = this.app.vault.getAllLoadedFiles()
      .filter((f) => f instanceof TFolder && f.path !== '/' && !f.path.startsWith('.') && f.path.split('/').length <= 2)
      .map((f) => f.path)
      .sort();
    for (const p of folders) sel.createEl('option', { text: p, value: p });
    sel.value = this.folder;
    sel.onchange = () => { this.folder = sel.value; this.render(); };
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
      .setName('Show history from before install')
      .setDesc('Fills earlier days using Tasks completion/cancel dates and file created/modified dates (only the last edit of each note is known).')
      .addToggle((t) => t.setValue(p.settings.showHistory)
        .onChange(async (v) => { p.settings.showHistory = v; await p.saveSettings(); p.refreshViews(); }));

    containerEl.createEl('p', {
      cls: 'setting-item-description',
      text: `Logging since ${moment(p.settings.installedAt).format('LL')}. Log files live in the hidden "${LOG_DIR}" folder of your vault and sync with it. This device: ${p.deviceId}.`,
    });
  }
}

module.exports = ActivityTimelinePlugin;
module.exports._test = { changedRegion, parseTask, taskLines, diffTasks, cleanDesc, bodyPreview };
