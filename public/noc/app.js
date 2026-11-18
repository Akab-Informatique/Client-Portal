/* AKAB technical TV dashboard. Plain JS, no external resource. Feed: ?key=<display key> (kiosk) or ?feed=<same-origin path> (portal preview). */
(function () {
  'use strict';
  var TZ = 'America/Toronto';
  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var SVGNS = 'http://www.w3.org/2000/svg';

  // ---------- tiny DOM helpers (text only, never innerHTML with data: the feed is data) ----------
  function h(tag, cls, text, kids) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null && text !== '') e.textContent = String(text);
    if (kids) for (var i = 0; i < kids.length; i++) if (kids[i]) e.appendChild(kids[i]);
    return e;
  }
  function sv(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function fill(el, kids) { while (el.firstChild) el.removeChild(el.firstChild); for (var i = 0; i < kids.length; i++) if (kids[i]) el.appendChild(kids[i]); }

  // ---------- icons: constant inline SVG paths (24 x 24, stroke), nothing external ----------
  var ICONS = {
    list: 'M9 6h11M9 12h11M9 18h11M5 6h.01M5 12h.01M5 18h.01',
    users: 'M9 7m-4 0a4 4 0 1 0 8 0a4 4 0 1 0 -8 0M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2M16 3.13a4 4 0 0 1 0 7.75M21 21v-2a4 4 0 0 0-3-3.85',
    clock: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0M12 7v5l3 3',
    cal: 'M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-12a2 2 0 0 1-2-2zM16 3v4M8 3v4M4 11h16',
    alert: 'M12 9v4M10.36 3.59l-8.1 13.53a1.91 1.91 0 0 0 1.64 2.87h16.2a1.91 1.91 0 0 0 1.64-2.87l-8.1-13.53a1.91 1.91 0 0 0-3.28 0zM12 16h.01',
    plus: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0M9 12h6M12 9v6',
    check: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0M9 12l2 2l4-4',
    ticket: 'M15 5v2M15 11v2M15 17v2M5 5h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2h-14a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4v-3a2 2 0 0 1 2-2',
    folder: 'M5 4h4l3 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-14a2 2 0 0 1-2-2v-11a2 2 0 0 1 2-2',
    desktop: 'M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-16a1 1 0 0 1-1-1zM7 20h10M9 16l-1 4M15 16l1 4',
    wifi: 'M12 18h.01M9.17 15.17a4 4 0 0 1 5.66 0M6.34 12.34a8 8 0 0 1 11.32 0M3.51 9.51c4.69-4.69 12.28-4.69 17 0',
    trend: 'M3 17l6-6l4 4l8-8M14 7h7v7'
  };
  function ico(name) {
    var s = sv('svg', { 'class': 'i', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
    s.appendChild(sv('path', { d: ICONS[name] }));
    return s;
  }

  // ---------- number count-up (calm: 0.8 s ease-out, only when a value changes) ----------
  var last = {}; // key -> last value shown
  var raf = {};
  function cnt(key, value, cls, tag) {
    var el = h(tag || 'span', cls, '');
    var from = last[key] == null ? 0 : last[key];
    last[key] = value;
    if (REDUCED || from === value || typeof value !== 'number') { el.textContent = String(value); return el; }
    var t0 = Date.now(), dur = 800;
    el.textContent = String(from);
    setTimeout(function () { el.textContent = String(value); }, dur + 150); // never left half-way, even if the screen was asleep
    (function step() {
      var p = Math.min(1, (Date.now() - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(from + (value - from) * e));
      if (p < 1 && el.isConnected !== false) raf[key] = requestAnimationFrame(step);
    })();
    return el;
  }

  // ---------- scaling to the window, pixel shift ----------
  var stage = document.getElementById('stage');
  var ORBIT = [[0, -1], [0.7, -0.7], [1, 0], [0.7, 0.7], [0, 1], [-0.7, 0.7], [-1, 0], [-0.7, -0.7]];
  function place() {
    var scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080) * 0.97; // 3 % margin: room for the shift
    var r = Math.max(2, Math.min(window.innerWidth, window.innerHeight) * 0.0075); // about 8 px on 1080p
    var p = ORBIT[Math.floor(Date.now() / 120000) % ORBIT.length]; // one step every 2 minutes
    stage.style.transform = 'translate(-50%,-50%) translate(' + Math.round(p[0] * r) + 'px,' + Math.round(p[1] * r) + 'px) scale(' + scale + ')';
  }
  // the glide of the pixel shift is switched on after the first placement, so the page does not slide in at load
  if (!REDUCED) setTimeout(function () { stage.style.transition = 'transform 2s ease-in-out'; }, 500);
  window.addEventListener('resize', place);
  setInterval(place, 15000);

  // ---------- rest screen and brightness (same settings as the lobby TV, decided by the server) ----------
  var restWrap = document.getElementById('rest'), restBox = null, restClock = null, restRed = null, resting = false, unassigned = 0;
  function buildRest() {
    restBox = h('div', 'box');
    var img = document.createElement('img'); img.src = 'assets/akab-logo.svg'; img.alt = ''; img.draggable = false;
    restClock = h('span'); restRed = h('span', 'rd');
    restBox.appendChild(img); restBox.appendChild(restClock); restBox.appendChild(restRed);
    restWrap.appendChild(restBox);
  }
  function restJump() {
    if (!restBox) return;
    var x = window.innerWidth * 0.05 + Math.random() * Math.max(1, window.innerWidth * 0.9 - restBox.offsetWidth);
    var y = window.innerHeight * 0.06 + Math.random() * Math.max(1, window.innerHeight * 0.88 - restBox.offsetHeight);
    restBox.style.left = Math.round(x) + 'px'; restBox.style.top = Math.round(y) + 'px';
  }
  function setRest(on) {
    if (on === resting) return;
    resting = on;
    if (!restBox) buildRest();
    restWrap.hidden = !on;
    stage.style.visibility = on ? 'hidden' : '';
    if (on) { clockTick(); restJump(); }
  }
  setInterval(function () { if (resting) restJump(); }, 60000);
  function setBrightness(b) {
    b = Math.min(100, Math.max(50, Math.floor(Number(b) || 100)));
    stage.style.filter = b < 100 ? 'brightness(' + b + '%)' : '';
  }

  // ---------- clock (Québec time, whatever the device says) ----------
  var fmtTime = new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  var fmtDate = new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  var fmtDay = new Intl.DateTimeFormat('fr-CA', { timeZone: TZ, weekday: 'short' });
  var updatedAt = '';
  function clockTick() {
    var d = new Date(), t = fmtTime.format(d);
    document.getElementById('time').textContent = t;
    var dateEl = document.getElementById('date');
    dateEl.textContent = fmtDate.format(d);
    if (updatedAt) dateEl.appendChild(h('b', '', 'mis à jour ' + updatedAt));
    if (restClock) { restClock.textContent = t; restRed.textContent = unassigned > 0 ? '● ' + (unassigned > 999 ? '999+' : unassigned) : ''; }
  }
  setInterval(clockTick, 10000);
  clockTick();

  // ---------- helpers ----------
  function dayLabel(day) {
    if (!day) return '-';
    var p = day.split('-');
    var m = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'août', 'sep', 'oct', 'nov', 'déc'][Number(p[1]) - 1];
    return Number(p[2]) + ' ' + m;
  }
  function todayStr() { return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); }
  var isErr = function (v) { return v && v.error === true; };
  function head(icon, title, sub) { return h('div', 'ph', '', [h('div', 'ic', '', [ico(icon)]), h('h2', '', title), sub ? h('span', 'sub', sub) : null]); }
  function avatar(name, free) { return h('div', 'av' + (free ? ' free' : ''), free ? '?' : (name || '?').charAt(0).toUpperCase()); }
  function errPanel(icon, title) { return [head(icon, title), h('div', 'err', 'Données indisponibles')]; }

  // ---------- hero numbers: the four that matter, then three smaller ----------
  function hero(key, icon, label, n, tone) {
    return h('div', 'hn ' + (tone || ''), '', [h('div', 'lab', '', [ico(icon), h('span', '', label)]), n == null ? h('div', 'num', '-') : cnt(key, n, 'num', 'div')]);
  }
  function side(key, icon, label, n, tone) {
    return h('div', 'sr ' + (tone || ''), '', [h('div', 'ib', '', [ico(icon)]), h('div', 'lab', label), n == null ? h('div', 'num', '-') : cnt(key, n, 'num', 'div')]);
  }
  function renderTop(t) {
    var k = t && !isErr(t) ? t : null;
    // the lab icon comes first in the DOM: rebuild label nodes with the icon before the text
    fill(document.getElementById('hero'), [
      hero('h-un', 'users', 'Non assignés', k && k.unassigned, k ? (k.unassigned > 0 ? 'alarm' : 'green') : ''),
      hero('h-od', 'clock', 'En retard', k && k.overdue, k ? (k.overdue > 0 ? 'red' : 'green') : ''),
      hero('h-td', 'cal', 'Échéance aujourd\'hui', k && k.dueToday, k && k.dueToday > 0 ? 'amber' : ''),
      hero('h-op', 'list', 'Billets ouverts', k && k.open, '')
    ]);
    fill(document.getElementById('side'), [
      side('s-al', 'alert', 'Alertes ouvertes', k && k.alerts, k && k.alerts > 0 ? 'amber' : ''),
      side('s-cr', 'plus', 'Créés aujourd\'hui', k && k.createdToday, 'gold'),
      side('s-rs', 'check', 'Résolus aujourd\'hui', k && k.resolvedToday, 'green')
    ]);
    unassigned = k ? k.unassigned : 0;
  }

  // ---------- tickets ----------
  function renderTickets(t) {
    var el = document.getElementById('p-tickets');
    if (!t || isErr(t)) { fill(el, errPanel('ticket', 'Billets à traiter')); return; }
    var today = todayStr();
    var rows = t.urgent.map(function (x) {
      var state = x.late ? 'late' : x.due === today ? 'today' : '';
      var who = x.tech ? h('div', 'who', '', [avatar(x.tech), h('span', '', x.tech)]) : h('div', 'who free', '', [avatar('', true), h('span', '', 'Libre')]);
      return h('div', 't k-' + x.priorityKind, '', [
        h('div', 'bar'),
        h('div', 'num', x.number),
        h('div', 'mid', '', [h('div', 'ttl', x.title), h('div', 'cli', '', [h('b', '', x.client), document.createTextNode('  ·  ' + x.status)])]),
        who,
        h('div', 'chip ' + state, x.late ? 'En retard' : x.due === today ? 'Aujourd\'hui' : dayLabel(x.due))
      ]);
    });
    fill(el, [head('ticket', 'Billets à traiter', 'les plus urgents d\'abord')].concat(rows.length ? rows : [h('div', 'empty', 'Tout est sous contrôle')]));
  }

  // ---------- team ----------
  function renderTechs(techs) {
    var el = document.getElementById('p-techs');
    if (!techs || isErr(techs)) { fill(el, errPanel('users', 'Équipe')); return; }
    var shown = techs.slice(0, 4);
    var rows = shown.map(function (x) {
      var sub = x.on
        ? h('div', 'sb' + (x.on.kind === 'project' ? ' proj' : ''), '', [h('i'), h('b', '', x.on.ref), document.createTextNode(x.on.kind === 'project' ? 'projet' : 'chrono')])
        : h('div', 'sb', 'Aucun chrono');
      return h('div', 'r', '', [
        avatar(x.name),
        h('div', '', '', [h('div', 'nm', x.name), sub]),
        h('div', 'st', '', [x.overdue ? h('span', 'chip late', x.overdue + ' retard') : null, cnt('t-' + x.name, x.open, 'c')])
      ]);
    });
    var more = techs.length - shown.length;
    fill(el, [head('users', 'Équipe', more > 0 ? '+' + more + ' autres' : '')].concat(rows.length ? rows : [h('div', 'err', 'Personne n\'a de billet')]));
  }

  // ---------- projects ----------
  function ring(pct, late) {
    var C = 2 * Math.PI * 20, p = Math.max(0, Math.min(100, pct || 0));
    var s = sv('svg', { viewBox: '0 0 54 54' });
    s.appendChild(sv('circle', { 'class': 'bg', cx: 27, cy: 27, r: 20 }));
    s.appendChild(sv('circle', { 'class': 'fg', cx: 27, cy: 27, r: 20, 'stroke-dasharray': (C * p / 100).toFixed(1) + ' ' + C.toFixed(1) }));
    return h('div', 'ring' + (late ? ' late' : ''), '', [s, h('b', '', pct == null ? '-' : p + '')]);
  }
  function renderProjects(p) {
    var el = document.getElementById('p-projects');
    if (p == null) { el.hidden = true; return; }
    el.hidden = false;
    if (isErr(p)) { fill(el, errPanel('folder', 'Projets en cours')); return; }
    var rows = p.items.slice(0, 4).map(function (x) {
      var over = x.sold != null && x.worked > x.sold;
      var hoursPct = x.sold ? Math.min(100, Math.round(x.worked / x.sold * 100)) : 0;
      var meta = (x.client || 'Sans client') + '  ·  ' + x.worked + (x.sold != null ? ' / ' + x.sold : '') + ' h';
      var bar = h('div', 'hb' + (over ? ' over' : ''), '', [h('i')]);
      bar.firstChild.style.width = hoursPct + '%';
      return h('div', 'p', '', [
        ring(x.pct, x.late),
        h('div', '', '', [h('div', 'a', '', [h('em', '', x.number), document.createTextNode(x.name)]), h('div', 'b', meta)]),
        h('div', 'd', '', [h('span', 'chip' + (x.late ? ' late' : ''), x.due ? dayLabel(x.due) : '-'), x.sold ? bar : null])
      ]);
    });
    fill(el, [head('folder', 'Projets en cours', p.total > 4 ? p.total + ' au total' : '')].concat(rows.length ? rows : [h('div', 'err', 'Aucun projet en cours')]));
  }

  // ---------- RMM, UniFi ----------
  function kv(label, n, tone) { return h('div', '', label, [h('b', tone || '', n)]); }
  function seg(ok, ko) {
    var t = Math.max(1, ok + ko), a = h('i', 'ok'), b = h('i', 'ko');
    a.style.width = (ok / t * 100) + '%'; b.style.width = (ko / t * 100) + '%';
    return h('div', 'seg', '', [a, ko ? b : null]);
  }
  function renderRmm(r) {
    var el = document.getElementById('p-rmm');
    if (r == null) { el.hidden = true; return; }
    el.hidden = false;
    if (isErr(r)) { fill(el, errPanel('desktop', 'Parc informatique')); return; }
    fill(el, [
      head('desktop', 'Parc informatique', 'Datto'),
      h('div', 'big', '', [cnt('r-tot', r.total, ''), h('small', '', 'postes')]),
      seg(r.online, r.offline),
      h('div', 'kv kv3', '', [
        kv('En ligne', r.online, 'good'),
        kv('Hors ligne', r.offline, r.offline ? 'warn' : ''),
        kv('Absents 7 j', r.offline7d, r.offline7d ? 'bad' : ''),
        kv('Redémarrage', r.reboot, r.reboot ? 'warn' : ''),
        kv('Correctifs', r.patches, r.patches ? 'warn' : '')
      ])
    ]);
  }
  function renderUnifi(u) {
    var el = document.getElementById('p-unifi');
    if (u == null) { el.hidden = true; return; }
    el.hidden = false;
    if (isErr(u)) { fill(el, errPanel('wifi', 'Réseau')); return; }
    var offC = u.consoles - u.consolesOnline, offD = u.devices - u.devicesOnline;
    fill(el, [
      head('wifi', 'Réseau', 'UniFi'),
      h('div', 'big', '', [cnt('u-dev', u.devicesOnline, ''), h('small', '', '/ ' + u.devices + ' appareils en ligne')]),
      seg(u.devicesOnline, offD),
      h('div', 'kv', '', [
        kv('Consoles en ligne', u.consolesOnline + ' / ' + u.consoles, offC ? 'bad' : 'good'),
        kv('Appareils hors ligne', offD, offD ? 'bad' : ''),
        kv('Mises à jour', u.updates, u.updates ? 'warn' : ''),
        kv('Sites touchés', u.sitesOffline, u.sitesOffline ? 'bad' : '')
      ])
    ]);
  }

  // ---------- 7-day trend: monotone lines (no overshoot, never below the baseline), the two numbers under each day ----------
  function monotone(pts) {
    var n = pts.length, dx = [], dy = [], m = [], i;
    for (i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; dy[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
    m[0] = dy[0]; m[n - 1] = dy[n - 2];
    for (i = 1; i < n - 1; i++) m[i] = dy[i - 1] * dy[i] <= 0 ? 0 : (dy[i - 1] + dy[i]) / 2;
    for (i = 0; i < n - 1; i++) {
      if (dy[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      var a = m[i] / dy[i], b = m[i + 1] / dy[i], t = a * a + b * b;
      if (t > 9) { var k = 3 / Math.sqrt(t); m[i] = k * a * dy[i]; m[i + 1] = k * b * dy[i]; }
    }
    var d = 'M' + pts[0][0] + ' ' + pts[0][1];
    for (i = 0; i < n - 1; i++) {
      var x1 = pts[i][0] + dx[i] / 3, y1 = pts[i][1] + m[i] * dx[i] / 3, x2 = pts[i + 1][0] - dx[i] / 3, y2 = pts[i + 1][1] - m[i + 1] * dx[i] / 3;
      d += ' C' + x1.toFixed(1) + ' ' + y1.toFixed(1) + ' ' + x2.toFixed(1) + ' ' + y2.toFixed(1) + ' ' + pts[i + 1][0] + ' ' + pts[i + 1][1];
    }
    return d;
  }
  function renderTrend(tr) {
    var el = document.getElementById('p-trend');
    if (!tr || isErr(tr) || !tr.length) { fill(el, errPanel('trend', '7 jours')); return; }
    var W = 700, H = 100, top = 10, base = H - 6, max = 1, n = tr.length;
    tr.forEach(function (d) { max = Math.max(max, d.created, d.resolved); });
    var pt = function (key) { return tr.map(function (d, i) { return [Math.round((i + 0.5) * W / n), Math.round(base - (d[key] / max) * (base - top))]; }); };
    var c = pt('created'), s = pt('resolved');
    var svg = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' });
    var defs = sv('defs', {}), g = sv('linearGradient', { id: 'tg', x1: 0, y1: 0, x2: 0, y2: 1 });
    g.appendChild(sv('stop', { offset: '0', 'stop-color': '#ffce1a', 'stop-opacity': '.26' }));
    g.appendChild(sv('stop', { offset: '1', 'stop-color': '#ffce1a', 'stop-opacity': '0' }));
    defs.appendChild(g); svg.appendChild(defs);
    svg.appendChild(sv('line', { x1: 0, x2: W, y1: base, y2: base, stroke: 'rgba(255,255,255,.12)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
    svg.appendChild(sv('path', { d: monotone(c) + ' L' + c[n - 1][0] + ' ' + base + ' L' + c[0][0] + ' ' + base + ' Z', fill: 'url(#tg)' }));
    svg.appendChild(sv('path', { d: monotone(c), fill: 'none', stroke: '#ffce1a', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
    svg.appendChild(sv('path', { d: monotone(s), fill: 'none', stroke: '#46d68a', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' }));
    var cols = tr.map(function (d) {
      return h('div', 'dc', '', [
        h('span', 'dn', fmtDay.format(new Date(d.day + 'T12:00:00Z')).replace('.', '')),
        h('span', 'v', '', [h('b', 'c', d.created), h('b', 's', d.resolved)])
      ]);
    });
    function key(color, text) { var i = h('i'); i.style.background = color; return h('span', '', '', [i, document.createTextNode(text)]); }
    var legend = h('div', 'legend', '', [key('#ffce1a', 'Créés'), key('#46d68a', 'Résolus')]);
    var hd = head('trend', '7 jours');
    hd.appendChild(legend);
    fill(el, [hd, h('div', 'chart', '', [svg, h('div', 'days', '', cols)])]);
  }

  // ---------- layout: the columns reflow so that no area stays empty ----------
  var mainEl = document.querySelector('main'), colB = document.getElementById('col-b'), colC = document.getElementById('col-c'), trendEl = document.getElementById('p-trend');
  function reflow() {
    var rv = !document.getElementById('p-rmm').hidden, uv = !document.getElementById('p-unifi').hidden;
    if (!rv && !uv) {
      // no Datto, no UniFi: two columns; tickets on the left, team and projects side by side over a wide trend on the right
      colC.hidden = true; colB.classList.add('wide');
      if (trendEl.parentNode !== colB) colB.appendChild(trendEl);
      mainEl.style.gridTemplateColumns = '1.05fr 1fr';
    } else {
      colC.hidden = false; colB.classList.remove('wide');
      if (trendEl.parentNode !== colC) colC.appendChild(trendEl);
      mainEl.style.gridTemplateColumns = '';
    }
  }

  function render(d) {
    renderTop(d.tickets);
    renderTickets(d.tickets);
    renderTechs(d.techs);
    renderProjects(d.projects);
    renderRmm(d.rmm);
    renderUnifi(d.unifi);
    renderTrend(d.trend);
    reflow();
    var sc = d.screen || {};
    setBrightness(sc.brightness == null ? 100 : sc.brightness);
    setRest(sc.rest === true);
    updatedAt = fmtTime.format(new Date());
    clockTick();
  }

  // ---------- data ----------
  var FEED = (function () {
    var q = new URLSearchParams(location.search), key = q.get('key'), feed = q.get('feed');
    if (key && /^[A-Za-z0-9_-]{8,128}$/.test(key)) return { url: '/api/noc/display/state?key=' + encodeURIComponent(key), cred: 'omit' };
    if (feed && /^\/(?![\/\\])[^\s]*$/.test(feed)) return { url: feed, cred: 'same-origin' };
    return { url: '/api/noc/state', cred: 'same-origin' };
  })();
  var offline = document.getElementById('offline'), fails = 0;
  function fetchState() {
    var ctl = new AbortController(), tm = setTimeout(function () { ctl.abort(); }, 8000);
    return fetch(FEED.url, { cache: 'no-store', credentials: FEED.cred, referrerPolicy: 'no-referrer', signal: ctl.signal }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (d) { clearTimeout(tm); return d; }, function (e) { clearTimeout(tm); throw e; });
  }
  function poll() {
    fetchState().then(function (d) { fails = 0; offline.hidden = true; render(d); }, function () {
      fails++;
      if (fails >= 2) offline.hidden = false; // keep the last data on screen
    });
  }
  place();
  poll();
  setInterval(poll, 30000);
  // a page left open for days: reload once a night so nothing leaks or drifts
  setInterval(function () { if (fmtTime.format(new Date()) === '04:00' && !resting) location.reload(); }, 60000);
})();
