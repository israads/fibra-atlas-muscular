import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import './style.css';
import { createViewer, zoneLabel } from './viewer.js';
import { REGIONS } from './muscles.js';
import { GROUPS, SEVERITY } from './groups.js';
import PARTS from './parts.json';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const STORE = 'fibra.v1';
// El enlace compartido lleva las marcas en el fragmento de la URL: l=<leves>_<moderadas>_<severas>.
const enc = (id) => (id.startsWith('FMA') ? (+id.slice(3)).toString(36) : `B${id.slice(2)}`);
const dec = (t) => (t[0] === 'B' ? `BP${t.slice(1)}` : `FMA${parseInt(t, 36)}`);
function readLink() {
  const q = new URLSearchParams(location.hash.slice(1)); if (!q.has('l')) return null;
  const injuries = {}; q.get('l').split('_').slice(0, 3).forEach((g, i) => g.split('.').filter(Boolean).forEach((t) => { injuries[dec(t)] = i + 1; }));
  return { injuries, patient: q.get('p') || '', notes: q.get('n') || '' };
}
const linked = readLink();
const saved = linked || (() => { try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; } })();
const isPhone = () => matchMedia('(max-width: 760px)').matches;

const state = {
  zone: null, isolate: false, onlyInjured: false, skeleton: true,
  hidden: new Set(), injuries: saved.injuries || {}, sel: new Set(), multiMode: false,
  get selected() { return this.sel.size === 1 ? [...this.sel][0] : null; },
  set selected(id) { this.sel = new Set(id ? [id] : []); }, hover: null, hoverZone: null,
  patient: saved.patient || '', notes: saved.notes || '', tab: linked ? 'p' : 'm', lastSev: 2, sheet: 'peek',
};
function linkHash() {
  const b = [[], [], []]; for (const id in state.injuries) b[state.injuries[id] - 1].push(enc(id));
  let h = `l=${b.map((a) => a.join('.')).join('_')}`;
  if (state.patient) h += `&p=${encodeURIComponent(state.patient)}`;
  if (state.notes) h += `&n=${encodeURIComponent(state.notes.slice(0, 800))}`;
  return h;
}
const save = () => {
  const any = Object.keys(state.injuries).length;
  history.replaceState(null, '', any ? `#${linkHash()}` : location.pathname + location.search);
  if (linked) return; // abierto desde un enlace: no pisa lo guardado en este navegador
  try { localStorage.setItem(STORE, JSON.stringify({ injuries: state.injuries, patient: state.patient, notes: state.notes })); } catch { /* sin almacenamiento */ }
};

const zl = (zone) => { const [r, s] = zone.split(':'); return zoneLabel(r, s, REGIONS); };
const sevName = (s) => (s ? SEVERITY[s].name : 'Sano');
const dot = (s) => `<i class="dot" data-s="${s || 0}"></i>`;

let viewer;
const handlers = {
  onHover(part, ev) {
    const tip = $('#tip');
    let hover = null, hoverZone = null, text = '';
    if (part) {
      const add = state.multiMode || (ev && (ev.shiftKey || ev.metaKey || ev.ctrlKey));
      if (add) { hover = part.id; text = `${esc(part.label)}<span>${state.sel.has(part.id) ? 'clic para quitar' : 'clic para añadir'}</span>`; }
      else if (!state.zone) { hoverZone = part.zone; text = `${esc(zl(part.zone))}<span>clic para acercar</span>`; }
      else if (part.zone !== state.zone) { hover = part.id; text = `${esc(zl(part.zone))}<span>clic para ir a esta zona</span>`; }
      else { hover = part.id; const s = state.injuries[part.id]; text = esc(part.label) + (s ? `<span>${sevName(s).toLowerCase()}</span>` : ''); }
    }
    $('#canvas').style.cursor = part ? 'pointer' : 'grab';
    if (part && ev) {
      const r = $('.stage').getBoundingClientRect();
      tip.innerHTML = text; tip.hidden = false;
      const x = Math.min(ev.clientX - r.left + 14, r.width - tip.offsetWidth - 8), y = Math.max(ev.clientY - r.top - 34, 8);
      tip.style.transform = `translate(${x}px, ${y}px)`;
    } else tip.hidden = true;
    if (hover !== state.hover || hoverZone !== state.hoverZone) { state.hover = hover; state.hoverZone = hoverZone; viewer.refresh(); markRows(); }
  },
  onPick(part, ev) {
    if (state.multiMode || ev.shiftKey || ev.metaKey || ev.ctrlKey) {
      if (!part) return;
      if (state.sel.has(part.id)) state.sel.delete(part.id); else state.sel.add(part.id);
      state.tab = 'm'; viewer.refresh(); render(); return;
    }
    if (!part) { if (state.sel.size) select(null); return; }
    if (part.zone !== state.zone) setZone(part.zone);
    else select(part.id);
  },
  onMenu(part, ev) {
    if (!state.sel.has(part.id)) { if (state.multiMode) state.sel.add(part.id); else state.selected = part.id; state.tab = 'm'; viewer.refresh(); render(); }
    openMenu(ev.clientX, ev.clientY, part);
  },
};

