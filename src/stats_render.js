'use strict';

/**
 * Render /stats as a dark Discord-like PNG. Fresh every call (no cache).
 * A process-wide lock serializes renders so two canvases cannot OOM the 256 MB machine.
 */

const fs = require('fs');
const path = require('path');
const { computeStats, frNum, fmtParis, usersDirFrom, defaultSelfId } = require('./stats_compute');

const W = 1600;
const BG = '#111214';
const CARD = '#2B2D31';
const BORDER = '#3F4147';
const TEXT = '#F2F3F5';
const MUTED = '#B5BAC1';
const DIM = '#80848E';
const BLURPLE = '#5865F2';
const HUMAN = '#5865F2';
const BOT = '#F0B232';
const AZURE = '#00B0F4';
const GOLD = '#FEE75C';
const GREEN = '#23A559';
const PINK = '#EB459E';
const RED = '#ED4245';
const CYAN = '#00B0F4';

const TRIGGER_COLORS = {
  mention: BLURPLE,
  name: GREEN,
  follow: GOLD,
  keyword: PINK,
  dm: CYAN,
  reply: RED,
  reply_to_bot: RED,
  slash_fiche: '#9B59B6',
  daily_roast: '#E67E22',
};

const LOCK_TIMEOUT_MS = 20_000;
let renderChain = Promise.resolve();

function fontsDir() {
  const candidates = [
    path.join(__dirname, 'fonts'),
    path.join(__dirname, '..', 'fonts'),
  ];
  return candidates.find((d) => fs.existsSync(d)) || candidates[0];
}

