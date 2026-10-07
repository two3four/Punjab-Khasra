/* Punjab Khasra Explorer – serverless (Vercel) edition.
   Parcels are fetched live from the Punjab Zameen ArcGIS server straight from the browser.
   Only the PULSE token and admin lists go through /api (PULSE has no CORS).
   Opened mauzas are saved in this browser (IndexedDB) and re-downloaded every 24 h while the page is open. */
const CFG = Object.assign({
  gis: "https://gismaps.punjab-zameen.gov.pk/arcgis/rest/services/VendorMaps/Punjab_Cdastral_Maps/MapServer",
  api: "/api",
  refreshHours: 24,
  pageSize: 2000,
  concurrency: 3,
}, window.PCK_CONFIG || {});

const DIVISIONS = [
  [1, "Bahawalpur", "69.468316822,27.703041182,73.974162581,30.383153413"],
  [2, "Dera Ghazi Khan", "69.33046612,28.407440247,71.832969032,31.395171158"],
  [3, "Faisalabad", "71.617896854,30.537063185,73.670740371,31.993213768"],
  [4, "Gujranwala", "73.775625406,31.813297434,75.365623901,32.843030586"],
  [11, "Gujrat", "73.047317886,31.756950693,74.469254201,33.038330521"],
  [5, "Lahore", "73.262896355,30.627420793,74.702264249,32.068156379"],
  [6, "Multan", "71.019918862,29.35305958,72.971588126,30.740270878"],
  [7, "Rawalpindi", "71.706392048,32.428694375,73.798404543,34.023247124"],
  [8, "Sahiwal", "72.385065605,30.000724909,74.134936998,31.147395767"],
  [9, "Sargodha", "70.82779843,31.162103104,73.299354259,33.228880946"],
].map(([id, name, extent]) => ({ id, name, extent }));

/* ---------------- helpers ---------------- */
const $ = (id) => document.getElementById(id);
const fmtN = (n) => (n == null ? "–" : Number(n).toLocaleString());
const MARLA_M2 = 272.25 * 0.09290304, KANAL_M2 = MARLA_M2 * 20, ACRE_M2 = KANAL_M2 * 8;
const fmtAcres = (m2) => (m2 == null ? "–" : (m2 / ACRE_M2).toLocaleString(undefined, { maximumFractionDigits: 1 }));
const fmtKM = (m2) => { const k = Math.floor(m2 / KANAL_M2); return `${k}K-${((m2 - k * KANAL_M2) / MARLA_M2).toFixed(1)}M`; };
const ago = (ts) => {
  if (!ts) return "never";
  const s = Date.now() / 1000 - ts;
  if (s < 90) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
};
const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString() : "–");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const now = () => Date.now() / 1000;

async function getJSON(url) {
  const r = await fetch(url);
  let body = null;
  try { body = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error((body && body.error) || `${r.status} ${r.statusText}`);
  return body;
}

/* ---------------- geometry ---------------- */
function ringArea(c) {
  const R = 6378137, n = c.length;
  if (n < 3) return 0;
  let t = 0;
  for (let i = 0; i < n; i++) {
    const lo = c[i], mi = c[(i + 1) % n], hi = c[(i + 2) % n];
    t += (hi[0] - lo[0]) * Math.PI / 180 * Math.sin(mi[1] * Math.PI / 180);
  }
  return Math.abs(t * R * R / 2);
}
function geomArea(g) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  let a = 0;
  for (const p of polys) if (p.length) a += ringArea(p[0]) - p.slice(1).reduce((s, h) => s + ringArea(h), 0);
  return a;
}
function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + ":" + str.length.toString(36);
}
const VOLATILE = new Set(["OBJECTID", "Shape.STArea()", "Shape.STLength()", "area_m2", "area_KM"]);
function parcelHash(f) {
  const p = f.properties || {};
  const keys = Object.keys(p).filter((k) => !VOLATILE.has(k)).sort();
  return fnv(JSON.stringify(keys.map((k) => [k, p[k]])) + JSON.stringify(f.geometry));
}
function parcelKey(f) {
  const p = f.properties || {};
  return p.Khasra_ID ? String(p.Khasra_ID) : "oid:" + (p.OBJECTID ?? f.id);
}

/* ---------------- GIS access ---------------- */
let TOKEN = null, TOKEN_AT = 0;
async function token(force) {
  if (!force && TOKEN && Date.now() - TOKEN_AT < 15 * 60e3) return TOKEN;
  const d = await getJSON(`${CFG.api}/token${force ? "?t=" + Date.now() : ""}`);
  TOKEN = d.token; TOKEN_AT = Date.now();
  return TOKEN;
}
const STATS = { requests: 0, errors: 0, lastOk: null, lastError: null };
let active = 0;
const waiters = [];
async function slot() {
  if (active < CFG.concurrency) { active++; return; }
  await new Promise((ok) => waiters.push(ok));
  active++;
}
function release() { active--; const w = waiters.shift(); if (w) w(); }

async function gis(path, params = {}, retries = 4) {
  let lastErr, forceTok = false;
  for (let i = 0; i < retries; i++) {
    const qs = new URLSearchParams({ f: "json", ...params, token: await token(forceTok) });
    forceTok = false;
    await slot();
    try {
      STATS.requests++;
      const r = await fetch(`${CFG.gis}${path}?${qs}`);
      if (!r.ok) throw new Error("GIS HTTP " + r.status);
      const d = await r.json();
      if (d && d.error) {
        if (d.error.code === 498 || d.error.code === 499) { forceTok = true; lastErr = new Error("token expired"); continue; }
        throw new Error(`GIS error ${d.error.code}: ${d.error.message}`);
      }
      STATS.lastOk = now();
      return d;
    } catch (e) {
      lastErr = e; STATS.errors++; STATS.lastError = new Date().toLocaleTimeString() + " " + e.message;
      await sleep(1500 * (i + 1));
    } finally { release(); }
  }
  throw lastErr;
}