function setZone(zone, keepSel) {
  state.zone = zone; state.hover = state.hoverZone = null;
  if (!keepSel && !state.multiMode) state.selected = null;
  $('#tip').hidden = true; state.sheet = 'peek';
  viewer.focusZone(zone, 850); viewer.refresh(); render();
}
function select(id) {
  state.selected = id; state.tab = 'm'; if (id) state.sheet = 'peek';
  viewer.refresh(); render();
}
function setSeverity(ids, sev) {
  for (const id of ids) { if (sev) state.injuries[id] = sev; else delete state.injuries[id]; }
  if (sev) state.lastSev = sev;
  save(); viewer.refresh(); render();
}
function hide(id) { state.hidden.add(id); state.sel.delete(id); viewer.refresh(); render(); }

// ---------- Lateral
function renderZones() {
  const inj = {}; for (const id in state.injuries) { const p = viewer.byId[id]; if (p) inj[p.zone] = (inj[p.zone] || 0) + 1; }
  const [zr, zs] = (state.zone || '').split(':');
  let h = `<li class="${state.zone ? '' : 'on'}"><button class="z" data-zone="">Cuerpo completo</button></li>`;
  for (const r of REGIONS) {
    const on = zr === r.id;
    if (!r.lados) { h += `<li class="${on ? 'on' : ''}"><button class="z" data-zone="${r.id}">${r.name}</button>${inj[r.id] ? `<span class="n" title="Músculos lesionados">${inj[r.id]}</span>` : ''}</li>`; continue; }
    const n = (inj[`${r.id}:L`] || 0) + (inj[`${r.id}:R`] || 0);
    h += `<li class="${on ? 'on' : ''}"><button class="z" data-zone="${r.id}:${on ? zs : 'L'}">${r.name}</button>${n ? `<span class="n" title="Músculos lesionados">${n}</span>` : ''}`
      + `<button class="s ${on && zs === 'L' ? 'on' : ''}" data-zone="${r.id}:L" aria-label="${r.name}, lado izquierdo" title="Izquierdo">Izq</button>`
      + `<button class="s ${on && zs === 'R' ? 'on' : ''}" data-zone="${r.id}:R" aria-label="${r.name}, lado derecho" title="Derecho">Der</button></li>`;
  }
  $('#zones').innerHTML = h;
  const nh = state.hidden.size; const u = $('#unhide');
  u.hidden = !nh; u.textContent = nh === 1 ? 'Mostrar 1 músculo oculto' : `Mostrar ${nh} músculos ocultos`;
}

function renderCrumbs() {
  const sel = viewer.byId[state.selected];
  let h = '';
  if (!state.zone) h = state.sel.size > 1 ? `Cuerpo completo<small>${state.sel.size} músculos seleccionados</small>` : state.multiMode ? 'Cuerpo completo<small>Toca los músculos que forman la línea de dolor</small>' : 'Cuerpo completo<small>Toca una zona para acercarte y ver sus músculos</small>';
  else {
    h = `<button data-zone="">Cuerpo completo</button><span class="sep">/</span>`;
    if (state.sel.size > 1) h += `<button data-zone="${state.zone}">${esc(zl(state.zone))}</button><span class="sep">/</span>${state.sel.size} músculos seleccionados`;
    else h += sel ? `<button data-zone="${state.zone}">${esc(zl(state.zone))}</button><span class="sep">/</span>${esc(sel.label)}` : esc(zl(state.zone));
  }
  $('#crumbs').innerHTML = h;
}

