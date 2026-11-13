'use strict';
// Original 5x7 pixel font, drawn from a glyph table. Caps only; accents are added as marks.
(function () {
  var G = {
    'A': '01110,10001,10001,11111,10001,10001,10001', 'B': '11110,10001,10001,11110,10001,10001,11110',
    'C': '01110,10001,10000,10000,10000,10001,01110', 'D': '11110,10001,10001,10001,10001,10001,11110',
    'E': '11111,10000,10000,11110,10000,10000,11111', 'F': '11111,10000,10000,11110,10000,10000,10000',
    'G': '01110,10001,10000,10111,10001,10001,01111', 'H': '10001,10001,10001,11111,10001,10001,10001',
    'I': '01110,00100,00100,00100,00100,00100,01110', 'J': '00111,00010,00010,00010,00010,10010,01100',
    'K': '10001,10010,10100,11000,10100,10010,10001', 'L': '10000,10000,10000,10000,10000,10000,11111',
    'M': '10001,11011,10101,10101,10001,10001,10001', 'N': '10001,11001,10101,10011,10001,10001,10001',
    'O': '01110,10001,10001,10001,10001,10001,01110', 'P': '11110,10001,10001,11110,10000,10000,10000',
    'Q': '01110,10001,10001,10001,10101,10010,01101', 'R': '11110,10001,10001,11110,10100,10010,10001',
    'S': '01111,10000,10000,01110,00001,00001,11110', 'T': '11111,00100,00100,00100,00100,00100,00100',
    'U': '10001,10001,10001,10001,10001,10001,01110', 'V': '10001,10001,10001,10001,10001,01010,00100',
    'W': '10001,10001,10001,10101,10101,11011,10001', 'X': '10001,10001,01010,00100,01010,10001,10001',
    'Y': '10001,10001,01010,00100,00100,00100,00100', 'Z': '11111,00001,00010,00100,01000,10000,11111',
    '0': '01110,10001,10011,10101,11001,10001,01110', '1': '00100,01100,00100,00100,00100,00100,01110',
    '2': '01110,10001,00001,00010,00100,01000,11111', '3': '11110,00001,00001,01110,00001,00001,11110',
    '4': '00010,00110,01010,10010,11111,00010,00010', '5': '11111,10000,11110,00001,00001,10001,01110',
    '6': '00110,01000,10000,11110,10001,10001,01110', '7': '11111,00001,00010,00100,01000,01000,01000',
    '8': '01110,10001,10001,01110,10001,10001,01110', '9': '01110,10001,10001,01111,00001,00010,01100',
    '.': '00000,00000,00000,00000,00000,01100,01100', ',': '00000,00000,00000,00000,01100,00100,01000',
    ':': '00000,01100,01100,00000,01100,01100,00000', '!': '00100,00100,00100,00100,00100,00000,00100',
    '?': '01110,10001,00001,00110,00100,00000,00100', '-': '00000,00000,00000,11111,00000,00000,00000',
    "'": '00100,00100,01000,00000,00000,00000,00000', '"': '01010,01010,00000,00000,00000,00000,00000',
    '/': '00001,00010,00010,00100,01000,01000,10000', '%': '11001,11010,00010,00100,01000,01011,10011',
    '(': '00010,00100,01000,01000,01000,00100,00010', ')': '01000,00100,00010,00010,00010,00100,01000',
    '+': '00000,00100,00100,11111,00100,00100,00000', '_': '00000,00000,00000,00000,00000,00000,11111',
    '&': '01100,10010,10100,01000,10101,10010,01101',
    '$': '00100,01111,10100,01110,00101,11110,00100', '*': '00000,10101,01110,11111,01110,10101,00000', '=': '00000,00000,11111,00000,11111,00000,00000'
  };
  for (var k in G) G[k] = G[k].split(',');
  var ACC = {
    0x301: [[3, -2], [2, -1]], 0x300: [[1, -2], [2, -1]],
    0x302: [[2, -2], [1, -1], [3, -1]], 0x308: [[1, -1], [3, -1]], 0x327: [[2, 7]]
  };

  function decompose(str) {
    var s = String(str == null ? '' : str)
      .replace(/[\u0000-\u001f]/g, ' ').replace(/œ/gi, 'oe').replace(/æ/gi, 'ae')
      .replace(/[’‘`´]/g, "'").replace(/[«»“”]/g, '"').replace(/ /g, ' ');
    var out = [], n = s.normalize('NFD');
    for (var i = 0; i < n.length; i++) {
      var cp = n.charCodeAt(i);
      if (cp >= 0x300 && cp <= 0x36f) { if (out.length) out[out.length - 1].acc = cp; continue; }
      out.push({ c: n[i].toUpperCase(), acc: 0 });
    }
    return out;
  }

  function measure(str, scale) {
    scale = scale || 1;
    var n = decompose(str).length;
    return n ? n * 6 * scale - scale : 0;
  }

  var cache = new Map();
  function sprite(str, color, scale, outline) {
    var key = str + '|' + color + '|' + scale + '|' + outline;
    var hit = cache.get(key);
    if (hit) return hit;
    if (cache.size > 400) cache.clear();
    var gl = decompose(str);
    var ox = 1, oy = 2 * scale + 1;
    var w = Math.max(1, gl.length * 6 * scale - scale + 2), h = 10 * scale + 2;
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    function paint(col, dx, dy) {
      g.fillStyle = col;
      for (var i = 0; i < gl.length; i++) {
        var gx = ox + i * 6 * scale + dx, rows = G[gl[i].c];
        if (gl[i].c !== ' ') {
          rows = rows || G['?'];
          for (var r = 0; r < 7; r++) for (var q = 0; q < 5; q++)
            if (rows[r][q] === '1') g.fillRect(gx + q * scale, oy + r * scale + dy, scale, scale);
          var a = ACC[gl[i].acc];
          if (a) for (var j = 0; j < a.length; j++) g.fillRect(gx + a[j][0] * scale, oy + a[j][1] * scale + dy, scale, scale);
        }
      }
    }
    if (outline) for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) if (dx || dy) paint(outline, dx, dy);
    paint(color, 0, 0);
    hit = { c: c, ox: ox, oy: oy };
    cache.set(key, hit);
    return hit;
  }

  // Draw text; (x,y) = top-left of the 7-row cap height. align: left|center|right
  function text(g, str, x, y, color, scale, outline, align) {
    scale = scale || 1;
    var sp = sprite(String(str), color, scale, outline || null);
    var w = measure(str, scale);
    if (align === 'center') x -= Math.floor(w / 2); else if (align === 'right') x -= w;
    g.drawImage(sp.c, Math.round(x) - sp.ox, Math.round(y) - sp.oy);
    return w;
  }

  function wrap(str, maxChars, maxLines) {
    var words = String(str == null ? '' : str).trim().split(/\s+/).filter(Boolean), lines = [], cur = '';
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w.length > maxChars) w = w.slice(0, maxChars - 1) + '.';
      if (!cur) cur = w; else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w; else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      var l = lines[maxLines - 1];
      if (l.length > maxChars - 2) l = l.slice(0, maxChars - 2);
      lines[maxLines - 1] = l + '..';
    }
    return lines;
  }

  window.PX = { text: text, measure: measure, wrap: wrap };
})();