let LAYERS = null;
async function layers() {
  if (!LAYERS) LAYERS = (await gis("")).layers.filter((l) => !l.subLayerIds).map((l) => ({ id: l.id, name: l.name }));
  return LAYERS;
}
async function layerFor(name) {
  const ls = await layers(), n = norm(name);
  return ls.find((l) => norm(l.name) === n) || ls.find((l) => norm(l.name).startsWith(n) || n.startsWith(norm(l.name))) || null;
}

async function mauzaList(layerId, tehsilId) {
  try {
    const d = await gis(`/${layerId}/query`, {
      where: `Tehsil_ID=${tehsilId}`, groupByFieldsForStatistics: "Mouza_ID,Mouza", returnGeometry: "false",
      outStatistics: JSON.stringify([{ statisticType: "count", onStatisticField: "OBJECTID", outStatisticFieldName: "n" }]),
    });
    const m = new Map();
    for (const f of d.features || []) {
      const a = f.attributes, id = a.Mouza_ID ?? a.MOUZA_ID;
      if (id == null) continue;
      const e = m.get(String(id)) || { mouza_id: String(id), name: a.Mouza ?? a.MOUZA, count: 0 };
      e.count += Number(a.n ?? a.N ?? 0);
      m.set(String(id), e);
    }
    if (m.size) return [...m.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  } catch (e) { console.warn("stats query failed", e); }
  const d = await gis(`/${layerId}/query`, { where: `Tehsil_ID=${tehsilId}`, outFields: "Mouza,Mouza_ID", returnDistinctValues: "true", returnGeometry: "false", orderByFields: "Mouza" });
  return (d.features || []).map((f) => ({ mouza_id: String(f.attributes.Mouza_ID), name: f.attributes.Mouza, count: null }));
}

async function tehsilsFromLayer(layerId) {
  const d = await gis(`/${layerId}/query`, { where: "1=1", outFields: "Tehsil,Tehsil_ID", returnDistinctValues: "true", returnGeometry: "false" });
  const m = new Map();
  for (const f of d.features || []) if (f.attributes.Tehsil_ID != null && /^[A-Za-z]/.test(f.attributes.Tehsil || "")) if (!m.has(f.attributes.Tehsil_ID)) m.set(f.attributes.Tehsil_ID, f.attributes.Tehsil);
  return [...m].map(([id, name]) => ({ id, name, extent: null }));
}

async function downloadMauza(layerId, tehsilId, mouzaId, onProgress) {
  const where = `Tehsil_ID=${Number(tehsilId)} AND Mouza_ID='${String(mouzaId).replace(/'/g, "")}'`;
  const total = (await gis(`/${layerId}/query`, { where, returnCountOnly: "true" })).count || 0;
  const offsets = [];
  for (let o = 0; o < total; o += CFG.pageSize) offsets.push(o);
  const pages = new Array(offsets.length);
  let done = 0;
  await Promise.all(offsets.map(async (o, i) => {
    const d = await gis(`/${layerId}/query`, {
      where, outFields: "*", returnGeometry: "true", outSR: "4326", geometryPrecision: "7",
      orderByFields: "OBJECTID", resultOffset: String(o), resultRecordCount: String(CFG.pageSize), f: "geojson",
    });
    pages[i] = d.features || [];
    done += pages[i].length;
    if (onProgress) onProgress(done, total);
  }));
  const feats = pages.flat().filter((f) => f.geometry);
  if (feats.length < total * 0.999) throw new Error(`Incomplete download (${feats.length} of ${total})`);
  for (const f of feats) {
    const a = geomArea(f.geometry);
    f.properties.area_m2 = Math.round(a * 100) / 100;
    f.properties.area_KM = fmtKM(a);
  }
  return feats;
}

/* ---------------- browser storage (IndexedDB) ---------------- */
const DB = {
  db: null,
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((ok, bad) => {
      const r = indexedDB.open("punjab-khasra", 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("mauzas", { keyPath: "key" });
        r.result.createObjectStore("changes", { keyPath: "id", autoIncrement: true });
      };
      r.onsuccess = () => { this.db = r.result; ok(this.db); };
      r.onerror = () => bad(r.error);
    });
  },
  async run(store, mode, fn) {
    const db = await this.open();
    return new Promise((ok, bad) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => ok(req && req.result);
      tx.onerror = () => bad(tx.error);
      tx.onabort = () => bad(tx.error);
    });
  },
  get: (s, k) => DB.run(s, "readonly", (st) => st.get(k)),
  put: (s, v) => DB.run(s, "readwrite", (st) => st.put(v)),
  all: (s) => DB.run(s, "readonly", (st) => st.getAll()),
  keys: (s) => DB.run(s, "readonly", (st) => st.getAllKeys()),
  clear: (s) => DB.run(s, "readwrite", (st) => st.clear()),
  async addMany(s, rows) {
    if (!rows.length) return;
    const db = await this.open();
    return new Promise((ok, bad) => {
      const tx = db.transaction(s, "readwrite");
      const st = tx.objectStore(s);
      rows.forEach((r) => st.add(r));
      tx.oncomplete = ok; tx.onerror = () => bad(tx.error);
    });
  },
};
const mkey = (l, t, m) => `${l}|${t}|${m}`;