// ---------- Inspector: músculos
function groupsOf(zone) {
  const out = new Map();
  for (const p of viewer.parts) if (!zone || p.zone === zone) { if (!out.has(p.groupId)) out.set(p.groupId, []); out.get(p.groupId).push(p); }
  const order = Object.keys(GROUPS);
  return new Map([...out].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])));
}
const row = (p) => `<li data-part="${p.id}" class="${state.sel.has(p.id) ? 'on' : ''}">${dot(state.injuries[p.id])}<span class="nm">${esc(p.zone.includes(':') && p.zone === state.zone ? p.name : p.label)}</span>${state.hidden.has(p.id) ? '<span class="meta">oculto</span>' : state.injuries[p.id] ? `<span class="meta">${sevName(state.injuries[p.id])}</span>` : ''}</li>`;

function renderMuscles() {
  const el = $('#panel-m'); const sel = viewer.byId[state.selected];
  if (state.sel.size > 1) {
    const ps = [...state.sel].map((id) => viewer.byId[id]); const sevs = new Set(ps.map((p) => state.injuries[p.id] || 0)); const s = sevs.size === 1 ? [...sevs][0] : -1;
    const gs = [...new Set(ps.map((p) => p.group.name))];
    el.innerHTML = `
      <h2>${ps.length} músculos seleccionados</h2>
      <p class="lead">${esc(gs.join(', '))}.</p>
      <h3>Estado de toda la selección</h3>
      <div class="seg" role="group" aria-label="Gravedad de la lesión">
        ${[0, 1, 2, 3].map((v) => `<button data-sev="${v}" aria-pressed="${s === v}"><i style="${v ? `background:var(--sev${v})` : ''}"></i>${sevName(v)}</button>`).join('')}
      </div>
      <div class="actions">
        <button class="btn" data-act="frame">Encuadrar la selección</button>
        <button class="btn" data-act="only">Ver solo estos</button>
        <button class="btn" data-act="none">Vaciar selección</button>
      </div>
      <h3>Línea de músculos</h3>
      <ul class="rows">${ps.map((p) => `<li data-focus="${p.id}">${dot(state.injuries[p.id])}<span class="nm">${esc(p.label)}</span><span class="meta">${esc(p.group.name)}</span><button class="x" data-unsel="${p.id}" aria-label="Quitar ${esc(p.label)} de la selección">×</button></li>`).join('')}</ul>`;
    return;
  }
  if (sel) {
    const s = state.injuries[sel.id] || 0; const g = sel.group;
    const mates = viewer.parts.filter((p) => p.groupId === sel.groupId && p.zone === sel.zone && p.side === sel.side);
    el.innerHTML = `
      <button class="back" data-zone="${sel.zone}">‹ ${esc(zl(sel.zone))}</button>
      <h2>${esc(sel.label)}</h2>
      <p class="term">${esc(PARTS[sel.id].en)}</p>
      <p class="lead">${esc(sel.action)}.</p>
      <h3>Estado</h3>
      <div class="seg" role="group" aria-label="Gravedad de la lesión">
        ${[0, 1, 2, 3].map((v) => `<button data-sev="${v}" aria-pressed="${s === v}"><i style="${v ? `background:var(--sev${v})` : ''}"></i>${sevName(v)}</button>`).join('')}
      </div>
      ${s ? `<p class="note">${esc(SEVERITY[s].fase)} <button class="link" data-tab="p">Ver el plan</button></p>` : ''}
      <div class="actions">
        <button class="btn" data-act="group">Marcar todo el grupo</button>
        <button class="btn" data-act="hide">Ocultar para ver debajo</button>
        <button class="btn" data-act="center">Centrar</button>
      </div>
      <h3>${esc(g.name)}</h3>
      <p>${esc(g.funcion)}</p>
      <dl class="kv"><dt>Lesiones frecuentes</dt><dd>${esc(g.lesiones)}</dd></dl>
      <h3>Músculos del mismo grupo</h3>
      <ul class="rows">${mates.map(row).join('')}</ul>`;
    return;
  }
  if (state.zone) {
    const gs = groupsOf(state.zone);
    el.innerHTML = `<h2>${esc(zl(state.zone))}</h2><p class="lead">${[...gs.values()].reduce((a, b) => a + b.length, 0)} músculos en ${gs.size} ${gs.size === 1 ? 'grupo' : 'grupos'}. Toca uno en el modelo o en la lista.</p>`
      + [...gs].map(([gid, ps]) => `<h3>${esc(GROUPS[gid].name)}</h3><ul class="rows">${ps.sort((a, b) => a.name.localeCompare(b.name, 'es')).map(row).join('')}</ul>`).join('');
    return;
  }
  const gs = groupsOf(null);
  el.innerHTML = `<h2>Grupos musculares</h2><p class="lead">${viewer.parts.length} músculos en ${gs.size} grupos. Elige un grupo para ir a su zona.</p><ul class="rows groups" style="margin-top:12px">`
    + REGIONS.flatMap((r) => Object.entries(GROUPS).filter(([, g]) => g.region === r.id).map(([gid, g]) => {
      const ps = gs.get(gid) || []; const worst = Math.max(0, ...ps.map((p) => state.injuries[p.id] || 0)); const n = ps.filter((p) => state.injuries[p.id]).length;
      return `<li data-group="${gid}">${dot(worst)}<span class="nm">${esc(g.name)}<small>${r.name}</small></span><span class="meta">${n ? `${n} de ${ps.length}` : ps.length}</span></li>`;
    })).join('') + '</ul>';
}
function markRows() { document.querySelectorAll('#panel-m [data-part]').forEach((li) => li.classList.toggle('hover', li.dataset.part === state.hover)); }

