const $ = (id) => document.getElementById(id);
const state = { svgText: '', result: '', autoTimer: null, buildId: 0 };
const CONTROL_IDS = ['autoParams','numExtraPoints','safeBorder','outlineSize','fillMode','patternShape','edgeMode','hideGrid'];

const NS = 'http://www.w3.org/2000/svg';
const rnd = (n) => Math.round(n * 1000) / 1000;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const area = (poly) => poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length]; return s + p.x * q.y - q.x * p.y; }, 0) / 2;
const centroid = (poly) => poly.reduce((c, p) => ({ x: c.x + p.x / poly.length, y: c.y + p.y / poly.length }), { x: 0, y: 0 });
const bbox = (points) => points.reduce((b, p) => ({ minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y), maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y) }), { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
const pathD = (poly, closed = true) => poly.length ? `M ${poly.map(p => `${rnd(p.x)} ${rnd(p.y)}`).join(' L ')}${closed ? ' Z' : ''}` : '';
const contourPoints = (c) => Array.isArray(c) ? c : c.points;
const contourClosed = (c) => Array.isArray(c) ? true : !!c.closed;

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function makeRng(seed) {
  let x = seed || 1;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}

function getOptions() {
  return {
    autoParams: $("autoParams")?.checked || false,
    numExtraPoints: +$("numExtraPoints").value || 120,
    safeBorder: +$("safeBorder").value || 0.5,
    outlineSize: +$("outlineSize").value || 2,
    curveSamples: 8,
    fillMode: $("fillMode")?.value || "grid",
    patternShape: $("patternShape").value || "triangle",
    edgeMode: $("edgeMode")?.value || "shrink",
    hideGrid: $("hideGrid")?.checked || false
  };
}

function parseSvg(text, samples) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('SVG не удалось прочитать');
  const imported = document.importNode(doc.documentElement, true);
  const host = document.createElement('div');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '-10000px';
  host.style.width = '1px';
  host.style.height = '1px';
  host.style.overflow = 'hidden';
  host.appendChild(imported);
  document.body.appendChild(host);

  const raw = [...imported.querySelectorAll('path, polygon, polyline, rect, circle, ellipse, line')];
  if (!raw.length) { host.remove(); throw new Error('В SVG не найдено поддерживаемых контуров. Сначала преобразуйте фигуры в контуры.'); }

  const svgPoint = imported.createSVGPoint ? imported.createSVGPoint() : null;
  const applyMatrix = (node, x, y) => {
    let m = null;
    try { m = node.getCTM && node.getCTM(); } catch (_) { m = null; }
    if (!m || !svgPoint) return { x, y };
    svgPoint.x = x; svgPoint.y = y;
    const q = svgPoint.matrixTransform(m);
    return { x: q.x, y: q.y };
  };

  const parsePoints = (value) => {
    const nums = (value || '').match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: +nums[i], y: +nums[i + 1] });
    return pts.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  };

  const addClean = (arr, p) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    const last = arr[arr.length - 1];
    if (!last || dist(last, p) > 1e-5) arr.push(p);
  };
  const lineTo = (arr, from, to, steps = 1) => {
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      addClean(arr, { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t });
    }
  };
  const cubic = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return { x: u*u*u*p0.x + 3*u*u*t*p1.x + 3*u*t*t*p2.x + t*t*t*p3.x,
             y: u*u*u*p0.y + 3*u*u*t*p1.y + 3*u*t*t*p2.y + t*t*t*p3.y };
  };
  const quad = (p0, p1, p2, t) => {
    const u = 1 - t;
    return { x: u*u*p0.x + 2*u*t*p1.x + t*t*p2.x,
             y: u*u*p0.y + 2*u*t*p1.y + t*t*p2.y };
  };
  const arcPoint = (cx, cy, rx, ry, phi, theta) => ({
    x: cx + rx * Math.cos(phi) * Math.cos(theta) - ry * Math.sin(phi) * Math.sin(theta),
    y: cy + rx * Math.sin(phi) * Math.cos(theta) + ry * Math.cos(phi) * Math.sin(theta)
  });
  const arcTo = (arr, p0, rx, ry, angle, largeArc, sweep, p1) => {
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (!rx || !ry || (Math.abs(p0.x - p1.x) < 1e-9 && Math.abs(p0.y - p1.y) < 1e-9)) { lineTo(arr, p0, p1); return; }
    const phi = angle * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
    const dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2;
    let x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
    const lam = (x1p*x1p)/(rx*rx) + (y1p*y1p)/(ry*ry);
    if (lam > 1) { const k = Math.sqrt(lam); rx *= k; ry *= k; }
    const sign = largeArc === sweep ? -1 : 1;
    const num = rx*rx*ry*ry - rx*rx*y1p*y1p - ry*ry*x1p*x1p;
    const den = rx*rx*y1p*y1p + ry*ry*x1p*x1p;
    const coef = sign * Math.sqrt(Math.max(0, num / (den || 1)));
    const cxp = coef * (rx * y1p / ry), cyp = coef * (-ry * x1p / rx);
    const cx = cos * cxp - sin * cyp + (p0.x + p1.x) / 2;
    const cy = sin * cxp + cos * cyp + (p0.y + p1.y) / 2;
    const v1 = { x: (x1p - cxp) / rx, y: (y1p - cyp) / ry };
    const v2 = { x: (-x1p - cxp) / rx, y: (-y1p - cyp) / ry };
    const ang = (u, v) => Math.atan2(u.x*v.y - u.y*v.x, u.x*v.x + u.y*v.y);
    let th1 = Math.atan2(v1.y, v1.x), dth = ang(v1, v2);
    if (!sweep && dth > 0) dth -= Math.PI * 2;
    if (sweep && dth < 0) dth += Math.PI * 2;
    const steps = Math.max(6, Math.ceil(Math.abs(dth) * Math.max(rx, ry) / Math.max(2, samples || 10)));
    for (let i = 1; i <= steps; i++) addClean(arr, arcPoint(cx, cy, rx, ry, phi, th1 + dth * i / steps));
  };

  const parsePathSubpaths = (d) => {
    const tokens = (d || '').match(/[AaCcHhLlMmQqSsTtVvZz]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
    const isCmd = (x) => /^[AaCcHhLlMmQqSsTtVvZz]$/.test(x || '');
    const out = [];
    let i = 0, cmd = '', p = {x:0,y:0}, start = {x:0,y:0}, current = [], closed = false, lastC = null, lastQ = null;
    const num = () => parseFloat(tokens[i++]);
    const hasNum = () => i < tokens.length && !isCmd(tokens[i]);
    const flush = () => {
      if (current.length > (closed ? 2 : 1)) out.push({ points: current, closed });
      current = []; closed = false; lastC = null; lastQ = null;
    };
    const move = (pt) => { flush(); p = pt; start = pt; addClean(current, pt); };
    while (i < tokens.length) {
      if (isCmd(tokens[i])) cmd = tokens[i++];
      if (!cmd) break;
      const rel = cmd === cmd.toLowerCase();
      const C = cmd.toUpperCase();
      try {
        if (C === 'M') {
          if (!hasNum()) continue;
          move({ x: num() + (rel ? p.x : 0), y: num() + (rel ? p.y : 0) });
          cmd = rel ? 'l' : 'L';
          while (hasNum()) { const np = { x: num() + (rel ? p.x : 0), y: num() + (rel ? p.y : 0) }; lineTo(current, p, np); p = np; }
        } else if (C === 'L') {
          while (hasNum()) { const np = { x: num() + (rel ? p.x : 0), y: num() + (rel ? p.y : 0) }; lineTo(current, p, np); p = np; }
        } else if (C === 'H') {
          while (hasNum()) { const np = { x: num() + (rel ? p.x : 0), y: p.y }; lineTo(current, p, np); p = np; }
        } else if (C === 'V') {
          while (hasNum()) { const np = { x: p.x, y: num() + (rel ? p.y : 0) }; lineTo(current, p, np); p = np; }
        } else if (C === 'C') {
          while (hasNum()) {
            const p1 = { x: num() + (rel ? p.x : 0), y: num() + (rel ? p.y : 0) };
            const p2 = { x: num() + (rel ? p.x : 0), y: num() + (rel ? p.y : 0) };
            const p3 = { x: num() + (rel ? p.x : 0), y: num() + (rel ? p.y : 0) };
            const steps = Math.max(8, Math.ceil((dist(p,p1)+dist(p1,p2)+dist(p2,p3)) / Math.max(2, samples || 10)));
            for (let k=1;k<=steps;k++) addClean(current, cubic(p,p1,p2,p3,k/steps));
            p = p3; lastC = p2; lastQ = null;
          }
        } else if (C === 'S') {
          while (hasNum()) {
            const p1 = lastC ? { x: 2*p.x - lastC.x, y: 2*p.y - lastC.y } : p;
            const p2 = { x: num() + (rel ? p.x : 0), y: num() + (rel ? p.y : 0) };
            const p3 = { x: num() + (rel ? p.x : 0), y: num() + (rel ? p.y : 0) };
            const steps = Math.max(8, Math.ceil((dist(p,p1)+dist(p1,p2)+dist(p2,p3)) / Math.max(2, samples || 10)));
            for (let k=1;k<=steps;k++) addClean(current, cubic(p,p1,p2,p3,k/steps));
            p = p3; lastC = p2; lastQ = null;
          }
        } else if (C === 'Q') {
          while (hasNum()) {
            const p1 = { x: num() + (rel ? p.x : 0), y: num() + (rel ? p.y : 0) };
            const p2 = { x: num() + (rel ? p.x : 0), y: num() + (rel ? p.y : 0) };
            const steps = Math.max(8, Math.ceil((dist(p,p1)+dist(p1,p2)) / Math.max(2, samples || 10)));
            for (let k=1;k<=steps;k++) addClean(current, quad(p,p1,p2,k/steps));
            p = p2; lastQ = p1; lastC = null;
          }
        } else if (C === 'T') {
          while (hasNum()) {
            const p1 = lastQ ? { x: 2*p.x - lastQ.x, y: 2*p.y - lastQ.y } : p;
            const p2 = { x: num() + (rel ? p.x : 0), y: num() + (rel ? p.y : 0) };
            const steps = Math.max(8, Math.ceil((dist(p,p1)+dist(p1,p2)) / Math.max(2, samples || 10)));
            for (let k=1;k<=steps;k++) addClean(current, quad(p,p1,p2,k/steps));
            p = p2; lastQ = p1; lastC = null;
          }
        } else if (C === 'A') {
          while (hasNum()) {
            const rx = num(), ry = num(), rot = num(), large = !!num(), sweep = !!num();
            const np = { x: num() + (rel ? p.x : 0), y: num() + (rel ? p.y : 0) };
            arcTo(current, p, rx, ry, rot, large, sweep, np);
            p = np; lastC = null; lastQ = null;
          }
        } else if (C === 'Z') {
          if (current.length && dist(current[current.length - 1], start) > 1e-5) lineTo(current, p, start);
          if (current.length && dist(current[0], current[current.length - 1]) < 1e-5) current.pop();
          closed = true; p = start; flush(); cmd = '';
        } else { break; }
      } catch (_) { break; }
    }
    flush();
    return out;
  };

  const contours = [];
  for (const node of raw) {
    const tag = node.tagName.toLowerCase();
    let pieces = [];
    if (tag === 'path') {
      pieces = parsePathSubpaths(node.getAttribute('d') || '');
      // Если ручной разбор не дал результата, используем браузерный getTotalLength как запасной вариант.
      if (!pieces.length) {
        let len = 0;
        try { len = node.getTotalLength(); } catch (_) { len = 0; }
        if (Number.isFinite(len) && len > 0) {
          const points = [];
          const count = Math.max(32, Math.ceil(len / Math.max(1, samples)));
          for (let i = 0; i < count; i++) {
            const q = node.getPointAtLength((i / count) * len);
            points.push({x:q.x, y:q.y});
          }
          const d = (node.getAttribute('d') || '').trim();
          pieces = [{ points, closed: /[zZ]\s*$/.test(d) || (points.length > 2 && dist(points[0], points[points.length-1]) < len * 0.003) }];
        }
      }
    } else if (tag === 'polygon' || tag === 'polyline') {
      pieces = [{ points: parsePoints(node.getAttribute('points')), closed: tag === 'polygon' }];
    } else if (tag === 'line') {
      pieces = [{ points: [{x:+node.getAttribute('x1')||0,y:+node.getAttribute('y1')||0},{x:+node.getAttribute('x2')||0,y:+node.getAttribute('y2')||0}], closed: false }];
    } else if (tag === 'rect') {
      const x=+node.getAttribute('x')||0, y=+node.getAttribute('y')||0, w=+node.getAttribute('width')||0, h=+node.getAttribute('height')||0;
      if (w>0 && h>0) pieces = [{ points: [{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}], closed: true }];
    } else if (tag === 'circle' || tag === 'ellipse') {
      const cx=+node.getAttribute('cx')||0, cy=+node.getAttribute('cy')||0;
      const rx=tag==='circle' ? (+node.getAttribute('r')||0) : (+node.getAttribute('rx')||0);
      const ry=tag==='circle' ? rx : (+node.getAttribute('ry')||0);
      if (rx>0 && ry>0) {
        const count = Math.max(40, Math.ceil(Math.PI * 2 * Math.max(rx, ry) / Math.max(2, samples || 10)));
        const pts=[];
        for (let k=0;k<count;k++) { const a = k * Math.PI * 2 / count; pts.push({x:cx+Math.cos(a)*rx, y:cy+Math.sin(a)*ry}); }
        pieces = [{ points: pts, closed: true }];
      }
    }

    for (const piece of pieces) {
      const clean = [];
      for (const p of piece.points || []) addClean(clean, applyMatrix(node, p.x, p.y));
      const closed = !!piece.closed || (clean.length > 2 && dist(clean[0], clean[clean.length - 1]) < 1e-4);
      if (closed && clean.length > 2 && dist(clean[0], clean[clean.length - 1]) < 1e-4) clean.pop();
      if (clean.length > (closed ? 2 : 1)) {
        // Важно: не переворачиваем направление под-контуров.
        // У compound-path ориентация нужна, чтобы корректно отделять черные области от белых отверстий.
        contours.push({ points: clean, closed });
      }
    }
  }
  host.remove();
  if (!contours.length) throw new Error('Не удалось извлечь контуры из SVG.');
  return contours;
}