async function syncMauza(meta, onProgress) {
  const feats = await downloadMauza(meta.layer_id, meta.tehsil_id, meta.mouza_id, onProgress);
  const key = mkey(meta.layer_id, meta.tehsil_id, meta.mouza_id);
  const old = await DB.get("mauzas", key);
  const oldHashes = (old && old.hashes) || null;
  const hashes = {}, logs = [];
  let added = 0, changed = 0, area = 0;
  const ts = now();
  for (const f of feats) {
    let k = parcelKey(f);
    if (hashes[k]) k += ":" + f.properties.OBJECTID;
    f.properties._pkey = k;
    const h = parcelHash(f);
    hashes[k] = h;
    area += f.properties.area_m2 || 0;
    if (oldHashes) {
      if (!(k in oldHashes)) { added++; logs.push({ kind: "added", pkey: k, label: f.properties.Label }); }
      else if (oldHashes[k] !== h) { changed++; logs.push({ kind: "changed", pkey: k, label: f.properties.Label }); }
    }
  }
  let removed = 0;
  if (oldHashes) for (const k of Object.keys(oldHashes)) if (!(k in hashes)) {
    removed++;
    logs.push({ kind: "removed", pkey: k, label: (old.labels && old.labels[k]) || k });
  }
  const labels = {};
  feats.forEach((f) => (labels[f.properties._pkey] = f.properties.Label));
  const rec = { key, ...meta, features: feats, hashes, labels, count: feats.length, area_m2: area,
    last_synced: ts, first_saved: (old && old.first_saved) || ts, added, changed, removed };
  await DB.put("mauzas", rec);
  await DB.addMany("changes", logs.map((l) => ({ ...l, ts, key, mauza: meta.name, tehsil: meta.tehsil, district: meta.district })));
  return rec;
}

/* ---------------- jobs & auto refresh ---------------- */
const JOBS = [];
let jobSeq = 0, refreshing = false;
async function runJob(label, metas, kind) {
  const job = { id: ++jobSeq, label, kind, total: metas.length, done: 0, added: 0, changed: 0, removed: 0, errors: [], status: "running", current: null, started: now() };
  JOBS.unshift(job);
  JOBS.splice(20);
  for (const m of metas) {
    if (job.cancel) { job.status = "cancelled"; break; }
    job.current = m.name;
    try {
      const r = await syncMauza(m);
      job.added += r.added; job.changed += r.changed; job.removed += r.removed;
    } catch (e) { job.errors.push(`${m.name}: ${e.message}`); }
    job.done++;
    renderJobsIfVisible();
  }
  if (job.status === "running") job.status = job.errors.length ? "done with errors" : "done";
  job.current = null; job.finished = now();
  renderJobsIfVisible();
  refreshHeader();
  return job;
}
async function refreshStale(force) {
  if (refreshing) return;
  refreshing = true;
  try {
    const recs = await DB.all("mauzas");
    const cutoff = now() - CFG.refreshHours * 3600;
    const stale = recs.filter((r) => force || r.last_synced < cutoff).map(({ features, hashes, labels, ...m }) => m);
    if (stale.length) await runJob(`${force ? "Manual" : "Automatic"} refresh of ${stale.length} saved mauzas`, stale, "refresh");
  } finally { refreshing = false; }
}

/* ---------------- map ---------------- */
const map = L.map("map", { preferCanvas: true }).setView([31.2, 72.7], 7);
const basemaps = {
  "Satellite (Esri)": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 21, maxNativeZoom: 19, attribution: "Imagery © Esri" }),
  "Streets (OSM)": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 21, maxNativeZoom: 19, attribution: "© OpenStreetMap" }),
};
basemaps["Satellite (Esri)"].addTo(map);
L.control.layers(basemaps, null, { position: "topright" }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);
const renderer = L.canvas({ padding: 0.3, tolerance: 3 });
const baseStyle = { color: "#ffd84d", weight: 1, fillColor: "#ffd84d", fillOpacity: 0.05, renderer };
const hiStyle = { color: "#00e5ff", weight: 3, fillOpacity: 0.25, fillColor: "#00e5ff" };
let parcelLayer = null, selectedLayer = null, viewFeatures = [];
const labelLayer = L.layerGroup().addTo(map);