// ---------- Inspector: plan
function injuredGroups() {
  const m = new Map();
  for (const id in state.injuries) { const p = viewer.byId[id]; if (!p) continue; if (!m.has(p.groupId)) m.set(p.groupId, []); m.get(p.groupId).push(p); }
  return [...m].map(([gid, ps]) => ({ gid, g: GROUPS[gid], ps, sev: Math.max(...ps.map((p) => state.injuries[p.id])) })).sort((a, b) => b.sev - a.sev || a.g.name.localeCompare(b.g.name, 'es'));
}
function renderPlan() {
  const list = injuredGroups(); const n = Object.keys(state.injuries).length;
  const today = new Date().toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
  const steps = (a) => `<ul class="steps">${a.map(([t, d]) => `<li><b>${esc(t)}</b><span>${esc(d)}</span></li>`).join('')}</ul>`;
  const bul = (a, c) => `<ul class="bul ${c}">${a.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
  $('#panel-p').innerHTML = `
    <div class="print-only"><div class="print-head"><b>Plan de recuperación muscular</b><span>${today}</span></div><img class="print-shot" id="shot" alt="Modelo con los músculos lesionados marcados"></div>
    ${linked ? '<p class="note no-print" style="margin:0 0 16px">Abriste un mapa compartido. Puedes ajustarlo y generar un enlace nuevo.</p>' : ''}
    <label class="field"><span>Paciente</span><input id="patient" value="${esc(state.patient)}" placeholder="Nombre" autocomplete="off"></label>
    ${n ? '' : '<p class="empty">Todavía no hay músculos marcados. Selecciona un músculo en el modelo y elige su gravedad: el plan aparece aquí.</p>'}
    ${list.map(({ gid, g, ps, sev }) => `
      <section class="plan-group">
        <div class="plan-head"><h2>${esc(g.name)}</h2><span class="pill" data-s="${sev}">${sevName(sev)}</span></div>
        <ul class="chips">${ps.map((p) => `<li>${dot(state.injuries[p.id])}${esc(p.label)}<button data-clear="${p.id}" aria-label="Quitar ${esc(p.label)}">×</button></li>`).join('')}</ul>
        <p class="note">${esc(SEVERITY[sev].fase)}</p>
        <div class="do"><div><h3>Qué hacer</h3>${bul(g.hacer, 'yes')}</div><div><h3>Qué evitar</h3>${bul(g.evitar, 'no')}</div></div>
        <h3>Estiramientos${sev === 3 ? ' (cuando lo autorice el profesional)' : ''}</h3>${steps(g.e)}
        <h3>Ejercicios${sev === 3 ? ' (cuando lo autorice el profesional)' : sev === 2 ? ' (empieza por los isométricos)' : ''}</h3>${steps(g.x)}
      </section>`).join('')}
    <label class="field" style="margin-top:20px"><span>Notas del fisioterapeuta</span><textarea id="notes" rows="4" placeholder="Hallazgos, dosis, próxima revisión">${esc(state.notes)}</textarea></label>
    ${n ? '<div class="actions no-print"><button class="btn primary" id="share-2">Compartir enlace</button><button class="btn" id="print-2">Imprimir</button><button class="link" id="clear-all">Quitar todas las marcas</button></div>' : ''}
    <p class="fine">Orientación general para trabajar junto a un fisioterapeuta. No sustituye una valoración presencial. Acude a urgencias si hay deformidad, pérdida de fuerza brusca, hormigueo persistente o dolor que no cede en reposo.</p>`;
}

function render() {
  renderZones(); renderCrumbs(); renderMuscles(); renderPlan(); renderQuick();
  $('.inspector').dataset.sheet = state.sheet;
  $('#multi-btn').setAttribute('aria-pressed', state.multiMode);
  $('#share').disabled = !Object.keys(state.injuries).length;
  const n = Object.keys(state.injuries).length;
  $('#tab-count').textContent = n || '';
  $('#count').textContent = n ? `${n} ${n === 1 ? 'músculo marcado' : 'músculos marcados'}` : '';
  $('#print').disabled = !n;
  for (const t of ['m', 'p']) { $(`#tab-${t}`).setAttribute('aria-selected', state.tab === t); $(`#panel-${t}`).hidden = state.tab !== t; }
  $('#t-multi').checked = state.multiMode; $('#t-isolate').checked = state.isolate; $('#t-injured').checked = state.onlyInjured; $('#t-skeleton').checked = state.skeleton;
}