function resample(poly, n) {
  const lens = poly.map((p, i) => dist(p, poly[(i + 1) % poly.length]));
  const total = lens.reduce((a, b) => a + b, 0), out = [];
  for (let k = 0; k < n; k++) {
    let t = (k / n) * total, i = 0; while (t > lens[i] && i < lens.length - 1) t -= lens[i++];
    const a = poly[i], b = poly[(i + 1) % poly.length], u = lens[i] ? t / lens[i] : 0;
    out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
  }
  return out;
}

function inside(p, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (((a.y > p.y) !== (b.y > p.y)) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

function scaleContours(contours) {
  const all = contours.flatMap(contourPoints);
  const b = bbox(all);
  const w = Math.max(1e-9, b.maxX - b.minX), h = Math.max(1e-9, b.maxY - b.minY);
  const target = 300; // условные единицы предпросмотра и экспорта
  const s = target / Math.max(w, h);
  return contours.map(c => ({ closed: contourClosed(c), points: contourPoints(c).map(p => ({ x: (p.x - b.minX) * s + 40, y: (p.y - b.minY) * s + 40 })) }));
}

const perimeter = (poly) => poly.reduce((s, p, i) => s + dist(p, poly[(i + 1) % poly.length]), 0);
const polyAbsArea = (poly) => Math.abs(area(poly));
const minEdge = (poly) => poly.reduce((m, p, i) => Math.min(m, dist(p, poly[(i + 1) % poly.length])), Infinity);

function segmentInside(a, b, outer, steps = 7) {
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!inside({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, outer)) return false;
  }
  return true;
}

function polygonInside(poly, outer) {
  if (!poly.every(p => inside(p, outer))) return false;
  for (let i = 0; i < poly.length; i++) {
    if (!segmentInside(poly[i], poly[(i + 1) % poly.length], outer)) return false;
  }
  return true;
}


function windingNumber(p, poly) {
  let wn = 0;
  const isLeft = (a, b, q) => (b.x - a.x) * (q.y - a.y) - (q.x - a.x) * (b.y - a.y);
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if (a.y <= p.y) {
      if (b.y > p.y && isLeft(a, b, p) > 0) wn++;
    } else if (b.y <= p.y && isLeft(a, b, p) < 0) wn--;
  }
  return wn;
}