function fontFiles() {
  const dir = fontsDir();
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.ttf')); } catch { /* none */ }
  return names.map((f) => path.join(dir, f));
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function rounded(x, y, w, h, r, fill, extra = '') {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${fill}"${extra}/>`;
}

function card(x, y, w, h) {
  return `${rounded(x, y, w, h, 16, CARD)}<rect x="${x + 0.5}" y="${y + 0.5}" width="${w - 1}" height="${h - 1}" rx="16" ry="16" fill="none" stroke="${BORDER}" stroke-width="1"/>`;
}

function text(x, y, s, { size = 16, weight = 400, family = 'Noto Sans', color = TEXT, anchor = 'start', extra = '' } = {}) {
  return `<text x="${x}" y="${y}" fill="${color}" font-family="${family}" font-size="${size}" font-weight="${weight}" text-anchor="${anchor}"${extra}>${esc(s)}</text>`;
}

function pill(x, y, label) {
  const w = 36;
  const h = 16;
  return `${rounded(x, y - h / 2, w, h, 4, BOT)}${text(x + w / 2, y + 5, label, { size: 10, weight: 700, family: 'Noto Sans', color: '#1C180A', anchor: 'middle' })}`;
}

function barh({ x, y, w, h, rows, getValue, getLabel, isBot, colorFor, maxPad = 1.22 }) {
  const n = rows.length || 1;
  const rowH = h / n;
  const maxV = Math.max(1, ...rows.map(getValue));
  const maxX = maxV * maxPad;
  const labelW = 210;
  const padR = 52;
  const barX = x + labelW;
  const barW = Math.max(40, w - labelW - padR);
  let out = '';
  // guides
  for (let g = 1; g <= 4; g++) {
    const gx = barX + (barW * g) / 5;
    out += `<line x1="${gx}" y1="${y + 4}" x2="${gx}" y2="${y + h - 4}" stroke="${BORDER}" stroke-width="1"/>`;
  }
  rows.forEach((row, i) => {
    const cy = y + (i + 0.5) * rowH;
    const val = getValue(row);
    const bw = (val / maxX) * barW;
    const bot = isBot ? isBot(row) : false;
    const fill = colorFor ? colorFor(row, bot) : (bot ? BOT : HUMAN);
    const bh = Math.min(28, rowH * 0.62);
    out += rounded(barX, cy - bh / 2, Math.max(2, bw), bh, 4, fill);
    const label = getLabel(row);
    if (bot) {
      const approxW = Math.min(labelW - 60, String(label).length * 9);
      out += pill(x + labelW - 10 - approxW - 44, cy, 'BOT');
      out += text(x + labelW - 10, cy + 5, label, { size: 16, weight: 500, anchor: 'end' });
    } else {
      out += text(x + labelW - 10, cy + 5, label, { size: 16, weight: 500, anchor: 'end' });
    }
    const inside = bw > 48 && bot;
    if (inside) {
      out += text(barX + bw - 8, cy + 5, String(val), { size: 14, weight: 700, color: '#1E1F22', anchor: 'end' });
    } else {
      out += text(barX + bw + 8, cy + 5, String(val), { size: 14, weight: 600, anchor: 'start' });
    }
  });
  return out;
}

function donut(cx, cy, r, inner, slices) {
  const total = slices.reduce((s, x) => s + x.count, 0) || 1;
  let angle = -Math.PI / 2;
  let out = '';
  const pt = (a, rad) => [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad];
  for (const sl of slices) {
    const da = (sl.count / total) * Math.PI * 2;
    const a1 = angle;
    const a2 = angle + da;
    const large = da > Math.PI ? 1 : 0;
    const [x1, y1] = pt(a1, r);
    const [x2, y2] = pt(a2, r);
    const [x3, y3] = pt(a2, inner);
    const [x4, y4] = pt(a1, inner);
    // For a full circle (single slice) path-arc fails; use a circle instead.
    if (Math.abs(da - Math.PI * 2) < 1e-6) {
      out += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${sl.color}"/>`;
      out += `<circle cx="${cx}" cy="${cy}" r="${inner}" fill="${CARD}"/>`;
    } else if (da > 0.002) {
      out += `<path d="M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} L ${x3.toFixed(2)} ${y3.toFixed(2)} A ${inner} ${inner} 0 ${large} 0 ${x4.toFixed(2)} ${y4.toFixed(2)} Z" fill="${sl.color}"/>`;
    }
    angle = a2;
  }
  return out;
}

function buildSvg(stats) {
  const pad = 40;
  const gap = 20;
  const headerH = 118;
  const kpiH = 168;
  const fullDoc = stats.fullCount && Number.isFinite(Number(stats.fullCount.total)) ? stats.fullCount : null;
  const fullH = fullDoc ? 132 : 0;
  const row1H = 620;
  const row2H = 460;
  const row3H = 480;
  const factsH = 230;
  const lifeH = stats.lifetime && (stats.lifetime.startedAt || stats.lifetime.images || stats.lifetime.videos || stats.lifetime.stats || Object.keys(stats.lifetime.triggers || {}).length)
    ? 150
    : 0;
  const footH = 70;

  let y = 32;
  const headerY = y;
  y += headerH + 8;
  const fullY = fullH ? y : 0;
  if (fullH) y += fullH + gap;
  const kpiY = y;
  y += kpiH + gap;
  const row1Y = y;
  y += row1H + gap;
  const row2Y = y;
  y += row2H + gap;
  const row3Y = y;
  y += row3H + gap;
  const factsY = y;
  y += factsH + (lifeH ? gap : 16);
  const lifeY = lifeH ? y : 0;
  if (lifeH) y += lifeH + 16;
  const footY = y;
  const H = footY + footH;

  const innerW = W - 2 * pad;
  const colW = Math.floor((innerW - gap) / 2);
  const kpiGap = 16;
  const kpiW = Math.floor((innerW - 3 * kpiGap) / 4);

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="${BG}"/>`;

  // header
  s += rounded(pad, headerY + 18, 8, 72, 4, BLURPLE);
  s += text(pad + 28, headerY + 58, 'cûm slayer', { size: 54, weight: 700, family: 'Outfit' });
  const badgeX = pad + 28 + 290;
  s += rounded(badgeX, headerY + 28, 78, 28, 8, BLURPLE);
  s += text(badgeX + 39, headerY + 48, 'STATS', { size: 16, weight: 600, family: 'Outfit', anchor: 'middle' });
  const oldestShort = stats.oldestLabel ? stats.oldestLabel.replace(/\s\d{2}:\d{2}$/, '') : '';
  const newestShort = stats.newestLabel || '';
  s += text(pad + 28, headerY + 96,
    `Ce que le bot a stocké  ·  Le Royaume  ·  ${oldestShort} — ${newestShort}  ·  Europe/Paris`,
    { size: 20, weight: 500, color: MUTED });

  // Full guild history (when a scan result is on disk)
  if (fullDoc) {
    s += card(pad, fullY, innerW, fullH);
    s += rounded(pad + 20, fullY + 16, 36, 6, 3, GOLD);
    const big = String(frNum(fullDoc.total));
    const bigSize = big.length >= 8 ? 42 : 52;
    s += text(pad + 28, fullY + 72, big, { size: bigSize, weight: 700, family: 'Outfit', color: GOLD });
    s += text(pad + 28, fullY + 104, 'Total du serveur (historique complet)', { size: 18, weight: 600 });
    const scanShort = fullDoc.scannedAtShort || (fullDoc.scannedAtLabel || '').replace(/\s\d{2}:\d{2}.*$/, '') || '';
    const midX = pad + 520;
    const hb = `${frNum(fullDoc.humans || 0)} humains  ·  ${frNum(fullDoc.bots || 0)} bots`;
    s += text(midX, fullY + 52, 'Scan complet du serveur', { size: 16, weight: 600, family: 'Outfit' });
    if (scanShort) s += text(midX, fullY + 78, `scan du ${scanShort}`, { size: 15, weight: 500, color: MUTED });
    s += text(midX, fullY + 104, hb, { size: 15, weight: 500, color: MUTED });
    if (fullDoc.oldestLabel) {
      const first = String(fullDoc.oldestLabel).replace(/\sEurope\/Paris$/, '');
      s += text(pad + innerW - 24, fullY + 78, `1er message :  ${first}`, { size: 14, weight: 500, color: DIM, anchor: 'end' });
    }
  }

  // KPIs
  const readN = Number(stats.messagesRead);
  const hasRead = Number.isFinite(readN) && (readN > 0 || stats.messagesReadSeededAt);
  const kpis = [
    hasRead
      ? null
      : [frNum(stats.messages), 'Messages stockés', stats.oldestLabel && stats.newestLabel ? `${oldestShort} → ${newestShort.replace(/\s\d{2}:\d{2}$/, '')}` : ''],
    [frNum(stats.users), 'Membres avec un log', `${stats.humanUsers} humains  ·  ${stats.botUsers} bots`],
    [frNum(stats.triggers.recorded), 'Déclenchements', stats.triggers.oldestLabel ? `depuis le ${stats.triggers.oldestLabel}` : 'fenêtre récente (max 300)'],
    [frNum(stats.attachments.units), 'Pièces jointes', `dans ${frNum(stats.attachments.messages)} messages`],
  ];
  kpis.forEach((k, i) => {
    const x = pad + i * (kpiW + kpiGap);
    s += card(x, kpiY, kpiW, kpiH);
    s += rounded(x + 20, kpiY + 14, 32, 6, 3, BLURPLE);
    if (i === 0 && hasRead) {
      const big = String(frNum(Math.max(readN, stats.messages || 0)));
      const bigSize = big.length >= 7 ? 38 : 44;
      s += text(x + 20, kpiY + 64, big, { size: bigSize, weight: 700, family: 'Outfit' });
      s += text(x + 20, kpiY + 90, 'Messages lus depuis toujours', { size: 13, weight: 600 });
      s += text(x + 20, kpiY + 116, `stockés :  ${frNum(stats.messages)}`, { size: 15, weight: 500, color: MUTED });
      const since = stats.messagesReadSeedLabel ? `depuis le ${stats.messagesReadSeedLabel}` : '';
      if (since) s += text(x + 20, kpiY + 140, since, { size: 13, weight: 400, color: DIM });
      return;
    }
    s += text(x + 20, kpiY + 72, k[0], { size: 46, weight: 700, family: 'Outfit' });
    s += text(x + 20, kpiY + 104, k[1], { size: 16, weight: 600 });
    s += text(x + 20, kpiY + 128, k[2], { size: 14, weight: 400, color: DIM });
  });

  // Top talkers
  const tX = pad;
  const tY = row1Y;
  s += card(tX, tY, colW, row1H);
  s += text(tX + 22, tY + 36, 'Top 10 bavards', { size: 22, weight: 600, family: 'Outfit' });
  s += `<circle cx="${tX + colW - 168}" cy="${tY + 30}" r="6" fill="${HUMAN}"/>`;
  s += text(tX + colW - 156, tY + 35, 'humain', { size: 14, weight: 600, color: MUTED });
  s += `<circle cx="${tX + colW - 80}" cy="${tY + 30}" r="6" fill="${BOT}"/>`;
  s += text(tX + colW - 68, tY + 35, 'bot', { size: 14, weight: 600, color: MUTED });
  s += barh({
    x: tX + 8,
    y: tY + 56,
    w: colW - 16,
    h: row1H - 72,
    rows: stats.topTalkers,
    getValue: (r) => r.count,
    getLabel: (r) => r.name,
    isBot: (r) => r.bot,
  });

  // Top channels
  const cX = pad + colW + gap;
  s += card(cX, tY, colW, row1H);
  s += text(cX + 22, tY + 36, 'Top 10 salons', { size: 22, weight: 600, family: 'Outfit' });
  s += barh({
    x: cX + 8,
    y: tY + 56,
    w: colW - 16,
    h: row1H - 72,
    rows: stats.topChannels,
    getValue: (r) => r.count,
    getLabel: (r) => r.name,
    isBot: () => false,
    colorFor: () => AZURE,
  });

  // Hours
  const hX = pad;
  const hY = row2Y;
  s += card(hX, hY, colW, row2H);
  s += text(hX + 22, hY + 36, 'Messages par heure', { size: 22, weight: 600, family: 'Outfit' });
  s += text(hX + 22, hY + 58, 'Europe/Paris  ·  sur l’historique stocké', { size: 13, weight: 400, color: DIM });
  {
    const plotX = hX + 56;
    const plotY = hY + 88;
    const plotW = colW - 76;
    const plotH = row2H - 140;
    const maxH = Math.max(1, ...stats.hours, 1);
    const yMax = Math.max(580, Math.ceil(maxH / 100) * 100 + 80);
    for (const tick of [0, 200, 400]) {
      if (tick > yMax) continue;
      const yy = plotY + plotH - (tick / yMax) * plotH;
      s += `<line x1="${plotX}" y1="${yy}" x2="${plotX + plotW}" y2="${yy}" stroke="${BORDER}" stroke-width="1"/>`;
      s += text(plotX - 8, yy + 4, String(tick), { size: 12, weight: 400, color: DIM, anchor: 'end' });
    }
    const bw = plotW / 24 * 0.78;
    const gapB = plotW / 24;
    stats.hours.forEach((n, hour) => {
      const bh = (n / yMax) * plotH;
      const bx = plotX + hour * gapB + (gapB - bw) / 2;
      const by = plotY + plotH - bh;
      const fill = hour === stats.peakHour ? GOLD : (n >= 400 ? '#8EA1FF' : HUMAN);
      s += rounded(bx, by, bw, Math.max(1, bh), 3, fill);
      if (hour === stats.peakHour) {
        s += text(bx + bw / 2, by - 8, `pic  ${n}`, { size: 12, weight: 700, color: GOLD, anchor: 'middle' });
      }
    });
    for (const hour of [0, 4, 8, 12, 16, 20, 23]) {
      const bx = plotX + hour * gapB + gapB / 2;
      s += text(bx, plotY + plotH + 22, `${hour} h`, { size: 12, weight: 500, color: MUTED, anchor: 'middle' });
    }
  }

  // Last 7 days
  const dX = pad + colW + gap;
  s += card(dX, hY, colW, row2H);
  s += text(dX + 22, hY + 36, '7 derniers jours', { size: 22, weight: 600, family: 'Outfit' });
  const lastHint = stats.last7.some((d) => d.ongoing)
    ? `${frNum(stats.last7Total)} messages  ·  dernier jour en cours jusqu’à l’instant du calcul`
    : `${frNum(stats.last7Total)} messages`;
  s += text(dX + 22, hY + 58, lastHint, { size: 13, weight: 400, color: DIM });
  {
    const plotX = dX + 70;
    const plotY = hY + 88;
    const plotW = colW - 90;
    const plotH = row2H - 150;
    const maxD = Math.max(1, ...stats.last7.map((d) => d.count));
    const yMax = Math.max(1000, Math.ceil(maxD / 250) * 250 + 80);
    const ticks = [0, 250, 500, 750, 1000].filter((t) => t <= yMax);
    for (const tick of ticks) {
      const yy = plotY + plotH - (tick / yMax) * plotH;
      s += `<line x1="${plotX}" y1="${yy}" x2="${plotX + plotW}" y2="${yy}" stroke="${BORDER}" stroke-width="1"/>`;
      const lab = tick >= 1000 ? tick.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : String(tick);
      s += text(plotX - 8, yy + 4, lab, { size: 12, weight: 400, color: DIM, anchor: 'end' });
    }
    const gapB = plotW / 7;
    const bw = gapB * 0.68;
    stats.last7.forEach((d, i) => {
      const bh = (d.count / yMax) * plotH;
      const bx = plotX + i * gapB + (gapB - bw) / 2;
      const by = plotY + plotH - bh;
      const fill = d.count >= 700 ? GOLD : HUMAN;
      s += rounded(bx, by, bw, Math.max(1, bh), 4, fill);
      s += text(bx + bw / 2, by - 8, String(d.count), { size: 13, weight: 600, anchor: 'middle' });
      s += text(bx + bw / 2, plotY + plotH + 22, d.label, { size: 12, weight: 500, color: MUTED, anchor: 'middle' });
    });
  }

  // Triggers donut
  const trX = pad;
  const trY = row3Y;
  s += card(trX, trY, colW, row3H);
  s += text(trX + 22, trY + 36, 'Déclenchements', { size: 22, weight: 600, family: 'Outfit' });
  s += text(trX + 22, trY + 58, stats.triggers.oldestLabel ? `depuis le ${stats.triggers.oldestLabel}  ·  fenêtre récente (max 300)` : 'fenêtre récente (max 300)', { size: 13, weight: 400, color: DIM });
  {
    const slices = (stats.triggers.list.length ? stats.triggers.list : [{ type: 'aucun', count: 1 }]).map((t) => ({
      ...t,
      color: TRIGGER_COLORS[t.type] || '#888',
    }));
    const cx = trX + 200;
    const cy = trY + 260;
    if (stats.triggers.recorded) {
      s += donut(cx, cy, 118, 70, slices);
    } else {
      s += `<circle cx="${cx}" cy="${cy}" r="118" fill="none" stroke="${BORDER}" stroke-width="28"/>`;
    }
    s += text(cx, cy + 4, frNum(stats.triggers.recorded), { size: 28, weight: 700, family: 'Outfit', anchor: 'middle' });
    s += text(cx, cy + 28, 'au total', { size: 13, weight: 400, color: DIM, anchor: 'middle' });
    const lx = trX + 360;
    const totalT = stats.triggers.recorded || 1;
    slices.forEach((sl, i) => {
      if (!stats.triggers.recorded) return;
      const ly = trY + 100 + i * 52;
      const pct = Math.round((sl.count / totalT) * 100);
      s += `<circle cx="${lx + 8}" cy="${ly}" r="7" fill="${sl.color}"/>`;
      s += text(lx + 24, ly + 5, sl.type, { size: 15, weight: 500 });
      s += text(lx + 24, ly + 24, `${sl.count}  ·  ${pct} %`, { size: 13, weight: 400, color: MUTED });
    });
  }

  // Replies
  const rX = pad + colW + gap;
  s += card(rX, trY, colW, row3H);
  s += text(rX + 22, trY + 36, 'Qui répond à cûm slayer', { size: 22, weight: 600, family: 'Outfit' });
  s += text(rX + 22, trY + 58, `${frNum(stats.repliesToBot.total)} réponses stockées  ·  champ  ru`, { size: 13, weight: 400, color: DIM });
  s += barh({
    x: rX + 8,
    y: trY + 80,
    w: colW - 16,
    h: row3H - 100,
    rows: stats.repliesToBot.people.slice(0, 8),
    getValue: (r) => r.count,
    getLabel: (r) => r.name,
    isBot: (r) => r.bot,
  });

  // Fun facts
  s += card(pad, factsY, innerW, factsH);
  s += text(pad + 28, factsY + 36, 'Anecdotes', { size: 22, weight: 600, family: 'Outfit' });
  const facts = [
    [frNum(stats.hearts.total), 'cœurs dans le stock', stats.hearts.maxOne && stats.hearts.author
      ? `dont ${frNum(stats.hearts.maxOne)} dans un seul message\nde ${stats.hearts.author}`
      : 'aucun cœur compté dans le stock'],
    [String(stats.length.avgRounded), 'caractères en moyenne', `médiane ${stats.length.median}  ·  plafond de stockage 500`],
    [`${stats.peakHour} h`, 'heure de pointe', `${frNum(stats.peakHourCount)} messages  ·  Europe/Paris`],
  ];
  const fw = Math.floor((innerW - 56 - 48) / 3);
  facts.forEach((f, i) => {
    const fx = pad + 28 + i * (fw + 24);
    if (i) s += `<line x1="${fx - 12}" y1="${factsY + 64}" x2="${fx - 12}" y2="${factsY + 200}" stroke="${BORDER}" stroke-width="1"/>`;
    s += text(fx, factsY + 100, f[0], { size: 44, weight: 700, family: 'Outfit' });
    s += text(fx, factsY + 132, f[1], { size: 16, weight: 600 });
    String(f[2]).split('\n').forEach((line, li) => {
      s += text(fx, factsY + 158 + li * 20, line, { size: 14, weight: 400, color: DIM });
    });
  });

  // Lifetime
  if (lifeH) {
    s += card(pad, lifeY, innerW, lifeH);
    s += text(pad + 28, lifeY + 36, 'Compteurs all-time', { size: 22, weight: 600, family: 'Outfit' });
    const sinceLab = stats.lifetime.startedAt ? `depuis le ${fmtParis(stats.lifetime.startedAt)} Europe/Paris` : 'démarrés avec cette version';
    s += text(pad + 28, lifeY + 58, sinceLab + '  ·  pas un historique complet avant cette date', { size: 13, weight: 400, color: DIM });
    const trigParts = Object.entries(stats.lifetime.triggers || {})
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k} ${frNum(v)}`);
    const trigLine = trigParts.length ? trigParts.join('  ·  ') : 'aucun déclencheur encore compté';
    s += text(pad + 28, lifeY + 92, `Déclencheurs :  ${trigLine}`, { size: 16, weight: 500 });
    const media = `Images :  ${frNum(stats.lifetime.images)}    Vidéos :  ${frNum(stats.lifetime.videos)}`;
    const st = stats.lifetime.stats ? `    ·    /stats :  ${frNum(stats.lifetime.stats)}` : '';
    s += text(pad + 28, lifeY + 122, media + st, { size: 16, weight: 500 });
  }

  s += text(pad, footY + 28,
    `Historique plafonné à ${stats.cap} messages/membre  ·  les totaux sont le stock, pas tout ce qui a jamais été lu  ·  cliché ${stats.generatedLabel}`,
    { size: 15, weight: 400, color: DIM });

  s += '</svg>';
  return { svg: s, width: W, height: H };
}