// ---------- Eventos
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-unsel],[data-focus],[data-zone],[data-part],[data-group],[data-sev],[data-act],[data-tab],[data-clear],[data-view]'); if (!t) return;
  const d = t.dataset; const sel = viewer.byId[state.selected];
  if (d.unsel) { state.sel.delete(d.unsel); viewer.refresh(); render(); }
  else if (d.focus) viewer.focusPart(d.focus);
  else if ('zone' in d) setZone(d.zone || null);
  else if (d.part && (state.multiMode || e.shiftKey || e.metaKey || e.ctrlKey)) { if (state.sel.has(d.part)) state.sel.delete(d.part); else { state.sel.add(d.part); state.hidden.delete(d.part); } viewer.refresh(); render(); }
  else if (d.part) { const p = viewer.byId[d.part]; if (state.hidden.has(p.id)) state.hidden.delete(p.id); if (p.zone !== state.zone) { state.selected = p.id; setZone(p.zone, true); } else select(p.id); }
  else if (d.group) { const p = viewer.parts.find((x) => x.groupId === d.group && (x.side === 'L' || !x.side)) || viewer.parts.find((x) => x.groupId === d.group); setZone(p.zone); }
  else if (d.sev && state.sel.size) setSeverity([...state.sel], +d.sev);
  else if (d.act === 'frame') viewer.focusIds([...state.sel]);
  else if (d.act === 'none') select(null);
  else if (d.act === 'only') { for (const p of viewer.parts) if (!state.sel.has(p.id)) state.hidden.add(p.id); viewer.refresh(); render(); viewer.focusIds([...state.sel]); }
  else if (d.act === 'group' && sel) setSeverity(viewer.parts.filter((p) => p.groupId === sel.groupId && p.zone === sel.zone && p.side === sel.side).map((p) => p.id), state.injuries[sel.id] || state.lastSev);
  else if (d.act === 'hide' && sel) hide(sel.id);
  else if (d.act === 'center' && sel) viewer.focusPart(sel.id);
  else if (d.tab) { state.tab = d.tab; if (state.sheet === 'peek') state.sheet = d.tab === 'p' ? 'full' : 'half'; render(); }
  else if (d.clear) setSeverity([d.clear], 0);
  else if (d.view) viewer.orbitTo(d.view.split(',').map(Number));
});
document.addEventListener('pointerover', (e) => {
  const li = e.target.closest('#panel-m [data-part]'); const id = li ? li.dataset.part : null;
  if (e.target.closest('#panel-m') && id !== state.hover) { state.hover = id; viewer.refresh(); }
});
$('#multi-btn').onclick = () => { state.multiMode = !state.multiMode; state.hover = state.hoverZone = null; viewer.refresh(); render(); if (state.multiMode) toast('Toca varios músculos para formar el grupo'); };
$('#share').onclick = () => share();
$('#tab-m').onclick = () => { state.tab = 'm'; render(); };
$('#tab-p').onclick = () => { state.tab = 'p'; render(); };
$('#t-skeleton').onchange = (e) => { state.skeleton = e.target.checked; viewer.refresh(); };
$('#t-isolate').onchange = (e) => { state.isolate = e.target.checked; viewer.refresh(); };
$('#t-multi').onchange = (e) => { state.multiMode = e.target.checked; state.hover = state.hoverZone = null; viewer.refresh(); render(); };
$('#t-injured').onchange = (e) => { state.onlyInjured = e.target.checked; viewer.refresh(); };
$('#unhide').onclick = () => { state.hidden.clear(); viewer.refresh(); render(); };
$('#z-in').onclick = () => viewer.zoom(0.8);
$('#z-out').onclick = () => viewer.zoom(1.25);
$('#z-fit').onclick = () => viewer.focusZone(state.zone, 600);
$('#panel-p').addEventListener('input', (e) => {
  if (e.target.id === 'patient') state.patient = e.target.value;
  if (e.target.id === 'notes') state.notes = e.target.value;
  save();
});
$('#panel-p').addEventListener('click', (e) => { if (e.target.id === 'clear-all') setSeverity(Object.keys(state.injuries), 0); if (e.target.id === 'share-2') share(); if (e.target.id === 'print-2') $('#print').click(); });
$('#print').onclick = () => {
  state.tab = 'p'; render();
  const img = $('#shot'); img.onload = () => window.print(); img.src = viewer.snapshot();
};
document.addEventListener('keydown', (e) => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); $('#search').focus(); return; }
  if (typing) return;
  if (e.key === 'Escape') { if (!$('#menu').hidden) closeMenu(); else if (state.sel.size) select(null); else if (state.zone) setZone(null); }
  if (state.sel.size && '0123'.includes(e.key)) setSeverity([...state.sel], +e.key);
  if (state.selected && e.key.toLowerCase() === 'h') hide(state.selected);
});