function inBlackRegion(p, contours) {
  // Основной режим для SVG из potrace/compound-path: nonzero winding.
  // Если направления под-контуров потеряны, evenodd всё равно спасает большинство файлов с отверстиями.
  let wn = 0, crossings = 0;
  for (const c of contours) {
    if (!c.closed || c.points.length < 3) continue;
    const insideC = inside(p, c.points);
    if (insideC) crossings++;
    wn += windingNumber(p, c.points);
  }
  return wn !== 0 || (wn === 0 && (crossings % 2) === 1);
}

function pointSegmentDistance(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (vx * vx + vy * vy || 1)));
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

function distanceToContours(p, contours) {
  let best = Infinity;
  for (const c of contours) {
    const pts = c.points || c;
    if (!pts || pts.length < 2) continue;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      if (!contourClosed(c) && i === n - 1) break;
      best = Math.min(best, pointSegmentDistance(p, pts[i], pts[(i + 1) % n]));
    }
  }
  return best;
}

function regionPointOk(p, contours, safe = 0) {
  if (!inBlackRegion(p, contours)) return false;
  return !safe || distanceToContours(p, contours) + 1e-6 >= safe;
}

function segmentInsideRegion(a, b, contours, steps = 13, safe = 0) {
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (!regionPointOk({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, contours, safe)) return false;
  }
  return true;
}