function drawFeatures(feats, fit = true) {
  if (parcelLayer) map.removeLayer(parcelLayer);
  selectedLayer = null;
  viewFeatures = feats;
  parcelLayer = L.geoJSON({ type: "FeatureCollection", features: feats }, {
    style: () => baseStyle,
    onEachFeature: (f, layer) => layer.on("click", () => selectParcel(layer)),
  }).addTo(map);
  if (fit && feats.length) map.fitBounds(parcelLayer.getBounds(), { padding: [20, 20] });
  updateLabels();
}
function selectParcel(layer) {
  if (selectedLayer) parcelLayer.resetStyle(selectedLayer);
  selectedLayer = layer;
  layer.setStyle(hiStyle); layer.bringToFront();
  const p = layer.feature.properties;
  const order = ["Label", "area_KM", "area_m2", "Mouza", "Mouza_ID", "Tehsil", "District", "QH", "PC", "MN", "K", "SK", "M", "A", "Karam", "Type", "Khasra_ID", "Khewat_ID", "Khewat_No", "Khatuni_No", "Join_Shp", "propstatus", "Remarks", "OBJECTID"];
  const names = { area_KM: "Area (Kanal-Marla)", area_m2: "Area (m²)", MN: "Murabba no.", K: "Killa", SK: "Sub-killa", QH: "Qanungo halqa", PC: "Patwar circle" };
  const keys = [...order.filter((k) => k in p), ...Object.keys(p).filter((k) => !order.includes(k) && !k.startsWith("_") && !k.startsWith("Shape"))];
  $("parcelAttrs").innerHTML = keys.map((k) => `<tr><td>${esc(names[k] || k)}</td><td>${esc(p[k])}</td></tr>`).join("");
  $("parcelBlock").hidden = false;
  L.popup({ maxWidth: 260 }).setLatLng(layer.getBounds().getCenter())
    .setContent(`<b>Khasra ${esc(p.Label)}</b><br>${esc(p.Mouza || "")}<br>${esc(p.area_KM || "")}`).openOn(map);
}
function updateLabels() {
  labelLayer.clearLayers();
  if (!parcelLayer || map.getZoom() < 17) return;
  const b = map.getBounds();
  let n = 0;
  parcelLayer.eachLayer((l) => {
    if (n > 1500) return;
    const c = l.getBounds().getCenter();
    if (b.contains(c)) {
      n++;
      L.tooltip({ permanent: true, direction: "center", className: "plabel", interactive: false }).setLatLng(c).setContent(esc(l.feature.properties.Label || "")).addTo(labelLayer);
    }
  });
}
map.on("moveend", updateLabels);

/* ---------------- tabs ---------------- */
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + t.dataset.tab));
  if (t.dataset.tab === "dashboard") loadDashboard();
  if (t.dataset.tab === "sync") loadSync();
}));

/* ---------------- selectors ---------------- */
const state = { division: null, district: null, tehsil: null, mauza: null, mauzas: [], view: null };
const msg = (t, err) => { $("exploreMsg").textContent = t || ""; $("exploreMsg").classList.toggle("err", !!err); };
const parseExt = (s) => (s ? String(s).split(",").map(Number) : null);
const zoomExt = (e) => { e = Array.isArray(e) ? e : parseExt(e); if (e && e.length === 4 && e.every(isFinite)) map.fitBounds([[e[1], e[0]], [e[3], e[2]]]); };
function fill(sel, items, placeholder, label, value) {
  sel.innerHTML = `<option value="">${placeholder}</option>` + items.map((it, i) => `<option value="${i}">${esc(label(it))}</option>`).join("");
  sel.disabled = !items.length;
  if (value != null) sel.value = value;
}
let DISTS = [], TEHS = [];
fill($("selDivision"), DIVISIONS, "Select division", (d) => d.name);