// ---------- Búsqueda
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
let found = []; let cur = 0;
const rank = (p, q) => { const i = norm(p.label).indexOf(q); return i < 0 ? 99 : i; };
function search(q) {
  const ul = $('#results'); q = norm(q.trim());
  if (!q) { ul.hidden = true; return; }
  found = viewer.parts.filter((p) => norm(`${p.label} ${p.group.name}`).includes(q)).sort((a, b) => rank(a, q) - rank(b, q) || a.label.localeCompare(b.label, 'es')).slice(0, 12);
  cur = 0; ul.hidden = false;
  ul.innerHTML = found.length ? found.map((p, i) => `<li role="option" data-i="${i}" aria-selected="${i === 0}">${esc(p.label)}<span>${esc(p.group.name)}</span></li>`).join('') : '<li class="none">Sin resultados</li>';
}
function go(i) { const p = found[i]; if (!p) return; $('#search').value = ''; $('#results').hidden = true; $('#search').blur(); state.hidden.delete(p.id); state.selected = p.id; state.tab = 'm'; setZone(p.zone, true); }
$('#search').addEventListener('input', (e) => search(e.target.value));
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') go(cur);
  else if (e.key === 'Escape') { e.target.value = ''; $('#results').hidden = true; e.target.blur(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); cur = (cur + (e.key === 'ArrowDown' ? 1 : -1) + found.length) % (found.length || 1); $('#results').querySelectorAll('li').forEach((li, i) => li.setAttribute('aria-selected', i === cur)); }
});
$('#search').addEventListener('blur', () => setTimeout(() => { $('#results').hidden = true; }, 150));
$('#results').addEventListener('pointerdown', (e) => { const li = e.target.closest('[data-i]'); if (li) go(+li.dataset.i); });