function polygonInsideRegion(poly, contours, safe = 0) {
  if (!poly.every(pt => regionPointOk(pt, contours, safe))) return false;
  const c = centroid(poly);
  if (!regionPointOk(c, contours, safe)) return false;
  for (let i = 0; i < poly.length; i++) {
    const steps = Math.max(13, Math.ceil(dist(poly[i], poly[(i + 1) % poly.length]) / Math.max(1, (safe || 1) * 0.75)));
    if (!segmentInsideRegion(poly[i], poly[(i + 1) % poly.length], contours, steps, safe)) return false;
  }
  return true;
}

function validPatternCellRegion(poly, contours, gap, targetEdge = 0, allowSmall = false, safe = 0) {
  if (poly.length < 3) return false;
  const a = polyAbsArea(poly);
  const minArea = allowSmall ? Math.max(0.45, gap * gap * 0.12) : Math.max(6, gap * gap * 1.8);
  const minLen = allowSmall ? Math.max(0.25, gap * 0.12) : Math.max(2.2, gap * 0.9);
  if (a < minArea) return false;
  if (minEdge(poly) < minLen) return false;
  if (!allowSmall && !cellIsUniform(poly, targetEdge)) return false;
  return polygonInsideRegion(poly, contours, safe);
}

function cellTouchesRegion(poly, contours, safe = 0) {
  const c = centroid(poly);
  if (regionPointOk(c, contours, safe)) return true;
  for (const pt of poly) if (regionPointOk(pt, contours, safe)) return true;
  const b = bbox(poly);
  for (let yy = 0; yy <= 3; yy++) {
    for (let xx = 0; xx <= 3; xx++) {
      const pt = { x: b.minX + (b.maxX - b.minX) * xx / 3, y: b.minY + (b.maxY - b.minY) * yy / 3 };
      if (inside(pt, poly) && regionPointOk(pt, contours, safe)) return true;
    }
  }
  return false;
}

function scaleAround(poly, c, k) {
  return poly.map(p => ({ x: c.x + (p.x - c.x) * k, y: c.y + (p.y - c.y) * k }));
}