$("selDivision").onchange = async (e) => {
  state.division = DIVISIONS[e.target.value] || null;
  resetBelow("division");
  if (!state.division) return;
  zoomExt(state.division.extent);
  msg("Loading districts…");
  try {
    const rows = await getJSON(`${CFG.api}/districts?division_id=${state.division.id}`);
    DISTS = await Promise.all(rows.map(async (d) => ({ ...d, layer_id: (await layerFor(d.name))?.id ?? null })));
    DISTS.sort((a, b) => a.name.localeCompare(b.name));
    fill($("selDistrict"), DISTS, "Select district", (d) => d.name + (d.layer_id == null ? " (no cadastral layer)" : ""));
    msg("");
  } catch (err) { msg("Could not load districts: " + err.message, true); }
};
$("selDistrict").onchange = async (e) => {
  state.district = DISTS[e.target.value] || null;
  resetBelow("district");
  if (!state.district) return;
  zoomExt(state.district.extent);
  if (state.district.layer_id == null) return msg("This district has no cadastral layer on the server.", true);
  msg("Loading tehsils…");
  try {
    try { TEHS = await getJSON(`${CFG.api}/tehsils?district_id=${state.district.id}`); } catch (e) { TEHS = []; }
    if (!TEHS.length) TEHS = await tehsilsFromLayer(state.district.layer_id);
    TEHS.sort((a, b) => a.name.localeCompare(b.name));
    fill($("selTehsil"), TEHS, "Select tehsil", (t) => t.name);
    msg("");
  } catch (err) { msg("Could not load tehsils: " + err.message, true); }
};
$("selTehsil").onchange = async (e) => {
  state.tehsil = TEHS[e.target.value] || null;
  resetBelow("tehsil");
  if (!state.tehsil) return;
  zoomExt(state.tehsil.extent);
  await loadMauzaList();
  ["btnShowTehsil", "btnCacheTehsil"].forEach((b) => ($(b).disabled = false));
};
async function loadMauzaList(keepIndex) {
  msg("Loading mauzas…");
  try {
    const rows = await mauzaList(state.district.layer_id, state.tehsil.id);
    const recs = await savedForTehsil();
    const byId = Object.fromEntries(recs.map((r) => [r.mouza_id, r]));
    state.mauzas = rows.map((m) => ({ ...m, saved: byId[m.mouza_id] || null }));
    fill($("selMauza"), state.mauzas, `Select mauza (${state.mauzas.length})`,
      (m) => `${m.saved ? "● " : "○ "}${m.name}${m.count != null ? "  ·  " + fmtN(m.count) : ""}`, keepIndex);
    const total = state.mauzas.reduce((a, m) => a + (m.count || 0), 0);
    msg(`${state.mauzas.length} mauzas, ${fmtN(total)} parcels on the server · ${recs.length} saved in this browser (●)`);
    if (keepIndex != null) state.mauza = state.mauzas[keepIndex] || null;
    renderSelTiles();
  } catch (err) { msg("Could not load mauzas: " + err.message, true); }
}
async function savedForTehsil() {
  const prefix = `${state.district.layer_id}|${state.tehsil.id}|`;
  const keys = (await DB.keys("mauzas")).filter((k) => k.startsWith(prefix));
  const out = [];
  for (const k of keys) { const r = await DB.get("mauzas", k); if (r) out.push({ mouza_id: r.mouza_id, last_synced: r.last_synced, count: r.count, key: k }); }
  return out;
}
$("selMauza").onchange = (e) => {
  state.mauza = state.mauzas[e.target.value] || null;
  $("btnLoadMauza").disabled = !state.mauza;
  renderSelTiles();
};
function resetBelow(level) {
  const order = ["division", "district", "tehsil", "mauza"], sels = { district: "selDistrict", tehsil: "selTehsil", mauza: "selMauza" };
  order.slice(order.indexOf(level) + 1).forEach((l) => {
    state[l] = null;
    const s = $(sels[l]);
    s.innerHTML = `<option value="">Select ${l}</option>`;
    s.disabled = true;
  });
  ["btnLoadMauza", "btnShowTehsil", "btnCacheTehsil"].forEach((b) => ($(b).disabled = true));
  if (level !== "tehsil") state.mauzas = [];
  renderSelTiles();
}
function renderSelTiles() {
  const t = $("selTiles");
  if (!state.tehsil) { t.innerHTML = ""; return; }
  const m = state.mauza, saved = state.mauzas.filter((x) => x.saved);
  const tiles = m ? [
    ["Parcels on server", fmtN(m.count), m.name],
    ["Saved here", m.saved ? fmtN(m.saved.count) : "–", m.saved ? "synced " + ago(m.saved.last_synced) : "not saved yet"],
  ] : [
    ["Mauzas", fmtN(state.mauzas.length), state.tehsil.name],
    ["Saved here", `${saved.length}/${state.mauzas.length}`, fmtN(saved.reduce((a, x) => a + (x.saved.count || 0), 0)) + " parcels"],
  ];
  if (state.view) tiles.push(["On map", fmtN(state.view.n), state.view.label], ["Area on map", fmtAcres(state.view.area) + " ac", Math.round(state.view.area / KANAL_M2).toLocaleString() + " kanal"]);
  t.innerHTML = tiles.map(([k, v, s]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s || "")}</div></div>`).join("");
}
const metaFor = (m) => ({ layer_id: state.district.layer_id, tehsil_id: state.tehsil.id, mouza_id: m.mouza_id, name: m.name,
  district: state.district.name, tehsil: state.tehsil.name, division: state.division.name });
function showRecord(rec, label) {
  drawFeatures(rec.features);
  state.view = { n: rec.features.length, area: rec.area_m2, label };
  renderSelTiles();
}

$("btnLoadMauza").onclick = async () => {
  const m = state.mauza, idx = $("selMauza").value;
  $("btnLoadMauza").disabled = true;
  try {
    let rec = m.saved ? await DB.get("mauzas", mkey(state.district.layer_id, state.tehsil.id, m.mouza_id)) : null;
    if (rec && rec.last_synced < now() - CFG.refreshHours * 3600) {
      msg(`${m.name} is older than ${CFG.refreshHours} h, downloading the latest…`);
      try { rec = await syncMauza(metaFor(m)); } catch (e) { msg("Server unreachable, showing saved copy: " + e.message, true); }
    }
    if (!rec) {
      msg(`Downloading ${m.name} (${fmtN(m.count)} parcels) from the server…`);
      rec = await syncMauza(metaFor(m), (d, t) => msg(`Downloading ${m.name}: ${fmtN(d)} / ${fmtN(t)} parcels…`));
    }
    showRecord(rec, m.name);
    msg(`${m.name}: ${fmtN(rec.count)} parcels (synced ${ago(rec.last_synced)}). Click a parcel for details.`);
    await loadMauzaList(idx);
  } catch (err) { msg("Download failed: " + err.message, true); }
  $("btnLoadMauza").disabled = false;
};
$("btnShowTehsil").onclick = async () => {
  const saved = await savedForTehsil();
  if (!saved.length) return msg("Nothing saved for this tehsil yet. Load a mauza or use “Save whole tehsil”.", true);
  const feats = [];
  let area = 0;
  for (const s of saved) { const r = await DB.get("mauzas", s.key); feats.push(...r.features); area += r.area_m2; }
  drawFeatures(feats);
  state.view = { n: feats.length, area, label: state.tehsil.name + " (saved)" };
  renderSelTiles();
  msg(`${fmtN(feats.length)} saved parcels of ${state.tehsil.name} shown.`);
};
$("btnCacheTehsil").onclick = async () => {
  const missing = state.mauzas.filter((m) => !m.saved);
  if (!missing.length) return msg("Every mauza of this tehsil is already saved. Auto-refresh keeps it current.");
  const n = missing.reduce((a, m) => a + (m.count || 0), 0);
  msg(`Saving ${missing.length} mauzas (about ${fmtN(n)} parcels). Keep this tab open; progress is on the Auto-sync tab.`);
  const idx = $("selMauza").value, tehsil = state.tehsil;
  await runJob(`Save ${missing.length} mauzas of ${tehsil.name} (${state.district.name})`, missing.map(metaFor), "save");
  if (state.tehsil === tehsil) await loadMauzaList(idx);
};

/* ---------------- search ---------------- */
async function doSearch() {
  const q = $("searchBox").value.trim();
  if (!q) return;
  const recs = await DB.all("mauzas");
  const res = [];
  for (const r of recs) {
    if (state.tehsil && (r.layer_id !== state.district.layer_id || r.tehsil_id !== state.tehsil.id)) continue;
    for (const f of r.features) {
      const p = f.properties;
      if (p.Label === q || String(p.Khasra_ID) === q || String(p.Khewat_ID) === q || (p.Label && String(p.Label).startsWith(q + "/"))) {
        res.push({ r, f });
        if (res.length >= 60) break;
      }
    }
    if (res.length >= 60) break;
  }
  $("searchResults").innerHTML = res.length ? res.map(({ r, f }, i) =>
    `<div class="result" data-i="${i}"><b>${esc(f.properties.Label)}</b> · ${esc(r.name)} <small>${esc(r.tehsil)}, ${esc(r.district)} · ${esc(f.properties.area_KM)}</small></div>`).join("")
    : `<div class="hint">No match among mauzas saved in this browser${state.tehsil ? " for this tehsil" : ""}.</div>`;
  $("searchResults").querySelectorAll(".result").forEach((el) => (el.onclick = () => {
    const { r, f } = res[el.dataset.i];
    showRecord(r, r.name);
    let target = null;
    parcelLayer.eachLayer((l) => { if (l.feature.properties._pkey === f.properties._pkey) target = l; });
    if (target) { map.fitBounds(target.getBounds(), { maxZoom: 18 }); selectParcel(target); }
  }));
}
$("btnSearch").onclick = doSearch;
$("searchBox").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

/* ---------------- export (all in the browser) ---------------- */
const FIELDS = [["OBJECTID", "N"], ["District", "C"], ["Dist_ID", "C"], ["Tehsil", "C"], ["Tehsil_ID", "N"], ["QH", "C"], ["QH_ID", "C"], ["PC", "C"], ["PC_ID", "C"],
  ["Mouza", "C"], ["Mouza_ID", "C"], ["Type", "C"], ["M", "C"], ["A", "N"], ["K", "C"], ["SK", "C"], ["Label", "C"], ["MK", "C"], ["Khewat_No", "C"], ["Khatuni_No", "C"],
  ["Khasra_ID", "N"], ["MN", "N"], ["B", "C"], ["Remarks", "C"], ["Karam", "F"], ["Khewat_ID", "N"], ["Join_Shp", "C"], ["propstatus", "N"], ["area_m2", "F", "Area_m2"], ["area_KM", "C", "Area_KM"]];

function saveBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
}
function shpRings(g) {
  const sa = (r) => { let s = 0; for (let i = 0; i < r.length - 1; i++) s += (r[i + 1][0] - r[i][0]) * (r[i + 1][1] + r[i][1]); return s; };
  const out = [];
  for (const p of g.type === "Polygon" ? [g.coordinates] : g.coordinates) p.forEach((r, i) => {
    const rr = r.map((pt) => [pt[0], pt[1]]);
    const a = rr[0], b = rr[rr.length - 1];
    if (a[0] !== b[0] || a[1] !== b[1]) rr.push(a);
    const cw = sa(rr) > 0;
    if ((i === 0 && !cw) || (i > 0 && cw)) rr.reverse();
    out.push(rr);
  });
  return out;
}
async function buildShpZip(feats, base) {
  const enc = new TextEncoder();
  const fields = FIELDS.map(([src, t, name]) => {
    const f = { src, name: name || src, type: t === "C" ? "C" : "N", dec: t === "F" ? 4 : 0, len: t === "C" ? 1 : t === "F" ? 19 : 12 };
    if (t === "C") for (const ft of feats) { const v = ft.properties[src]; if (v != null) f.len = Math.min(254, Math.max(f.len, enc.encode(String(v)).length)); }
    return f;
  });
  const recs = feats.map((f) => {
    const rs = shpRings(f.geometry);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, np = 0;
    for (const r of rs) for (const [x, y] of r) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); np++; }
    return { rs, b: [x0, y0, x1, y1], np };
  });
  const B = recs.reduce((a, r) => [Math.min(a[0], r.b[0]), Math.min(a[1], r.b[1]), Math.max(a[2], r.b[2]), Math.max(a[3], r.b[3])], [1e9, 1e9, -1e9, -1e9]);
  const lens = recs.map((r) => 44 + 4 * r.rs.length + 16 * r.np);
  const shpLen = 100 + lens.reduce((a, c) => a + 8 + c, 0), shxLen = 100 + 8 * recs.length;
  const shp = new DataView(new ArrayBuffer(shpLen)), shx = new DataView(new ArrayBuffer(shxLen));
  for (const [dv, len] of [[shp, shpLen], [shx, shxLen]]) {
    dv.setInt32(0, 9994); dv.setInt32(24, len / 2); dv.setInt32(28, 1000, true); dv.setInt32(32, 5, true);
    B.forEach((v, k) => dv.setFloat64(36 + 8 * k, v, true));
  }
  let o = 100;
  recs.forEach((r, i) => {
    const cl = lens[i];
    shx.setInt32(100 + 8 * i, o / 2); shx.setInt32(104 + 8 * i, cl / 2);
    shp.setInt32(o, i + 1); shp.setInt32(o + 4, cl / 2);
    const p = o + 8;
    shp.setInt32(p, 5, true); r.b.forEach((v, k) => shp.setFloat64(p + 4 + 8 * k, v, true));
    shp.setInt32(p + 36, r.rs.length, true); shp.setInt32(p + 40, r.np, true);
    let q = p + 44, start = 0;
    r.rs.forEach((rr) => { shp.setInt32(q, start, true); q += 4; start += rr.length; });
    r.rs.forEach((rr) => rr.forEach(([x, y]) => { shp.setFloat64(q, x, true); shp.setFloat64(q + 8, y, true); q += 16; }));
    o += 8 + cl;
  });
  const recLen = 1 + fields.reduce((a, f) => a + f.len, 0), hLen = 32 + 32 * fields.length + 1;
  const dbf = new Uint8Array(hLen + recLen * feats.length + 1), dd = new DataView(dbf.buffer), d = new Date();
  dbf[0] = 3; dbf[1] = d.getFullYear() - 1900; dbf[2] = d.getMonth() + 1; dbf[3] = d.getDate();
  dd.setUint32(4, feats.length, true); dd.setUint16(8, hLen, true); dd.setUint16(10, recLen, true);
  fields.forEach((f, i) => { const b = 32 + 32 * i; dbf.set(enc.encode(f.name).slice(0, 10), b); dbf[b + 11] = f.type.charCodeAt(0); dbf[b + 16] = f.len; dbf[b + 17] = f.dec; });
  dbf[hLen - 1] = 0x0d;
  let pos = hLen;
  for (const ft of feats) {
    dbf[pos++] = 0x20;
    for (const f of fields) {
      const v = ft.properties[f.src];
      if (f.type === "C") {
        let bytes = enc.encode(v == null ? "" : String(v));
        if (bytes.length > f.len) bytes = bytes.slice(0, f.len);
        dbf.set(bytes, pos); dbf.fill(0x20, pos + bytes.length, pos + f.len);
      } else {
        let s = v == null || v === "" || !isFinite(Number(v)) ? "" : f.dec ? Number(v).toFixed(f.dec) : String(Math.round(Number(v)));
        if (s.length > f.len) s = "";
        dbf.set(enc.encode(s.padStart(f.len, " ")), pos);
      }
      pos += f.len;
    }
  }
  dbf[pos] = 0x1a;
  const zip = new JSZip();
  zip.file(base + ".shp", shp.buffer); zip.file(base + ".shx", shx.buffer); zip.file(base + ".dbf", dbf);
  zip.file(base + ".prj", 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]');
  zip.file(base + ".cpg", "UTF-8");
  return zip.generateAsync({ type: "blob", compression: "DEFLATE" });
}
function toCSV(feats) {
  const cols = FIELDS.map((f) => f[0]);
  const q = (v) => (v == null ? "" : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = [[...cols, "centroid_lon", "centroid_lat"].join(",")];
  for (const f of feats) {
    const c = L.geoJSON(f).getBounds().getCenter();
    lines.push([...cols.map((k) => q(f.properties[k])), c.lng.toFixed(7), c.lat.toFixed(7)].join(","));
  }
  return new Blob(["﻿" + lines.join("\n")], { type: "text/csv" });
}
document.querySelectorAll(".exp").forEach((b) => (b.onclick = async () => {
  if (!state.tehsil) return msg("Choose a tehsil (and mauza) first.", true);
  const scope = $("exportScope").value;
  let feats = [], name = `${state.district.name}_${state.tehsil.name}`;
  if (scope === "mauza") {
    if (!state.mauza || !state.mauza.saved) return msg("Load the mauza first, then export it.", true);
    feats = (await DB.get("mauzas", mkey(state.district.layer_id, state.tehsil.id, state.mauza.mouza_id))).features;
    name += "_" + state.mauza.name;
  } else {
    for (const s of await savedForTehsil()) feats.push(...(await DB.get("mauzas", s.key)).features);
    if (!feats.length) return msg("Nothing saved for this tehsil yet.", true);
  }
  const base = (name + "_Cadastral").replace(/[^A-Za-z0-9_-]+/g, "_");
  msg(`Preparing ${b.dataset.fmt.toUpperCase()} of ${fmtN(feats.length)} parcels…`);
  if (b.dataset.fmt === "geojson") saveBlob(new Blob([JSON.stringify({ type: "FeatureCollection", features: feats })], { type: "application/geo+json" }), base + ".geojson");
  if (b.dataset.fmt === "csv") saveBlob(toCSV(feats), base + ".csv");
  if (b.dataset.fmt === "shp") saveBlob(await buildShpZip(feats, base), base + "_SHP.zip");
  msg(`Exported ${fmtN(feats.length)} parcels.`);
}));

/* ---------------- dashboard ---------------- */
async function loadDashboard() {
  const recs = await DB.all("mauzas");
  const changes = (await DB.all("changes")).sort((a, b) => b.id - a.id);
  const wk = changes.filter((c) => c.ts > now() - 7 * 86400).length;
  const parcels = recs.reduce((a, r) => a + r.count, 0), area = recs.reduce((a, r) => a + r.area_m2, 0);
  const last = Math.max(0, ...recs.map((r) => r.last_synced));
  $("dashTiles").innerHTML = [
    ["Saved mauzas", fmtN(recs.length), "in this browser"], ["Saved parcels", fmtN(parcels), ""],
    ["Total area", fmtAcres(area) + " ac", ""], ["Changes (7 days)", fmtN(wk), "last sync " + ago(last || null)],
  ].map(([k, v, x]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${esc(x)}</div></div>`).join("");
  const by = {};
  for (const r of recs) {
    const k = r.district + " / " + r.tehsil;
    const e = by[k] || (by[k] = { mauzas: 0, parcels: 0, oldest: Infinity });
    e.mauzas++; e.parcels += r.count; e.oldest = Math.min(e.oldest, r.last_synced);
  }
  $("tehsilTable").innerHTML = `<tr><th>District / Tehsil</th><th class="num">Mauzas</th><th class="num">Parcels</th><th>Synced</th></tr>` +
    (Object.entries(by).sort().map(([k, e]) => `<tr><td>${esc(k)}</td><td class="num">${fmtN(e.mauzas)}</td><td class="num">${fmtN(e.parcels)}</td><td>${ago(e.oldest)}</td></tr>`).join("")
      || `<tr><td colspan="4" class="hint">Nothing saved yet.</td></tr>`);
  $("changesTable").innerHTML = `<tr><th>When</th><th>Mauza</th><th>Khasra</th><th>Change</th></tr>` +
    (changes.slice(0, 200).map((c) => `<tr><td title="${when(c.ts)}">${ago(c.ts)}</td><td>${esc(c.mauza)}<br><small class="hint">${esc(c.tehsil || "")}</small></td><td>${esc(c.label || c.pkey)}</td><td><span class="badge ${c.kind}">${c.kind}</span></td></tr>`).join("")
      || `<tr><td colspan="4" class="hint">No changes detected yet. They appear when a saved mauza is refreshed and the server data differs.</td></tr>`);
}