// ---------- Panel rápido (teléfono): gravedad al alcance del pulgar
function segHtml(s) { return `<div class="seg" role="group" aria-label="Gravedad de la lesión">${[0, 1, 2, 3].map((v) => `<button data-sev="${v}" aria-pressed="${s === v}"><i style="${v ? `background:var(--sev${v})` : ''}"></i>${sevName(v)}</button>`).join('')}</div>`; }
function renderQuick() {
  const n = Object.keys(state.injuries).length; const ids = [...state.sel]; let h;
  if (ids.length) {
    const sevs = new Set(ids.map((id) => state.injuries[id] || 0));
    const title = ids.length > 1 ? `${ids.length} músculos seleccionados` : viewer.byId[ids[0]].label;
    h = `<div class="q-head"><b>${esc(title)}</b><button class="link" data-sheet="half">Detalles</button></div>${segHtml(sevs.size === 1 ? [...sevs][0] : -1)}`;
  } else if (n) {
    h = `<div class="q-head"><b>${n} ${n === 1 ? 'músculo marcado' : 'músculos marcados'}</b>${state.zone ? '<button class="link" data-sheet="half">Ver músculos</button>' : ''}</div><div class="q-row"><button class="btn" data-tab="p">Ver el plan</button><button class="btn primary" data-share>Compartir enlace</button></div>`;
  } else {
    h = `<div class="q-head"><b>${state.zone ? esc(zl(state.zone)) : 'Marca lo que duele'}</b></div><div class="q-row"><span class="q-hint">${state.zone ? 'Toca un músculo. Mantén pulsado para ver más opciones.' : 'Toca una zona del cuerpo para acercarte.'}</span><button class="btn" data-sheet="half">${state.zone ? 'Lista' : 'Grupos'}</button></div>`;
  }
  $('#quick').innerHTML = h;
}
document.addEventListener('click', (e) => {
  const t = e.target.closest('button[data-sheet],[data-share]'); if (!t) return;
  if ('share' in t.dataset) return share();
  state.sheet = t.dataset.sheet; state.tab = 'm'; render();
});
// Asa del panel: arrastrar o tocar para cambiar entre los tres tamaños.
(() => {
  const h = $('#handle'), box = $('.inspector'); let g = null;
  h.addEventListener('pointerdown', (e) => { g = { y: e.clientY, h0: box.offsetHeight, moved: false }; h.setPointerCapture(e.pointerId); box.classList.add('drag'); });
  h.addEventListener('pointermove', (e) => { if (!g) return; const dy = g.y - e.clientY; if (Math.abs(dy) > 4) g.moved = true; box.style.height = `${Math.max(90, g.h0 + dy)}px`; });
  const end = () => {
    if (!g) return; const max = box.parentElement.clientHeight, cur = box.offsetHeight; box.classList.remove('drag'); box.style.height = '';
    if (!g.moved) state.sheet = state.sheet === 'peek' ? 'half' : 'peek';
    else state.sheet = cur < max * 0.33 ? 'peek' : cur < max * 0.75 ? 'half' : 'full';
    g = null; render();
  };
  h.addEventListener('pointerup', end); h.addEventListener('pointercancel', end);
})();