function fitPatternCellRegion(poly, contours, gap, targetEdge = 0, safe = 0) {
  // Для плотной заливки у границ: если обычная ячейка пересекает контур,
  // уменьшаем её вокруг центра, пока она не поместится в черную область SVG.
  // Так крайние элементы становятся меньше, а пустоты вдоль контура заметно сокращаются.
  const c = centroid(poly);
  if (!regionPointOk(c, contours, safe)) return null;
  const base = shrink(poly, gap);
  if (validPatternCellRegion(base, contours, gap, targetEdge, false, safe)) return base;

  let lo = 0.015, hi = 1, best = null;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    const candidate = shrink(scaleAround(poly, c, mid), Math.min(gap, targetEdge * mid * 0.12));
    if (validPatternCellRegion(candidate, contours, gap, targetEdge * mid, true, safe)) {
      best = candidate;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return best;
}
function patternGridCellsInRegion(regionContours, desiredCells, gap, options) {
  const shape = options.patternShape || 'triangle';
  const all = regionContours.flatMap(c => c.points);
  const b = bbox(all);
  const approxArea = Math.max(1, regionContours.reduce((s, c) => s + Math.abs(area(c.points)), 0));
  const target = Math.max(12, (desiredCells || 40) * 2.4);
  const cells = [];
  const pushCell = (poly, targetEdge) => {
    if ((options.edgeMode || 'shrink') === 'clip') {
      if (cellTouchesRegion(poly, regionContours, options.safeBorder || 0)) cells.push(poly);
      return;
    }
    const fitted = fitPatternCellRegion(poly, regionContours, gap, targetEdge, options.safeBorder || 0);
    if (fitted) cells.push(fitted);
  };

  if (shape === 'triangle') {
    let side = Math.sqrt((approxArea / target) / 0.4330127019);
    side = Math.max(side, gap * 3.2, 3);
    const h = side * Math.sqrt(3) / 2;
    const margin = side * 2;
    let row = 0;
    for (let y = b.minY - margin; y <= b.maxY + margin; y += h, row++) {
      const offset = (row % 2) * side / 2;
      for (let x = b.minX - margin + offset; x <= b.maxX + margin; x += side) {
        const p1 = { x, y }, p2 = { x: x + side, y }, p3 = { x: x + side / 2, y: y + h }, p4 = { x: x + side * 1.5, y: y + h };
        pushCell(normalizeTri([p1, p2, p3]), side);
        pushCell(normalizeTri([p2, p4, p3]), side);
      }
    }
    return cells;
  }

  if (shape === 'square') {
    let side = Math.sqrt(approxArea / target);
    side = Math.max(side, gap * 3.2, 3);
    const margin = side * 2;
    for (let y = b.minY - margin; y <= b.maxY + margin; y += side) {
      for (let x = b.minX - margin; x <= b.maxX + margin; x += side) {
        pushCell([{x,y},{x:x+side,y},{x:x+side,y:y+side},{x,y:y+side}], side);
      }
    }
    return cells;
  }

  const sides = shape === 'hexagon' ? 6 : 5;
  const factor = sides === 6 ? 2.598076211 : 2.377641291;
  let r = Math.sqrt((approxArea / target) / factor);
  r = Math.max(r, gap * 2.4, 3);
  const stepX = sides === 6 ? r * 1.55 : r * 1.85;
  const stepY = sides === 6 ? r * Math.sqrt(3) * 0.92 : r * 1.75;
  const margin = r * 3;
  let row = 0;
  for (let y = b.minY - margin; y <= b.maxY + margin; y += stepY, row++) {
    const offset = (row % 2) * stepX / 2;
    for (let x = b.minX - margin + offset; x <= b.maxX + margin; x += stepX) {
      pushCell(regularPolygon(x, y, r, sides, sides === 6 ? Math.PI / 6 : -Math.PI / 2), r);
    }
  }
  return cells;
}

function normalizeTri(poly) {
  return area(poly) < 0 ? poly.slice().reverse() : poly;
}

function triangleGridCells(outer, desiredCells, gap, options) {
  const b = bbox(outer);
  const a = Math.max(1, polyAbsArea(outer));
  const target = Math.max(12, (desiredCells || 40) * 2.4);
  let side = Math.sqrt((a / target) / 0.4330127019);
  side = Math.max(side, gap * 3.2, 3);
  const h = side * Math.sqrt(3) / 2;
  const cells = [];
  const margin = side * 2;
  const minX = b.minX - margin, maxX = b.maxX + margin;
  const minY = b.minY - margin, maxY = b.maxY + margin;

  let row = 0;
  for (let y = minY; y <= maxY; y += h, row++) {
    const offset = (row % 2) * side / 2;
    for (let x = minX + offset; x <= maxX; x += side) {
      const p1 = { x, y };
      const p2 = { x: x + side, y };
      const p3 = { x: x + side / 2, y: y + h };
      const p4 = { x: x + side * 1.5, y: y + h };
      const candidates = [normalizeTri([p1, p2, p3]), normalizeTri([p2, p4, p3])];
      for (const tri of candidates) {
        const small = shrink(tri, gap);
        if (validPatternCell(small, outer, gap, side)) cells.push(small);
      }
    }
  }
  return cells;
}


function regularPolygon(cx, cy, radius, sides, rotation = -Math.PI / 2) {
  const pts = [];
  for (let i = 0; i < sides; i++) {
    const a = rotation + i * Math.PI * 2 / sides;
    pts.push({ x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius });
  }
  return normalizeTri(pts);
}

function patternGridCells(outer, desiredCells, gap, options) {
  const shape = options.patternShape || 'triangle';
  if (shape === 'triangle') return triangleGridCells(outer, desiredCells, gap, options);

  const b = bbox(outer);
  const a = Math.max(1, polyAbsArea(outer));
  const target = Math.max(12, (desiredCells || 40) * 2.4);
  const cells = [];

  const pushCell = (poly, targetEdge) => {
    const small = shrink(poly, gap);
    if (validPatternCell(small, outer, gap, targetEdge)) cells.push(small);
  };

  if (shape === 'square') {
    let side = Math.sqrt(a / target);
    side = Math.max(side, gap * 3.2, 3);
    const margin = side * 2;
    for (let y = b.minY - margin; y <= b.maxY + margin; y += side) {
      for (let x = b.minX - margin; x <= b.maxX + margin; x += side) {
        pushCell([{x,y},{x:x+side,y},{x:x+side,y:y+side},{x,y:y+side}], side);
      }
    }
    return cells;
  }

  const sides = shape === 'hexagon' ? 6 : 5;
  const factor = sides === 6 ? 2.598076211 : 2.377641291;
  let r = Math.sqrt((a / target) / factor);
  r = Math.max(r, gap * 2.4, 3);
  const stepX = sides === 6 ? r * 1.55 : r * 1.85;
  const stepY = sides === 6 ? r * Math.sqrt(3) * 0.92 : r * 1.75;
  const margin = r * 3;
  let row = 0;
  for (let y = b.minY - margin; y <= b.maxY + margin; y += stepY, row++) {
    const offset = (row % 2) * stepX / 2;
    for (let x = b.minX - margin + offset; x <= b.maxX + margin; x += stepX) {
      pushCell(regularPolygon(x, y, r, sides, sides === 6 ? Math.PI / 6 : -Math.PI / 2), r);
    }
  }
  return cells;
}

function cellIsUniform(poly, targetEdge) {
  if (!targetEdge || targetEdge <= 0) return true;
  const edges = poly.map((p, i) => dist(p, poly[(i + 1) % poly.length]));
  const maxE = Math.max(...edges), minE = Math.min(...edges);
  return maxE <= targetEdge * 2.05 && minE >= targetEdge * 0.28 && polyAbsArea(poly) <= targetEdge * targetEdge * 2.6;
}

function validPatternCell(poly, outer, gap, targetEdge = 0) {
  if (poly.length < 3) return false;
  const a = polyAbsArea(poly);
  if (a < Math.max(6, gap * gap * 1.8)) return false;
  if (minEdge(poly) < Math.max(2.2, gap * 0.9)) return false;
  if (!cellIsUniform(poly, targetEdge)) return false;
  const c = centroid(poly);
  if (!inside(c, outer)) return false;
  if (!polygonInside(poly, outer)) return false;
  return true;
}

function evenInteriorPoints(poly, n, rng) {
  const b = bbox(poly);
  const a = Math.max(1, polyAbsArea(poly));
  const spacing = Math.sqrt(a / Math.max(1, n)) * 0.95;
  const out = [];
  const rowH = spacing * Math.sqrt(3) / 2;
  let row = 0;
  for (let y = b.minY; y <= b.maxY; y += rowH, row++) {
    const offset = (row % 2) * spacing / 2;
    for (let x = b.minX + offset; x <= b.maxX; x += spacing) {
      const p = { x: x + (rng() - 0.5) * spacing * 0.25, y: y + (rng() - 0.5) * rowH * 0.25 };
      if (inside(p, poly)) out.push(p);
    }
  }
  // Если фигура узкая и сетка дала мало точек, аккуратно досыпаем кандидаты, но всё равно держим минимальную дистанцию.
  let guard = 0;
  while (out.length < n && guard++ < n * 800) {
    const p = { x: b.minX + rng() * (b.maxX - b.minX), y: b.minY + rng() * (b.maxY - b.minY) };
    if (!inside(p, poly)) continue;
    const nearestD = out.reduce((m, q) => Math.min(m, dist(p, q)), Infinity);
    if (nearestD > spacing * 0.55 || guard > n * 500) out.push(p);
  }
  return out.slice(0, Math.max(0, n));
}

function circum(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return { x: 0, y: 0, r: Infinity };
  const ux = ((a.x*a.x+a.y*a.y)*(b.y-c.y)+(b.x*b.x+b.y*b.y)*(c.y-a.y)+(c.x*c.x+c.y*c.y)*(a.y-b.y))/d;
  const uy = ((a.x*a.x+a.y*a.y)*(c.x-b.x)+(b.x*b.x+b.y*b.y)*(a.x-c.x)+(c.x*c.x+c.y*c.y)*(b.x-a.x))/d;
  return { x: ux, y: uy, r: Math.hypot(ux - a.x, uy - a.y) };
}

function delaunay(points) {
  const b = bbox(points), d = Math.max(b.maxX - b.minX, b.maxY - b.minY) * 12;
  const st = [{ x: b.minX - d, y: b.minY - d }, { x: b.minX + d * 2, y: b.minY - d }, { x: b.minX + d / 2, y: b.maxY + d * 2 }];
  const pts = points.concat(st); let tris = [[points.length, points.length + 1, points.length + 2]];
  points.forEach((p, pi) => {
    const bad = [], edgeCount = new Map();
    tris.forEach((t, ti) => { const cc = circum(pts[t[0]], pts[t[1]], pts[t[2]]); if (Math.hypot(p.x - cc.x, p.y - cc.y) <= cc.r) bad.push(ti); });
    const kept = [];
    tris.forEach((t, ti) => {
      if (!bad.includes(ti)) return kept.push(t);
      [[t[0],t[1]],[t[1],t[2]],[t[2],t[0]]].forEach(e => { const key = e.slice().sort((a,b)=>a-b).join(','); edgeCount.set(key, (edgeCount.get(key) || 0) + 1); });
    });
    tris = kept;
    edgeCount.forEach((count, key) => { if (count === 1) tris.push(key.split(',').map(Number).concat(pi)); });
  });
  return tris.filter(t => t.every(i => i < points.length));
}

function shrink(poly, amount) {
  const c = centroid(poly);
  return poly.map(p => { const v = { x: p.x - c.x, y: p.y - c.y }; const l = Math.hypot(v.x, v.y) || 1; return { x: p.x - v.x / l * amount, y: p.y - v.y / l * amount }; });
}

function voronoiCells(points, tris, bounds) {
  const byPoint = new Map();
  tris.forEach(t => { const cc = circum(points[t[0]], points[t[1]], points[t[2]]); if (!Number.isFinite(cc.r)) return; t.forEach(i => { if (!byPoint.has(i)) byPoint.set(i, []); byPoint.get(i).push({ x: cc.x, y: cc.y }); }); });
  const cells = [];
  byPoint.forEach((arr, i) => {
    const p = points[i];
    const sorted = arr.filter(q => q.x >= bounds.minX && q.x <= bounds.maxX && q.y >= bounds.minY && q.y <= bounds.maxY).sort((a,b)=>Math.atan2(a.y-p.y,a.x-p.x)-Math.atan2(b.y-p.y,b.x-p.x));
    if (sorted.length >= 3) cells.push(sorted);
  });
  return cells;
}

function insetPolygonApprox(poly, amount) {
  if (!amount || amount <= 0) return poly;
  // Быстрое равномерное смещение внутрь для безопасной рамки. Не меняет исходный SVG, только область заливки узором.
  return shrink(poly, amount);
}

function applyAutoParams(options, closedContours) {
  const all = closedContours.flatMap(c => c.points);
  const b = bbox(all);
  const width = Math.max(1, b.maxX - b.minX);
  const height = Math.max(1, b.maxY - b.minY);
  const totalArea = closedContours.reduce((s, c) => s + Math.abs(area(c.points)), 0) || (width * height);
  const complexity = closedContours.reduce((s, c) => s + perimeter(c.points), 0) / Math.max(1, Math.sqrt(totalArea));
  const shapeFactor = { triangle: 1.25, square: 1.0, pentagon: 0.82, hexagon: 0.9 }[options.patternShape] || 1;
  const targetCellArea = Math.max(18, Math.min(totalArea / 45, (width * height) / 120));
  options.numExtraPoints = Math.max(40, Math.min(420, Math.round((totalArea / targetCellArea) * shapeFactor)));
  options.safeBorder = Math.max(0.15, Math.min(2.2, Math.sqrt(totalArea) * 0.009 + complexity * 0.018));
  options.outlineSize = Math.max(1, Math.min(4, Math.sqrt(targetCellArea) * 0.18));
}

function syncInputsFromOptions(options) {
  $('numExtraPoints').value = Math.round(options.numExtraPoints);
  $('safeBorder').value = rnd(options.safeBorder);
  $('outlineSize').value = rnd(options.outlineSize);
}

function inwardStepLine(poly, center, step) {
  return poly.map((p) => {
    const dx = center.x - p.x, dy = center.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const move = Math.min(step, len * 0.92);
    return { x: p.x + dx / len * move, y: p.y + dy / len * move };
  });
}

function generateClosedStraightLines(regionContours, lineCount, safe) {
  // Режим замкнутых линий: количество задаётся полем «Количество линий».
  // 1 = одна линия по контуру; 3 = контур + две вложенные линии и т.д.
  const lines = [];
  const count = Math.max(1, Math.round(Number(lineCount) || 1));
  const border = Math.max(0, Number(safe) || 0);

  for (const contour of regionContours) {
    const base = (contour.points || contour).map(p => ({ x: p.x, y: p.y }));
    if (base.length < 3 || Math.abs(area(base)) < 0.5) continue;

    const c = centroid(base);
    const radii = base.map(p => Math.hypot(p.x - c.x, p.y - c.y));
    const maxR = Math.max(...radii, 1);
    const positive = radii.filter(v => v > 0.001);
    const minR = Math.max(0.8, positive.length ? Math.min(...positive) : maxR);
    const usableR = Math.max(1, maxR - border);
    const step = count === 1 ? 0 : usableR / count;

    for (let i = 0; i < count; i++) {
      const offset = border + i * step;
      const k = Math.max(0.02, 1 - offset / maxR);
      if (k * minR < 0.35) break;
      const poly = scaleAround(base, c, k).filter((p, idx, arr) => idx === 0 || dist(p, arr[idx - 1]) > 0.05);
      if (poly.length < 3 || Math.abs(area(poly)) < 0.25) break;
      lines.push(poly);
    }
  }
  return lines;
}

function build() {
  const o = getOptions();
  if (!state.svgText) throw new Error('Сначала выберите SVG-файл.');

  let contours = scaleContours(parseSvg(state.svgText, o.curveSamples));
  contours = contours.filter(c => c.points.length > (c.closed ? 2 : 1));
  const closedContours = contours.filter(c => c.closed && Math.abs(area(c.points)) > 0.5);
  if (!closedContours.length) throw new Error('Не удалось построить замкнутые области SVG для заливки узором. Открытые линии показаны как контур.');

  const totalPerimeter = closedContours.reduce((s, c) => s + perimeter(c.points), 0) || 1;
  const totalArea = closedContours.reduce((s, c) => s + Math.abs(area(c.points)), 0) || 1;
  if (o.autoParams) {
    applyAutoParams(o, closedContours);
    syncInputsFromOptions(o);
  }
  const rng = makeRng(hashString(state.svgText) ^ (Math.round(o.safeBorder * 1000) * 2654435761) ^ (Math.round(o.numExtraPoints) * 2246822519));
  const safe = o.safeBorder, gap = o.outlineSize;
  const cells = [];
  const outlines = [];

  contours.forEach(c => outlines.push(c));

  if (!o.hideGrid) {
    const region = closedContours.map(c => ({ ...c, points: c.points }));
    if ((o.fillMode || 'grid') === 'contours') {
      cells.push(...generateClosedStraightLines(region, gap, 0));
    } else {
      cells.push(...patternGridCellsInRegion(region, Math.max(4, Math.round(o.numExtraPoints)), gap, o));
    }
  }

  const vb = bbox(outlines.flatMap(c => c.points)); const width = vb.maxX - vb.minX + 80, height = vb.maxY - vb.minY + 80;
  const join = 'miter';
  let svg = `<svg xmlns="${NS}" viewBox="0 0 ${rnd(width)} ${rnd(height)}" width="${rnd(width)}" height="${rnd(height)}">`;
  svg += `<rect width="100%" height="100%" fill="white"/>`;
  if ((o.edgeMode || 'shrink') === 'clip' || (o.fillMode || 'grid') === 'contours') {
    const clipId = `regionClip`;
    svg += `<defs><clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">`;
    svg += `<path fill="black" clip-rule="evenodd" fill-rule="evenodd" d="${closedContours.map(c => pathD(c.points, true)).join(' ')}"/>`;
    svg += `</clipPath></defs>`;
    svg += `<g fill="none" stroke="black" stroke-width="1" stroke-linejoin="${join}" stroke-linecap="round">`;
    for (const outer of outlines) svg += `<path d="${pathD(outer.points, outer.closed)}"/>`;
    svg += `</g>`;
    svg += `<g clip-path="url(#${clipId})" fill="none" stroke="black" stroke-width="1" stroke-linejoin="${join}" stroke-linecap="round">`;
    for (const cell of cells) svg += `<path d="${pathD((o.fillMode || 'grid') === 'contours' ? cell : shrink(cell, gap))}"/>`;
    svg += `</g>`;
  } else {
    svg += `<g fill="none" stroke="black" stroke-width="1" stroke-linejoin="${join}" stroke-linecap="round">`;
    for (const outer of outlines) svg += `<path d="${pathD(outer.points, outer.closed)}"/>`;
    for (const cell of cells) svg += `<path d="${pathD(cell)}"/>`;
    svg += `</g>`;
  }
  svg += `</svg>`;
  return { svg, count: cells.length };
}

function nearest(p, poly) {
  let best = poly[0], bestD = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], vx = b.x - a.x, vy = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x-a.x)*vx + (p.y-a.y)*vy) / (vx*vx + vy*vy || 1)));
    const q = { x: a.x + vx * t, y: a.y + vy * t }, dd = dist(p, q);
    if (dd < bestD) { bestD = dd; best = q; }
  }
  return best;
}

