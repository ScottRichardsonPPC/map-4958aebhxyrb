(() => {
  'use strict';
  const MI = 1609.344, NOTE = 'Video may not include every part of this flight; the section over your location might not have been filmed or kept.';
  const LS_MODE = 'ppc-track-color-mode', LS_COLOR = 'ppc-track-color', LS_YEARS = 'ppc-track-year-colors';
  const DEFAULT_COLOR = '#FFB000';
  // High-contrast defaults that stay visible on satellite imagery and on the street map.
  const YEAR_DEFAULTS = {
    2015: '#F5D000', 2016: '#FF6A00', 2017: '#E31C3D', 2018: '#00C2E0',
    2019: '#5CDB00', 2020: '#FF2BD6', 2021: '#3D8BFF', 2022: '#B56BFF',
    2023: '#FF9F1C', 2024: '#00E39A', 2025: '#FF5C8A', 2026: '#7A00FF'
  };
  const $ = id => document.getElementById(id);
  const map = L.map('map', { zoomControl: true, preferCanvas: true }).setView([39.6, -85.85], 10);
  // Base maps that work without a Referer (file:// offline copy) and without a key. OSM's own tile servers block Referer-less requests.
  const ESRI = 'Tiles &copy; <a href="https://www.esri.com">Esri</a> &mdash; Esri, HERE, Garmin, USGS, Maxar, Earthstar Geographics, &copy; OpenStreetMap contributors, and the GIS User Community';
  const street = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: ESRI }).addTo(map);   // CARTO answers 'API key required' without a Referer, so Esri everywhere
  const sat = L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, maxNativeZoom: 19, attribution: ESRI }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: ESRI })]);
  const topo = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19, attribution: ESRI });
  const bestLayer = L.layerGroup();
  window.PPCMAP = { map, bestLayer };
  L.control.layers({ 'Street map': street, 'Satellite': sat, 'Topographic': topo }, { 'Best-of photos (4–5★)': bestLayer }, { position: 'topright', collapsed: false }).addTo(map);
  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = function () {
    const d = L.DomUtil.create('div', 'best-legend');
    d.innerHTML = '<div class="lg"><span class="dot gold-lg"></span> 5-star, posted on Facebook</div>'
      + '<div class="lg"><span class="dot gold"></span> 4-star, posted on Facebook</div>';
    return d;
  };
  legend.addTo(map);
  const allRenderer = L.canvas({ padding: 0.5 });
  const allLayer = L.layerGroup().addTo(map);
  let FL = [], ZONES = [], pick = null, pickMarker = null, circle = null, resLayer = L.layerGroup().addTo(map), hiLayer = L.layerGroup().addTo(map), phLayer = L.layerGroup().addTo(map), lastHits = [], selId = null;
  const photoFlights = new Map();   // photo key -> flights (a post/photo can appear on more than one)
  const TAP_PX = 20;   // generous tap target for photo pins, including on a phone
  const yearsOn = new Set();
  let allOn = false, colorMode = 'single', trackColor = DEFAULT_COLOR, yearColors = Object.assign({}, YEAR_DEFAULTS);

  try {
    const m = localStorage.getItem(LS_MODE);
    if (m === 'single' || m === 'year') colorMode = m;
    const c = localStorage.getItem(LS_COLOR);
    if (c && /^#[0-9A-Fa-f]{6}$/.test(c)) trackColor = c;
    const y = JSON.parse(localStorage.getItem(LS_YEARS) || 'null');
    if (y && typeof y === 'object') {
      for (const k of Object.keys(YEAR_DEFAULTS)) {
        const v = y[k] || y[+k];
        if (typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v)) yearColors[k] = v;
      }
    }
  } catch (_) {}

  function saveColors() {
    try {
      localStorage.setItem(LS_MODE, colorMode);
      localStorage.setItem(LS_COLOR, trackColor);
      localStorage.setItem(LS_YEARS, JSON.stringify(yearColors));
    } catch (_) {}
  }
  const colorForYear = y => colorMode === 'year' ? (yearColors[y] || YEAR_DEFAULTS[y] || trackColor) : trackColor;

  // ---------- data
  (window.FLIGHTS_DATA ? Promise.resolve(window.FLIGHTS_DATA) : fetch('data/flights.json').then(r => r.json())).then(D => {   // offline build sets FLIGHTS_DATA via data/flights.js
    ZONES = D.zones || [];
    if (ZONES.length) document.getElementById('privacy').textContent = ' For privacy, a few private areas are left out of the tracks and photos.';
    FL = D.flights.map(f => {
      const segs = f.s.map(s => {
        const n = s.length / 4, t = new Float64Array(n), la = new Float64Array(n), lo = new Float64Array(n), ag = new Float32Array(n);
        let T = 0, A = 0, O = 0;
        for (let i = 0; i < n; i++) {
          T += s[4*i]; A += s[4*i+1]; O += s[4*i+2];
          t[i] = T; la[i] = A / 1e5; lo[i] = O / 1e5; ag[i] = s[4*i+3] < 0 ? NaN : s[4*i+3] * 10;
        }
        return { t, la, lo, ag };
      });
      let s0 = 90, n0 = -90, w0 = 180, e0 = -180;
      for (const g of segs) for (let i = 0; i < g.la.length; i++) { if (g.la[i] < s0) s0 = g.la[i]; if (g.la[i] > n0) n0 = g.la[i]; if (g.lo[i] < w0) w0 = g.lo[i]; if (g.lo[i] > e0) e0 = g.lo[i]; }
      const pp = (f.pp || []).map(p => ({ t: p[0], la: p[1] / 1e5, lo: p[2] / 1e5, id: p[3], hi: !!p[4], u: p[5] || '' })).filter(p => !inZone(p.la, p.lo));
      const bp = (f.bp || []).map(p => ({ t: p[0], la: p[1] / 1e5, lo: p[2] / 1e5, r: p[3], pk: p[4], hd: p[5], agl: p[6], sub: p[7] || [], u: p[8] })).filter(p => !inZone(p.la, p.lo));
      const f2 = Object.assign(f, { y: +f.d.slice(0, 4), segs, pp, bp, bb: [s0, w0, n0, e0] });
      f2.st = flightStats(f2);
      f2.simple = simplePath(f2);
      return f2;
    });
    photoFlights.clear();
    FL.forEach(f => {
      (f.pp || []).forEach(p => indexPhoto(p, f));
      (f.bp || []).forEach(p => indexPhoto(p, f));
    });
    FL.forEach(f => f.bp.forEach(p => bestPin(p, f, bestLayer)));
    const yrs = [...new Set(FL.map(f => f.y))].sort();
    yrs.forEach(y => yearsOn.add(y));
    $('years').innerHTML = yrs.map(y => `<label><input type="checkbox" value="${y}" checked>${y}</label>`).join('');
    $('years').addEventListener('change', e => {
      const y = +e.target.value; e.target.checked ? yearsOn.add(y) : yearsOn.delete(y); e.target.parentNode.classList.toggle('off', !e.target.checked);
      applyYearFilter();
    });
    syncColorUi();
    setStatus(`<b>${FL.length}</b> GPS-tracked flights loaded. Search an address or tap the map, or show all tracks for the selected years.`);
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get('lat') && h.get('lon')) setPick(+h.get('lat'), +h.get('lon'), true);
  }).catch(() => setStatus('Could not load the flight data. Please reload the page.'));

  // ---------- helpers
  const setStatus = h => { $('status').innerHTML = h; };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hav = (a, b, c, d) => { const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2; return 2 * 6371000 * Math.asin(Math.sqrt(x)); };
  const inZone = (la, lo) => ZONES.length > 0 && ZONES.some(z => hav(la, lo, z[0], z[1]) < z[2] * MI);
  const fmtDate = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const fmtTime = t => new Date(t * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  const fmtDist = m => { const mi = m / MI; return mi < 0.1 ? `${Math.round(m * 3.281 / 10) * 10} ft` : `${mi.toFixed(2)} mi`; };

  function flightStats(f) {
    let t0 = Infinity, t1 = -Infinity, dist = 0, maxAg = -Infinity, hasAg = false;
    for (const g of f.segs) {
      const n = g.la.length;
      if (n) { t0 = Math.min(t0, g.t[0]); t1 = Math.max(t1, g.t[n - 1]); }
      for (let i = 0; i < n; i++) {
        if (i) dist += hav(g.la[i - 1], g.lo[i - 1], g.la[i], g.lo[i]);
        if (isFinite(g.ag[i])) { hasAg = true; if (g.ag[i] > maxAg) maxAg = g.ag[i]; }
      }
    }
    return { t0, t1, dist, maxAg, hasAg };
  }
  function simplePath(f) {
    const MIN_M = 280, out = [];
    for (const g of f.segs) {
      const n = g.la.length;
      if (n < 2) continue;
      const pts = [[g.la[0], g.lo[0]]];
      for (let i = 1; i < n - 1; i++) {
        const p = pts[pts.length - 1];
        if (hav(p[0], p[1], g.la[i], g.lo[i]) >= MIN_M) pts.push([g.la[i], g.lo[i]]);
      }
      pts.push([g.la[n - 1], g.lo[n - 1]]);
      if (pts.length >= 2) out.push(pts);
    }
    return out;
  }

  // closest approach of flight f to (la0, lo0), in meters (equirectangular around the pick)
  function closest(f, la0, lo0, rM) {
    const kx = 111320 * Math.cos(la0 * Math.PI / 180), ky = 110540, pad = rM / ky * 1.2, padx = rM / kx * 1.2;
    if (la0 < f.bb[0] - pad || la0 > f.bb[2] + pad || lo0 < f.bb[1] - padx || lo0 > f.bb[3] + padx) return null;
    let best = { d: Infinity };
    for (const g of f.segs) {
      const n = g.la.length;
      let px = (g.lo[0] - lo0) * kx, py = (g.la[0] - la0) * ky;
      if (n === 1) { const d = Math.hypot(px, py); if (d < best.d) best = { d, t: g.t[0], ag: g.ag[0], la: g.la[0], lo: g.lo[0] }; continue; }
      for (let i = 1; i < n; i++) {
        const qx = (g.lo[i] - lo0) * kx, qy = (g.la[i] - la0) * ky, dx = qx - px, dy = qy - py, L2 = dx * dx + dy * dy;
        let u = L2 > 0 ? -(px * dx + py * dy) / L2 : 0; u = u < 0 ? 0 : u > 1 ? 1 : u;
        const d = Math.hypot(px + u * dx, py + u * dy);
        if (d < best.d) best = { d, t: g.t[i-1] + u * (g.t[i] - g.t[i-1]), ag: g.ag[i-1] + u * (g.ag[i] - g.ag[i-1]), la: g.la[i-1] + u * (g.la[i] - g.la[i-1]), lo: g.lo[i-1] + u * (g.lo[i] - g.lo[i-1]) };
        px = qx; py = qy;
      }
    }
    return best.d <= rM ? best : null;
  }

  function flightPopupHtml(f) {
    const st = f.st, mi = st.dist / MI, durH = (st.t1 - st.t0) / 3600;
    const dur = durH >= 1 ? `${durH.toFixed(1)} h` : `${Math.max(1, Math.round((st.t1 - st.t0) / 60))} min`;
    const ht = !(f.agl && st.hasAg) ? '' : (st.maxAg < 100 ? ' · max height under 100 ft' : ` · max about ${(Math.round(st.maxAg / 50) * 50).toLocaleString()} ft up`);
    const vids = (f.v || []).map(v => `<div class="vid">🎥 <a href="${esc(v.u)}" target="_blank" rel="noopener">${esc(v.t)}</a>${v.c === 'low' ? ' <span class="conf">(possible match)</span>' : ''}<span class="note">${NOTE}</span></div>`).join('');
    let ph = '';
    if ((f.ph || []).length) {
      ph = `<div class="photos">Facebook post${f.ph.length > 1 ? 's' : ''}: ` +
        f.ph.map(p => `<a href="${esc(p.u)}" target="_blank" rel="noopener">${fmtDate(p.pd)}</a> (${p.n} photo${p.n > 1 ? 's' : ''})`).join(' · ') + '</div>';
    }
    return `<div class="flight-pop"><b>${fmtDate(f.d)}</b><br>${fmtTime(st.t0)} – ${fmtTime(st.t1)} ET · ${dur} · ${mi.toFixed(1)} mi${ht}<br>${esc(f.ac)} · ${esc(f.n)}${vids}${ph}</div>`;
  }

  function setPick(la, lo, fit) {
    pick = [la, lo];
    if (!pickMarker) pickMarker = L.marker(pick).addTo(map); else pickMarker.setLatLng(pick);
    history.replaceState(null, '', `#lat=${la.toFixed(5)}&lon=${lo.toFixed(5)}`);
    run(fit);
  }

  function run(fit) {
    if (!pick || !FL.length) return;
    const rM = +$('radius').value * MI;
    if (circle) circle.remove();
    circle = L.circle(pick, { radius: rM, color: '#2f5fb3', weight: 1.5, fillOpacity: 0.06 }).addTo(map);
    if (fit) map.fitBounds(circle.getBounds(), { maxZoom: 15, padding: [20, 20] });
    resLayer.clearLayers(); hiLayer.clearLayers(); phLayer.clearLayers(); $('results').innerHTML = ''; selId = null;
    if (inZone(pick[0], pick[1])) { lastHits = []; setStatus('No flight data shown for this area.'); return; }
    if (!yearsOn.size) { lastHits = []; setStatus('No years selected. Choose a year, or All, to see flights near this spot.'); return; }
    const t0 = performance.now();
    lastHits = [];
    for (const f of FL) { if (!yearsOn.has(f.y)) continue; const c = closest(f, pick[0], pick[1], rM); if (c) lastHits.push({ f, c }); }
    lastHits.sort((a, b) => b.c.t - a.c.t);
    const ms = Math.round(performance.now() - t0);
    const r = $('radius').selectedOptions[0].textContent;
    setStatus(lastHits.length ? `<b>${lastHits.length}</b> flight${lastHits.length > 1 ? 's' : ''} passed within ${r}, newest first. Tap one to see its track.` : `No tracked flights passed within ${r} of this spot${yearsOn.size < new Set(FL.map(f => f.y)).size ? ' in the selected years' : ''}.`);
    $('status').dataset.ms = ms;
    const frag = document.createDocumentFragment();
    lastHits.forEach(({ f, c }) => {
      const li = document.createElement('li'); li.dataset.id = f.id;
      const ht = !(f.agl && isFinite(c.ag)) ? 'height not available' : c.ag < 100 ? 'under 100 ft up' : `about ${(Math.round(c.ag / 50) * 50).toLocaleString()} ft up`;
      const vids = f.v.map(v => `<div class="vid">🎥 <a href="${esc(v.u)}" target="_blank" rel="noopener">${esc(v.t)}</a>${v.c === 'low' ? ' <span class="conf">(possible match)</span>' : ''}<span class="note">${NOTE}</span></div>`).join('');
      const near = f.pp.filter(p => hav(p.la, p.lo, pick[0], pick[1]) <= rM).sort((a, b) => hav(a.la, a.lo, pick[0], pick[1]) - hav(b.la, b.lo, pick[0], pick[1]));
      near.slice(0, 60).forEach(p => photoPin(p, phLayer, 5, f));
      let ph = '';
      if (near.length) {
        const seen = new Set();
        const postLinks = [];
        for (const p of near) {
          const u = photoUrl(p);
          if (u && !seen.has(u)) { seen.add(u); postLinks.push(u); }
        }
        ph += `<div class="photos">📷 <b>${near.length} photo${near.length > 1 ? 's' : ''} taken within ${$('radius').selectedOptions[0].textContent}</b>: ` +
          near.slice(0, 6).map(p => `${fmtTime(p.t)} (${fmtDist(hav(p.la, p.lo, pick[0], pick[1]))})`).join(' · ') + (near.length > 6 ? ` · +${near.length - 6} more on the map` : '') +
          '<br>' + postLinks.map(u => `<a href="${esc(u)}" target="_blank" rel="noopener">View Facebook post</a>`).join(' · ') + '</div>';
      }
      if ((f.ph || []).length) ph += `<div class="photos">Facebook photo post${f.ph.length > 1 ? 's' : ''} from this flight: ` + f.ph.slice(0, 4).map(p => `<a href="${esc(p.u)}" target="_blank" rel="noopener">${fmtDate(p.pd)}</a> (${p.n} photo${p.n > 1 ? 's' : ''})`).join(' · ') + (f.ph.length > 4 ? ` · +${f.ph.length - 4} more` : '') + '</div>';
      if (f.lr) ph += `<div class="photos lr">🖼️ ${f.lr.n.toLocaleString()} photo${f.lr.n > 1 ? 's' : ''} in Scott's photo library from this flight` + (f.lr.np ? ` (${f.lr.np} posted)` : '') + (f.bp.length ? `, ${f.bp.length} best-of (4–5★, posted) shown on the map when selected` : '') +
        (f.lr.lab ? ` · ${esc(f.lr.lab)}` : '') + (f.lr.sub.length ? `<br><span class="note">Possible subjects (a guess from the camera's direction): ${f.lr.sub.map(esc).join(', ')}</span>` : '') + '</div>';
      li.innerHTML = `<div class="r1"><span>${fmtDate(f.d)}</span><span>${fmtDist(c.d)} away</span></div>
        <div class="r2">Closest about ${fmtTime(c.t)} ET · ${ht}</div>
        <div class="r2">${esc(f.ac)} · ${esc(f.n)}</div>${vids}${ph}`;
      li.addEventListener('click', e => { if (e.target.tagName !== 'A') select(f.id); });
      frag.appendChild(li);
      const col = colorForYear(f.y);
      f.segs.forEach(g => L.polyline([...g.la].map((a, i) => [a, g.lo[i]]), { color: col, weight: 2, opacity: 0.55, interactive: false }).addTo(resLayer));
    });
    $('results').appendChild(frag);
  }

  function select(id) {
    const h = lastHits.find(x => x.f.id === id);
    const f = h ? h.f : FL.find(x => x.id === id);
    if (!f) return;
    let c = h && h.c && isFinite(h.c.d) ? h.c : null;
    if (!c && pick) {
      const near = closest(f, pick[0], pick[1], 50 * MI);
      if (near) c = near;
    }
    highlightFlight(f, c);
  }
  function highlightFlight(f, c) {
    selId = f.id;
    hiLayer.clearLayers();
    document.querySelectorAll('#results li').forEach(li => li.classList.toggle('sel', li.dataset.id === f.id));
    const lines = f.segs.map(g => L.polyline([...g.la].map((a, i) => [a, g.lo[i]]), { color: '#f28c18', weight: 4, opacity: 0.95 }).addTo(hiLayer));
    if (c && isFinite(c.d) && isFinite(c.la) && isFinite(c.lo)) {
      L.circleMarker([c.la, c.lo], { radius: 6, color: '#b3261e', fillColor: '#fff', fillOpacity: 1, weight: 3 }).bindTooltip(`Closest: ${fmtDist(c.d)}, about ${fmtTime(c.t)} ET`).addTo(hiLayer);
    }
    f.pp.forEach(p => photoPin(p, hiLayer, 3.5, f));
    f.bp.forEach(p => bestPin(p, f, hiLayer));
    if (!lines.length) return;
    const b = L.featureGroup(lines).getBounds();
    if (pick) b.extend(pick);
    map.fitBounds(b, { padding: [24, 24], maxZoom: 14 });
    if (window.innerWidth < 800) $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function drawAllTracks(fit) {
    allLayer.clearLayers();
    if (!allOn || !FL.length) return;
    const lines = [];
    let n = 0;
    for (const f of FL) {
      if (!yearsOn.has(f.y)) continue;
      n++;
      const col = colorForYear(f.y);
      for (const pts of f.simple) {
        const pl = L.polyline(pts, { color: col, weight: 2.25, opacity: 0.85, renderer: allRenderer, bubblingMouseEvents: false, lineCap: 'round', lineJoin: 'round' });
        pl.bindPopup(() => flightPopupHtml(f), { maxWidth: 340 });
        pl.on('click', e => {
          L.DomEvent.stopPropagation(e);
          const hit = nearestPin(e.latlng);
          if (hit) {
            map.closePopup();
            showPhotoFlight(hit.m);
          }
        });
        pl.addTo(allLayer);
        lines.push(pl);
      }
    }
    if (fit && lines.length) {
      try { map.fitBounds(L.featureGroup(lines).getBounds(), { padding: [24, 24], maxZoom: 11 }); } catch (_) {}
    }
    if (!pick) {
      setStatus(n ? `<b>${n}</b> track${n > 1 ? 's' : ''} for the selected year${yearsOn.size === 1 ? '' : 's'}. Search or tap the map to see which flights passed a spot, or tap a track for details.` : (yearsOn.size ? 'No tracked flights in the selected years.' : 'No years selected. Choose a year, or All, to show tracks.'));
    }
  }

  function setAllTracks(on, fit) {
    allOn = !!on;
    const btn = $('alltracks');
    if (btn) { btn.setAttribute('aria-pressed', allOn ? 'true' : 'false'); btn.classList.toggle('on', allOn); }
    if (!allOn) allLayer.clearLayers();
    drawAllTracks(fit && allOn && !pick);
    if (!allOn && !pick && FL.length) setStatus(`<b>${FL.length}</b> GPS-tracked flights loaded. Search an address or tap the map, or show all tracks for the selected years.`);
  }

  function syncColorUi() {
    document.querySelectorAll('input[name="tcmode"]').forEach(r => { r.checked = r.value === colorMode; });
    const inp = $('tccolor');
    if (inp) { inp.value = trackColor; inp.disabled = colorMode === 'year'; }
    renderYearLegend();
  }
  function renderYearLegend() {
    const el = $('yearlegend');
    if (!el) return;
    if (colorMode !== 'year') { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    const yrs = [...yearsOn].sort((a, b) => a - b);
    el.innerHTML = yrs.map(y => `<label class="yl"><span>${y}</span><input type="color" data-year="${y}" value="${yearColors[y] || YEAR_DEFAULTS[y]}" aria-label="Color for ${y}"></label>`).join('') || '<span class="note">Check at least one year.</span>';
  }
  function applyColorChange() {
    saveColors();
    syncColorUi();
    drawAllTracks(false);
    if (pick) run(false);
  }
  function applyYearFilter() {
    renderYearLegend();
    drawAllTracks(false);
    run();
  }
  function setYearSelection(on) {
    yearsOn.clear();
    document.querySelectorAll('#years input[type=checkbox]').forEach(b => {
      b.checked = !!on;
      b.parentNode.classList.toggle('off', !b.checked);
      if (b.checked) yearsOn.add(+b.value);
    });
    applyYearFilter();
  }

  function photoKey(p) {
    if (!p) return '';
    if (p.id !== undefined && p.id !== null && p.id !== '') return 'id:' + p.id;
    if (p.u) return 'u:' + p.u;
    return 'txy:' + p.t + ':' + p.la + ':' + p.lo;
  }
  function indexPhoto(p, f) {
    const k = photoKey(p);
    if (!k || !f) return;
    let arr = photoFlights.get(k);
    if (!arr) { arr = []; photoFlights.set(k, arr); }
    if (!arr.some(x => x.id === f.id)) arr.push(f);
  }
  function flightsForPhoto(p, fallback) {
    const k = photoKey(p);
    const arr = (k && photoFlights.get(k)) || fallback || [];
    const seen = new Set();
    return arr.filter(f => f && !seen.has(f.id) && seen.add(f.id));
  }
  function nearestPin(latlng) {
    const pt = map.latLngToContainerPoint(latlng);
    let best = null;
    const layers = [phLayer, hiLayer];
    if (map.hasLayer(bestLayer)) layers.push(bestLayer);
    for (const layer of layers) {
      layer.eachLayer(m => {
        if (!m || !m._ppc || !m.getLatLng) return;
        const d = pt.distanceTo(map.latLngToContainerPoint(m.getLatLng()));
        if (d <= TAP_PX && (!best || d < best.d)) best = { d, m };
      });
    }
    return best;
  }
  function flightCardHtml(f, c) {
    const st = f.st, durH = (st.t1 - st.t0) / 3600;
    const dur = durH >= 1 ? `${durH.toFixed(1)} h` : `${Math.max(1, Math.round((st.t1 - st.t0) / 60))} min`;
    const mi = (st.dist / MI).toFixed(1) + ' mi';
    const htC = (c && f.agl && isFinite(c.ag)) ? (c.ag < 100 ? 'under 100 ft up' : `about ${(Math.round(c.ag / 50) * 50).toLocaleString()} ft up`) : '';
    const htF = !(f.agl && st.hasAg) ? '' : (st.maxAg < 100 ? 'max height under 100 ft' : `max about ${(Math.round(st.maxAg / 50) * 50).toLocaleString()} ft up`);
    const vids = (f.v || []).map(v => `<div class="vid">🎥 <a href="${esc(v.u)}" target="_blank" rel="noopener">${esc(v.t)}</a>${v.c === 'low' ? ' <span class="conf">(possible match)</span>' : ''}<span class="note">${NOTE}</span></div>`).join('');
    let ph = '';
    if ((f.ph || []).length) ph += `<div class="photos">Facebook photo post${f.ph.length > 1 ? 's' : ''} from this flight: ` + f.ph.slice(0, 4).map(p => `<a href="${esc(p.u)}" target="_blank" rel="noopener">${fmtDate(p.pd)}</a> (${p.n} photo${p.n > 1 ? 's' : ''})`).join(' · ') + (f.ph.length > 4 ? ` · +${f.ph.length - 4} more` : '') + '</div>';
    if (f.lr) ph += `<div class="photos lr">🖼️ ${f.lr.n.toLocaleString()} photo${f.lr.n > 1 ? 's' : ''} in Scott's photo library from this flight` + (f.lr.np ? ` (${f.lr.np} posted)` : '') + (f.bp.length ? `, ${f.bp.length} best-of (4–5★, posted) shown on the map when selected` : '') +
      (f.lr.lab ? ` · ${esc(f.lr.lab)}` : '') + (f.lr.sub && f.lr.sub.length ? `<br><span class="note">Possible subjects (a guess from the camera's direction): ${f.lr.sub.map(esc).join(', ')}</span>` : '') + '</div>';
    if (c && isFinite(c.d)) {
      return `<div class="r1"><span>${fmtDate(f.d)}</span><span>${fmtDist(c.d)} away</span></div>
        <div class="r2">Closest about ${fmtTime(c.t)} ET · ${htC || 'height not available'}</div>
        <div class="r2">${esc(f.ac)} · ${esc(f.n)}</div>${vids}${ph}`;
    }
    return `<div class="r1"><span>${fmtDate(f.d)}</span><span>${mi}</span></div>
      <div class="r2">${fmtTime(st.t0)} – ${fmtTime(st.t1)} ET · ${dur}${htF ? ' · ' + htF : ''}</div>
      <div class="r2">${esc(f.ac)} · ${esc(f.n)}</div>${vids}${ph}`;
  }
  function presentFlights(flights, status) {
    $('results').innerHTML = '';
    hiLayer.clearLayers();
    resLayer.clearLayers();
    const frag = document.createDocumentFragment();
    lastHits = flights.map(f => {
      const c = pick ? closest(f, pick[0], pick[1], 50 * MI) : null;
      return { f, c: c || { d: NaN, t: (f.st || {}).t0 } };
    });
    lastHits.forEach(({ f, c }) => {
      const li = document.createElement('li');
      li.dataset.id = f.id;
      li.innerHTML = flightCardHtml(f, c && isFinite(c.d) ? c : null);
      li.addEventListener('click', e => { if (e.target.tagName !== 'A') select(f.id); });
      frag.appendChild(li);
    });
    $('results').appendChild(frag);
    setStatus(status);
    if (flights[0]) select(flights[0].id);
  }
  function showPhotoFlight(m) {
    if (m && m.openPopup) m.openPopup();
    const info = (m && m._ppc) || {};
    const flights = flightsForPhoto(info.p, info.flights || []);
    if (!flights.length) {
      setStatus('Couldn’t match this photo to a tracked flight.');
      return;
    }
    const inList = lastHits.length && flights.every(f => lastHits.some(h => h.f.id === f.id));
    if (inList) {
      select(flights[0].id);
      if (flights.length > 1) setStatus(`This photo is on ${flights.length} flights. They’re listed below; tap one to see its track.`);
      if (m && m.openPopup) m.openPopup();
      return;
    }
    const status = flights.length > 1
      ? `This photo is on ${flights.length} flights. They’re listed below; tap one to see its track.`
      : 'Flight for the photo you tapped.';
    presentFlights(flights, status);
    if (m && m.openPopup) {
      map.once('moveend', () => { try { m.openPopup(); } catch (_) {} });
      setTimeout(() => { try { m.openPopup(); } catch (_) {} }, 400);
    }
  }

  function photoUrl(p) {
    if (p && p.u) return p.u;
    const id = (p && (p.id !== undefined)) ? p.id : p;
    return 'https://www.facebook.com/photo.php?fbid=' + encodeURIComponent(id);
  }
  function photoPin(p, layer, r, f) {
    const m = L.circleMarker([p.la, p.lo], { radius: r, color: '#7b2cbf', weight: 1.5, fillColor: '#c77dff', fillOpacity: 0.9 })
      .bindPopup(`📷 Photo taken about ${fmtTime(p.t)} ET, ${new Date(p.t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}<br><a href="${esc(photoUrl(p))}" target="_blank" rel="noopener">View Facebook post</a>`).addTo(layer);
    m._ppc = { kind: 'photo', p, flights: f ? [f] : [] };
    m.on('click', e => { L.DomEvent.stopPropagation(e); showPhotoFlight(m); });
    return m;
  }

  function bestStyle(p) {
    if (p.r >= 5) return { radius: 7, color: '#7a5200', weight: 1.6, fillColor: '#ffbf00', fillOpacity: 0.95 };
    return { radius: 5.5, color: '#9a6b00', weight: 1.5, fillColor: '#ffc93c', fillOpacity: 0.95 };
  }
  function bestPin(p, f, layer) {
    const d = new Date(p.t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
    const bits = [p.hd ? `camera facing ${esc(p.hd)}` : '', p.agl >= 0 ? (p.agl < 100 ? 'under 100 ft up' : `about ${(Math.round(p.agl / 50) * 50).toLocaleString()} ft up`) : ''].filter(Boolean).join(', ');
    const label = (p.r >= 5 ? '5★' : '4★') + (p.pk ? ', pick' : '');
    const m = L.circleMarker([p.la, p.lo], bestStyle(p))
      .bindPopup(`⭐ Best-of photo (${label}), about ${fmtTime(p.t)} ET, ${d}<br>Aircraft position when taken${bits ? ' · ' + bits : ''}` +
        (p.sub.length ? `<br><i>Possible subjects (guess): ${p.sub.map(esc).join(', ')}</i>` : '') +
        (p.u ? `<br><a href="${esc(p.u)}" target="_blank" rel="noopener">View Facebook post</a>` : '<br>Not posted online') + `<br><span style="color:#666">${esc(f.ac)} flight, ${fmtDate(f.d)}</span>`).addTo(layer);
    m._ppc = { kind: 'best', p, flights: f ? [f] : [] };
    m.on('click', e => { L.DomEvent.stopPropagation(e); showPhotoFlight(m); });
    return m;
  }

  // ---------- inputs
  map.on('click', e => {
    const hit = nearestPin(e.latlng);
    if (hit) { showPhotoFlight(hit.m); return; }
    setPick(e.latlng.lat, e.latlng.lng, false);
  });
  $('radius').addEventListener('change', () => run(true));
  $('alltracks').addEventListener('click', () => setAllTracks(!allOn, true));
  $('yearsall').addEventListener('click', () => setYearSelection(true));
  $('yearsnone').addEventListener('click', () => setYearSelection(false));
  document.querySelectorAll('input[name="tcmode"]').forEach(r => r.addEventListener('change', e => {
    if (!e.target.checked) return;
    colorMode = e.target.value === 'year' ? 'year' : 'single';
    applyColorChange();
  }));
  $('tccolor').addEventListener('input', e => {
    const v = e.target.value;
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) { trackColor = v; applyColorChange(); }
  });
  $('yearlegend').addEventListener('input', e => {
    const y = e.target.getAttribute('data-year'), v = e.target.value;
    if (y && /^#[0-9A-Fa-f]{6}$/.test(v)) { yearColors[y] = v; applyColorChange(); }
  });
  let lastQ = 0; const cache = new Map();
  $('search').addEventListener('submit', async e => {
    e.preventDefault();
    const q = $('q').value.trim(); if (!q) return;
    if (cache.has(q)) { const r = cache.get(q); return r ? setPick(r[0], r[1], true) : setStatus('No match for that address. Try adding the town, or tap the map.'); }
    const wait = 1100 - (Date.now() - lastQ); if (wait > 0) await new Promise(r => setTimeout(r, wait));   // geocoder etiquette: at most 1 request per second
    lastQ = Date.now(); $('go').disabled = true; setStatus('Searching…');
    let hit = null, ok = false;
    try {   // 1) Photon (komoot): keyless, CORS-open, works from file://; biased to central Indiana, US results preferred
      const r = await fetch('https://photon.komoot.io/api/?limit=5&lang=en&lat=39.6&lon=-85.9&q=' + encodeURIComponent(q));
      if (r.ok) { ok = true; const j = await r.json(); const fs = (j.features || []); const f = fs.find(x => x.properties && x.properties.countrycode === 'US') || fs[0];
        if (f) hit = [f.geometry.coordinates[1], f.geometry.coordinates[0]]; }
    } catch (_) {}
    if (!hit) try {   // 2) fallback: Nominatim
      const r = await fetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&viewbox=-88.2,42.0,-80.5,37.7&q=' + encodeURIComponent(q));
      if (r.ok) { ok = true; const j = await r.json(); if (j[0]) hit = [+j[0].lat, +j[0].lon]; }
    } catch (_) {}
    $('go').disabled = false;
    if (hit) { cache.set(q, hit); setPick(hit[0], hit[1], true); }
    else setStatus(ok ? 'No match for that address. Try adding the town, or tap the map.' : 'Address search is unavailable right now. You can still tap the map.');
  });
  $('loc').addEventListener('click', () => {
    if (!navigator.geolocation) return setStatus('Your browser does not share location. Tap the map instead.');
    setStatus('Finding your location…');
    navigator.geolocation.getCurrentPosition(p => setPick(p.coords.latitude, p.coords.longitude, true), () => setStatus('Could not get your location. Search an address or tap the map.'), { enableHighAccuracy: true, timeout: 10000 });
  });
  window.__site = { setPick, select, hits: () => lastHits, setAllTracks, drawAllTracks, setColorMode: m => { colorMode = m === 'year' ? 'year' : 'single'; applyColorChange(); }, colorMode: () => colorMode, allOn: () => allOn, setYearSelection, yearsOn: () => [...yearsOn].sort((a, b) => a - b), nearestPin, showPhotoFlight, showPhotoAt: (la, lo) => { const hit = nearestPin(L.latLng(la, lo)); if (hit) showPhotoFlight(hit.m); return hit && { d: hit.d, kind: hit.m._ppc && hit.m._ppc.kind, id: ((hit.m._ppc.flights||[])[0]||{}).id }; } };
  syncColorUi();
})();