// ---------- Menú del músculo (clic derecho, doble clic o pulsación larga)
function openMenu(x, y, part) {
  const m = $('#menu'); const ids = state.sel.has(part.id) && state.sel.size > 1 ? [...state.sel] : [part.id];
  const sevs = new Set(ids.map((id) => state.injuries[id] || 0)); const cur = sevs.size === 1 ? [...sevs][0] : -1;
  m.dataset.ids = ids.join(','); m.dataset.part = part.id;
  m.innerHTML = `<p class="m-title">${esc(ids.length > 1 ? `${ids.length} músculos seleccionados` : part.label)}</p>`
    + [0, 1, 2, 3].map((v) => `<button role="menuitemradio" aria-checked="${cur === v}" data-msev="${v}"><i class="dot" data-s="${v}"></i>${sevName(v)}</button>`).join('')
    + '<div class="m-sep"></div>'
    + (state.multiMode ? '' : '<button role="menuitem" data-mact="multi">Seleccionar varios</button>')
    + '<button role="menuitem" data-mact="group">Marcar todo su grupo</button>'
    + '<button role="menuitem" data-mact="hide">Ocultar para ver debajo</button>'
    + '<button role="menuitem" data-mact="center">Centrar</button>';
  m.hidden = false; $('#menu-back').hidden = false;
  if (isPhone()) { m.style.left = m.style.top = ''; return; }
  m.style.left = `${Math.min(x + 4, innerWidth - m.offsetWidth - 8)}px`;
  m.style.top = `${Math.min(y + 4, innerHeight - m.offsetHeight - 8)}px`;
}
function closeMenu() { $('#menu').hidden = true; $('#menu-back').hidden = true; }
$('#menu-back').addEventListener('pointerdown', closeMenu);
$('#menu-back').addEventListener('contextmenu', (e) => { e.preventDefault(); closeMenu(); });
$('#menu').addEventListener('contextmenu', (e) => e.preventDefault());
$('#menu').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const m = $('#menu'); const ids = m.dataset.ids.split(','); const part = viewer.byId[m.dataset.part]; closeMenu();
  if (b.dataset.msev) setSeverity(ids, +b.dataset.msev);
  else if (b.dataset.mact === 'multi') { state.multiMode = true; state.sel.add(part.id); viewer.refresh(); render(); toast('Toca más músculos para añadirlos al grupo'); }
  else if (b.dataset.mact === 'group') setSeverity(viewer.parts.filter((p) => p.groupId === part.groupId && p.zone === part.zone && p.side === part.side).map((p) => p.id), state.injuries[part.id] || state.lastSev);
  else if (b.dataset.mact === 'hide') ids.forEach(hide);
  else if (b.dataset.mact === 'center') viewer.focusIds(ids);
});

// ---------- Compartir
let toastT;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600); }
async function share() {
  const n = Object.keys(state.injuries).length; if (!n) return toast('Marca al menos un músculo para compartir');
  const url = `${location.origin}${location.pathname}#${linkHash()}`;
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title: 'Fibra · mapa de lesión', text: `${n} ${n === 1 ? 'músculo marcado' : 'músculos marcados'} con su plan de ejercicios`, url }); } catch { /* cancelado */ }
    return;
  }
  try { await navigator.clipboard.writeText(url); }
  catch { const a = document.createElement('textarea'); a.value = url; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove(); }
  toast('Enlace copiado. Quien lo abra verá este mapa y su plan.');
}

// ---------- Arranque
createViewer($('#canvas'), state, handlers, (f) => { $('#bar').style.width = `${Math.round(f * 100)}%`; })
  .then((v) => { viewer = v; for (const id in state.injuries) if (!v.byId[id]) delete state.injuries[id]; render(); if (linked && Object.keys(state.injuries).length) setTimeout(() => viewer.focusIds(Object.keys(state.injuries)), 300); $('#loading').classList.add('done'); if (import.meta.env.DEV) window.__fibra = { viewer, state, setZone, select, setSeverity }; })
  .catch((err) => { console.error(err); $('#loading').innerHTML = '<p>No se pudo cargar el modelo. Recarga la página.</p>'; });