function parsePercentValue(value) {
  const raw = String(value ?? '').replace(',', '.').replace('%', '').trim();
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return 100;
  return Math.max(1, Math.min(400, Math.round(n)));
}

function setPreviewScaleValue(value, source = 'slider') {
  const v = parsePercentValue(value);
  $('previewScale').value = v;
  if ($('previewScaleNumber')) $('previewScaleNumber').value = `${v}%`;
  updatePreviewScale();
}

function updatePreviewScale() {
  const scale = parsePercentValue($('previewScale').value) / 100;
  const inner = $('previewInner');
  const canvas = $('canvas');
  const svg = inner.querySelector('svg');
  if (!svg) return;

  const vb = svg.viewBox && svg.viewBox.baseVal;
  const baseW = (vb && vb.width) || parseFloat(svg.getAttribute('width')) || 300;
  const baseH = (vb && vb.height) || parseFloat(svg.getAttribute('height')) || 300;
  const scaledW = baseW * scale;
  const scaledH = baseH * scale;
  const minW = Math.max(canvas.clientWidth - 56, scaledW);
  const minH = Math.max(canvas.clientHeight - 56, scaledH);

  svg.style.width = `${scaledW}px`;
  svg.style.height = `${scaledH}px`;
  inner.style.width = `${minW}px`;
  inner.style.minWidth = `${minW}px`;
  inner.style.height = `${minH}px`;
  inner.style.minHeight = `${minH}px`;

  requestAnimationFrame(() => {
    canvas.scrollLeft = Math.max(0, (canvas.scrollWidth - canvas.clientWidth) / 2);
    canvas.scrollTop = Math.max(0, (canvas.scrollHeight - canvas.clientHeight) / 2);
  });
}
function renderNow(source = 'manual') {
  try {
    const id = ++state.buildId;
    const { svg, count } = build();
    if (id !== state.buildId) return;
    state.result = svg;
    $('previewInner').innerHTML = svg;
    updatePreviewScale();
    setDownloadButtonsDisabled(false);
    $('status').textContent = 'Предпросмотр обновлён';
  } catch (err) {
    if (source !== 'auto' || state.svgText) $('status').textContent = err.message;
    console.error(err);
  }
}

