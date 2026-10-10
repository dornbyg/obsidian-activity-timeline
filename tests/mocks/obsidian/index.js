'use strict';
// Minimal Obsidian API stand-in for running the plugin under Node.
const fs = require('fs');
const path = require('path');
const moment = require('../moment-shim');

/* ---- tiny DOM ---- */
let nodeCount = 0;
class El {
  constructor(tag) { this.tagName = tag; this.children = []; this.parent = null; this.cls = new Set(); this.text = ''; this.attrs = {}; this.style = {}; this.scrollTop = 0; this.value = ''; this.shown = true; this.listeners = {}; nodeCount++; }
  _make(tag, o) {
    const e = new El(tag);
    if (typeof o === 'string') o = { cls: o };
    o = o || {};
    if (o.cls) o.cls.split(/\s+/).filter(Boolean).forEach((c) => e.cls.add(c));
    if (o.text !== undefined) e.text = String(o.text);
    if (o.attr) Object.assign(e.attrs, o.attr);
    if (o.value !== undefined) e.value = o.value;
    if (o.href) e.attrs.href = o.href;
    e.parent = this;
    this.children.push(e);
    return e;
  }
  createDiv(o) { return this._make('div', o); }
  createSpan(o) { return this._make('span', o); }
  createEl(tag, o) { return this._make(tag, o); }
  empty() { this.children = []; this.text = ''; }
  addClass(c) { this.cls.add(c); }
  removeClass(c) { this.cls.delete(c); }
  hasClass(c) { return this.cls.has(c); }
  setText(t) { this.text = String(t); }
  setAttr(k, v) { this.attrs[k] = v; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
  get childElementCount() { return this.children.length; }
  isShown() { return this.shown; }
  addEventListener(n, f) { (this.listeners[n] = this.listeners[n] || []).push(f); }
  find(pred, out = []) { if (pred(this)) out.push(this); for (const c of this.children) c.find(pred, out); return out; }
  allText() { return [this.text, ...this.children.map((c) => c.allText())].join(' '); }
}

/* ---- files ---- */
class TAbstractFile {}
class TFile extends TAbstractFile {
  constructor(p, stat) { super(); this.path = p; this.name = p.split('/').pop(); this.extension = this.name.includes('.') ? this.name.split('.').pop() : ''; this.basename = this.name.replace(/\.[^.]+$/, ''); this.stat = stat; }
}
class TFolder extends TAbstractFile { constructor(p) { super(); this.path = p; } }

class Events {
  constructor() { this._h = {}; }
  on(n, f) { (this._h[n] = this._h[n] || []).push(f); return { n, f }; }
  trigger(n, ...a) { for (const f of this._h[n] || []) f(...a); }
}

class Adapter {
  constructor(root) { this.root = root; fs.mkdirSync(root, { recursive: true }); this.reads = 0; }
  p(x) { return path.join(this.root, x); }
  async exists(x) { return fs.existsSync(this.p(x)); }
  async read(x) { this.reads++; return fs.readFileSync(this.p(x), 'utf8'); }
  async write(x, t) { fs.mkdirSync(path.dirname(this.p(x)), { recursive: true }); fs.writeFileSync(this.p(x), t); }
  async append(x, t) { fs.appendFileSync(this.p(x), t); }
  async mkdir(x) { fs.mkdirSync(this.p(x), { recursive: true }); }
  async remove(x) { fs.unlinkSync(this.p(x)); }
  async list(x) { const items = fs.readdirSync(this.p(x), { withFileTypes: true }); return { files: items.filter((i) => i.isFile()).map((i) => x + '/' + i.name), folders: items.filter((i) => i.isDirectory()).map((i) => x + '/' + i.name) }; }
}

class Vault extends Events {
  constructor(root) { super(); this.adapter = new Adapter(root); this.files = new Map(); this.contents = new Map(); this.folders = new Map(); this.configDir = '.obsidian'; this.reads = 0; }
  getName() { return 'Test Vault'; }
  addFile(p, content, stat) {
    const f = new TFile(p, Object.assign({ size: content.length }, stat));
    this.files.set(p, f); this.contents.set(p, content);
    const parts = p.split('/'); for (let i = 1; i < parts.length; i++) { const fp = parts.slice(0, i).join('/'); if (!this.folders.has(fp)) this.folders.set(fp, new TFolder(fp)); }
    return f;
  }
  getFiles() { return Array.from(this.files.values()); }
  getMarkdownFiles() { return this.getFiles().filter((f) => f.extension === 'md'); }
  getAllLoadedFiles() { return [...this.files.values(), ...this.folders.values()]; }
  getAbstractFileByPath(p) { return this.files.get(p) || this.folders.get(p) || null; }
  async cachedRead(f) { this.reads++; return this.contents.get(f.path); }
  async read(f) { this.reads++; return this.contents.get(f.path); }
}

class MetadataCache extends Events {
  constructor() { super(); this.caches = new Map(); }
  getFileCache(f) { return this.caches.get(f.path) || null; }
}

class Workspace extends Events {
  constructor() { super(); this.leaves = []; this.active = null; }
  onLayoutReady(cb) { this._ready = cb; }
  getLeavesOfType(t) { return this.leaves.filter((l) => l.view && l.view.getViewType() === t); }
  getActiveFile() { return this.active; }
  getLeaf() { const l = { app: this.app, openFile: async () => {}, setViewState: async () => {} }; return l; }
  revealLeaf() {}
}

function makeApp(root) {
  const app = { vault: new Vault(root), metadataCache: new MetadataCache(), workspace: new Workspace(), _codeblocks: {}, _modals: [] };
  app.workspace.app = app;
  return app;
}

class Plugin {
  constructor(app) { this.app = app; this._data = null; }
  async loadData() { return this._data ? JSON.parse(JSON.stringify(this._data)) : null; }
  async saveData(d) { this._data = JSON.parse(JSON.stringify(d)); }
  registerView(t, f) { this._viewFactory = f; }
  addRibbonIcon() {}
  addCommand() {}
  addSettingTab(t) { this._settingTab = t; }
  registerMarkdownCodeBlockProcessor(lang, f) { if (this.app._codeblocks[lang]) throw new Error('taken'); this.app._codeblocks[lang] = f; }
  registerEvent() {}
  registerDomEvent() {}
  registerInterval(id) { return id; }
}
class ItemView { constructor(leaf) { this.leaf = leaf; this.app = leaf.app; this.containerEl = new El('div'); this.contentEl = this.containerEl.createDiv(); } }
class Modal { constructor(app) { this.app = app; this.contentEl = new El('div'); } open() { this.app._modals.push(this); this.onOpen(); } close() { this.closed = true; if (this.onClose) this.onClose(); } }
class PluginSettingTab { constructor(app) { this.app = app; this.containerEl = new El('div'); } }
class Setting {
  constructor(el) { this.el = el.createDiv('setting'); }
  setName(n) { this.el.createDiv({ text: n }); return this; } setDesc() { return this; }
  _c() { const c = { setPlaceholder: () => c, setValue: () => c, onChange: () => c, setLimits: () => c, setDynamicTooltip: () => c, addOption: () => c }; return c; }
  addTextArea(f) { f(this._c()); return this; } addSlider(f) { f(this._c()); return this; } addToggle(f) { f(this._c()); return this; } addDropdown(f) { f(this._c()); return this; }
}
function getAllTags(cache) { const t = (cache.tags || []).map((x) => x.tag); const fm = cache.frontmatter && cache.frontmatter.tags; if (fm) for (const x of [].concat(fm)) t.push('#' + x); return t; }
function debounce(f) { const d = (...a) => { d.calls++; if (!d.paused) f(...a); }; d.calls = 0; d.paused = true; return d; }

module.exports = { Plugin, ItemView, Modal, PluginSettingTab, Setting, TFile, TFolder, setIcon() {}, moment, getAllTags, debounce, Platform: { isMobile: false }, makeApp, El, nodeCounter: () => nodeCount };