async function renderPng(stats) {
  const { Resvg } = require('@resvg/resvg-js');
  const { svg, width, height } = buildSvg(stats);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'original' },
    font: {
      fontFiles: fontFiles(),
      loadSystemFonts: false,
      defaultFontFamily: 'Noto Sans',
    },
    background: BG,
  });
  const rendered = resvg.render();
  const buf = Buffer.from(rendered.asPng());
  return { buffer: buf, width, height, bytes: buf.length };
}

function withRenderLock(fn) {
  let release;
  const mine = new Promise((resolve) => { release = resolve; });
  const prev = renderChain;
  renderChain = prev.then(() => mine, () => mine);
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('render lock timeout')), LOCK_TIMEOUT_MS).unref?.();
  });
  return Promise.race([prev, timeout])
    .catch((err) => {
      if (err && err.message === 'render lock timeout') throw err;
      // previous render failed; we still run
    })
    .then(fn)
    .finally(() => release());
}

async function renderFresh(opts = {}) {
  return withRenderLock(async () => {
    const selfId = opts.selfId || defaultSelfId();
    const usersDir = opts.usersDir || usersDirFrom(opts.dataDir);
    let lifetime = opts.lifetime;
    if (lifetime === undefined) {
      const lt = require('./lifetime');
      lt.ensureSeeded(usersDir);
      lifetime = lt.load();
    }
    const stats = computeStats({
      usersDir,
      dataDir: opts.dataDir,
      triggersFile: opts.triggersFile,
      lifetime: lifetime && require('./lifetime').hasData(lifetime) ? lifetime : null,
      fullCount: opts.fullCount,
      fullCountFile: opts.fullCountFile,
      selfId,
      now: opts.now || Date.now(),
    });
    const out = await renderPng(stats);
    return { ...out, stats };
  });
}