function scheduleRender() {
  if (!state.svgText) return;
  clearTimeout(state.autoTimer);
  $('status').textContent = 'Обновляю предпросмотр…';
  state.autoTimer = setTimeout(() => {
    if ('requestIdleCallback' in window) requestIdleCallback(() => renderNow('auto'), { timeout: 600 });
    else renderNow('auto');
  }, 220);
}

$('file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  state.svgText = await f.text();
  $('autoParams').checked = true;
  updateControlsForFillMode();
  $('status').textContent = `Загружено: ${f.name}. Предпросмотр строится автоматически.`;
  scheduleRender();
});

CONTROL_IDS.forEach((id) => {
  const el = $(id);
  const onControlChange = () => {
    if (id === 'fillMode') updateControlsForFillMode();
    if (id !== 'autoParams' && $('autoParams')?.checked) $('autoParams').checked = false;
    scheduleRender();
  };
  el.addEventListener('input', onControlChange);
  el.addEventListener('change', onControlChange);
});

$('generate').addEventListener('click', () => renderNow('manual'));

function setDownloadButtonsDisabled(disabled) {
  const el = $('downloadSvg');
  if (el) el.disabled = disabled;
}

function updateControlsForFillMode() {
  const isContours = ($('fillMode')?.value || 'grid') === 'contours';
  const disabledInContours = ['numExtraPoints', 'safeBorder', 'patternShape', 'edgeMode'];
  disabledInContours.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.disabled = isContours;
    const label = el.closest('label');
    if (label) label.classList.toggle('control-disabled', isContours);
  });

  // The fill type and line-count controls remain active, so make sure they look active.
  ['fillMode', 'outlineSize'].forEach((id) => {
    const el = $(id);
    const label = el?.closest('label');
    if (label) label.classList.remove('control-disabled');
  });

  const outlineLabel = $('outlineSizeLabel');
  if (outlineLabel && outlineLabel.firstChild) {
    outlineLabel.firstChild.nodeValue = isContours ? 'Количество линий' : 'Размер фигуры';
  }

  const outlineInput = $('outlineSize');
  if (outlineInput) {
    outlineInput.step = isContours ? '1' : '0.1';
    outlineInput.min = isContours ? '1' : '0.1';
    if (isContours) outlineInput.value = Math.max(1, Math.round(Number(outlineInput.value) || 1));
  }

  const hideLabel = $('hideGridLabel');
  if (hideLabel && hideLabel.childNodes.length > 1) {
    hideLabel.childNodes[1].nodeValue = ' Скрыть заполнение';
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 250);
}

