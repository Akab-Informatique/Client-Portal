'use strict';
// AKAB Informatique - office TV sign. Pixel-art scene, all drawn procedurally on a 480x270 canvas.
(function () {
  var W = 480, H = 270, HEAD = 50, FLOOR = 108;
  var DEMO = /(?:^|[?&])demo=1(?:&|$)/.test(location.search);
  // Fixed staff config (not part of the bot feed). Add more entries later (2 desks are laid out for now).
  var PEOPLE = [
    { name: 'Jonathan', role: '', look: { skin: '#e8b088', hair: '#3b2412', beard: '#33200f', beardFull: true, quiff: true, glasses: false, top: 'polo' } },
    { name: 'Alexandre', role: '', queueDesk: true, look: { skin: '#e8b088', hair: '#6a4426', beard: '#8a4f25', beardFull: false, quiff: false, glasses: false, top: 'blazer' } },
    // Camille, accounting: seated at her own desk (never walks, no coffee trips). Long ombre hair, bangs, big hexagonal tortoise-shell glasses, navy blazer over a mustard top.
    { name: 'Camille', role: 'COMPTABILITÉ', seated: true, look: { skin: '#f3cfb5', hair: '#3a2216', hairEnds: '#c5622a', longHair: true, bangs: true, lips: '#d8667a', glasses: true, glassesStyle: 'big', top: 'blazer', inner: '#d9a21b', shirt: '#14172a' } }
  ];
  var PEOPLE_ON = !/(?:^|[?&])people=0(?:&|$)/.test(location.search);
  // Ambiance mode (default): bots whose feed state is idle are DRAWN as busy, at the owner's request. ?mode=live shows the true status.
  var AMBIANCE = !/(?:^|[?&])mode=live(?:&|$)/.test(location.search);
  // Role-specific task labels (rotated sequentially, random start). Unknown names use the union of all lists.
  var ROLE_LABELS = {
    'clicky': ['Réponse aux questions', "Recherche d'information", 'Résumé de réunion', 'Organisation des tâches'],
    'finance': ['Rapprochement bancaire', 'Vérification des factures', 'Suivi des comptes clients', 'Préparation de la paie', 'Rapport financier'],
    'adjointe': ["Gestion de l'agenda", 'Tri des courriels', 'Préparation de réunion', 'Classement des documents', 'Suivi des échéances'],
    'portail akab': ['Consultation des billets ouverts', 'Suivi des billets', 'Mise à jour du portail', 'Support technique'],
    'boss': ["Supervision de l'équipe", 'Revue des priorités', 'Répartition des tâches', 'Contrôle qualité'],
    'facebook': ['Vérification des publicités Meta', 'Publication Marketplace', 'Mise à jour des annonces', 'Réponse aux messages'],
    'legale': ['Révision de contrat', 'Vérification de conformité', 'Rédaction de document légal', 'Suivi des échéances légales'],
    'videaste': ["Édition d'une vidéo", 'Montage vidéo', 'Mixage audio', 'Rendu de la vidéo'],
    "l'artiste": ['Création graphique', "Retouche d'images", 'Cadrage de la vidéo', 'Choix des accessoires']
  };
  var LABELS = [];
  Object.keys(ROLE_LABELS).forEach(function (k) { ROLE_LABELS[k].forEach(function (l) { if (LABELS.indexOf(l) < 0) LABELS.push(l); }); });
  function nextLabel(b) {
    var key = normName(b.name), L = ROLE_LABELS[key] || LABELS;
    if (b.li == null) b.li = (key === 'videaste' || key === 'portail akab' || key === 'facebook') ? 0 : Math.floor(Math.random() * L.length);
    else b.li = (b.li + 1) % L.length;
    return L[b.li];
  }
  function coffeeGap() { return AMBIANCE ? 120 + Math.random() * 120 : 60 + Math.random() * 60; }
  var TAGLINE = 'Votre partenaire informatique'; // PLACEHOLDER tagline - to be confirmed by AKAB
  var cv = document.getElementById('c');
  var g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  var logo = document.getElementById('logo');
  var bootTime = Date.now();

  var PALETTE = ['#ff5a5f', '#4aa8ff', '#62d96b', '#b57bff', '#ff8fd0', '#2fd9c9', '#e4e9f2', '#c8ee3c', '#a0a8ff', '#e05fd0', '#c9a27a', '#9fdc6a'];
  var DARK = '#14121f';

  // ---------- helpers ----------
  function shade(hex, f) {
    var n = parseInt(hex.slice(1), 16), r = n >> 16, gg = (n >> 8) & 255, b = n & 255;
    var t = f > 0 ? 255 : 0, a = Math.abs(f);
    r = Math.round(r + (t - r) * a); gg = Math.round(gg + (t - gg) * a); b = Math.round(b + (t - b) * a);
    return '#' + ((1 << 24) | (r << 16) | (gg << 8) | b).toString(16).slice(1);
  }
  function hash(a, b) { return ((Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663)) >>> 0); }
  function R(x, y, w, h, c) { g.fillStyle = c; g.fillRect(Math.round(x), Math.round(y), w, h); }
  function RO(x, y, w, h, c) { R(x - 1, y - 1, w + 2, h + 2, DARK); R(x, y, w, h, c); }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function T(s, x, y, c, sc, o, al) { return PX.text(g, s, x, y, c, sc, o, al); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // ---------- layout ----------
  var lay = null, bg = null;
  function makeLayout(D) {
    var rows = D <= 8 ? 2 : 3, cols = Math.ceil(D / rows), areaX = 52, areaW = 328, cell = areaW / cols;
    var dys = rows === 2 ? [122, 198] : [112, 164, 216], lanes = rows === 2 ? [168, 244] : [152, 204, 256], desks = [];
    for (var i = 0; i < D; i++) {
      var row = Math.floor(i / cols), col = i % cols, inRow = Math.min(cols, D - row * cols);
      var startX = areaX + (areaW - inRow * cell) / 2, cx = Math.round(startX + cell * (col + 0.5));
      desks.push({ i: i, cx: cx, dy: dys[row], seatX: cx + 10, seatY: dys[row] + 8, standX: cx + 10, standY: lanes[row], row: row });
    }
    return { D: D, rows: rows, cols: cols, cell: cell, desks: desks, lanes: lanes, laneA: lanes[0], laneB: lanes[lanes.length - 1], corrL: 26, corrR: 388,
      coffee: { x: 388, y: 126 }, beans: [{ x: 26, y: 250 }, { x: 388, y: 250 }] };
  }

  var logoImg = new Image();
  logoImg.onload = function () { try { if (lay) bg = buildBg(); } catch (e) { /* ignore */ } };
  logoImg.src = 'assets/akab-logo.svg';

  function buildBg() {
    var c = document.createElement('canvas'); c.width = W; c.height = H;
    var s = c.getContext('2d'), keep = g, x, y, i;
    g = s;
    R(0, 0, W, H, '#000');
    // wall: near-black navy with panel lines
    R(0, 0, W, 108, '#0f1528');
    for (x = 0; x < W; x += 24) R(x, 6, 1, 98, '#151c34');
    R(0, 0, W, 3, '#1a2038');
    // ceiling LED strip (steady)
    R(0, 3, W, 1, '#FFF200');
    s.globalAlpha = 0.18; R(0, 4, W, 2, '#FFF200'); s.globalAlpha = 0.10; R(0, 6, W, 2, '#F7941D'); s.globalAlpha = 1;
    // baseboard
    R(0, 104, W, 4, '#1a2038'); R(0, 104, W, 1, '#F7941D');
    // calm dark floor: very low-contrast tiles, a few faint traces near the edges only
    for (y = FLOOR; y < H; y += 16) for (x = 0; x < W; x += 16) {
      var k = hash(x >> 4, y >> 4), alt = ((x >> 4) + ((y - FLOOR) >> 4)) & 1;
      R(x, y, 16, 16, alt ? '#0d1325' : '#0c1222');
      R(x, y, 16, 1, '#0f1629'); R(x, y, 1, 16, '#0f1629');
      if ((x < 32 || x >= 448 || y >= 256) && k % 3 === 0) { R(x + 2, y + 8, 12, 1, '#121b33'); R(x + 13, y + 7, 2, 3, '#152240'); }
    }
    // server rack
    RO(6, 58, 34, 58, '#1a2038'); R(6, 58, 34, 1, '#FFF200');
    for (var u = 0; u < 5; u++) { R(9, 61 + u * 11, 28, 9, '#0b0f1e'); for (var v = 0; v < 6; v++) R(22 + v * 2, 63 + u * 11, 1, 5, '#2a3558'); }
    R(8, 116, 30, 3, '#0b0f1e');
    // glass wall along the direction corner
    if (PEOPLE_ON) { s.globalAlpha = 0.14; R(398, 118, 4, 80, '#7df9ff'); s.globalAlpha = 1; R(400, 118, 1, 80, '#FFF200'); }
    // wall-mounted digital clock panel (top right)
    if (CLOCK) {
      s.globalAlpha = 0.18; R(383, 9, 86, 34, '#F7941D'); s.globalAlpha = 0.3; R(384, 10, 84, 32, '#FFF200'); s.globalAlpha = 1;
      R(385, 11, 82, 30, '#05070f'); R(385, 11, 82, 1, '#FFF200'); R(385, 40, 82, 1, '#F7941D'); R(385, 11, 1, 30, '#2a2f48'); R(466, 11, 1, 30, '#2a2f48');
      R(388, 14, 76, 24, '#0a1224');
    }
    // coffee counter + sleek machine
    RO(366, 100, 44, 16, '#1c2036'); R(366, 100, 44, 2, '#FFF200');
    RO(376, 76, 24, 24, '#2a2f48'); R(380, 80, 16, 8, '#0a1420'); R(378, 76, 20, 2, '#F7941D'); R(382, 90, 12, 2, '#7d849c');
    // illuminated AKAB logo sign (backlit panel, static glow)
    var sx = 130, sy = 12, sw = 220, sh = 66;
    s.globalAlpha = 0.10; R(sx - 4, sy - 4, sw + 8, sh + 8, '#F7941D');
    s.globalAlpha = 0.16; R(sx - 3, sy - 3, sw + 6, sh + 6, '#F7941D');
    s.globalAlpha = 0.28; R(sx - 2, sy - 2, sw + 4, sh + 4, '#FFB020');
    s.globalAlpha = 0.5; R(sx - 1, sy - 1, sw + 2, sh + 2, '#FFF200');
    s.globalAlpha = 1;
    R(sx, sy, sw, sh, '#05070f');
    R(sx + 1, sy + 1, sw - 2, 1, '#2a2f48'); R(sx + 1, sy + sh - 2, sw - 2, 1, '#2a2f48');
    if (logoImg.complete && logoImg.naturalWidth) {
      s.imageSmoothingEnabled = true; s.imageSmoothingQuality = 'high';
      s.drawImage(logoImg, sx + 8, sy + 6, sw - 16, Math.round((sw - 16) * 225 / 870));
      s.imageSmoothingEnabled = false;
    }
    // desk under-glow (steady LED strips) instead of shadows
    for (i = 0; i < lay.desks.length; i++) {
      var d = lay.desks[i];
      s.globalAlpha = 0.07; R(d.cx - 30, d.dy + 19, 60, 5, '#F7941D'); s.globalAlpha = 0.25; R(d.cx - 26, d.dy + 21, 52, 1, '#F7941D'); s.globalAlpha = 1;
    }
    // plants
    plant(12, 150); plant(12, 196); plant(12, 240); plant(48, 118);
    if (PEOPLE_ON) {
      RO(402, 118, 76, 80, '#111833'); R(404, 120, 72, 1, '#4a4818'); R(404, 194, 72, 1, '#4a3418');
      RO(402, 206, 76, 58, '#101a30'); R(404, 208, 72, 1, '#18503e'); R(404, 260, 72, 1, '#18503e');
      RO(412, 62, 66, 18, '#05070f'); R(412, 62, 66, 1, '#FFF200'); R(412, 79, 66, 1, '#F7941D');
      T('DIRECTION', 445, 68, '#FFF200', 1, null, 'center');
    }
    // beanbags (back)
    g = keep;
    return c;
  }
  function plant(x, y) {
    RO(x - 5, y, 10, 8, '#1c1f2e'); R(x - 5, y, 10, 2, '#3a4268');
    RO(x - 1, y - 8, 2, 8, '#2f7a3a');
    RO(x - 6, y - 12, 5, 6, '#3fa24a'); RO(x + 1, y - 14, 5, 7, '#4fbf5a'); RO(x - 3, y - 17, 6, 6, '#3fa24a');
  }
  function bean(x, y, col) {
    RO(x - 12, y - 10, 24, 12, col); R(x - 8, y - 9, 12, 2, shade(col, 0.4)); R(x - 12, y - 2, 24, 4, shade(col, -0.3));
  }

  // ---------- bots ----------
  var bots = new Map(), order = [], bossBot = null, slots = [null, null, null], bossTalking = false;
  var GAGS_ON = !/(?:^|[?&])gags=0(?:&|$)/.test(location.search);
  var gag = null, gagTimer = 20 + Math.random() * 25, plantBoost = {}, rackRed = false;
  var PLANTS = [{ x: 12, y: 150 }, { x: 12, y: 196 }, { x: 12, y: 240 }];
  function normName(s) { return String(s == null ? '' : s).replace(/[\u2019\u2018]/g, "'").normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim(); }
  var SPEED = 38;

  function rlane() { return lay.lanes[Math.floor(Math.random() * lay.lanes.length)]; }
  function inCorr(p) { return Math.abs(p.x - lay.corrL) < 4 || Math.abs(p.x - lay.corrR) < 4; }
  function route(c, Tg) {
    var pts = [], p = { x: c.x, y: c.y };
    if (inCorr(p)) {
      if (inCorr(Tg)) {
        if (Math.abs(p.x - Tg.x) < 4) { pts.push(Tg); return pts; }
        var yy = lay.laneB; pts.push({ x: p.x, y: yy }, { x: Tg.x, y: yy }, Tg); return pts;
      }
      pts.push({ x: p.x, y: Tg.y }, Tg); return pts;
    }
    if (!inCorr(Tg) && Math.abs(p.y - Tg.y) < 4) { pts.push(Tg); return pts; }
    var cx = inCorr(Tg) ? Tg.x : (p.x < 240 ? lay.corrL : lay.corrR);
    pts.push({ x: cx, y: p.y });
    if (!inCorr(Tg)) pts.push({ x: cx, y: Tg.y });
    pts.push(Tg);
    return pts;
  }

  function queueSpot(k) { return { x: 446 - 26 * k, y: [256, 244, 232][k % 3] }; }
  function queueRoute(p, Tg) {
    var pts = [], Rr = lay.corrR;
    if (p.x > Rr - 90 && p.y >= 228) return [Tg];
    if (Math.abs(p.x - lay.corrL) < 4) pts.push({ x: p.x, y: lay.laneB }, { x: Rr, y: lay.laneB });
    else if (Math.abs(p.x - Rr) > 3) pts.push({ x: Rr, y: p.y });
    pts.push({ x: Rr, y: Tg.y }, Tg);
    return pts;
  }
  function updateQueue() {
    var q = order.filter(function (b) { return b.state === 'needs_human' && !b.leaving && !(xmas && isHostage(b)); }); // a hostage never leaves its desk
    q.sort(function (a, b) { return (a.since - b.since) || (a.id < b.id ? -1 : 1); });
    var mq = lay.cols <= 3 ? 4 : 3; // spots that stay clear of the bot desk grid
    staff.qn = QUEUE_ON ? Math.min(mq, q.length) : 0;
    q.forEach(function (b, i) {
      var dk = lay.desks[b.desk];
      if (QUEUE_ON && i < mq) {
        var sp = queueSpot(i);
        if (b.fresh) { b.fresh = false; b.qi = i; b.goal = { type: 'queue', key: null, x: sp.x, y: sp.y }; b.x = sp.x; b.y = sp.y; b.path = []; b.mode = 'queue'; b.facing = 0; return; }
        if (!b.goal || b.goal.type !== 'queue' || b.qi !== i) { b.qi = i; b.goal = { type: 'queue', key: null, x: sp.x, y: sp.y }; b.dwell = 0; planPath(b); }
      } else {
        b.fresh = false;
        if (!b.goal || b.goal.type !== 'wave' || (b.mode !== 'wave' && !b.path.length)) { b.qi = -1; b.goal = { type: 'wave', key: null, x: dk.standX, y: dk.standY }; b.dwell = 0; planPath(b); }
      }
    });
  }
  function planPath(b) {
    var dk = lay.desks[b.desk], gl = b.goal, cur = { x: b.x, y: b.y }, pts = [];
    var onSeg = Math.abs(b.x - dk.standX) < 2 && b.y > dk.seatY - 2 && b.y < dk.standY - 2;
    if ((b.mode === 'seat' && !b.path.length) || onSeg) { cur = { x: dk.standX, y: dk.standY }; pts.push(cur); }
    var tgt = gl.type === 'seat' ? { x: dk.standX, y: dk.standY } : { x: gl.x, y: gl.y };
    var r = gl.type === 'queue' ? queueRoute(cur, tgt) : route(cur, tgt);
    for (var i = 0; i < r.length; i++) if (r[i].x !== cur.x || r[i].y !== cur.y || i === r.length - 1) pts.push(r[i]);
    if (gl.type === 'seat') pts.push({ x: dk.seatX, y: dk.seatY });
    b.path = pts; b.arrived = false; b.mode = 'walk';
  }

  function occupied(b, key) {
    if (key === 'coffee' && humans.some(function (h) { return h.task; })) return true;
    var r = false; bots.forEach(function (o) { if (o !== b && o.goal && o.goal.key === key) r = true; });
    return r;
  }
  function visitSpot(k) { var d = lay.desks[0]; return { x: d.standX + 24 * k, y: d.standY }; }
  function freeSlot() { for (var i = 0; i < 3; i++) if (!slots[i]) return i; return -1; }
  function bossReady() { return !!bossBot && bossBot.state !== 'needs_human' && bossBot.mode === 'seat' && !bossBot.path.length; }
  function canVisit(b) { return !(xmas && isHostage(b)) && bossBot && b !== bossBot && bossReady() && freeSlot() >= 0 && bossBot.desk === 0; }
  function startVisit(b, kind, after) {
    var k = freeSlot(); if (k < 0) return false;
    slots[k] = b; var sp = visitSpot(k);
    b.visit = { kind: kind, slot: k, phase: 'go', timer: 0, dur: kind === 'task' ? 3 : (kind === 'report' ? 2 : 2.5) };
    b.goal = { type: 'visit', key: null, x: sp.x, y: sp.y }; b.dwell = 0; planPath(b);
    return true;
  }
  function cancelVisit(b) { if (b.visit) { if (slots[b.visit.slot] === b) slots[b.visit.slot] = null; b.visit = null; } }
  function finishVisit(b) {
    cancelVisit(b);
    if (b.state === 'working') { b.goal = { type: 'seat', key: null }; planPath(b); }
    else if (b.state === 'idle') planIdle(b);
  }
  function tryDeliver(b) {
    b.delT = 5 + Math.random() * 5;
    if (!PEOPLE_ON || !humans.length || b.sp === 'boss' || (xmas && isHostage(b)) || staff.qn >= 3 || b.gag || b.visit || b.leaving) return;
    var busy = false; bots.forEach(function (o) { if (o.dv) busy = true; });
    var al = humans.filter(function (h) { return h.p.queueDesk; })[0];
    if (busy || !al || al.mode !== 'sit') return;
    b.delT = 15 + Math.random() * 25;
    b.dv = { phase: 'go', t: 0 };
    b.goal = { type: 'deliver', key: null, x: lay.corrR, y: al.standY }; b.dwell = 0; planPath(b);
  }
  function planIdle(b) {
    if (b.sp !== 'boss' && b.chatT <= 0 && canVisit(b)) { b.chatT = rnd(40, 90); if (startVisit(b, 'chat', 'idle')) return; }
    var opts = [['wander', 45]];
    if (!occupied(b, 'coffee')) opts.push(['coffee', 30]);
    var tot = 0, i; for (i = 0; i < opts.length; i++) tot += opts[i][1];
    var r = Math.random() * tot, pick = opts[0][0];
    for (i = 0; i < opts.length; i++) { r -= opts[i][1]; if (r <= 0) { pick = opts[i][0]; break; } }
    if (pick === 'coffee') { b.goal = { type: 'coffee', key: 'coffee', x: lay.coffee.x, y: lay.coffee.y }; b.dwell = rnd(5, 9); }
    else if (pick === 'bean0' || pick === 'bean1') {
      var bn = lay.beans[pick === 'bean0' ? 0 : 1];
      b.goal = { type: 'doze', key: pick, x: bn.x, y: bn.y - 3 }; b.dwell = rnd(12, 25);
    } else {
      var wl = rlane(), wx = Math.round(wl === lay.laneB ? rnd(60, 300) : rnd(60, 370)); b.goal = { type: 'wander', key: null, x: wx, y: wl }; b.dwell = rnd(3, 7);
    }
    planPath(b);
  }

  function enter(b, ns, init) {
    var prev = b.state;
    b.hold = 0; b.dv = null;
    cancelVisit(b); if (gag && gag.bots.indexOf(b) >= 0) cancelGag();
    if (!init && prev === 'needs_human' && ns !== 'needs_human' && b.goal && b.goal.type === 'queue' && b.mode === 'queue' && !b.path.length) {
      b.state = ns; b.fx = { t: 0 }; b.hold = 1.4; if (b.qi === 0) staff.thumb = 2.5; b.qi = -1; return;
    }
    b.state = ns; b.fx = (!init && prev === 'needs_human' && ns !== 'needs_human') ? { t: 0 } : null;
    var dk = lay.desks[b.desk];
    if (ns === 'working') {
      b.goal = { type: 'seat', key: null };
      if (init) { b.x = dk.seatX; b.y = dk.seatY; b.path = []; b.mode = 'seat'; b.arrived = true; }
      else if (prev === 'idle' && canVisit(b) && startVisit(b, 'task', 'seat')) { /* briefing first */ }
      else planPath(b);
    } else if (ns === 'needs_human') {
      b.goal = { type: 'wave', key: null, x: dk.standX, y: dk.standY };
      if (init) { b.x = dk.standX; b.y = dk.standY; b.path = []; b.mode = 'wave'; b.arrived = true; b.facing = 0; b.fresh = true; } else if (!QUEUE_ON) planPath(b);
    } else if (b.sp === 'boss') {
      b.goal = { type: 'seat', key: null };
      if (init) { b.x = dk.seatX; b.y = dk.seatY; b.path = []; b.mode = 'seat'; b.arrived = true; } else planPath(b);
    } else {
      if (!init && prev === 'working' && canVisit(b) && startVisit(b, 'report', 'idle')) return;
      if (init) { b.x = Math.round(rnd(60, 370)); b.y = rlane(); b.path = []; b.mode = 'stand'; }
      planIdle(b);
      if (init) b.dwell = rnd(1, 4);
    }
  }

  function newBot(id, idx) {
    var used = {}; bots.forEach(function (o) { used[o.ci] = 1; });
    var ci = 0; while (used[ci] && ci < PALETTE.length - 1) ci++;
    var base = PALETTE[ci];
    return { id: id, name: '', label: '', state: null, ci: ci, design: idx % 4, ph: Math.random() * 10,
      col: { base: base, light: shade(base, 0.4), dark: shade(base, -0.4) },
      x: 0, y: 0, path: [], goal: null, mode: 'stand', facing: 0, timer: 0, dwell: 0, arrived: true, desk: idx, wt: 0, chatT: 40 + Math.random() * 50, delT: 5 + Math.random() * 10, lblT: 5 + Math.random() * 55, bubOn: false, bubAge: 0, bubT: 1 + Math.random() * 19, _tag: 0, fake: false, dv: null, visit: null, gag: false, fx: null, talking: false, sp: '' };
  }

  var QUEUE_ON = PEOPLE_ON;
  var staff = { thumb: 0, qn: 0, fast: 0 };
  var NAMED = {
    'clicky': { base: '#f2f4f7', light: '#ffffff', dark: '#a8aeb8' },
    'finance': { base: '#19C37D', sp: 'finance' },
    'adjointe': { base: '#F7941D', sp: 'star' },
    'portail akab': { base: '#FFB020', sp: 'spiky' },
    'boss': { base: '#8a8f99', sp: 'boss' },
    'facebook': { base: '#1E88FF' },
    'legale': { base: '#1565D8', sp: 'tie' },
    'videaste': { base: '#2EC4A6', sp: 'cam' },
    "l'artiste": { base: '#E8283C', sp: 'brush' }
  };
  function assignColor(b) {
    var k = normName(b.name);
    var n = NAMED[k], base = n ? n.base : PALETTE[b.ci];
    b.col = { base: base, light: n && n.light || shade(base, 0.4), dark: n && n.dark || shade(base, -0.4) };
    b.sp = n ? n.sp || '' : '';
  }

  function applyData(d) {
    if (!d || !Array.isArray(d.bots)) return;
    var seen = {}, items = [];
    d.bots.slice(0, 12).forEach(function (it, idx) {
      if (!it || typeof it !== 'object') return;
      var id = String(it.id != null ? it.id : 'bot-' + idx).slice(0, 40);
      if (seen[id]) id = id + '#' + idx;
      seen[id] = 1; items.push({ id: id, it: it });
    });
    var bi = -1;
    items.forEach(function (x, i) { if (bi < 0 && normName(x.it.name) === 'boss') bi = i; });
    if (bi > 0) items.unshift(items.splice(bi, 1)[0]);
    var D = Math.max(6, items.length), departing = false;
    bots.forEach(function (b, id) { if (!seen[id]) departing = true; });
    if (lay && departing) D = Math.max(D, lay.D);
    var relayout = false;
    if (!lay || lay.D !== D) { lay = makeLayout(D); bg = buildBg(); relayout = true; }
    var first = !order.length && !bots.size;
    var taken = {}, dmap = {};
    if (bi >= 0) { dmap[items[0].id] = 0; taken[0] = 1; }
    items.forEach(function (x) {
      if (dmap[x.id] != null) return;
      var e = bots.get(x.id);
      if (e && !e.leaving && e.desk < D && !taken[e.desk]) { dmap[x.id] = e.desk; taken[e.desk] = 1; }
    });
    items.forEach(function (x) { if (dmap[x.id] != null) return; var k = 0; while (taken[k]) k++; dmap[x.id] = k; taken[k] = 1; });
    order = [];
    items.forEach(function (x) {
      var it = x.it, id = x.id, b = bots.get(id), isNew = false;
      var st = (it.state === 'working' || it.state === 'needs_human') ? it.state : 'idle';
      var fake = AMBIANCE && st === 'idle'; if (xmas && normName(it.name) === 'facebook' && st === 'idle') fake = true; if (fake) st = 'working';
      if (!b) { b = newBot(id, dmap[id]); bots.set(id, b); isNew = true; }
      else if (b.leaving) { b.leaving = false; b.state = null; }
      b.name = String(it.name != null ? it.name : id).slice(0, 12);
      assignColor(b);
      b.since = Date.parse(it.since) || 0;
      var wasFake = b.fake; b.fake = fake;
      if (fake) { if (!wasFake || !b.label) { b.label = nextLabel(b); b.lblT = 8 + Math.random() * 52; } }
      else b.label = it.label ? String(it.label).slice(0, 80) : '';
      var moved = b.desk !== dmap[id];
      b.desk = dmap[id]; b.design = b.desk % 4;
      order.push(b);
      if (isNew && !first) { b.x = lay.corrL; b.y = H + 30; b.path = []; b.mode = 'stand'; b.state = null; enter(b, st, false); }
      else if (relayout || isNew) { b.state = null; enter(b, st, true); }
      else if (b.state !== st || moved) enter(b, st, false);
    });
    bots.forEach(function (b, id) {
      if (seen[id] || b.leaving) return;
      cancelVisit(b); if (gag && gag.bots.indexOf(b) >= 0) cancelGag();
      b.leaving = true; b.state = 'leaving'; b.fx = null; b.dv = null;
      b.goal = { type: 'exit', key: null, x: lay.corrL, y: H + 30 }; b.dwell = 0; planPath(b);
    });
    bossBot = (order[0] && order[0].sp === 'boss') ? order[0] : null;
  }

  function update(dt) {
    bossTalking = false;
    var bubShown = 0; bots.forEach(function (o) { if (o.bubOn) bubShown++; });
    for (var k = 1; k < 3; k++) if (slots[k] && !slots[k - 1]) {
      var h = slots[k]; slots[k - 1] = h; slots[k] = null; h.visit.slot = k - 1;
      var sp = visitSpot(k - 1); h.goal = { type: 'visit', key: null, x: sp.x, y: sp.y }; h.dwell = 0; planPath(h);
    }
    bots.forEach(function (b) {
      b.wt += dt; b.chatT -= dt;
      if (b.fake) { b.lblT -= dt; if (b.lblT <= 0) { b.label = nextLabel(b); b.lblT = 25 + Math.random() * 35; } }
      if (b.state === 'working' && b.mode === 'seat' && !b.path.length) {
        if (b.bubOn) { b.bubAge += dt; if (b.bubAge >= 6) { b.bubOn = false; b.bubT = 15 + Math.random() * 15; } }
        else { b.bubT -= dt; if (b.bubT <= 0 && bubShown < 3) { b.bubOn = true; b.bubAge = 0; bubShown++; } }
      } else if (b.bubOn) { b.bubOn = false; b.bubT = 6 + Math.random() * 10; }
      if (b.hold > 0) { b.hold -= dt; if (b.hold <= 0) { b.hold = 0; enter(b, b.state, false); } return; }
      if (b.fx) { b.fx.t += dt; if (b.fx.t > 2.5) b.fx = null; }
      if (b.path.length) {
        var p = b.path[0], dx = p.x - b.x, dy = p.y - b.y, dist = Math.sqrt(dx * dx + dy * dy), step = SPEED * dt;
        if (Math.abs(dx) > 0.1) b.facing = dx > 0 ? 1 : -1;
        if (dist <= step) { b.x = p.x; b.y = p.y; b.path.shift(); }
        else { b.x += dx / dist * step; b.y += dy / dist * step; }
        b.mode = 'walk';
        if (!b.path.length) {
          b.mode = b.goal.type; b.arrived = true; b.timer = b.dwell || 0;
          if (b.goal.type !== 'wander') b.facing = 0;
          if (b.leaving) bots.delete(b.id);
        }
      } else if (b.dv) {
        if (b.mode === 'deliver') {
          if (b.dv.phase === 'go') {
            b.dv.phase = 'give'; b.dv.t = 0; b.facing = 1;
            var al = humans.filter(function (h) { return h.p.queueDesk; })[0]; if (al) { al.nod = 0.6; staff.fast = 3; }
          }
          b.dv.t += dt;
          if (b.dv.t >= 2.2) { b.dv = null; b.goal = { type: 'seat', key: null }; planPath(b); }
        }
      } else if (b.visit) {
        if (b.mode === 'visit') {
          if (!bossReady()) finishVisit(b);
          else if (b.visit.slot === 0) {
            b.visit.phase = 'talk'; b.visit.timer += dt; bossTalking = true;
            if (b.visit.timer >= b.visit.dur) finishVisit(b);
          }
        }
      } else if (b.state === 'working' && b.mode === 'seat') {
        if (AMBIANCE) { b.delT -= dt; if (b.delT <= 0) tryDeliver(b); }
      } else if (b.state === 'idle' && !b.gag && b.sp !== 'boss') {
        if (b.mode === 'walk' || b.mode === 'seat' || b.mode === 'wave' || b.mode === 'queue') b.mode = 'stand';
        b.timer -= dt;
        if (b.timer <= 0) planIdle(b);
      }
    });
    if (bossBot) bossBot.talking = bossTalking;
    try { updateQueue(); } catch (e) { /* ignore */ }
    try { updateHumans(dt); } catch (e) { humans = []; }
    try { xmasUpdate(dt); } catch (e) { xmasReset(); }
    try { gagUpdate(dt); } catch (e) { gag = null; rackRed = false; bots.forEach(function (b) { b.gag = false; }); }
  }

  // ---------- staff (humans) ----------
  var humans = [], SPEEDH = 34;
  function initHumans() {
    humans = [];
    if (!PEOPLE_ON) return;
    PEOPLE.slice(0, 3).forEach(function (p, i) {
      var cx = 436, dy = [116, 158, 226][i];
      humans.push({ p: p, i: i, cx: cx, dy: dy, seatX: cx + 8, seatY: dy + 9, standX: cx + 8, standY: [162, 188, 226][i],
        x: cx + 8, y: dy + 9, path: [], mode: 'sit', facing: 0, task: null, home: false, anim: 'type', animT: 0, animDur: 0,
        animNext: rnd(3, 8), coffeeT: coffeeGap() + i * 25, nodT: rnd(3, 6), nod: 0, bubT: 6, bub: null, stT: 0 });
    });
  }
  // Easter egg (the portal's hidden console): Camille stands, is shocked, points at Jonathan and a photo of her shows in a bubble for ~12 s
  var EGG_DUR = 12, eggImg = null, lastEggId = null;
  function startEgg(id) {
    if (id === lastEggId) return;
    lastEggId = id;
    var h = humans.filter(function (x) { return x.p.name === 'Camille'; })[0];
    if (!h || h.egg) return;
    h.egg = { t: 0 }; h.mode = 'egg'; h.path = []; h.x = h.standX; h.y = h.standY; h.facing = 0; h.bub = null;
    if (!eggImg) {
      var q = new URLSearchParams(location.search), key = q.get('key');
      eggImg = new Image();
      eggImg.src = (key && /^[A-Za-z0-9_-]{8,128}$/.test(key)) ? '/api/tv/display/easter/camille.jpg?key=' + encodeURIComponent(key) : '/api/tv/easter/camille.jpg';
    }
  }
  function drawEgg(t) {
    var h = humans.filter(function (x) { return x.egg; })[0];
    if (!h) return;
    var e = h.egg.t, al = Math.max(0, Math.min(1, e / 0.4, (EGG_DUR - e) / 0.4));
    if (e < 2.5) iconBubble(h.x + 12, h.y - 44, '_!', t);
    if (e >= 1.5 && eggImg && eggImg.complete && eggImg.naturalWidth) {
      var bw = 47, bh = 70, bx = 352, by = 186, a2 = Math.min(al, Math.max(0, (e - 1.5) / 0.4));
      g.globalAlpha = a2;
      R(bx - 1, by - 1, bw + 2, bh + 2, DARK); R(bx, by, bw, bh, '#fff');
      g.imageSmoothingEnabled = true; g.drawImage(eggImg, bx + 2, by + 2, bw - 4, bh - 4); g.imageSmoothingEnabled = false;
      R(bx + bw, by + bh - 16, 4, 3, DARK); R(bx + bw, by + bh - 15, 3, 1, '#fff'); R(bx + bw + 4, by + bh - 14, 8, 2, DARK);
      g.globalAlpha = 1;
    }
  }
  function humanRoute(p, Tg) {
    var pts = [], Rr = lay.corrR;
    if (Math.abs(p.x - Rr) > 3) pts.push({ x: Rr, y: p.y });
    if (Math.abs(Tg.x - Rr) < 4) pts.push(Tg); else { pts.push({ x: Rr, y: Tg.y }); pts.push(Tg); }
    return pts;
  }
  function humanGo(h, Tg, task) {
    var cur = { x: h.x, y: h.y }, pts = [];
    if (h.mode === 'sit' && !h.path.length) { cur = { x: h.standX, y: h.standY }; pts.push(cur); }
    h.path = pts.concat(humanRoute(cur, Tg)); h.mode = 'walk'; h.task = task; h.home = false;
  }
  function humanHome(h) {
    var cur = { x: h.x, y: h.y }, pts = [];
    if (Math.abs(h.x - h.seatX) < 2 && h.y > h.seatY - 2 && h.y < h.standY - 2) { cur = { x: h.standX, y: h.standY }; pts.push(cur); }
    if (Math.abs(cur.x - h.standX) > 2 || Math.abs(cur.y - h.standY) > 2) pts = pts.concat(humanRoute(cur, { x: h.standX, y: h.standY }));
    pts.push({ x: h.seatX, y: h.seatY });
    h.path = pts; h.mode = 'walk'; h.task = null; h.home = true;
  }
  function updateHumans(dt) {
    if (!humans.length) return;
    var anyAway = humans.some(function (h) { return h.mode !== 'sit'; });
    if (staff.thumb > 0) staff.thumb -= dt;
    if (staff.fast > 0) staff.fast -= dt;
    humans.forEach(function (h) {
      if (h.bub) { h.bub.t -= dt; if (h.bub.t <= 0) h.bub = null; }
      if (h.egg) {
        h.egg.t += dt;
        if (h.egg.t < EGG_DUR) return;
        h.egg = null; h.mode = 'sit'; h.x = h.seatX; h.y = h.seatY; h.facing = 0; h.anim = 'type'; h.animT = 0; h.animNext = rnd(3, 8);
      }
      if (h.path.length) {
        var p = h.path[0], dx = p.x - h.x, dy = p.y - h.y, dist = Math.sqrt(dx * dx + dy * dy), st = SPEEDH * dt;
        if (Math.abs(dx) > 0.1) h.facing = dx > 0 ? 1 : -1;
        if (dist <= st) { h.x = p.x; h.y = p.y; h.path.shift(); } else { h.x += dx / dist * st; h.y += dy / dist * st; }
        h.mode = 'walk';
        if (!h.path.length) {
          if (h.home) { h.mode = 'sit'; h.home = false; h.facing = 0; h.anim = 'type'; h.animT = 0; h.animNext = rnd(3, 8); h.coffeeT = coffeeGap(); }
          else { h.mode = 'stand'; h.stT = 0; h.facing = 0; }
        }
      } else if (h.mode === 'stand') {
        h.stT += dt;
        if (h.stT > 5) humanHome(h);
      } else if (h.mode === 'sit') {
        h.animT += dt;
        var qn = staff.qn;
        if (h.anim === 'type') {
          if (h.animT > h.animNext) {
            var r = Math.random(); h.anim = r < 0.4 ? 'sip' : (r < 0.7 ? 'stretch' : 'glance'); h.animT = 0;
            h.animDur = h.anim === 'stretch' ? 1.6 : 2;
            h.facing = (qn > 0 && !h.p.queueDesk) ? -1 : (Math.random() < 0.5 ? -1 : 1);
          } else h.facing = (h.p.queueDesk && qn > 0) ? -1 : 0;
        } else if (h.animT > h.animDur) { h.anim = 'type'; h.animT = 0; h.animNext = rnd(4, 9); h.facing = 0; }
        if (h.p.queueDesk && qn > 0) {
          h.nodT -= dt; if (h.nodT <= 0) { h.nodT = rnd(3, 6); h.nod = 0.5; }
          h.bubT -= dt; if (h.bubT <= 0) { h.bubT = 10; h.bub = { k: 'doc', t: 2 }; }
        }
        if (h.p.queueDesk && staff.thumb > 0 && (!h.bub || h.bub.k !== 'thumb')) h.bub = { k: 'thumb', t: staff.thumb };
        h.coffeeT -= dt;
        if (h.coffeeT <= 0 && h.p.seated) h.coffeeT = 60;
        if (h.coffeeT <= 0) {
          if (!anyAway && !occupied(null, 'coffee')) { humanGo(h, { x: lay.corrR, y: lay.coffee.y }, { type: 'coffee' }); anyAway = true; }
          else h.coffeeT = rnd(8, 15);
        }
      }
      if (h.nod > 0) h.nod -= dt;
    });
  }
  function drawHuman(h, x, y, pose, t) {
    x = Math.round(x); y = Math.round(y);
    var L = h.p.look, sk = L.skin, sh = shade(sk, -0.18), walk = pose === 'walk', sit = pose === 'sit';
    var fr = walk ? (Math.floor(t * 7) & 3) : 0, bob = (walk && (fr & 1)) ? -1 : 0;
    var hb = bob + (h.nod > 0 ? 1 : 0);
    var shirt = L.shirt || (L.top === 'polo' ? '#1c1c26' : '#17171f'), pants = '#2b3350', shoe = '#12121a';
    var an = sit ? h.anim : '', P = [], D = [], la = walk ? (fr === 1 ? -1 : (fr === 3 ? 1 : 0)) : 0, i;
    if (!sit) P.push([-5, -12, 4, 10, pants], [1, -12, 4, 10, pants], [-6, -2 - ((walk && fr === 1) ? 1 : 0), 5, 2, shoe], [1, -2 - ((walk && fr === 3) ? 1 : 0), 5, 2, shoe]);
    P.push([-7, -26 + bob, 14, 14, shirt]);
    var al = sit ? 16 : 12;
    if (h.egg) an = h.egg.t < 2.5 ? 'stretch' : 'point';
    if (an === 'point') { P.push([-10, -25 + bob, 3, al, shirt], [7, -46, 3, 20, shirt]); D.push([7, -49, 3, 3, sk]); }
    else if (an === 'stretch') { P.push([-10, -44, 3, 18, shirt], [7, -44, 3, 18, shirt]); D.push([-10, -47, 3, 3, sk], [7, -47, 3, 3, sk]); }
    else {
      P.push([-10, -25 + bob + la, 3, al, shirt]);
      if (an === 'sip') { P.push([7, -33, 3, 9, shirt]); D.push([6, -36, 3, 3, sk], [8, -39, 4, 4, '#fff'], [12, -38, 1, 2, '#fff']); }
      else P.push([7, -25 + bob - la, 3, al, shirt]);
      if (!sit) { D.push([-10, -13 + bob + la, 3, 3, sk]); D.push([7, -13 + bob - la, 3, 3, sk]); }
    }
    if (pose === 'coffee') D.push([8, -16, 4, 4, '#fff'], [12, -15, 1, 2, '#fff']);
    P.push([-2, -28 + hb, 4, 2, sh], [-5, -38 + hb, 10, 10, sk], [-6, -41 + hb, 12, 4, L.hair], [-6, -38 + hb, 1, 3, L.hair], [5, -38 + hb, 1, 3, L.hair]);
    if (L.quiff) P.push([-2, -43 + hb, 6, 2, L.hair], [0, -44 + hb, 3, 1, L.hair]);
    if (L.longHair) {
      P.push([-6, -38 + hb, 2, 18, L.hair], [4, -38 + hb, 2, 18, L.hair]);
      D.push([-6, -29 + hb, 2, 3, '#7a4220'], [4, -29 + hb, 2, 3, '#7a4220'], [-6, -26 + hb, 2, 6, L.hairEnds], [4, -26 + hb, 2, 6, L.hairEnds]);
    }
    if (L.bangs) D.push([-5, -38 + hb, 10, 2, L.hair]);
    for (i = 0; i < P.length; i++) R(x + P[i][0] - 1, y + P[i][1] - 1, P[i][2] + 2, P[i][3] + 2, DARK);
    for (i = 0; i < P.length; i++) R(x + P[i][0], y + P[i][1], P[i][2], P[i][3], P[i][4]);
    for (i = 0; i < D.length; i++) R(x + D[i][0], y + D[i][1], D[i][2], D[i][3], D[i][4]);
    var fx = Math.max(-1, Math.min(1, h.facing)), blink = (Math.floor(t * 0.8 + h.i * 3) % 5) === 0 && ((t * 5) % 1) < 0.3, ey = -36 + hb;
    var big = L.glassesStyle === 'big';
    if (big) { R(x - 3 + fx, y + ey + 1, 1, blink ? 1 : 2, '#1a1018'); R(x + 2 + fx, y + ey + 1, 1, blink ? 1 : 2, '#1a1018'); }
    else { var ew = L.glasses ? 1 : 2; R(x - (L.glasses ? 2 : 3) + fx, y + ey, ew, blink ? 1 : 2, '#1a1018'); R(x + 1 + fx, y + ey, ew, blink ? 1 : 2, '#1a1018'); }
    if (L.lips) R(x - 1, y - 31 + hb, 3, 1, L.lips);
    if (big) {
      var G = '#5a3416', A = '#b8742a', TL = '#2d8f8a', gy = y - 38 + hb;
      R(x - 4, gy, 3, 1, G); R(x + 2, gy, 3, 1, G); R(x - 5, gy + 1, 1, 3, A); R(x - 1, gy + 1, 1, 3, A); R(x + 1, gy + 1, 1, 3, A); R(x + 5, gy + 1, 1, 3, A);
      R(x - 4, gy + 4, 3, 1, TL); R(x + 2, gy + 4, 3, 1, TL); R(x, gy + 2, 1, 1, G);
    }
    if (h.egg && big) {
      var wy = y - 37 + hb;
      R(x - 4, wy, 3, 3, '#fff'); R(x + 2, wy, 3, 3, '#fff'); R(x - 3, wy + 1, 1, 1, '#1a1018'); R(x + 3, wy + 1, 1, 1, '#1a1018');
      R(x - 1, y - 31 + hb, 3, h.egg.t < 2.5 ? 2 : 1, '#6a1a2a');
    }
    if (L.beardFull) { R(x - 5, y - 34 + hb, 2, 5, L.beard); R(x + 3, y - 34 + hb, 2, 5, L.beard); R(x - 5, y - 31 + hb, 10, 3, L.beard); R(x - 3, y - 33 + hb, 6, 1, L.beard); R(x - 2, y - 32 + hb, 4, 1, '#fff'); }
    else { R(x - 5, y - 33 + hb, 1, 3, L.beard); R(x + 4, y - 33 + hb, 1, 3, L.beard); R(x - 4, y - 30 + hb, 8, 2, L.beard); R(x - 2, y - 32 + hb, 4, 1, '#8a3a30'); R(x - 3, y - 33 + hb, 1, 1, '#8a3a30'); R(x + 2, y - 33 + hb, 1, 1, '#8a3a30'); }
    if (L.glasses) { var F = '#0a0a10'; R(x - 4, y - 37 + hb, 8, 1, F); R(x - 4, y - 34 + hb, 8, 1, F); R(x - 4, y - 37 + hb, 1, 4, F); R(x - 1, y - 37 + hb, 2, 4, F); R(x + 3, y - 37 + hb, 1, 4, F); }
    if (L.top === 'polo') { R(x - 3, y - 26 + bob, 6, 2, '#2a2a34'); R(x + 3, y - 22 + bob, 2, 2, '#FFF200'); R(x + 3, y - 20 + bob, 1, 1, '#F7941D'); }
    else if (L.inner) {
      var IN = L.inner, by = y - 26 + bob;
      R(x - 3, by, 6, 2, IN); R(x - 2, by + 2, 4, 3, IN); R(x - 1, by + 5, 2, 3, IN);
      R(x - 4, by, 1, 8, '#0c0c12'); R(x + 3, by, 1, 8, '#0c0c12'); R(x - 3, by + 2, 1, 5, '#0c0c12'); R(x + 2, by + 2, 1, 5, '#0c0c12');
      R(x - 2, by + 1, 1, 1, '#1a1a22'); R(x + 1, by + 3, 1, 1, '#1a1a22'); R(x - 1, by + 5, 1, 1, '#1a1a22'); R(x + 1, by + 6, 1, 1, '#1a1a22');
    }
    else { R(x - 2, y - 26 + bob, 4, 11, '#3b3e48'); R(x - 3, y - 26 + bob, 1, 11, '#0c0c12'); R(x + 2, y - 26 + bob, 1, 11, '#0c0c12'); }
  }
  function drawHChair(h) { RO(h.seatX - 9, h.dy - 16, 18, 16, '#2a2a38'); R(h.seatX - 7, h.dy - 15, 14, 2, '#454560'); }
  function drawHDesk(h, t) {
    var cx = h.cx, dy = h.dy;
    RO(cx - 31, dy + 16, 3, 4, '#9aa0b8'); RO(cx + 28, dy + 16, 3, 4, '#9aa0b8');
    RO(cx - 32, dy, 64, 5, '#2a2f48'); R(cx - 32, dy, 64, 1, '#FFF200');
    RO(cx - 32, dy + 5, 64, 11, '#10142a'); R(cx - 32, dy + 5, 64, 1, '#FFD700'); R(cx - 32, dy + 15, 64, 1, '#FFD700');
    var mx = cx - 30;
    RO(mx, dy - 13, 20, 14, '#2b2b3a'); R(mx + 8, dy + 1, 4, 2, '#2b2b3a');
    var work = h.mode === 'sit' && h.anim !== 'stretch', step = Math.floor(t * 5);
    R(mx + 1, dy - 12, 18, 11, work ? '#0e3550' : '#0a1420');
    if (work) for (var l = 0; l < 4; l++) { var hh = hash(h.i * 5 + 20 + l, Math.floor(step / 3)); R(mx + 2 + (l & 1), dy - 10 + l * 2, Math.min(3 + (hh % 11), 15), 1, ['#7df9ff', '#62ff7a', '#FFF200', '#ffffff'][hh % 4]); }
    R(h.seatX - 7, dy + 1, 14, 3, '#cfd3dd'); R(h.seatX - 6, dy + 2, 12, 1, '#6b7184');
    R(cx + 23, dy, 5, 5, DARK); R(cx + 24, dy + 1, 3, 3, '#fff');
    R(cx - 8, dy - 2, 4, 3, '#a5542f'); R(cx - 9, dy - 6, 6, 4, '#3fa24a'); R(cx - 7, dy - 8, 2, 3, '#4fbf5a');
    if (work && h.anim !== 'sip') { var a = (Math.floor(t * (h.p.queueDesk && staff.fast > 0 ? 16 : 8) + h.i) & 1), hc = h.p.look.skin; RO(h.seatX - 6, dy - 1 + a, 3, 3, hc); RO(h.seatX + 3, dy - 1 + (1 - a), 3, 3, hc); }
    drawHPlaque(h);
  }

  // ---------- gags (idle bots only) ----------
  function idleCands() {
    return order.filter(function (b) {
      return b.state === 'idle' && !b.visit && !b.gag && b.sp !== 'boss' && !b.path.length && (b.mode === 'stand' || b.mode === 'wander' || b.mode === 'coffee');
    });
  }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function startGag() {
    var c = idleCands(); if (!c.length) return false;
    var types = ['spill', 'plane', 'plant', 'rack', 'five'].sort(function () { return Math.random() - 0.5; });
    for (var i = 0; i < types.length; i++) {
      var ty = types[i], b = pick(c);
      if (ty === 'spill') { gag = { type: 'spill', bots: [b], t: 0, dur: 7 }; }
      else if (ty === 'plane') { gag = { type: 'plane', bots: [b], t: 0, dur: 5 }; gag.y = rnd(80, 130); }
      else if (ty === 'plant' || ty === 'rack') {
        var tg;
        if (ty === 'rack') tg = { x: lay.corrL, y: 130 };
        else { var pi = Math.floor(Math.random() * PLANTS.length), p = PLANTS[pi]; tg = { x: p.x < 100 ? lay.corrL : lay.corrR, y: p.y + 8, pi: pi }; }
        gag = { type: ty, bots: [b], t: 0, dur: ty === 'rack' ? 5.5 : 4, phase: 'walk', pi: tg.pi };
        b.goal = { type: 'gag', key: 'gag', x: tg.x, y: tg.y }; b.dwell = 0;
      } else {
        var o = c.filter(function (q) { return q !== b; });
        if (!o.length || lay.lanes.every(function (l) { return Math.abs(b.y - l) > 4; })) { gag = null; continue; }
        var m = pick(o), sx = b.x < 240 ? 1 : -1;
        gag = { type: 'five', bots: [b, m], t: 0, dur: 2.6, phase: 'walk', mover: m };
        m.goal = { type: 'gag', key: 'gag', x: b.x + 22 * sx, y: b.y }; m.dwell = 0;
      }
      gag.bots.forEach(function (q) { q.gag = true; });
      if (gag.phase === 'walk') planPath(gag.mover || gag.bots[0]);
      return true;
    }
    return false;
  }
  function endGag() {
    if (gag) gag.bots.forEach(function (b) { b.gag = false; b.timer = rnd(0.5, 2); if (b.mode === 'gag') b.mode = 'stand'; });
    gag = null; rackRed = false;
  }
  function cancelGag() { endGag(); }
  function gagUpdate(dt) {
    if (!GAGS_ON) return;
    if (!gag) {
      gagTimer -= dt;
      if (gagTimer <= 0) { gagTimer = rnd(20, 45); if (!startGag()) gag = null; }
      return;
    }
    for (var i = 0; i < gag.bots.length; i++) { var b = gag.bots[i]; if (bots.get(b.id) !== b || b.state !== 'idle' || b.visit) { cancelGag(); return; } }
    gag.t += dt;
    if (gag.phase === 'walk') {
      var mv = gag.mover || gag.bots[0];
      if (mv.mode === 'gag' && !mv.path.length) {
        gag.phase = 'act'; gag.t = 0; mv.facing = 0;
        if (gag.type === 'five') { gag.bots[0].facing = mv.x > gag.bots[0].x ? 1 : -1; mv.facing = -gag.bots[0].facing; }
        if (gag.type === 'plant') plantBoost[gag.pi] = { start: Date.now() + 1500, end: Date.now() + 40000 };
      } else if (gag.t > 25) cancelGag();
      return;
    }
    rackRed = gag.type === 'rack' && gag.t < 2.2;
    if (gag.type === 'plane') gag.bots[0].facing = planeX() < gag.bots[0].x ? -1 : 1;
    if (gag.t >= gag.dur) endGag();
  }
  function planeX() { return gag ? -12 + 504 * gag.t / gag.dur : -99; }
  function gagJy(b) {
    var jy = 0;
    if (b.fx && b.fx.t < 2) jy -= Math.abs(Math.sin(b.fx.t * 9)) * 5;
    if (gag && gag.phase !== 'walk' && gag.bots.indexOf(b) >= 0) {
      var t = gag.t;
      if (gag.type === 'spill' && t < 0.7) jy -= Math.abs(Math.sin(t * 4.5)) * 7;
      if (gag.type === 'rack' && t > 1.2 && t < 1.8) jy -= Math.abs(Math.sin((t - 1.2) * 5.2)) * 6;
      if (gag.type === 'five' && t > 0.5 && t < 1.2) jy -= Math.abs(Math.sin((t - 0.5) * 4.5)) * 7;
    }
    return Math.round(jy);
  }

  // ---------- robot drawing ----------
  function drawRobot(b, x, y, pose, t) {
    x = Math.round(x); y = Math.round(y);
    var c = b.col, walk = pose === 'walk', sit = pose === 'sit';
    var fr = walk ? (Math.floor(t * 8) & 3) : 0, bob = 0;
    if (walk) bob = (fr & 1) ? -1 : 0;
    else if (pose === 'wave') bob = (Math.floor(t * 4) & 1) ? -2 : 0;
    else if (pose === 'idle' || pose === 'doze' || pose === 'coffee') bob = (Math.floor(t * 1.3 + b.ph) & 1) ? -1 : 0;
    var P = [], ll = (walk && fr === 1) ? 1 : 0, rl = (walk && fr === 3) ? 1 : 0, la = 0, ra = 0;
    if (!sit) P.push([-4, -6, 2, 4, c.dark], [2, -6, 2, 4, c.dark], [-5, -2 - ll, 4, 2, '#3a3a4e'], [1, -2 - rl, 4, 2, '#3a3a4e']);
    if (walk) { la = fr === 1 ? -1 : (fr === 3 ? 1 : 0); ra = -la; }
    P.push([-5, -13 + bob, 10, 8, c.base]);
    P.push([-8, -12 + bob + la, 2, sit ? 4 : 6, c.base]);
    var sw = (Math.floor(t * 6) & 1);
    if (pose === 'wave') P.push([5, -12 + bob, 4, 2, c.base], [8, -24 + bob, 2, 13, c.base], [7 + sw, -27 + bob, 4, 3, c.light]);
    else if (pose === 'coffee') P.push([6, -12 + bob, 2, 6, c.base], [6, -14 + bob, 5, 2, c.base]);
    else P.push([6, -12 + bob + ra, 2, sit ? 4 : 6, c.base]);
    P.push([-2, -15 + bob, 4, 2, c.dark], [-7, -24 + bob, 14, 10, c.base]);
    if (b.design % 2 === 0) { P.push([-9, -21 + bob, 2, 4, c.dark]); if (pose !== 'wave') P.push([7, -21 + bob, 2, 4, c.dark]); }
    var tip = pose === 'wave' ? '#FFF200' : c.light;
    if (b.sp === 'spiky') P.push([-1, -28 + bob, 2, 4, c.dark], [-4, -27 + bob, 2, 3, tip], [2, -27 + bob, 2, 3, tip], [-1, -32 + bob, 2, 5, '#FFF200'], [-5, -26 + bob, 1, 1, '#FFF200'], [4, -26 + bob, 1, 1, '#FFF200']);
    else if (b.design === 0) P.push([-1, -28 + bob, 2, 4, c.dark], [-2, -31 + bob, 4, 3, tip]);
    else if (b.design === 1) P.push([-4, -28 + bob, 2, 4, c.dark], [2, -28 + bob, 2, 4, c.dark], [-5, -30 + bob, 3, 2, tip], [2, -30 + bob, 3, 2, tip]);
    else if (b.design === 2) P.push([-1, -27 + bob, 2, 3, c.dark], [-4, -29 + bob, 8, 2, tip]);
    else P.push([-1, -30 + bob, 2, 6, c.dark], [-1, -33 + bob, 2, 3, tip]);
    var i;
    for (i = 0; i < P.length; i++) R(x + P[i][0] - 1, y + P[i][1] - 1, P[i][2] + 2, P[i][3] + 2, DARK);
    for (i = 0; i < P.length; i++) R(x + P[i][0], y + P[i][1], P[i][2], P[i][3], P[i][4]);
    // face
    R(x - 5, y - 22 + bob, 10, 6, '#101828'); R(x - 6, y - 23 + bob, 12, 1, c.light);
    var fx = b.facing, eye = '#7df9ff', blink = (Math.floor(t * 2 + b.ph * 3) % 9) === 0 && (t * 7 % 1) < 0.5;
    if (pose === 'doze') { R(x - 4, y - 19 + bob, 3, 1, '#4a7f90'); R(x + 1, y - 19 + bob, 3, 1, '#4a7f90'); }
    else if (b.state === 'needs_human') { R(x - 4, y - 21 + bob, 3, 4, '#fff'); R(x + 1, y - 21 + bob, 3, 4, '#fff'); R(x - 1, y - 17 + bob, 2, 1, '#fff'); }
    else if (blink) { R(x - 4 + fx, y - 19 + bob, 3, 1, eye); R(x + 1 + fx, y - 19 + bob, 3, 1, eye); }
    else if (sit && !b.talking) { R(x - 4, y - 20 + bob, 3, 2, eye); R(x + 1, y - 20 + bob, 3, 2, eye); }
    else { R(x - 4 + fx, y - 21 + bob, 3, 3, eye); R(x + 1 + fx, y - 21 + bob, 3, 3, eye); }
    // chest panel
    R(x - 3, y - 11 + bob, 6, 4, '#101828');
    var led = b.state === 'needs_human' ? '#ff3b30' : (b.state === 'working' ? ((Math.floor(t * 6) & 1) ? '#62ff7a' : '#2c8f3c') : '#3a6fb0');
    R(x - 2, y - 10 + bob, 2, 2, led); R(x + 1, y - 10 + bob, 2, 1, c.light);
    if (b.sp === 'star') { var SR = ['00100', '11111', '01110', '01010']; for (var sr = 0; sr < 4; sr++) for (var sc2 = 0; sc2 < 5; sc2++) if (SR[sr][sc2] === '1') R(x - 2 + sc2, y - 12 + sr + bob, 1, 1, '#FFF200'); }
    if (b.sp === 'tie') { R(x - 3, y - 13 + bob, 6, 2, '#fff'); R(x - 1, y - 12 + bob, 2, 2, '#e63946'); R(x - 1, y - 10 + bob, 2, 4, '#e63946'); R(x - 1, y - 7 + bob, 2, 1, '#9b1d28'); }
    if (b.sp === 'cam') { R(x - 3, y - 12 + bob, 7, 4, '#0c0c12'); R(x - 3, y - 12 + bob, 7, 1, '#fff'); R(x - 1, y - 12 + bob, 1, 1, '#0c0c12'); R(x + 1, y - 12 + bob, 1, 1, '#0c0c12'); R(x - 1, y - 10 + bob, 3, 2, '#7df9ff'); }
    if (b.sp === 'brush') { R(x - 3, y - 12 + bob, 7, 4, '#c9a27a'); R(x - 2, y - 11 + bob, 1, 1, '#e63946'); R(x, y - 11 + bob, 1, 1, '#2d7cf0'); R(x + 2, y - 10 + bob, 1, 1, '#FFF200'); R(x + 3, y - 9 + bob, 1, 1, '#14121f'); }
    if (b.sp === 'finance') { R(x - 1, y - 11 + bob, 2, 4, '#0b6b45'); R(x - 2, y - 10 + bob, 4, 1, '#0b6b45'); R(x - 2, y - 8 + bob, 4, 1, '#0b6b45'); }
    if (pose === 'coffee') { R(x + 8, y - 17 + bob, 5, 5, DARK); R(x + 9, y - 16 + bob, 3, 3, '#fff'); R(x + 13, y - 16 + bob, 1, 2, '#fff'); }
  }

  function drawHalo(b, t) {
    var cx = Math.round(b.x), cy = Math.round(b.y - 14), pul = 0.5 + 0.5 * Math.sin(t * 6);
    var rad = 24 + Math.round(pul * 8), k, r;
    for (k = 0; k < 2; k++) {
      g.globalAlpha = k ? 0.35 : (0.18 + 0.2 * pul);
      g.fillStyle = k ? '#FFF200' : '#F7941D';
      r = k ? rad - 9 : rad;
      for (var y = -r; y <= r; y += 2) {
        var w = Math.floor(Math.sqrt(r * r - y * y) * 1.15);
        g.fillRect(cx - w, cy + y, w * 2, 2);
      }
    }
    g.globalAlpha = 1;
  }

  function drawTag(b, x, y, short) {
    var n = b.name.toUpperCase(), w = PX.measure(n, 1) + 4;
    R(Math.round(x - w / 2) - 1, y + 2, w + 2, 11, DARK); R(Math.round(x - w / 2), y + 3, w, 9, b.col.base);
    T(n, x, y + 4, DARK, 1, null, 'center');
  }

  // ---------- desks ----------
  function drawChair(dk) {
    var x = dk.seatX, y = dk.dy;
    RO(x - 8, y - 12, 16, 14, '#1d2440'); R(x - 6, y - 11, 12, 2, '#3a4a78'); R(x - 8, y - 12, 16, 1, '#F7941D');
  }
  function botAt(i) { var r = null; bots.forEach(function (b) { if (b.desk === i && !b.leaving) r = b; }); return r; }

  function drawDeskFront(dk, t) {
    var cx = dk.cx, dy = dk.dy, b = botAt(dk.i);
    // legs, top, front
    RO(cx - 27, dy + 16, 3, 4, '#7d849c'); RO(cx + 24, dy + 16, 3, 4, '#7d849c');
    RO(cx - 28, dy, 56, 5, '#232a42'); R(cx - 28, dy, 56, 1, '#FFF200');
    RO(cx - 28, dy + 5, 56, 11, '#151a2e');
    if (b && b.sp === 'boss') { R(cx - 28, dy, 56, 1, '#FFD700'); R(cx - 28, dy + 15, 56, 1, '#FFD700'); R(cx - 28, dy + 5, 1, 11, '#FFD700'); R(cx + 27, dy + 5, 1, 11, '#FFD700'); }
    // monitor
    var mx = cx - 25;
    RO(mx, dy - 11, 16, 12, '#2b2b3a'); R(mx + 6, dy + 1, 4, 2, '#2b2b3a');
    var sx = mx + 1, sy = dy - 10, step = Math.floor(t * 7);
    var work = b && b.state === 'working' && b.mode === 'seat' && !b.talking;
    if (work) {
      var flick = (hash(dk.i, step) % 7) === 0;
      R(sx, sy, 14, 9, flick ? '#1d5a78' : '#0b2a3a');
      for (var l = 0; l < 4; l++) {
        var h = hash(dk.i * 7 + l, Math.floor(step / 3)), len = 3 + (h % 9), col = ['#7df9ff', '#62ff7a', '#FFF200', '#ff9ac2'][h % 4];
        R(sx + 1 + (l & 1), sy + 1 + l * 2, Math.min(len, 12), 1, col);
      }
    } else {
      R(sx, sy, 14, 9, '#0a1420');
      var ph = (Math.floor(t * 2) + dk.i) % 8; R(sx + 1 + ph, sy + 3 + ((ph * 3) % 4), 2, 1, '#27465c');
    }
    // second (small) monitor for a dual-screen look
    RO(cx - 8, dy - 9, 10, 10, '#2b2b3a'); R(cx - 7, dy - 8, 8, 8, work ? ((Math.floor(t * 3) + dk.i) % 2 ? '#14425e' : '#0e3550') : '#0a1420');
    if (work) { R(cx - 6, dy - 3, 1, 3, '#FFF200'); R(cx - 4, dy - 5, 1, 5, '#F7941D'); R(cx - 2, dy - 4, 1, 4, '#7df9ff'); }
    // keyboard, mug
    R(dk.seatX - 7, dy + 1, 14, 3, '#cfd3dd'); R(dk.seatX - 6, dy + 2, 12, 1, '#6b7184');
    R(cx + 20, dy, 5, 5, DARK); R(cx + 21, dy + 1, 3, 3, '#fff');
    if (work) {
      var a = (Math.floor(t * 9) & 1), hc = b.col.light;
      RO(dk.seatX - 6, dy - 1 + a, 3, 3, hc); RO(dk.seatX + 3, dy - 1 + (1 - a), 3, 3, hc);
    }
    if (b) drawPlaque(dk, b);
  }
  // name plaque (robot colour); redrawn after the bubbles so it is always on top
  function drawPlaque(dk, b) {
    b = plaqueBot(b);
    var cx = dk.cx, dy = dk.dy, n = b.name.toUpperCase(), w = PX.measure(n, 1) + 4;
    if (w > 56) R(cx - Math.floor(w / 2) - 1, dy + 5, w + 2, 11, DARK);
    R(cx - Math.floor(w / 2), dy + 6, w, 9, b.col.base); T(n, cx, dy + 7, DARK, 1, null, 'center');
  }
  function drawHPlaque(h) {
    var cx = h.cx, dy = h.dy, n = h.p.name.toUpperCase(), w = PX.measure(n, 1) + 6;
    R(cx - Math.floor(w / 2), dy + 6, w, 9, '#d9b24a'); T(n, cx, dy + 7, DARK, 1, null, 'center');
    if (h.p.role) { var rw = PX.measure(h.p.role, 1) + 4; RO(cx - Math.floor(rw / 2), dy + 21, rw, 9, DARK); T(h.p.role, cx, dy + 22, '#FFD700', 1, null, 'center'); }
  }

  // ---------- scene ----------
  var NEEDS = [];
  function drawWindows(t) {
    var x = 46, y = 30, w = 78, h = 40, i;
    RO(x, y, w, h, '#05070f'); R(x + 2, y + 2, w - 4, h - 4, '#0a1530');
    R(x - 1, y - 1, w + 2, 1, '#FFF200'); R(x - 1, y + h, w + 2, 1, '#F7941D');
    R(x + w / 2 - 6, y + h + 1, 12, 2, '#2a2f48');
    g.save(); g.beginPath(); g.rect(x + 3, y + 3, w - 6, h - 6); g.clip();
    var sp = t * 4, step = Math.floor(sp / 5), off = Math.floor(sp % 5);
    for (i = 0; i < 21; i++) {
      var bx = x + 4 + i * 5 - off, k = step + i, v = 5 + (hash(k, 7) % 13);
      R(bx, y + h - 5 - v, 3, v, (k % 4 === 0) ? '#F7941D' : '#FFF200');
      var gy = y + 8 + (hash(k, 3) % 7);
      R(bx + 1, gy, 1, 1, '#7df9ff');
      if (i) { var py = y + 8 + (hash(k - 1, 3) % 7); R(bx - 2, Math.round((py + gy) / 2), 1, 1, '#2a7f8f'); }
    }
    if (xmas) drawSnowWindow(x, y, w, h, t);
    g.restore();
    R(x + w - 14, y + 4, 2, 2, '#62ff7a'); R(x + w - 10, y + 4, 2, 2, '#FFF200'); R(x + w - 6, y + 4, 2, 2, '#7df9ff');
    if (unassigned > 0) drawUnassigned(t, x, y, w, h);
  }
  // New tickets nobody has taken: the wall screen turns into an alarm with the count (steady when reduced motion is asked for)
  var unassigned = 0;
  var REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  function drawUnassigned(t, x, y, w, h) {
    var on = REDUCED ? true : (Math.floor(t * 2.5) & 1) === 0;
    var pulse = REDUCED ? 0.35 : 0.25 + 0.2 * Math.sin(t * 6);
    // glow around the screen
    g.globalAlpha = pulse; R(x - 6, y - 6, w + 12, h + 12, '#ff3b30'); g.globalAlpha = Math.min(1, pulse + 0.2); R(x - 3, y - 3, w + 6, h + 6, '#ff3b30'); g.globalAlpha = 1;
    // the screen itself: dark red, flashing frame
    R(x - 2, y - 2, w + 4, h + 4, on ? '#ffffff' : '#ff3b30');
    R(x, y, w, h, on ? '#c1121f' : '#6e0b12');
    R(x + 2, y + 2, w - 4, h - 4, on ? '#2a0508' : '#3a0709');
    var label = unassigned > 999 ? '999+' : String(unassigned);
    T(label, x + Math.floor(w / 2), y + 5, on ? '#FFF200' : '#ffffff', 3, DARK, 'center');
    T('NON ASSIGNÉS', x + Math.floor(w / 2), y + 29, '#ffffff', 1, null, 'center');
    // beacon on top of the screen
    var bx = x + Math.floor(w / 2) - 3;
    R(bx - 1, y - 9, 8, 6, DARK); R(bx, y - 8, 6, 4, on ? '#ff3b30' : '#7a1510');
    if (on) { R(bx - 4, y - 7, 2, 1, '#ff3b30'); R(bx + 8, y - 7, 2, 1, '#ff3b30'); R(bx + 2, y - 12, 2, 2, '#ff3b30'); }
  }
  function drawLeds(t, anyCoffee) {
    var red = rackRed, off = xmas && oct.rackOff;
    var step = Math.floor(t * 4);
    for (var u = 0; u < 5; u++) for (var k = 0; k < 4; k++) {
      var h = hash(u * 5 + k, step + (k > 1 ? Math.floor(step / 3) : 0)) % 5;
      R(11 + k * 3, 66 + u * 11 + (k & 1) * 2, 2, 2, off ? '#10172a' : red ? ((step & 1) ? '#ff3b30' : '#8a1a14') : h === 0 ? '#ff3b30' : (h < 3 ? '#62ff7a' : '#245a30'));
    }
    R(31, 63, 4, 2, (Math.floor(t * 2) & 1) ? '#FFF200' : '#6a5a10');
    // coffee machine light + steam
    R(392, 84, 2, 2, (Math.floor(t * 1.5) & 1) ? '#ff3b30' : '#8a2a20');
    if (anyCoffee) for (var s = 0; s < 3; s++) {
      var ph = (t * 0.8 + s * 0.33) % 1; g.globalAlpha = 1 - ph; R(380 + s * 3 + Math.round(Math.sin(t * 3 + s) * 1), 94 - Math.round(ph * 10) - 3, 2, 2, '#fff'); g.globalAlpha = 1;
    }
  }

  function drawBubble(cx, bottom, lines, fill, tc, bigText) {
    var mw = 0, i;
    for (i = 0; i < lines.length; i++) mw = Math.max(mw, PX.measure(lines[i], 1));
    var w = mw + 8, h = lines.length * 9 + 4, x = Math.round(cx - w / 2);
    x = Math.max(3, Math.min(W - 3 - w, x));
    var y = Math.round(bottom - h);
    R(x - 1, y - 1, w + 2, h + 2, DARK); R(x, y, w, h, fill);
    var tx = Math.round(cx);
    R(tx - 3, bottom, 7, 3, DARK); R(tx - 2, bottom - 1, 5, 4, fill); R(tx - 1, bottom + 3, 3, 1, DARK); R(tx - 1, bottom + 2, 3, 1, fill);
    for (i = 0; i < lines.length; i++) T(lines[i], x + Math.floor(w / 2), y + 3 + i * 9, tc, 1, null, 'center');
  }

  var ICONS = {
    check: { c: '#1fa84a', r: ['0000001', '0000011', '1000110', '1101100', '0111000', '0010000'] },
    heart: { c: '#e63946', r: ['0110110', '1111111', '1111111', '0111110', '0011100', '0001000'] },
    star: { c: '#FFB000', r: ['0010100'.slice(0, 5) === '' ? '' : '00100', '11111', '01110', '01010'] },
    doc: { c: '#4a5a7a', r: ['111110', '100010', '101110', '100010', '101110', '111110'] },
    thumb: { c: '#e0a860', r: ['00011000', '00011000', '00011000', '11111110', '11111110', '11111110', '11111100'] }
  };
  function iconBubble(cx, bottom, key, t) {
    var w, h, rows, col;
    if (key === 'dots') { w = 17; h = 9; }
    else if (key.charAt(0) === '_') { var s = key.slice(1); w = PX.measure(s, 1) + 6; h = 13; }
    else { var ic = ICONS[key]; if (!ic) return; rows = ic.r; col = ic.c; w = rows[0].length + 8; h = rows.length + 6; }
    cx = Math.round(cx); var x = Math.max(2, Math.min(W - 2 - w, cx - Math.floor(w / 2))), y = Math.round(bottom - h);
    R(x - 1, y - 1, w + 2, h + 2, DARK); R(x, y, w, h, '#fff'); R(cx - 2, bottom, 5, 2, DARK); R(cx - 1, bottom - 1, 3, 2, '#fff');
    if (key === 'dots') { var n = 1 + (Math.floor(t * 3) % 3); for (var d = 0; d < n; d++) R(x + 3 + d * 5, y + 4, 2, 2, DARK); }
    else if (key.charAt(0) === '_') T(key.slice(1), x + 3, y + 3, '#d1240f', 1);
    else for (var r = 0; r < rows.length; r++) for (var q = 0; q < rows[r].length; q++) if (rows[r][q] === '1') R(x + 4 + q, y + 3 + r, 1, 1, col);
  }
  function drawPlantBoost() {
    var now = Date.now();
    for (var k in plantBoost) {
      var pb = plantBoost[k], p = PLANTS[k];
      if (!p || now > pb.end) { delete plantBoost[k]; continue; }
      var grow = Math.max(0, Math.min(1, (now - pb.start) / 2500)) * Math.min(1, (pb.end - now) / 3000), h = Math.round(grow * 10);
      if (h > 0) { RO(p.x - 1, p.y - 17 - h, 2, h + 2, '#2f7a3a'); RO(p.x - 5, p.y - 20 - h, 10, 5, '#4fbf5a'); }
    }
  }
  function gagEntities(ents, t) {
    if (!gag || !GAGS_ON) return;
    var b = gag.bots[0], gt = gag.t;
    if (gag.type === 'spill' && b) {
      var sz = Math.max(0, Math.min(1, (gt - 0.4) / 0.8)) * (gt > 6 ? Math.max(0, 7 - gt) : 1), pw = Math.round(14 * sz);
      ents.push({ k: b.y - 0.5, f: function () {
        if (pw > 1) { R(b.x + 10 - pw, b.y - 3, pw * 2, 4, '#5a3a1c'); R(b.x + 11 - pw, b.y - 2, pw * 2 - 2, 2, '#7a5230'); }
        if (gt > 1.5 && gt < 6) { var sw = Math.round(Math.sin(gt * 6) * 4); R(b.x + 12 + sw, b.y - 19, 1, 17, '#b88a5a'); R(b.x + 9 + sw, b.y - 3, 7, 3, '#e8e8f0'); }
      } });
    }
    if (gag.type === 'plant' && gag.phase !== 'walk') {
      var p = PLANTS[gag.pi];
      ents.push({ k: 400, f: function () {
        var cx = p.x < 100 ? p.x + 6 : p.x - 6;
        RO(b.x + (p.x < 100 ? 8 : -12), b.y - 20, 6, 4, '#4aa8ff');
        for (var d = 0; d < 3; d++) { var ph = (t * 1.5 + d / 3) % 1; R(cx + (d - 1) * 2, p.y - 18 + Math.round(ph * 16), 1, 2, '#9ad8ff'); }
      } });
    }
  }
  function gagOverlay(t) {
    if (!gag || !GAGS_ON) return;
    var b = gag.bots[0], gt = gag.t, act = gag.phase !== 'walk';
    if (!b) return;
    if (gag.type === 'plane') {
      var px = Math.round(planeX()), py = Math.round(gag.y + Math.sin(gt * 4) * 6);
      RO(px, py + 1, 10, 3, '#ffffff'); R(px + 2, py - 1, 5, 2, '#e8e8f4'); R(px + 8, py + 2, 2, 1, '#c8c8dc');
    }
    if (!act) return;
    if (gag.type === 'spill' && gt < 2.4) iconBubble(b.x, b.y - 36 + gagJy(b), '_OUPS', t);
    if (gag.type === 'rack') {
      if (gt > 1.2 && gt < 2.2) iconBubble(b.x, b.y - 36, '_!', t);
      else if (gt >= 2.6 && gt < 3.8) iconBubble(b.x, b.y - 36, '_BIP BOP', t);
      else if (gt >= 3.8) iconBubble(b.x, b.y - 36, 'thumb', t);
    }
    if (gag.type === 'five' && gt > 0.9) { var m = gag.bots[1]; iconBubble((b.x + m.x) / 2, Math.min(b.y, m.y) - 38, 'star', t); }
  }

  function drawBangBubble(b, t) {
    var by = Math.round(b.y - 40 - Math.sin(t * 1.6) * 1.5), cx = Math.round(b.x);
    if (b.goal && b.goal.type === 'queue') {
      R(cx - 11, by - 26, 22, 26, DARK); R(cx - 10, by - 25, 20, 23, '#ffffff');
      R(cx - 3, by, 6, 3, DARK); R(cx - 1, by - 2, 2, 3, '#ffffff');
      T('!', cx, by - 22, '#d1240f', 2, null, 'center');
      return;
    }
    R(cx - 13, by - 30, 26, 30, DARK); R(cx - 11, by - 28, 22, 26, '#ffffff');
    R(cx - 11, by - 28, 22, 3, '#f0f0f0');
    R(cx - 4, by, 8, 4, DARK); R(cx - 2, by - 2, 4, 4, '#ffffff');
    T('!', cx, by - 24, '#d1240f', 3, null, 'center');
  }

  var CLOCK = !/(?:^|[?&])clock=0(?:&|$)/.test(location.search); // wall clock (top right); ?clock=0 hides it
  var logoScale = 1;
  function placeLogo() { /* header logo removed: the brand lives on the wall sign */ }
  function drawHeader(t, now) {
    if (!CLOCK) return;
    var str = pad2(now.getHours()) + ((Math.floor(t) & 1) ? ' ' : ':') + pad2(now.getMinutes());
    if (xmas && oct.clockOff) str = '  ' + ((Math.floor(t) & 1) ? ' ' : ':') + '  ';
    T(str, 426, 21, '#F7941D', 2, null, 'center'); T(str, 426, 20, '#FFF200', 2, null, 'center');
  }

  function drawOffline() {
    var x = 468, y = 44, rows = ['..XXXXX..', '.X.....X.', '...XXX...', '..X...X..', '....X....'];
    for (var r = 0; r < rows.length; r++) for (var c = 0; c < 9; c++) if (rows[r][c] === 'X') R(x + c, y + r, 1, 1, '#8a8a99');
    for (var k = 0; k < 8; k++) R(x + k, y + k - 1, 1, 1, '#ff3b30');
  }

  var st = { lastOk: Date.now(), stale: false };
  function draw(t) {
    var now = new Date();
    g.drawImage(bg, 0, 0);
    drawWindows(t, now);
    var working = 0, anyCoffee = false, ents = [], i;
    NEEDS = [];
    for (i = 0; i < order.length; i++) {
      var b = order[i];
      if (b.state === 'working') working++;
      if (b.state === 'needs_human') NEEDS.push(b);
      if (b.mode === 'coffee') anyCoffee = true;
    }
    drawLeds(t, anyCoffee);
    drawPlantBoost();
    if (xmas) { try { drawXmasBack(t); } catch (e) { /* ignore */ } }
    if (bossBot) ents.push({ k: -5, f: function () {
      var sp = visitSpot(0); R(sp.x - 14, sp.y - 3, 28, 8, '#1a2140'); R(sp.x - 14, sp.y - 3, 28, 1, '#33381f'); R(sp.x - 14, sp.y + 4, 28, 1, '#33381f');
    } });
    try { gagEntities(ents, t); } catch (e) { /* ignore */ }
    if (xmas) { try { xmasEnts(ents, t); } catch (e) { /* ignore */ } }
    lay.desks.forEach(function (dk) {
      ents.push({ k: dk.dy, f: function () { drawChair(dk); } });
      ents.push({ k: dk.dy + 10, f: function () { drawDeskFront(dk, t); } });
    });
    bots.forEach(function (b) {
      var pose = 'idle';
      if (b.path.length || b.mode === 'walk') pose = 'walk';
      else if (b.mode === 'seat') pose = 'sit';
      else if (b.mode === 'wave') pose = 'wave';
      else if (b.mode === 'queue') pose = b.state === 'needs_human' ? 'wave' : 'idle';
      else if (b.mode === 'doze') pose = 'doze';
      else if (b.mode === 'coffee') pose = 'coffee';
      else if (b.mode === 'visit' || b.mode === 'gag' || b.mode === 'deliver') pose = 'idle';
      var showTag = pose !== 'sit';
      ents.push({ k: b.y, f: function () {
        drawRobot(b, b.x, b.y + gagJy(b), pose, t);
        if (xmas && isHostage(b)) drawHostage(b);
        b._tag = showTag ? (b.goal && b.goal.type === 'queue' ? 2 : 1) : 0;
        if (showTag) drawTag(b, b.x, b.y, b.goal && b.goal.type === 'queue');
        if (pose === 'doze') for (var z = 0; z < 3; z++) {
          var ph = (t * 0.45 + z / 3) % 1; g.globalAlpha = 1 - ph;
          T('Z', b.x + 8 + ph * 10 + z * 2, b.y - 34 - ph * 16, '#bfe9ff', z === 1 ? 2 : 1, DARK); g.globalAlpha = 1;
        }
      } });
    });
    humans.forEach(function (h) {
      ents.push({ k: h.dy, f: function () { drawHChair(h); } });
      ents.push({ k: h.dy + 10, f: function () { drawHDesk(h, t); } });
      ents.push({ k: h.y, f: function () {
        var pose = h.path.length ? 'walk' : (h.mode === 'sit' ? 'sit' : (h.task ? 'coffee' : 'stand'));
        drawHuman(h, h.x, h.y, pose, t);
      } });
    });
    ents.sort(function (a, b) { return a.k - b.k; });
    for (i = 0; i < ents.length; i++) ents[i].f();
    // overlays: bubbles
    var maxc0 = Math.max(8, Math.floor((lay.cell - 6) / 6));
    order.forEach(function (b) {
      if (xmas && isHostage(b) && b.state === 'working') return;
      if (b.state === 'working' && b.mode === 'seat' && !b.path.length && !b.bubOn) {
        R(Math.round(b.x) - 5, Math.round(b.y - 36), 2, 2, '#ffffff'); R(Math.round(b.x) - 1, Math.round(b.y - 36) - (Math.floor(t * 3) % 3 === 1 ? 1 : 0), 2, 2, '#ffffff'); R(Math.round(b.x) + 3, Math.round(b.y - 36), 2, 2, '#ffffff');
      } else if (b.state === 'working' && b.mode === 'seat' && !b.path.length) {
        var lw = 0; String(b.label || '').split(/\s+/).forEach(function (w) { lw = Math.max(lw, w.length); });
        var maxc = Math.max(maxc0, Math.min(lw, 14)), lines = PX.wrap(b.label || 'Au travail', maxc, 2);
        var al = Math.max(0, Math.min(1, b.bubAge / 0.4, (6 - b.bubAge) / 0.4));
        g.globalAlpha = al;
        if (lay.rows === 3 && lay.cols <= 3) {
          var sl = PX.wrap(b.label || 'Au travail', 14, 3), sw = 0; sl.forEach(function (q) { sw = Math.max(sw, PX.measure(q, 1)); });
          var bw = sw + 8, bh = sl.length * 9 + 4, rx = Math.round(b.x) - 4, bx = Math.max(2, rx - bw), byy = Math.round(b.y - 12 - bh + (1 - al) * 3);
          R(bx - 1, byy - 1, bw + 2, bh + 2, DARK); R(bx, byy, bw, bh, '#ffffff'); R(bx + bw, byy + bh - 8, 3, 3, DARK); R(bx + bw - 1, byy + bh - 7, 2, 1, '#ffffff');
          sl.forEach(function (q, qi) { T(q, bx + Math.floor(bw / 2), byy + 3 + qi * 9, DARK, 1, null, 'center'); });
        } else drawBubble(b.x, Math.round(b.y - 36 + (1 - al) * 4), lines, '#ffffff', DARK);
        g.globalAlpha = 1;
      } else if (b.state === 'needs_human') drawBangBubble(b, t);
    });
    // briefing bubbles
    order.forEach(function (b) {
      try {
        if (b.visit && b.visit.phase === 'talk' && b.visit.slot === 0 && bossBot) {
          var v = b.visit, vt = Math.floor(v.timer / 0.8) % 2;
          if (v.kind === 'report') {
            iconBubble(b.x + 14, b.y - 30, 'check', t);
            if (v.timer > v.dur / 2) iconBubble(bossBot.x + 12, bossBot.y - 36, 'dots', t);
          } else iconBubble(vt ? bossBot.x + 12 : b.x + 14, vt ? bossBot.y - 36 : b.y - 30, 'dots', t);
        }
        if (b.dv) iconBubble(b.x, b.y - 36, b.dv.phase === 'give' ? 'check' : 'doc', t);
        if (b.fx && b.fx.t < 2.5) iconBubble(b.x, b.y - 36 + gagJy(b), 'heart', t);
      } catch (e) { /* ignore */ }
    });
    try { drawEgg(t); } catch (e) { /* ignore */ }
    humans.forEach(function (h) { try { if (h.bub) iconBubble(h.x - 24, h.y - 26, h.bub.k, t); } catch (e) { /* ignore */ } });
    try { gagOverlay(t); } catch (e) { /* ignore */ }
    if (xmas) { try { xmasOverlay(t); drawGarland(t); order.forEach(function (b) { if (isHostage(b) && !b.leaving) drawHostageSign(lay.desks[b.desk], t); }); } catch (e) { /* ignore */ } }
    // plaques and name tags always above bubbles
    lay.desks.forEach(function (dk) { var pb = botAt(dk.i); if (pb) drawPlaque(dk, pb); });
    humans.forEach(function (h) { drawHPlaque(h); });
    bots.forEach(function (b) { if (b._tag) drawTag(b, b.x, b.y, b._tag === 2); });
    drawHeader(t, now, working, NEEDS.length);
    var offline = (Date.now() - st.lastOk > 20000) || st.stale;
    if (offline) drawOffline();
  }

  // ---------- resize ----------
  function resize() {
    var vw = window.innerWidth, vh = window.innerHeight, s = Math.min(vw / W, vh / H) * 0.97; // ~3% safe margin for TV overscan
    if (s >= 1) { var si = Math.floor(s); if (si / s >= 0.95) s = si; }
    var stg = document.getElementById('stage');
    stg.style.width = Math.floor(W * s) + 'px'; stg.style.height = Math.floor(H * s) + 'px';
    logoScale = Math.floor(W * s) / W;
    stg.style.setProperty('--u', logoScale + 'px');
    placeLogo();
  }
  window.addEventListener('resize', resize);

  // ---------- data ----------
  var fails = 0;
  // Feed: ?key=<displayKey> (kiosk, no cookies) or ?feed=<same-origin path> (portal session); default /api/tv/state.
  // The key stays in the address (a reload keeps it) but is never logged or sent as a referrer.
  var FEED = (function () {
    var q = new URLSearchParams(location.search), key = q.get('key'), feed = q.get('feed');
    if (key && /^[A-Za-z0-9_-]{8,128}$/.test(key)) return { url: '/api/tv/display/state?key=' + encodeURIComponent(key), cred: 'omit' };
    if (feed && /^\/(?![\/\\])[^\s]*$/.test(feed)) return { url: feed, cred: 'same-origin' };
    return { url: '/api/tv/state', cred: 'same-origin' };
  })();
  function fetchState() {
    var ctl = new AbortController(), tm = setTimeout(function () { ctl.abort(); }, 5000);
    return fetch(FEED.url, { cache: 'no-store', credentials: FEED.cred, referrerPolicy: 'no-referrer', signal: ctl.signal }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (d) { clearTimeout(tm); return d; }, function (e) { clearTimeout(tm); throw e; });
  }
  // Chime when a new unassigned ticket comes in. Kiosk only (?key=): the portal preview (?feed=) stays silent, ?sound=0 turns it off.
  var prevUnassigned = null, actx = null, hint = null;
  var SOUND = (function () {
    var q = new URLSearchParams(location.search);
    return q.get('sound') !== '0' && !!q.get('key') && !!(window.AudioContext || window.webkitAudioContext);
  })();
  function soundReady() { return !!actx && actx.state === 'running'; }
  function updateHint() {
    if (!SOUND) return;
    if (soundReady()) { if (hint) { hint.remove(); hint = null; } return; }
    if (!hint) {
      hint = document.createElement('div');
      hint.textContent = 'Cliquer pour activer le son';
      hint.style.cssText = 'position:fixed;right:8px;bottom:6px;font:12px sans-serif;color:#fff;background:rgba(0,0,0,.55);padding:3px 8px;border-radius:4px;opacity:.7;pointer-events:none;z-index:10';
      document.body.appendChild(hint);
    }
  }
  function unlockSound() {
    if (!SOUND) return;
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state !== 'running') actx.resume().then(updateHint, function () {});
    } catch (e) { /* no sound */ }
    updateHint();
  }
  if (SOUND) {
    ['click', 'keydown', 'touchstart', 'pointerdown'].forEach(function (ev) { window.addEventListener(ev, unlockSound, { passive: true }); });
    updateHint();
  }
  function chime() {
    if (!SOUND || !soundReady()) return;
    try {
      var t0 = actx.currentTime + 0.02;
      [[659.25, 0], [830.61, 0.16], [987.77, 0.32]].forEach(function (n) {
        var o = actx.createOscillator(), gn = actx.createGain();
        o.type = 'sine'; o.frequency.value = n[0];
        gn.gain.setValueAtTime(0.0001, t0 + n[1]);
        gn.gain.exponentialRampToValueAtTime(0.25, t0 + n[1] + 0.02);
        gn.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + 0.5);
        o.connect(gn); gn.connect(actx.destination);
        o.start(t0 + n[1]); o.stop(t0 + n[1] + 0.55);
      });
    } catch (e) { /* no sound */ }
  }
  function poll() {
    var p = DEMO ? Promise.resolve(demoFeed()) : fetchState();
    p.then(function (d) {
      if (!d || !Array.isArray(d.bots)) throw new Error('bad payload');
      var nu = Math.max(0, Math.floor(Number(d.unassigned) || 0));
      if (prevUnassigned !== null && nu > prevUnassigned) chime();
      prevUnassigned = nu; unassigned = nu;
      if (d.easter === 'camille' && d.easterId != null) { try { startEgg(d.easterId); } catch (e) { /* ignore */ } }
      setXmas(d.christmas); applyData(d); st.lastOk = Date.now(); st.stale = !!d.stale; fails = 0;
      setTimeout(poll, 2000);
    }).catch(function () {
      fails++;
      setTimeout(poll, Math.min(30000, 2000 * Math.pow(2, fails)));
    });
  }

  // simulated feed (same shape as /api/state)
  var demo = null;
  var DEMO_NAMES = ['Clicky', 'Finance', 'Adjointe', 'Portail AKAB', 'Boss', 'Facebook', 'Légale', 'Vidéaste', "L'artiste"];
  var DEMO_LABELS = ['Tri des courriels', 'Sauvegarde nocturne', 'Mise à jour des postes', 'Analyse des journaux', 'Rapport de facturation', 'Vérification antivirus', 'Création de comptes', 'Suivi des billets'];
  function demoFeed() {
    var now = Date.now();
    if (!demo) {
      demo = DEMO_NAMES.map(function (n, i) { return { id: 'bot-' + (i + 1), name: n, state: i < 3 ? 'working' : 'idle', label: i < 3 ? DEMO_LABELS[i] : null, since: now, next: now + rnd(6000, 14000) }; });
      demo[6].state = 'needs_human'; demo[6].label = null; demo[6].next = now + 20000;
    }
    demo.forEach(function (b) {
      if (now < b.next) return;
      var r = Math.random();
      if (b.state === 'needs_human') r = 0.5;
      var ns = r < 0.08 && b.state !== 'needs_human' ? 'needs_human' : (b.state === 'working' ? 'idle' : 'working');
      if (b.state === 'idle' && Math.random() < 0.3) ns = 'idle';
      b.state = ns; b.since = now;
      b.label = ns === 'working' ? DEMO_LABELS[Math.floor(Math.random() * DEMO_LABELS.length)] : null;
      b.next = now + (ns === 'needs_human' ? rnd(14000, 24000) : rnd(8000, 22000));
    });
    return { updatedAt: new Date(now).toISOString(), source: 'demo', stale: false,
      bots: demo.map(function (b) { return { id: b.id, name: b.name, state: b.state, label: b.label, since: new Date(b.since).toISOString() }; }) };
  }

  // ---------- Christmas (1-25 December): Octet, AKAB's comic elf ----------
  // The server sends christmas: null outside the window, else { day, shirt, aubaine }. Outside it nothing below runs.
  var xmas = null;
  var PRANKS = ['cable', 'logo', 'swap', 'clock', 'chair', 'rack', 'plant', 'tuque'];
  var OC = { skin: '#f2b88f', hair: '#3a2212', green: '#1f8a45', red: '#e63946', gold: '#FFD700', yellow: '#FFF200', brown: '#8a5a2b', cheek: '#ff8f8f', shirt: '#2c2c3a' };
  var SHELF_Y = 46, HOME = { x: 22, y: 106 };
  var oct = { mode: 'sleep', x: 22, y: SHELF_Y, t: 0, tot: 0, wake: 25, face: 1, path: [], type: '', dur: 8, hop: false, rackOff: false, clockOff: false, wrap: null, swap: null, tuque: null, tuqueUntil: 0, target: null };

  function setXmas(c) {
    var nx = null;
    if (c && typeof c === 'object') {
      var day = Math.floor(Number(c.day));
      if (day >= 1 && day <= 25) nx = { day: day, shirt: !!c.shirt, aubaine: (typeof c.aubaine === 'string' && c.aubaine.trim()) ? c.aubaine.trim().slice(0, 80) : null };
    }
    var changed = JSON.stringify(nx) !== JSON.stringify(xmas);
    xmas = nx;
    if (changed) { xmasReset(); xmasCard(); }
  }
  function xmasReset() {
    oct.mode = 'sleep'; oct.x = HOME.x; oct.y = SHELF_Y; oct.path = []; oct.rackOff = false; oct.clockOff = false; oct.wrap = null; oct.swap = null; oct.tuque = null;
    oct.wake = 25 + Math.random() * 10; oct.t = 0; oct.tot = 0;
  }
  // The corner card: the real Octet picture (one of four by day), the title and the day's aubaine
  var CARD_IMGS = ['vue-trois-quarts', 'expr-clin-doeil', 'expr-rieur', 'expr-fier-b'];
  function xmasCard() {
    var el = document.getElementById('xmas');
    if (!el) return;
    if (!xmas) { el.hidden = true; return; }
    document.getElementById('xmas-img').src = 'assets/octet/' + CARD_IMGS[xmas.day % CARD_IMGS.length] + '-transparent.png';
    document.getElementById('xmas-a').textContent = xmas.aubaine || 'Des aubaines tous les jours !';
    el.hidden = false;
  }

  function pickBot(skipHostage) {
    var c = order.filter(function (b) { return !b.leaving && b.state !== 'leaving' && !(skipHostage && isHostage(b)); });
    if (!c.length) return null;
    var seated = c.filter(function (b) { return b.mode === 'seat' && !b.path.length; });
    return pick(seated.length ? seated : c);
  }
  function isHostage(b) { return normName(b.name) === 'facebook'; }

  function beginPrank() {
    var ty = PRANKS[(xmas.day - 1) % PRANKS.length], b = null;
    if (ty === 'cable') b = pickBot(true);
    if (ty === 'tuque') b = bossBot || pickBot(true);
    if ((ty === 'cable' || ty === 'tuque') && !b) ty = 'rack';
    if (ty === 'swap' && (order.length < 2 || !botAt(0) || !botAt(1))) ty = 'rack';
    oct.type = ty; oct.mode = 'wake'; oct.t = 0; oct.tot = 0; oct.target = b;
    oct.dur = { cable: 7, logo: 7, swap: 8, clock: 8, chair: 10, rack: 6.5, plant: 7, tuque: 9 }[ty];
  }
  function spotFor() {
    var ty = oct.type, b = oct.target, d0 = lay.desks[0];
    if (ty === 'cable' || ty === 'tuque') return b ? { x: Math.round(b.x - 15), y: Math.round(b.y + 5) } : HOME;
    if (ty === 'logo') return { x: 352, y: 66 };
    if (ty === 'swap') return { x: d0.cx + 34, y: d0.dy + 30 };
    if (ty === 'clock') return { x: 426, y: 62 };
    if (ty === 'chair') return { x: 60, y: lay.laneB };
    if (ty === 'rack') return { x: 52, y: 110 };
    return { x: 12, y: 207 }; // plant
  }
  function xmasUpdate(dt) {
    if (!xmas) { if (oct.mode !== 'sleep') xmasReset(); return; }
    if (REDUCED) return;
    oct.t += dt;
    if (oct.mode !== 'sleep') { oct.tot += dt; if (oct.tot > 70) { xmasReset(); oct.wake = rnd(150, 240); return; } }
    var u;
    if (oct.mode === 'sleep') { oct.wake -= dt; if (oct.wake <= 0) beginPrank(); }
    else if (oct.mode === 'wake') { if (oct.t > 1.5) { oct.mode = 'drop'; oct.t = 0; } }
    else if (oct.mode === 'drop') {
      u = Math.min(1, oct.t / 0.7); oct.x = HOME.x; oct.y = SHELF_Y + (HOME.y - SHELF_Y) * u - Math.sin(Math.PI * u) * 12;
      if (u >= 1) { oct.mode = 'go'; oct.t = 0; oct.path = [spotFor()]; }
    } else if (oct.mode === 'go' || oct.mode === 'back') {
      var p = oct.path[0];
      if (!p) { oct.mode = oct.mode === 'go' ? 'act' : 'climb'; oct.t = 0; oct.hop = false; if (oct.mode === 'act') actStart(); return; }
      var dx = p.x - oct.x, dy = p.y - oct.y, dist = Math.sqrt(dx * dx + dy * dy), step = 80 * dt;
      if (Math.abs(dx) > 0.5) oct.face = dx > 0 ? 1 : -1;
      oct.hop = true;
      if (dist <= step) { oct.x = p.x; oct.y = p.y; oct.path.shift(); } else { oct.x += dx / dist * step; oct.y += dy / dist * step; }
    } else if (oct.mode === 'act') {
      actUpdate();
      if (oct.t >= oct.dur) { actEnd(); oct.mode = 'back'; oct.t = 0; oct.path = [HOME]; }
    } else if (oct.mode === 'climb') {
      u = Math.min(1, oct.t / 1.1); oct.x = HOME.x; oct.y = HOME.y + (SHELF_Y - HOME.y) * u - Math.sin(Math.PI * u) * 12; oct.face = 1;
      if (u >= 1) { oct.mode = 'sleep'; oct.y = SHELF_Y; oct.wake = rnd(150, 240); oct.tot = 0; }
    }
  }
  function actStart() {
    var ty = oct.type;
    if (ty === 'cable') oct.wrap = oct.target;
    if (ty === 'swap') oct.swap = { a: botAt(0), b: botAt(1) };
    if (ty === 'clock') oct.clockOff = true;
    if (ty === 'tuque') oct.tuque = oct.target;
    if (ty === 'chair') oct.x = 60;
    if (ty !== 'chair') oct.face = 1;
  }
  function actUpdate() {
    var ty = oct.type, t = oct.t;
    if (ty === 'chair') { oct.x = 60 + 320 * (0.5 - 0.5 * Math.cos(2 * Math.PI * t / oct.dur)); oct.face = Math.sin(2 * Math.PI * t / oct.dur) > 0 ? 1 : -1; }
    if (ty === 'rack') oct.rackOff = t > 0.9 && (t < oct.dur - 1.4 || (Math.floor(t * 8) & 1) === 0);
    if (ty === 'cable' && (!oct.wrap || oct.wrap.leaving || bots.get(oct.wrap.id) !== oct.wrap)) oct.wrap = null;
    if (ty === 'swap' && oct.swap && (!oct.swap.a || !oct.swap.b || bots.get(oct.swap.a.id) !== oct.swap.a || bots.get(oct.swap.b.id) !== oct.swap.b)) oct.swap = null;
  }
  function actEnd() {
    oct.rackOff = false; oct.clockOff = false; oct.wrap = null; oct.swap = null;
    if (oct.tuque) oct.tuqueUntil = Date.now() + 15000;
  }
  function plaqueBot(b) {
    if (xmas && oct.swap) { if (oct.swap.a === b) return oct.swap.b; if (oct.swap.b === b) return oct.swap.a; }
    return b;
  }

  // Same drawing convention as the robots: a list of rects, each outlined with DARK, then the fills, then the face details
  function drawSet(x, y, P, D, f) {
    var i, r, rx;
    for (i = 0; i < P.length; i++) { r = P[i]; rx = f < 0 ? -r[0] - r[2] : r[0]; R(x + rx - 1, y + r[1] - 1, r[2] + 2, r[3] + 2, DARK); }
    for (i = 0; i < P.length; i++) { r = P[i]; rx = f < 0 ? -r[0] - r[2] : r[0]; R(x + rx, y + r[1], r[2], r[3], r[4]); }
    for (i = 0; i < D.length; i++) { r = D[i]; rx = f < 0 ? -r[0] - r[2] : r[0]; R(x + rx, y + r[1], r[2], r[3], r[4]); }
  }
  // Octet standing (feet at x,y), robot proportions: legs 4, body 8, chunky 14x10 head, hat on top. o.arms: 'down' | 'up'
  function drawOctet(x, y, t, o) {
    x = Math.round(x); y = Math.round(y);
    var shirt = xmas && xmas.shirt, up = o.arms === 'up', f = o.face || 1, walk = o.hop, fr = walk ? (Math.floor(t * 8) & 3) : 0;
    var bob = walk ? ((fr & 1) ? -1 : 0) : (o.still ? 0 : ((Math.floor(t * 1.3) & 1) ? -1 : 0));
    var ll = (walk && fr === 1) ? 1 : 0, rl = (walk && fr === 3) ? 1 : 0, la = walk ? (fr === 1 ? -1 : (fr === 3 ? 1 : 0)) : 0;
    var blink = !o.still && (Math.floor(t * 2) % 9 === 0) && (t * 7 % 1) < 0.5;
    var P = [[-5, -2 - ll, 4, 2, OC.brown], [1, -2 - rl, 4, 2, OC.brown], [-6, -3 - ll, 1, 1, OC.brown], [5, -3 - rl, 1, 1, OC.brown], [-4, -6, 2, 4, '#ffffff'], [2, -6, 2, 4, '#ffffff']], D = [], i;
    for (i = 0; i < 2; i++) { var x0 = i ? 2 : -4; D.push([x0, -6, 2, 1, OC.red], [x0, -5, 2, 1, OC.green], [x0, -4, 2, 1, OC.red], [x0, -3, 2, 1, OC.green]); }
    if (shirt) {
      P.push([-7, -14 + bob, 14, 10, OC.shirt]);
      if (up) P.push([-10, -24 + bob, 3, 11, OC.shirt], [7, -24 + bob, 3, 11, OC.shirt]); else P.push([-10, -13 + bob + la, 3, 10, OC.shirt], [7, -13 + bob - la, 3, 10, OC.shirt]);
      D.push([-3, -14 + bob, 6, 1, '#e8e8f0'], [-6, -11 + bob, 5, 1, OC.yellow], [-6, -9 + bob, 6, 1, OC.yellow], [-6, -7 + bob, 5, 1, OC.yellow], [1, -11 + bob, 3, 5, OC.gold], [2, -10 + bob, 1, 3, OC.shirt]);
      D.push([5, -13 + bob, 1, 4, OC.gold], [4, -10 + bob, 3, 2, OC.yellow]);
    } else {
      P.push([-5, -13 + bob, 10, 6, OC.green], [-5, -7 + bob, 10, 2, OC.red]);
      if (up) P.push([-8, -23 + bob, 2, 10, OC.green], [6, -23 + bob, 2, 10, OC.green]); else P.push([-8, -12 + bob + la, 2, 6, OC.green], [6, -12 + bob - la, 2, 6, OC.green]);
      D.push([-3, -14 + bob, 6, 2, OC.red], [-5, -9 + bob, 10, 1, OC.yellow], [-5, -7 + bob, 10, 1, OC.gold], [3, -12 + bob, 1, 3, OC.gold], [2, -10 + bob, 3, 2, OC.yellow]);
      if (up) D.push([-8, -25 + bob, 2, 2, OC.skin], [6, -25 + bob, 2, 2, OC.skin]); else D.push([-8, -7 + bob + la, 2, 2, OC.skin], [6, -7 + bob - la, 2, 2, OC.skin], [-8, -8 + bob + la, 2, 1, OC.red], [6, -8 + bob - la, 2, 1, OC.red]);
    }
    // head 14x10 like the robots', pointed ears, dark curly hair, tuque: green, red band, golden bell (never a lamp)
    P.push([-7, -24 + bob, 14, 10, OC.skin], [-9, -21 + bob, 2, 3, OC.skin], [7, -21 + bob, 2, 3, OC.skin], [-7, -27 + bob, 14, 3, OC.red], [-5, -31 + bob, 10, 4, OC.green], [-3, -34 + bob, 6, 3, OC.green], [-7, -36 + bob, 4, 3, OC.green]);
    D.push([-10, -22 + bob, 1, 1, OC.skin], [9, -22 + bob, 1, 1, OC.skin], [-9, -36 + bob, 3, 3, OC.gold]);
    D.push([-7, -24 + bob, 3, 4, OC.hair], [4, -24 + bob, 3, 4, OC.hair], [-7, -24 + bob, 14, 1, OC.hair], [-1, -23 + bob, 3, 1, OC.hair], [-3, -23 + bob, 1, 1, OC.hair], [2, -23 + bob, 1, 1, OC.hair]);
    D.push([-4, -21 + bob, 2, blink ? 1 : 3, '#2a1608'], [2, -21 + bob, 2, blink ? 1 : 3, '#2a1608'], [-5, -18 + bob, 2, 1, OC.cheek], [3, -18 + bob, 2, 1, OC.cheek], [-1, -17 + bob, 2, 1, '#a0402f']);
    drawSet(x, y, P, D, f);
  }
  // Octet asleep (or just waking) on his shelf, lying on his back; head to the left
  function drawOctetLying(x, y, t, awake) {
    x = Math.round(x); y = Math.round(y);
    var shirt = xmas && xmas.shirt, P = [], D = [], i;
    // lying on his back, head to the left, about 40 px long like a robot is 33 tall
    P.push([19, -6, 4, 6, OC.brown], [22, -7, 1, 1, OC.brown], [12, -5, 7, 5, '#ffffff']);
    for (i = 0; i < 7; i++) D.push([12 + i, -5, 1, 5, i & 1 ? OC.green : OC.red]);
    if (shirt) { P.push([-5, -9, 17, 9, OC.shirt]); D.push([-4, -9, 2, 1, '#e8e8f0'], [1, -7, 5, 1, OC.yellow], [0, -5, 6, 1, OC.yellow], [0, -3, 5, 1, OC.yellow], [7, -7, 3, 5, OC.gold], [8, -6, 1, 3, OC.shirt]); }
    else { P.push([-5, -9, 12, 9, OC.green], [7, -8, 5, 8, OC.red]); D.push([-5, -9, 2, 9, OC.red], [-3, -5, 10, 1, OC.yellow], [0, -8, 3, 2, OC.gold], [1, -7, 1, 1, DARK]); }
    P.push([-15, -10, 10, 10, OC.skin], [-14, -18, 8, 6, OC.green], [-12, -21, 5, 4, OC.green], [-16, -13, 12, 3, OC.red], [-18, -22, 4, 3, OC.green]);
    D.push([-20, -21, 3, 3, OC.gold], [-17, -9, 2, 3, OC.skin], [-15, -10, 3, 5, OC.hair], [-15, -10, 10, 1, OC.hair], [-11, -7, 3, awake ? 3 : 1, '#2a1608'], [-8, -4, 2, 1, OC.cheek], [-11, -3, 2, 1, '#a0402f']);
    drawSet(x, y, P, D, 1);
  }
  function drawShelf() {
    // small wooden shelf on the left wall, above the rack
    RO(4, 46, 40, 3, '#8a5a2b'); R(4, 46, 40, 1, '#b07a3f'); R(8, 49, 2, 6, '#5a3a1c'); R(38, 49, 2, 6, '#5a3a1c'); R(8, 54, 4, 1, '#5a3a1c'); R(36, 54, 4, 1, '#5a3a1c');
  }

  function drawGarland(t) {
    var i, x, y, per = 48, cols = ['#ff3b30', '#FFF200', '#62ff7a', '#4aa8ff'];
    for (x = 0; x < W; x++) {
      y = 5 + Math.round(Math.sin(Math.PI * ((x % per) / per)) * 5);
      R(x, y, 1, 2, '#1c6b34'); if (x % 3 === 0) R(x, y + 2, 1, 1, '#2fa04c'); if (x % 3 === 1) R(x, y - 1, 1, 1, '#2fa04c');
    }
    for (i = 0, x = 5; x < W; x += 8, i++) {
      y = 5 + Math.round(Math.sin(Math.PI * ((x % per) / per)) * 5) + 3;
      var on = REDUCED ? true : ((i + Math.floor(t * 2.2)) % 3) !== 0, c = cols[(i + (REDUCED ? 0 : Math.floor(t * 0.7))) % 4];
      R(x - 1, y - 1, 4, 5, DARK); R(x, y, 2, 3, on ? c : shade(c, -0.6));
      if (on) { g.globalAlpha = 0.25; R(x - 2, y - 1, 6, 6, c); g.globalAlpha = 1; }
    }
  }
  function gift(x, y, w, h, c, r) { RO(x, y, w, h, c); R(x + Math.floor(w / 2), y, 1, h, r); R(x, y + Math.floor(h / 2), w, 1, r); R(x + Math.floor(w / 2) - 1, y - 2, 3, 2, r); }
  function drawTree(t) {
    var cx = 106, y, w, l, layers = [[76, 86, 3, 12], [84, 94, 6, 16], [92, 102, 9, 20]];
    R(cx - 2, 100, 5, 5, '#6b4423');
    for (l = 0; l < layers.length; l++) {
      var L = layers[l];
      for (y = L[0]; y < L[1]; y++) {
        w = Math.round(L[2] + (L[3] - L[2]) * (y - L[0]) / (L[1] - L[0] - 1));
        R(cx - Math.floor(w / 2) - 1, y, w + 2, 1, DARK); R(cx - Math.floor(w / 2), y, w, 1, (y - L[0]) & 1 ? '#1d7a3a' : '#2a9a4c');
      }
    }
    var bulbs = [[0, 80], [-4, 88], [5, 91], [-8, 98], [1, 96], [9, 100], [-3, 84]], cols = ['#ff3b30', '#FFF200', '#4aa8ff', '#ff8fd0'];
    for (var i = 0; i < bulbs.length; i++) {
      var on = REDUCED ? true : ((i + Math.floor(t * 2)) % 2) === 0;
      R(cx + bulbs[i][0], bulbs[i][1], 2, 2, on ? cols[i % 4] : shade(cols[i % 4], -0.55));
    }
    var tw = REDUCED || (Math.floor(t * 3) & 1);
    R(cx - 1, 72, 3, 3, '#FFF200'); if (tw) { R(cx - 3, 73, 7, 1, '#FFF200'); R(cx, 70, 1, 7, '#FFF200'); }
    gift(84, 98, 9, 7, '#d1242f', '#FFD700'); gift(118, 99, 8, 6, '#2f8a4c', '#ffffff'); gift(94, 101, 7, 5, '#4aa8ff', '#FFF200'); gift(110, 102, 6, 4, '#FFD700', '#d1242f');
  }
  function drawSnowWindow(x, y, w, h, t) {
    var tt = REDUCED ? 0 : t;
    for (var k = 0; k < 36; k++) {
      var fx = x + 3 + (hash(k, 11) % (w - 8)) + Math.round(Math.sin(tt * 0.8 + k) * 2), sp = 7 + (hash(k, 5) % 9);
      var fy = y + 3 + ((tt * sp + (hash(k, 9) % h)) % (h - 6)), big = k % 5 === 0 ? 2 : 1;
      R(fx, Math.round(fy), big, big, k % 3 === 0 ? '#ffffff' : '#cfe4ff');
    }
  }
  function drawHostage(b) {
    var x = Math.round(b.x), y = Math.round(b.y), k;
    for (k = 0; k < 5; k++) { R(x - 8, y - 22 + k * 5, 16, 2, '#FFF200'); R(x - 8, y - 20 + k * 5, 16, 1, '#a08000'); }
    R(x - 8, y - 23, 2, 22, '#FFF200'); R(x + 6, y - 23, 2, 22, '#FFF200'); R(x - 10, y - 12, 2, 13, '#FFF200'); R(x + 8, y - 12, 2, 13, '#FFF200'); R(x - 10, y - 4, 20, 2, '#FFF200'); R(x - 10, y - 2, 20, 1, '#a08000'); R(x - 1, y - 9, 3, 3, '#FFD700');
  }
  function drawHostageSign(dk, t) {
    // two small placards under Facebook's own desk, clear of every other bot's plate
    var x = dk.cx - 30, y = dk.dy + 22, blink = REDUCED || (Math.floor(t * 2) & 1), aw = PX.measure('AUBAINE', 1) + 4;
    R(x - 1, y - 1, 35, 11, DARK); R(x, y, 33, 9, blink ? '#d1242f' : '#8a1a22'); T('OTAGE', x + 16, y + 1, '#ffffff', 1, null, 'center');
    R(x + 36, y - 1, aw + 2, 11, DARK); R(x + 37, y, aw, 9, '#FFD700'); T('AUBAINE', x + 37 + Math.floor(aw / 2), y + 1, DARK, 1, null, 'center');
  }
  function drawXmasBack(t) {
    drawShelf(); drawTree(t);
    if (oct.mode === 'sleep' || oct.mode === 'wake') drawOctetLying(HOME.x, SHELF_Y, t, oct.mode === 'wake');
  }
  function xmasEnts(ents, t) {
    if (oct.mode === 'sleep' || oct.mode === 'wake') return;
    var ty = oct.type, act = oct.mode === 'act';
    ents.push({ k: ty === 'plant' && act ? 206 : oct.y, f: function () {
      var o = { face: oct.face, hop: oct.hop && oct.mode !== 'act', arms: 'down' };
      if (act && (ty === 'chair' || ty === 'clock' || ty === 'logo')) o.arms = 'up';
      if (act && ty === 'chair') {
        RO(oct.x - 7, oct.y - 8, 14, 3, '#2a2a38'); R(oct.x - 1, oct.y - 5, 2, 4, '#7d849c');
        for (var w = -1; w <= 1; w += 2) R(oct.x + w * 6, oct.y - 2, 2, 2, '#cfd3dd');
        drawOctet(oct.x, oct.y - 4, t, o);
      } else if (act && ty === 'logo') {
        g.save(); g.beginPath(); g.rect(351, 0, W - 351, H); g.clip(); drawOctet(oct.x, oct.y, t, o); g.restore();
      } else drawOctet(oct.x, oct.y, t, o);
      if (act && ty === 'plant') plant(12, 196);
      if (act && ty === 'clock') {
        var s = pad2(new Date().getHours()) + ':' + pad2(new Date().getMinutes());
        T(s, oct.x, oct.y - 52, '#FFF200', 1, DARK, 'center');
      }
    } });
  }
  function xmasOverlay(t) {
    var i, z, ph;
    if (oct.mode === 'sleep' || oct.mode === 'wake') {
      for (z = 0; z < 2; z++) {
        ph = (t * 0.4 + z / 2) % 1; g.globalAlpha = 1 - ph;
        T(z ? 'z' : 'Z', HOME.x - 16 + ph * 14 + z * 3, SHELF_Y - 24 - ph * 14, '#bfe9ff', z ? 1 : 2, DARK); g.globalAlpha = 1;
      }
      if (oct.mode === 'wake') iconBubble(HOME.x + 4, SHELF_Y - 26, '_!', t);
    }
    if (oct.type === 'cable' && oct.wrap && oct.mode === 'act') {
      var b = oct.wrap, n = Math.min(5, 1 + Math.floor(oct.t / 0.6)), bx = Math.round(b.x), by = Math.round(b.y);
      for (i = 0; i < n; i++) { R(bx - 8, by - 22 + i * 5, 16, 2, '#FFF200'); R(bx - 8, by - 20 + i * 5, 16, 1, '#a08000'); }
    }
    var tq = oct.tuque;
    if (tq && (oct.mode === 'act' || Date.now() < oct.tuqueUntil) && bots.get(tq.id) === tq) {
      var tx = Math.round(tq.x), tyy = Math.round(tq.y);
      R(tx - 7, tyy - 30, 14, 6, DARK); R(tx - 6, tyy - 29, 12, 5, OC.green); R(tx - 6, tyy - 26, 12, 2, OC.red); R(tx + 5, tyy - 32, 4, 4, OC.gold);
    } else if (tq && oct.mode !== 'act') oct.tuque = null;
    if (oct.type === 'rack' && oct.mode === 'act') {
      for (i = 0; i < 12; i++) R(Math.round(oct.x - 6 - i * 1.2), Math.round(oct.y - 12 + i * 0.1 + Math.sin(i + t * 3)), 2, 1, '#FFF200');
      R(Math.round(oct.x - 8), Math.round(oct.y - 14), 3, 4, '#FFD700');
    }
    if (oct.mode === 'act' && oct.type !== 'clock') {
      var say = { cable: 'HIHI !', logo: 'COUCOU !', swap: 'OUPS...', chair: 'WOOOO !', rack: oct.rackOff ? 'ZZZT' : 'PRIX BRISES', plant: 'COUCOU !', tuque: 'UNE TUQUE !' }[oct.type];
      if (say && oct.t > 0.5 && oct.t < oct.dur - 0.5) drawBubble(oct.x, oct.y - 42 - (oct.type === 'chair' ? 2 : 0), [say], '#FFF200', DARK);
    }
  }

  // ---------- main loop ----------
  var last = 0;
  function loop(ts) {
    requestAnimationFrame(loop);
    if (ts - last < 30) return;
    var dt = Math.min(0.1, (ts - last) / 1000); last = ts;
    try { update(dt); draw(ts / 1000); } catch (e) { /* never break the loop */ }
  }

  lay = makeLayout(6); bg = buildBg(); initHumans();
  // hidden export helper (?avatars=1): window.__avatar(index, 'body'|'avatar') -> PNG data URL of a staff sprite (integer upscale)
  if (/(?:^|[?&])avatars=1(?:&|$)/.test(location.search)) window.__rects = function (idx) {
    var h = humans[idx]; if (!h) return null;
    var keep = g, rec = [], f0 = h.facing, n0 = h.nod;
    g = { fillStyle: '', fillRect: function (x, y, w, hh) { rec.push([x, y, w, hh, this.fillStyle]); } }; h.facing = 0; h.nod = 0;
    try { drawHuman(h, 16, 48, 'stand', 2); } finally { g = keep; h.facing = f0; h.nod = n0; }
    return rec;
  };
  if (/(?:^|[?&])avatars=1(?:&|$)/.test(location.search)) window.__avatar = function (idx, kind) {
    var h = humans[idx]; if (!h) return null;
    var keep = g, body = kind === 'body', sc = body ? 10 : 16, w = 32, hh = body ? 51 : 32, f0 = h.facing, n0 = h.nod;
    var c = document.createElement('canvas'); c.width = w; c.height = hh;
    var cx = c.getContext('2d'); cx.imageSmoothingEnabled = false; g = cx; h.facing = 0; h.nod = 0;
    try { if (!body) R(0, 0, w, hh, '#0B0B0F'); drawHuman(h, 16, body ? 48 : 47, 'stand', 2); } finally { g = keep; h.facing = f0; h.nod = n0; }
    var o = document.createElement('canvas'); o.width = w * sc; o.height = hh * sc;
    var ox = o.getContext('2d'); ox.imageSmoothingEnabled = false; ox.drawImage(c, 0, 0, o.width, o.height);
    return o.toDataURL('image/png');
  };
  resize();
  poll();
  requestAnimationFrame(loop);

  // reload when the front-end files change (checked every 60 s; not while a bot is waiting for a human; >= 5 min since load)
  (function () {
    var base = null;
    function dj(t) { var h = 5381; for (var i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return t.length + ':' + h; }
    function sig() {
      return Promise.all(['index.html', 'app.js', 'font.js', 'style.css'].map(function (f) {
        return fetch(f, { cache: 'no-store' }).then(function (r) { return r.text(); }).then(dj);
      })).then(function (a) { return a.join('|'); });
    }
    sig().then(function (v) { base = v; }).catch(function () { /* ignore */ });
    setInterval(function () {
      sig().then(function (v) {
        if (base && v !== base && Date.now() - bootTime > 300000 && order.every(function (b) { return b.state !== 'needs_human'; })) location.reload();
      }).catch(function () { /* ignore */ });
    }, 60000);
  })();

  // reload once a day at 04:00 (and never right after a fresh boot)
  setInterval(function () {
    var n = new Date();
    if (n.getHours() === 4 && n.getMinutes() === 0 && Date.now() - bootTime > 120000) location.reload();
  }, 15000);
})();