async function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outPath = outIdx >= 0 ? args[outIdx + 1] : '';
  const measure = args.includes('--measure');
  const dataIdx = args.indexOf('--data');
  const dataDir = dataIdx >= 0 ? args[dataIdx + 1] : undefined;
  const rss0 = process.memoryUsage.rss();
  const t0 = Date.now();
  let peak = rss0;
  const timer = setInterval(() => {
    const r = process.memoryUsage.rss();
    if (r > peak) peak = r;
  }, 20);
  if (timer.unref) timer.unref();
  const result = await renderFresh({
    dataDir,
    usersDir: dataDir ? path.join(dataDir, 'users') : undefined,
    triggersFile: dataDir ? path.join(dataDir, 'triggers.json') : undefined,
  });
  clearInterval(timer);
  peak = Math.max(peak, process.memoryUsage.rss());
  const ms = Date.now() - t0;
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, result.buffer);
  }
  const line = `stats_render ok bytes=${result.bytes} ${result.width}x${result.height} ms=${ms} rss_peak_mb=${(peak / 1024 / 1024).toFixed(1)} rss_start_mb=${(rss0 / 1024 / 1024).toFixed(1)} messages=${result.stats.messages}`;
  console.log(line);
  if (measure && !outPath) process.exit(0);
}

module.exports = {
  buildSvg,
  renderPng,
  renderFresh,
  withRenderLock,
  fontFiles,
  fontsDir,
  LOCK_TIMEOUT_MS,
};

if (require.main === module) {
  main().catch((err) => {
    console.error(`stats_render failed: ${err.message}`);
    process.exit(1);
  });
}
