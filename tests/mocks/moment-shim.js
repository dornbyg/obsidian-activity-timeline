'use strict';
// Minimal moment.js stand-in covering the API the plugin uses (local time, en locale).
const ISO = Symbol('ISO_8601');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n, w = 2) => String(n).padStart(w, '0');
const norm = (u) => { u = u || ''; return u === 'ms' ? 'ms' : u.replace(/s$/, ''); };

class M {
  constructor(d) { this._d = d; }
  isValid() { return !!this._d && !isNaN(this._d.getTime()); }
  valueOf() { return this._d.getTime(); }
  clone() { return new M(new Date(this._d.getTime())); }
  toDate() { return new Date(this._d.getTime()); }
  month() { return this._d.getMonth(); }
  year() { return this._d.getFullYear(); }
  startOf(u) {
    const d = this._d;
    switch (norm(u)) {
      case 'year': d.setMonth(0, 1); d.setHours(0, 0, 0, 0); break;
      case 'month': d.setDate(1); d.setHours(0, 0, 0, 0); break;
      case 'week': d.setDate(d.getDate() - d.getDay()); d.setHours(0, 0, 0, 0); break;
      case 'day': d.setHours(0, 0, 0, 0); break;
    }
    return this;
  }
  endOf(u) { return this.startOf(u).add(1, u).add(-1, 'ms'); }
  add(n, u) {
    const d = this._d;
    switch (norm(u)) {
      case 'ms': case 'millisecond': d.setTime(d.getTime() + n); break;
      case 'day': d.setDate(d.getDate() + n); break;
      case 'week': d.setDate(d.getDate() + 7 * n); break;
      case 'month': case 'year': {
        const months = norm(u) === 'year' ? 12 * n : n;
        const day = d.getDate();
        d.setDate(1);
        d.setMonth(d.getMonth() + months);
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        d.setDate(Math.min(day, last));
        break;
      }
      default: throw new Error('unit ' + u);
    }
    return this;
  }
  subtract(n, u) { return this.add(-n, u); }
  isAfter(o, u) { const t = moment(o); return u ? t.clone().endOf(u).valueOf() < this.valueOf() : this.valueOf() > t.valueOf(); }
  isBefore(o, u) { const t = moment(o); return u ? this.clone().endOf(u).valueOf() < t.valueOf() : this.valueOf() < t.valueOf(); }
  isSame(o, u) { const t = moment(o).valueOf(); return this.clone().startOf(u).valueOf() <= t && t <= this.clone().endOf(u).valueOf(); }
  format(f) {
    const d = this._d;
    const h = d.getHours();
    return f.replace(/\[([^\]]*)]|LT|LL|YYYY|MMMM|MMM|MM|dddd|ddd|DD|D|HH|hh|h|mm|ss|A/g, (tok, lit) => {
      if (lit !== undefined) return lit;
      switch (tok) {
        case 'LT': return this.format('h:mm A');
        case 'LL': return this.format('MMMM D, YYYY');
        case 'YYYY': return String(d.getFullYear());
        case 'MMMM': return MONTHS[d.getMonth()];
        case 'MMM': return MONTHS[d.getMonth()].slice(0, 3);
        case 'MM': return pad(d.getMonth() + 1);
        case 'dddd': return DAYS[d.getDay()];
        case 'ddd': return DAYS[d.getDay()].slice(0, 3);
        case 'DD': return pad(d.getDate());
        case 'D': return String(d.getDate());
        case 'HH': return pad(h);
        case 'hh': return pad(h % 12 || 12);
        case 'h': return String(h % 12 || 12);
        case 'mm': return pad(d.getMinutes());
        case 'ss': return pad(d.getSeconds());
        case 'A': return h < 12 ? 'AM' : 'PM';
      }
      return tok;
    });
  }
}

function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(s);
  if (!m) return new M(null);
  const [, Y, Mo, D, H = '0', Mi = '0', S = '0', tz] = m;
  if (tz) return new M(new Date(`${Y}-${Mo}-${D}T${pad(H)}:${pad(Mi)}:${pad(S)}${tz === 'Z' ? 'Z' : tz}`));
  const d = new Date(+Y, +Mo - 1, +D, +H, +Mi, +S);
  if (d.getMonth() !== +Mo - 1) return new M(null);
  return new M(d);
}

function parseFmt(s, f) {
  const order = [];
  const re = '^' + f.replace(/YYYY|MM|DD|HH|mm|ss|[.*+?^${}()|[\]\\]/g, (t) => {
    if (['YYYY', 'MM', 'DD', 'HH', 'mm', 'ss'].includes(t)) { order.push(t); return t === 'YYYY' ? '(\\d{4})' : '(\\d{2})'; }
    return '\\' + t;
  }) + '$';
  const m = new RegExp(re).exec(s);
  if (!m) return new M(null);
  const v = { YYYY: 1970, MM: 1, DD: 1, HH: 0, mm: 0, ss: 0 };
  order.forEach((t, i) => (v[t] = +m[i + 1]));
  const d = new Date(v.YYYY, v.MM - 1, v.DD, v.HH, v.mm, v.ss);
  if (d.getMonth() !== v.MM - 1 || d.getDate() !== v.DD) return new M(null);
  return new M(d);
}

function moment(a, fmt) {
  if (a === undefined) return new M(new Date());
  if (a instanceof M) return new M(new Date(a._d.getTime()));
  if (typeof a === 'number') return new M(new Date(a));
  if (a instanceof Date) return new M(new Date(a.getTime()));
  if (typeof a === 'string') {
    const fmts = Array.isArray(fmt) ? fmt : [fmt === undefined ? ISO : fmt];
    for (const f of fmts) {
      const r = f === ISO ? parseISO(a) : parseFmt(a, f);
      if (r.isValid()) return r;
    }
    return new M(null);
  }
  return new M(null);
}
moment.ISO_8601 = ISO;
module.exports = moment;
