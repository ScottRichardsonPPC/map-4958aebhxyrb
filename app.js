(() => {
  'use strict';
  const MI = 1609.344, NOTE = 'Video may not include every part of this flight; the section over your location might not have been filmed or kept.';
  const LS_MODE = 'ppc-track-color-mode', LS_COLOR = 'ppc-track-color', LS_YEARS = 'ppc-track-year-colors';
  const DEFAULT_COLOR = '#FFB000';
  // Best-of (4–5★) layer. Public builds set this to false via make_site_public.py unless --best-of is passed.
  const SHOW_BEST_OF = false;
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
  const overlays = SHOW_BEST_OF ? { 'Best-of photos (4–5★)': bestLayer } : {};
  L.control.layers({ 'Street map': street, 'Satellite': sat, 'Topographic': topo }, overlays, { position: 'topright', collapsed: false }).addTo(map);
  const LocateCtl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      const d = L.DomUtil.create('div', 'leaflet-bar leaflet-control ppc-locate');
      const a = L.DomUtil.create('a', '', d);
      a.href = '#'; a.role = 'button';
      a.title = 'Find my location. Your location is never stored or sent anywhere.';
      a.setAttribute('aria-label', 'Find my location. Your location is never stored or sent anywhere.');
      a.textContent = '📍';
      L.DomEvent.disableClickPropagation(d);
      L.DomEvent.on(a, 'click', ev => { L.DomEvent.preventDefault(ev); locateMe(); });
      return d;
    }
  });
  map.addControl(new LocateCtl());
  const legend = L.control({ position: 'bottomleft' });
  legend.onAdd = function () {
    const d = L.DomUtil.create('div', 'best-legend');
    d.innerHTML = '<div class="lg"><span class="dot gold-lg"></span> 5-star, posted on Facebook</div>'
      + '<div class="lg"><span class="dot gold"></span> 4-star, posted on Facebook</div>';
    return d;
  };
  if (SHOW_BEST_OF) legend.addTo(map);
  if (!SHOW_BEST_OF) { const _bc = document.getElementById('bestof-copy'); if (_bc) _bc.remove(); }
  const allRenderer = L.canvas({ padding: 0.5 });
  const allLayer = L.layerGroup().addTo(map);
  let FL = [], ZONES = [], pick = null, pickMarker = null, circle = null, hereMarker = null, resLayer = L.layerGroup().addTo(map), hiLayer = L.layerGroup().addTo(map), phLayer = L.layerGroup().addTo(map), lastHits = [], selId = null, browseAll = false, onlyThis = false, ignoreHash = false, lastCopied = '';
  const SHARE_ICO = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92Z"/></svg>';
  const photoFlights = new Map();   // photo key -> flights (a post/photo can appear on more than one)
  const TAP_PX = 20;   // generous tap target for photo pins, including on a phone
  const TRACK_PX = 18;   // generous tap target for tracks, including on a phone
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
    if (SHOW_BEST_OF) FL.forEach(f => f.bp.forEach(p => bestPin(p, f, bestLayer)));
    const yrs = [...new Set(FL.map(f => f.y))].sort();
    yrs.forEach(y => yearsOn.add(y));
    $('years').innerHTML = yrs.map(y => `<label><input type="checkbox" value="${y}" checked>${y}</label>`).join('');
    $('years').addEventListener('change', e => {
      const y = +e.target.value; e.target.checked ? yearsOn.add(y) : yearsOn.delete(y); e.target.parentNode.classList.toggle('off', !e.target.checked);
      applyYearFilter();
    });
    syncColorUi();
    setStatus(`<b>${FL.length}</b> GPS-tracked flights loaded. Search an address or tap the map, or show all tracks for the selected years.`);
    applyHash();
    window.addEventListener('hashchange', () => { if (!ignoreHash) applyHash(); });
  }).catch(() => setStatus('Could not load the flight data. Please reload the page.'));

  // ---------- helpers
  const setStatus = h => { $('status').innerHTML = h; };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function pageBase() {
    const path = location.pathname.endsWith('/') ? location.pathname : location.pathname.replace(/[^/]+$/, '');
    return location.origin + path;
  }
  function flightShareUrl(f) { return pageBase() + '#f=' + encodeURIComponent(f.id); }
  function setHash(s) {
    ignoreHash = true;
    try { history.replaceState(null, '', s); } catch (_) {}
    setTimeout(() => { ignoreHash = false; }, 0);
  }
  function toast(msg) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 1800);
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); }
      catch (e) { reject(e); }
      finally { ta.remove(); }
    });
  }
  function shareLink(url, title) {
    lastCopied = url;
    const payload = { title: title || 'Scott’s powered parachute flight', text: title || '', url };
    if (navigator.share) {
      return navigator.share(payload).catch(err => {
        if (err && err.name === 'AbortError') return;
        return copyText(url).then(() => toast('Link copied')).catch(() => setStatus('Could not copy the link. You can copy it from the address bar.'));
      });
    }
    return copyText(url).then(() => toast('Link copied')).catch(() => setStatus('Could not copy the link. You can copy it from the address bar.'));
  }
  function shareIco(url, label) {
    if (!url) return '';
    return ` <button type="button" class="share-ico" data-share-url="${esc(url)}" title="Share ${label}" aria-label="Share ${label}">${SHARE_ICO}</button>`;
  }
  function shareFlightBtn(f) {
    return `<button type="button" class="share-flight" data-share="flight" data-id="${esc(f.id)}" title="Share a link to this flight">Share</button>`;
  }
  function vidsHtml(f) {
    return (f.v || []).map(v => `<div class="vid">🎥 <a href="${esc(v.u)}" target="_blank" rel="noopener">${esc(v.t)}</a>${shareIco(v.u, 'this video')}${v.c === 'low' ? ' <span class="conf">(possible match)</span>' : ''}<span class="note">${NOTE}</span></div>`).join('');
  }
  function fbLink(url, text) {
    if (!url) return '';
    return `<a href="${esc(url)}" target="_blank" rel="noopener">${text}</a>${shareIco(url, 'this Facebook post')}`;
  }
  function openFlightLink(id) {
    if (!id) { setStatus('That flight link is missing a flight. Search an address or tap the map, or turn on all tracks.'); return false; }
    const f = FL.find(x => x.id === id);
    if (!f) { setStatus('Couldn’t find that flight. It may have been removed, or the link may be incomplete.'); return false; }
    browseAll = false;
    presentFlights([f], `Showing the shared flight, ${fmtDate(f.d)}.`, { fit: true });
    return true;
  }
  function applyHash() {
    const raw = location.hash.replace(/^#/, '');
    if (!raw) return;
    const h = new URLSearchParams(raw);
    if (/(?:^|&)f=/.test(raw)) { openFlightLink(h.get('f')); return; }
    let la = h.get('lat'), lo = h.get('lon');
    const p = h.get('p');
    if (p && p.indexOf(',') >= 0) { const parts = p.split(','); la = parts[0]; lo = parts[1]; }
    if (la && lo && isFinite(+la) && isFinite(+lo)) setPick(+la, +lo, true);
  }
  function locateMe() {
    if (!navigator.geolocation) return setStatus('Your browser does not share location. Search an address or tap the map instead.');
    setStatus('Finding your location… Your location is never stored or sent anywhere.');
    navigator.geolocation.getCurrentPosition(pos => {
      const la = pos.coords.latitude, lo = pos.coords.longitude;
      const icon = L.divIcon({ className: 'here-marker', html: '<span class="here-dot"></span><span class="here-ring"></span>', iconSize: [24, 24], iconAnchor: [12, 12] });
      if (hereMarker) hereMarker.setLatLng([la, lo]).setIcon(icon);
      else hereMarker = L.marker([la, lo], { icon, zIndexOffset: 1200, keyboard: false }).bindTooltip('You are here', { direction: 'top' }).addTo(map);
      setPick(la, lo, true);
    }, err => {
      const code = err && err.code;
      if (code === 1) setStatus('Location permission was denied. You can still search an address or tap the map. Your location is never stored or sent anywhere.');
      else if (code === 3) setStatus('Location is taking too long. Search an address or tap the map instead.');
      else setStatus('Could not get your location. Search an address or tap the map instead. Your location is never stored or sent anywhere.');
    }, { enableHighAccuracy: true, timeout: 10000 });
  }
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
    let ph = '';
    if ((f.ph || []).length) {
      ph = `<div class="photos">Facebook post${f.ph.length > 1 ? 's' : ''}: ` +
        f.ph.map(p => fbLink(p.u, `${fmtDate(p.pd)}`) + ` (${p.n} photo${p.n > 1 ? 's' : ''})`).join(' · ') + '</div>';
    }
    return `<div class="flight-pop"><b>${fmtDate(f.d)}</b> ${shareFlightBtn(f)}<br>${fmtTime(st.t0)} – ${fmtTime(st.t1)} ET · ${dur} · ${mi.toFixed(1)} mi${ht}<br>${esc(f.ac)} · ${esc(f.n)}${vidsHtml(f)}${ph}</div>`;
  }

  function setPick(la, lo, fit) {
    browseAll = false;
    pick = [la, lo];
    if (!pickMarker) pickMarker = L.marker(pick).addTo(map); else pickMarker.setLatLng(pick);
    setHash('#lat=' + la.toFixed(5) + '&lon=' + lo.toFixed(5));
    run(fit);
  }

  function run(fit) {
    if (!pick || !FL.length) return;
    if (onlyThis) { onlyThis = false; applyOnlyThis(); }
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
      const vids = vidsHtml(f);
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
          '<br>' + postLinks.map(u => fbLink(u, 'View Facebook post')).join(' · ') + '</div>';
      }
      if ((f.ph || []).length) ph += `<div class="photos">Facebook photo post${f.ph.length > 1 ? 's' : ''} from this flight: ` + f.ph.slice(0, 4).map(p => fbLink(p.u, fmtDate(p.pd)) + ` (${p.n} photo${p.n > 1 ? 's' : ''})`).join(' · ') + (f.ph.length > 4 ? ` · +${f.ph.length - 4} more` : '') + '</div>';
      if (f.lr) ph += `<div class="photos lr">🖼️ ${f.lr.n.toLocaleString()} photo${f.lr.n > 1 ? 's' : ''} in Scott's photo library from this flight` + (f.lr.np ? ` (${f.lr.np} posted)` : '') + (SHOW_BEST_OF && f.bp.length ? `, ${f.bp.length} best-of (4–5★, posted) shown on the map when selected` : '') +
        (f.lr.lab ? ` · ${esc(f.lr.lab)}` : '') + (f.lr.sub.length ? `<br><span class="note">Possible subjects (a guess from the camera's direction): ${f.lr.sub.map(esc).join(', ')}</span>` : '') + '</div>';
      li.innerHTML = `<div class="r1"><span>${fmtDate(f.d)}</span><span>${fmtDist(c.d)} away ${shareFlightBtn(f)}</span></div>
        <div class="r2">Closest about ${fmtTime(c.t)} ET · ${ht}</div>
        <div class="r2">${esc(f.ac)} · ${esc(f.n)}</div>${vids}${ph}`;
      li.addEventListener('click', e => { if (e.target.closest('a, button')) return; select(f.id); });
      frag.appendChild(li);
      const col = colorForYear(f.y);
      f.segs.forEach(g => L.polyline([...g.la].map((a, i) => [a, g.lo[i]]), { color: col, weight: 2, opacity: 0.55, interactive: false }).addTo(resLayer));
    });
    $('results').appendChild(frag);
  }

  function select(id, opts) {
    const h = lastHits.find(x => x.f.id === id);
    const f = h ? h.f : FL.find(x => x.id === id);
    if (!f) return;
    let c = h && h.c && isFinite(h.c.d) ? h.c : null;
    if (!c && pick) {
      const near = closest(f, pick[0], pick[1], 50 * MI);
      if (near) c = near;
    }
    highlightFlight(f, c, opts);
  }
  function highlightFlight(f, c, opts) {
    const fit = !opts || opts.fit !== false;
    selId = f.id;
    setHash('#f=' + encodeURIComponent(f.id));
    hiLayer.clearLayers();
    document.querySelectorAll('#results li').forEach(li => li.classList.toggle('sel', li.dataset.id === f.id));
    const row = document.querySelector('#results li[data-id="' + (window.CSS && CSS.escape ? CSS.escape(f.id) : f.id.replace(/"/g, '')) + '"]');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const lines = f.segs.map(g => L.polyline([...g.la].map((a, i) => [a, g.lo[i]]), { color: '#f28c18', weight: 4, opacity: 0.95 }).addTo(hiLayer));
    if (c && isFinite(c.d) && isFinite(c.la) && isFinite(c.lo)) {
      L.circleMarker([c.la, c.lo], { radius: 6, color: '#b3261e', fillColor: '#fff', fillOpacity: 1, weight: 3 }).bindTooltip(`Closest: ${fmtDist(c.d)}, about ${fmtTime(c.t)} ET`).addTo(hiLayer);
    }
    f.pp.forEach(p => photoPin(p, hiLayer, 3.5, f));
    if (SHOW_BEST_OF) f.bp.forEach(p => bestPin(p, f, hiLayer));
    if (fit && lines.length) {
      const b = L.featureGroup(lines).getBounds();
      if (pick) b.extend(pick);
      map.fitBounds(b, { padding: [24, 24], maxZoom: 14 });
      if (window.innerWidth < 800) $('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    applyOnlyThis();
  }
  function applyOnlyThis() {
    const hide = !!(onlyThis && selId);
    const ensure = (layer, show) => {
      if (show) { if (!map.hasLayer(layer)) map.addLayer(layer); }
      else if (map.hasLayer(layer)) map.removeLayer(layer);
    };
    ensure(allLayer, !hide);
    ensure(resLayer, !hide);
    ensure(phLayer, !hide);
    if (map.hasLayer(hiLayer)) map.removeLayer(hiLayer);
    hiLayer.addTo(map);
    syncOnlyThisUi();
  }
  function setOnlyThis(on) {
    onlyThis = !!(on && selId);
    applyOnlyThis();
  }
  function syncOnlyThisUi() {
    document.querySelectorAll('#results .only-this').forEach(el => el.remove());
    const row = document.querySelector('#results li.sel');
    if (!row || !selId) return;
    const wrap = document.createElement('div');
    wrap.className = 'only-this';
    wrap.innerHTML = `<button type="button" class="only-this-btn" data-only-this aria-pressed="${onlyThis ? 'true' : 'false'}">${onlyThis ? 'Showing only this flight' : 'Show only this flight'}</button>`;
    row.appendChild(wrap);
  }
  function openPhotoPopup(m, p) {
    if (m && m._map && typeof m.openPopup === 'function') { m.openPopup(); return true; }
    const key = photoKey(p || (m && m._ppc && m._ppc.p));
    const ll = m && m.getLatLng ? m.getLatLng() : null;
    const layers = [hiLayer, phLayer];
    if (map.hasLayer(bestLayer)) layers.push(bestLayer);
    let found = null;
    for (const layer of layers) {
      layer.eachLayer(x => {
        if (!x._ppc || typeof x.openPopup !== 'function') return;
        const sameKey = key && photoKey(x._ppc.p) === key;
        const samePt = ll && x.getLatLng && x.getLatLng().equals(ll);
        if (sameKey || samePt) found = found || x;
      });
    }
    if (found) { found.openPopup(); return true; }
    return false;
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
            return;
          }
          selectTrackFromMap(f);
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
    if (onlyThis && selId) applyOnlyThis();
  }

  function clearPick() {
    pick = null;
    if (pickMarker) { pickMarker.remove(); pickMarker = null; }
    if (circle) { circle.remove(); circle = null; }
    resLayer.clearLayers();
    phLayer.clearLayers();
    try {
      const u = location.pathname + location.search;
      if (location.hash) history.replaceState(null, '', u);
    } catch (_) {}
  }
  function setAllTracks(on, fit) {
    allOn = !!on;
    const btn = $('alltracks');
    if (btn) { btn.setAttribute('aria-pressed', allOn ? 'true' : 'false'); btn.classList.toggle('on', allOn); }
    if (!allOn) {
      allLayer.clearLayers();
      const wasBrowse = browseAll;
      browseAll = false;
      if (pick) run(false);
      else {
        if (wasBrowse) { lastHits = []; selId = null; onlyThis = false; $('results').innerHTML = ''; hiLayer.clearLayers(); applyOnlyThis(); }
        if (FL.length) setStatus(`<b>${FL.length}</b> GPS-tracked flights loaded. Search an address or tap the map, or show all tracks for the selected years.`);
      }
      return;
    }
    browseAll = true;
    onlyThis = false;
    clearPick();
    drawAllTracks(fit);
    listSelectedYearFlights();
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
    if (browseAll && allOn) listSelectedYearFlights(true);
    else if (pick) run(false);
  }
  function applyYearFilter() {
    renderYearLegend();
    drawAllTracks(false);
    if (browseAll && allOn) listSelectedYearFlights(true);
    else run();
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
  function distPointSegPx(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    let u = L2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    return p.distanceTo(L.point(a.x + u * dx, a.y + u * dy));
  }
  function nearestTrack(latlng, maxPx) {
    if (maxPx == null) maxPx = TRACK_PX;
    const pt = map.latLngToContainerPoint(latlng);
    const cands = [];
    const seen = new Set();
    const add = f => { if (f && !seen.has(f.id)) { seen.add(f.id); cands.push(f); } };
    if (allOn) FL.forEach(f => { if (yearsOn.has(f.y)) add(f); });
    lastHits.forEach(h => add(h.f));
    if (selId) add(FL.find(x => x.id === selId));
    if (!cands.length) return null;
    let best = null;
    const pad = maxPx;
    for (const f of cands) {
      const bb = f.bb;
      if (bb) {
        const sw = map.latLngToContainerPoint([bb[0], bb[1]]), ne = map.latLngToContainerPoint([bb[2], bb[3]]);
        const minx = Math.min(sw.x, ne.x) - pad, maxx = Math.max(sw.x, ne.x) + pad;
        const miny = Math.min(sw.y, ne.y) - pad, maxy = Math.max(sw.y, ne.y) + pad;
        if (pt.x < minx || pt.x > maxx || pt.y < miny || pt.y > maxy) continue;
      }
      let dBest = Infinity;
      const walk = (la, lo) => {
        const n = la.length;
        if (!n) return;
        let prev = map.latLngToContainerPoint([la[0], lo[0]]);
        if (n === 1) { dBest = Math.min(dBest, pt.distanceTo(prev)); return; }
        for (let i = 1; i < n; i++) {
          const cur = map.latLngToContainerPoint([la[i], lo[i]]);
          const d = distPointSegPx(pt, prev, cur);
          if (d < dBest) dBest = d;
          prev = cur;
        }
      };
      if (f.segs) for (const g of f.segs) walk(g.la, g.lo);
      else if (f.simple) for (const pts of f.simple) walk(pts.map(p => p[0]), pts.map(p => p[1]));
      if (dBest <= maxPx && (!best || dBest < best.d)) best = { f, d: dBest };
    }
    return best;
  }
  function listSelectedYearFlights(keepSel) {
    const prev = keepSel ? selId : null;
    const flights = FL.filter(f => yearsOn.has(f.y)).sort((a, b) => (a.d === b.d ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : (a.d < b.d ? 1 : -1)));
    $('results').innerHTML = '';
    resLayer.clearLayers();
    const frag = document.createDocumentFragment();
    lastHits = flights.map(f => ({ f, c: { d: NaN, t: (f.st || {}).t0 } }));
    lastHits.forEach(({ f, c }) => {
      const li = document.createElement('li');
      li.dataset.id = f.id;
      li.innerHTML = flightCardHtml(f, null);
      li.addEventListener('click', e => { if (e.target.closest('a, button')) return; select(f.id); });
      frag.appendChild(li);
    });
    $('results').appendChild(frag);
    const n = flights.length;
    setStatus(n ? `<b>${n}</b> flight${n > 1 ? 's' : ''} for the selected year${yearsOn.size === 1 ? '' : 's'}, newest first. Tap a track or a row for details, or tap an empty spot on the map to see which flights passed there.` : (yearsOn.size ? 'No tracked flights in the selected years.' : 'No years selected. Choose a year, or All, to show flights.'));
    if (prev && lastHits.some(h => h.f.id === prev)) select(prev, { fit: false });
    else { selId = null; onlyThis = false; hiLayer.clearLayers(); applyOnlyThis(); }
  }
  function ensureFlightInList(f) {
    if (!f || lastHits.some(h => h.f.id === f.id)) return;
    const c = pick ? closest(f, pick[0], pick[1], 50 * MI) : null;
    lastHits.unshift({ f, c: c || { d: NaN, t: (f.st || {}).t0 } });
    const li = document.createElement('li');
    li.dataset.id = f.id;
    li.innerHTML = flightCardHtml(f, c && isFinite(c.d) ? c : null);
    li.addEventListener('click', e => { if (e.target.closest('a, button')) return; select(f.id); });
    const ol = $('results');
    ol.insertBefore(li, ol.firstChild);
  }
  function selectTrackFromMap(f) {
    if (!f) return;
    ensureFlightInList(f);
    select(f.id, { fit: false });
  }
  function flightCardHtml(f, c) {
    const st = f.st, durH = (st.t1 - st.t0) / 3600;
    const dur = durH >= 1 ? `${durH.toFixed(1)} h` : `${Math.max(1, Math.round((st.t1 - st.t0) / 60))} min`;
    const mi = (st.dist / MI).toFixed(1) + ' mi';
    const htC = (c && f.agl && isFinite(c.ag)) ? (c.ag < 100 ? 'under 100 ft up' : `about ${(Math.round(c.ag / 50) * 50).toLocaleString()} ft up`) : '';
    const htF = !(f.agl && st.hasAg) ? '' : (st.maxAg < 100 ? 'max height under 100 ft' : `max about ${(Math.round(st.maxAg / 50) * 50).toLocaleString()} ft up`);
    const vids = vidsHtml(f);
    let ph = '';
    if ((f.ph || []).length) ph += `<div class="photos">Facebook photo post${f.ph.length > 1 ? 's' : ''} from this flight: ` + f.ph.slice(0, 4).map(p => fbLink(p.u, fmtDate(p.pd)) + ` (${p.n} photo${p.n > 1 ? 's' : ''})`).join(' · ') + (f.ph.length > 4 ? ` · +${f.ph.length - 4} more` : '') + '</div>';
    if (f.lr) ph += `<div class="photos lr">🖼️ ${f.lr.n.toLocaleString()} photo${f.lr.n > 1 ? 's' : ''} in Scott's photo library from this flight` + (f.lr.np ? ` (${f.lr.np} posted)` : '') + (SHOW_BEST_OF && f.bp.length ? `, ${f.bp.length} best-of (4–5★, posted) shown on the map when selected` : '') +
      (f.lr.lab ? ` · ${esc(f.lr.lab)}` : '') + (f.lr.sub && f.lr.sub.length ? `<br><span class="note">Possible subjects (a guess from the camera's direction): ${f.lr.sub.map(esc).join(', ')}</span>` : '') + '</div>';
    if (c && isFinite(c.d)) {
      return `<div class="r1"><span>${fmtDate(f.d)}</span><span>${fmtDist(c.d)} away ${shareFlightBtn(f)}</span></div>
        <div class="r2">Closest about ${fmtTime(c.t)} ET · ${htC || 'height not available'}</div>
        <div class="r2">${esc(f.ac)} · ${esc(f.n)}</div>${vids}${ph}`;
    }
    return `<div class="r1"><span>${fmtDate(f.d)}</span><span>${mi} ${shareFlightBtn(f)}</span></div>
      <div class="r2">${fmtTime(st.t0)} – ${fmtTime(st.t1)} ET · ${dur}${htF ? ' · ' + htF : ''}</div>
      <div class="r2">${esc(f.ac)} · ${esc(f.n)}</div>${vids}${ph}`;
  }
  function presentFlights(flights, status, opts) {
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
      li.addEventListener('click', e => { if (e.target.closest('a, button')) return; select(f.id); });
      frag.appendChild(li);
    });
    $('results').appendChild(frag);
    setStatus(status);
    if (flights[0]) select(flights[0].id, opts);
  }
  function showPhotoFlight(m) {
    const info = (m && m._ppc) || {};
    const flights = flightsForPhoto(info.p, info.flights || []);
    if (!flights.length) {
      openPhotoPopup(m, info.p);
      setStatus('Couldn’t match this photo to a tracked flight.');
      return;
    }
    const already = flights.some(f => f.id === selId);
    if (already) {
      openPhotoPopup(m, info.p);
      return;
    }
    const inList = lastHits.length && flights.every(f => lastHits.some(h => h.f.id === f.id));
    if (inList) {
      select(flights[0].id, { fit: false });
      if (flights.length > 1) setStatus(`This photo is on ${flights.length} flights. They’re listed below; tap one to see its track.`);
      openPhotoPopup(m, info.p);
      return;
    }
    const status = flights.length > 1
      ? `This photo is on ${flights.length} flights. They’re listed below; tap one to see its track.`
      : 'Flight for the photo you tapped.';
    presentFlights(flights, status, { fit: false });
    openPhotoPopup(m, info.p);
  }

  function photoUrl(p) {
    if (p && p.u) return p.u;
    const id = (p && (p.id !== undefined)) ? p.id : p;
    return 'https://www.facebook.com/photo.php?fbid=' + encodeURIComponent(id);
  }
  function photoPin(p, layer, r, f) {
    const m = L.circleMarker([p.la, p.lo], { radius: r, color: '#7b2cbf', weight: 1.5, fillColor: '#c77dff', fillOpacity: 0.9 })
      .bindPopup(`📷 Photo taken about ${fmtTime(p.t)} ET, ${new Date(p.t * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}<br>${fbLink(photoUrl(p), 'View Facebook post')}`).addTo(layer);
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
        (p.u ? `<br>${fbLink(p.u, 'View Facebook post')}` : '<br>Not posted online') + `<br><span style="color:#666">${esc(f.ac)} flight, ${fmtDate(f.d)}</span>`).addTo(layer);
    m._ppc = { kind: 'best', p, flights: f ? [f] : [] };
    m.on('click', e => { L.DomEvent.stopPropagation(e); showPhotoFlight(m); });
    return m;
  }

  // ---------- inputs
  map.on('click', e => {
    const pin = nearestPin(e.latlng);
    if (pin) { showPhotoFlight(pin.m); return; }
    const tr = nearestTrack(e.latlng);
    if (tr) { selectTrackFromMap(tr.f); return; }
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
  $('loc').addEventListener('click', locateMe);
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-only-this]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    setOnlyThis(!onlyThis);
  });
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-share], [data-share-url]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    if (btn.getAttribute('data-share') === 'flight') {
      const id = btn.getAttribute('data-id');
      const f = FL.find(x => x.id === id);
      if (f) shareLink(flightShareUrl(f), 'Scott’s flight on ' + fmtDate(f.d));
      return;
    }
    const url = btn.getAttribute('data-share-url');
    if (url) shareLink(url, btn.getAttribute('aria-label') || 'Shared link');
  });
  window.__site = { setPick, select, hits: () => lastHits, setAllTracks, drawAllTracks, setColorMode: m => { colorMode = m === 'year' ? 'year' : 'single'; applyColorChange(); }, colorMode: () => colorMode, allOn: () => allOn, setYearSelection, yearsOn: () => [...yearsOn].sort((a, b) => a - b), nearestPin, showPhotoFlight, showPhotoAt: (la, lo) => { const hit = nearestPin(L.latLng(la, lo)); if (hit) showPhotoFlight(hit.m); return hit && { d: hit.d, kind: hit.m._ppc && hit.m._ppc.kind, id: ((hit.m._ppc.flights||[])[0]||{}).id }; }, nearestTrack, selectTrackFromMap, listSelectedYearFlights, browseAll: () => browseAll, selectTrackAt: (la, lo) => { const t = nearestTrack(L.latLng(la, lo)); if (t) selectTrackFromMap(t.f); return t && { d: t.d, id: t.f.id }; }, openFlightLink, applyHash, flightShareUrl, shareLink, locateMe, lastCopied: () => lastCopied, hereMarker: () => hereMarker, onlyThis: () => onlyThis, setOnlyThis, showBestOf: () => SHOW_BEST_OF };
  syncColorUi();
})();