/* ---------------- auto-sync tab ---------------- */
async function loadSync() {
  const recs = await DB.all("mauzas");
  const oldest = recs.length ? Math.min(...recs.map((r) => r.last_synced)) : null;
  const due = oldest ? new Date((oldest + CFG.refreshHours * 3600) * 1000) : null;
  $("syncTiles").innerHTML = [
    ["Refresh interval", CFG.refreshHours + " h", refreshing ? "refresh running now" : "idle"],
    ["Next refresh due", due ? due.toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "–", recs.length + " saved mauzas"],
    ["Server requests", fmtN(STATS.requests), fmtN(STATS.errors) + " errors"],
    ["Last server reply", STATS.lastOk ? ago(STATS.lastOk) : "–", STATS.lastError ? "last error: " + STATS.lastError.slice(0, 60) : ""],
  ].map(([k, v, x]) => `<div class="tile"><div class="k">${k}</div><div class="v">${esc(v)}</div><div class="s">${esc(x)}</div></div>`).join("");
  renderJobs();
  if (navigator.storage && navigator.storage.estimate) {
    const e = await navigator.storage.estimate();
    $("storageInfo").textContent = `Using ${(e.usage / 1e6).toFixed(1)} MB of about ${(e.quota / 1e9).toFixed(1)} GB available to this site in this browser.`;
  }
}
function renderJobs() {
  $("jobsList").innerHTML = JOBS.map((j) => {
    const pct = j.total ? Math.round((100 * j.done) / j.total) : 100;
    return `<div class="job"><b>${esc(j.label)}</b> <span class="badge">${esc(j.status)}</span>
      <div class="bar"><span style="width:${pct}%"></span></div>
      <div class="meta">${j.done}/${j.total} mauzas · +${j.added} added, ${j.changed} changed, ${j.removed} removed${j.errors.length ? " · " + j.errors.length + " errors" : ""}${j.current ? "<br>Now: " + esc(j.current) : ""}</div>
      ${j.status === "running" ? `<button data-cancel="${j.id}">Cancel</button>` : ""}</div>`;
  }).join("") || `<div class="hint">No jobs yet.</div>`;
  $("jobsList").querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = () => { const j = JOBS.find((x) => x.id == b.dataset.cancel); if (j) j.cancel = true; }));
}
function renderJobsIfVisible() { if ($("tab-sync").classList.contains("active")) loadSync(); }
$("btnSyncNow").onclick = () => { refreshStale(true); setTimeout(loadSync, 300); };
$("btnClear").onclick = async () => {
  if (!confirm("Delete all mauzas and change history saved in this browser?")) return;
  await DB.clear("mauzas"); await DB.clear("changes");
  loadSync(); refreshHeader();
  if (state.tehsil) loadMauzaList($("selMauza").value);
};
setInterval(() => { if ($("tab-sync").classList.contains("active")) loadSync(); }, 5000);

async function refreshHeader() {
  try {
    const n = (await DB.keys("mauzas")).length;
    const running = JOBS.find((j) => j.status === "running");
    $("hdrStatus").textContent = running ? `${running.label}: ${running.done}/${running.total}` : `Live data · ${fmtN(n)} mauzas saved in this browser · auto-refresh every ${CFG.refreshHours} h`;
  } catch (e) { $("hdrStatus").textContent = "Live data"; }
}

/* ---------------- start ---------------- */
(async () => {
  await refreshHeader();
  setInterval(refreshHeader, 4000);
  try { await token(); } catch (e) { $("hdrStatus").textContent = "Cannot reach PULSE token service: " + e.message; }
  setTimeout(() => refreshStale(false), 5000);
  setInterval(() => refreshStale(false), 15 * 60e3);
})();