function normalizedSvgText() {
  if (!state.result) return '';
  const doc = new DOMParser().parseFromString(state.result, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.tagName.toLowerCase() !== 'svg') return state.result;
  svg.setAttribute('xmlns', NS);
  svg.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  return new XMLSerializer().serializeToString(svg);
}

function downloadSvgFile() {
  const svgText = normalizedSvgText();
  if (!svgText) return;
  saveBlob(new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }), 'plottrbottr-ru.svg');
}

async function downloadRasterFile(format) {
  const svgText = normalizedSvgText();
  if (!svgText) return;
  const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  const svgDoc = new DOMParser().parseFromString(svgText, 'image/svg+xml').documentElement;
  const vb = svgDoc.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
  const width = Math.max(1, Math.ceil((vb && vb[2]) || parseFloat(svgDoc.getAttribute('width')) || 1000));
  const height = Math.max(1, Math.ceil((vb && vb[3]) || parseFloat(svgDoc.getAttribute('height')) || 1000));

  const img = new Image();
  const encoded = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('Не удалось подготовить изображение для экспорта'));
      img.src = encoded;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, format === 'jpeg' ? 0.95 : undefined));
    if (!blob) throw new Error('Не удалось создать файл');
    saveBlob(blob, `plottrbottr-ru.${ext}`);
  } catch (err) {
    $('status').textContent = err.message;
    console.error(err);
  }
}

$('downloadSvg')?.addEventListener('click', downloadSvgFile);
updateControlsForFillMode();

$('previewScale').addEventListener('input', (e) => setPreviewScaleValue(e.target.value, 'slider'));
$('previewScaleNumber')?.addEventListener('change', (e) => setPreviewScaleValue(e.target.value, 'number'));
$('previewScaleNumber')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') setPreviewScaleValue(e.target.value, 'number'); });
$('darkTheme')?.addEventListener('change', (e) => document.body.classList.toggle('dark', e.target.checked));
setPreviewScaleValue($('previewScale').value);
