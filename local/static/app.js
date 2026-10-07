/* Punjab Cadastral Explorer – frontend */
const $ = (id) => document.getElementById(id);
const fmtN = (n) => (n == null ? "–" : Number(n).toLocaleString());
const ACRE_M2 = 272.25 * 0.09290304 * 160;
const fmtAcres = (m2) => (m2 == null ? "–" : (m2 / ACRE_M2).toLocaleString(undefined, { maximumFractionDigits: 1 }));
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

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) {
    let msg = r.statusText;
    try { msg = (await r.json()).detail || msg; } catch (e) {}
    throw new Error(msg);
  }
  return r.json();
}

/* ---------------- map ---------------- */
const map = L.map("map", { preferCanvas: true, zoomControl: true }).setView([31.2, 72.7], 7);
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
let parcelLayer = null, selectedLayer = null, labelLayer = L.layerGroup().addTo(map);

function drawGeojson(gj, fit = true) {
  if (parcelLayer) map.removeLayer(parcelLayer);
  selectedLayer = null;
  parcelLayer = L.geoJSON(gj, {
    style: () => baseStyle,
    onEachFeature: (f, layer) => {
      layer.on("click", () => selectParcel(layer));
    },
  }).addTo(map);
  if (fit && gj.features.length) map.fitBounds(parcelLayer.getBounds(), { padding: [20, 20] });
  updateLabels();
}

function selectParcel(layer) {
  if (selectedLayer) parcelLayer.resetStyle(selectedLayer);
  selectedLayer = layer;
  layer.setStyle(hiStyle);
  layer.bringToFront();
  const p = layer.feature.properties;
  const order = ["Label", "area_KM", "area_m2", "Mouza", "Mouza_ID", "Tehsil", "District", "QH", "PC", "MN", "K", "SK", "M", "A", "Karam", "Type", "Khasra_ID", "Khewat_ID", "Khewat_No", "Khatuni_No", "Join_Shp", "propstatus", "Remarks", "OBJECTID"];
  const names = { area_KM: "Area (Kanal-Marla)", area_m2: "Area (m²)", MN: "Murabba no.", K: "Killa", SK: "Sub-killa", QH: "Qanungo halqa", PC: "Patwar circle" };
  const keys = [...order.filter((k) => k in p), ...Object.keys(p).filter((k) => !order.includes(k) && !k.startsWith("_") && !k.startsWith("Shape"))];
  $("parcelAttrs").innerHTML = keys.map((k) => `<tr><td>${esc(names[k] || k)}</td><td>${esc(p[k])}</td></tr>`).join("");
  $("parcelBlock").hidden = false;
  const c = layer.getBounds().getCenter();
  L.popup({ maxWidth: 260 }).setLatLng(c).setContent(`<b>Khasra ${esc(p.Label)}</b><br>${esc(p.Mouza || "")}<br>${esc(p.area_KM || "")}`).openOn(map);
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
      L.tooltip({ permanent: true, direction: "center", className: "plabel", interactive: false })
        .setLatLng(c).setContent(esc(l.feature.properties.Label || "")).addTo(labelLayer);
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

function fill(sel, items, placeholder, label, value) {
  sel.innerHTML = `<option value="">${placeholder}</option>` + items.map((it, i) => `<option value="${i}">${esc(label(it))}</option>`).join("");
  sel.disabled = !items.length;
  if (value != null) sel.value = value;
}
const zoomExt = (e) => { if (e && e.length === 4) map.fitBounds([[e[1], e[0]], [e[3], e[2]]]); };

let DIVS = [], DISTS = [], TEHS = [];
async function init() {
  DIVS = await api("/api/divisions");
  fill($("selDivision"), DIVS, "Select division", (d) => d.name);
  refreshHeader();
  setInterval(refreshHeader, 30000);
}

$("selDivision").onchange = async (e) => {
  state.division = DIVS[e.target.value] || null;
  resetBelow("division");
  if (!state.division) return;
  zoomExt(state.division.extent);
  msg("Loading districts…");
  try {
    DISTS = await api(`/api/districts?division_id=${state.division.id}`);
    fill($("selDistrict"), DISTS, "Select district", (d) => d.name + (d.layer_id == null ? " (no cadastral layer)" : ""));
    msg("");
  } catch (err) { msg(err.message, true); }
};

$("selDistrict").onchange = async (e) => {
  state.district = DISTS[e.target.value] || null;
  resetBelow("district");
  if (!state.district) return;
  zoomExt(state.district.extent);
  if (state.district.layer_id == null) return msg("This district has no cadastral layer on the server.", true);
  msg("Loading tehsils…");
  try {
    TEHS = await api(`/api/tehsils?district_id=${state.district.id}&layer_id=${state.district.layer_id}`);
    fill($("selTehsil"), TEHS, "Select tehsil", (t) => t.name);
    msg("");
  } catch (err) { msg(err.message, true); }
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
    state.mauzas = await api(`/api/mauzas?layer_id=${state.district.layer_id}&tehsil_id=${state.tehsil.id}`);
    fill($("selMauza"), state.mauzas, `Select mauza (${state.mauzas.length})`,
      (m) => `${m.cached ? "● " : "○ "}${m.name}${m.count != null ? "  ·  " + fmtN(m.count) : ""}`, keepIndex);
    const cached = state.mauzas.filter((m) => m.cached).length;
    const total = state.mauzas.reduce((a, m) => a + (m.count || 0), 0);
    msg(`${state.mauzas.length} mauzas, ${fmtN(total)} parcels on server · ${cached} cached locally (●)`);
    renderSelTiles();
  } catch (err) { msg(err.message, true); }
}

$("selMauza").onchange = (e) => {
  state.mauza = state.mauzas[e.target.value] || null;
  $("btnLoadMauza").disabled = !state.mauza;
  renderSelTiles();
};

function resetBelow(level) {
  const order = ["division", "district", "tehsil", "mauza"];
  const sels = { district: "selDistrict", tehsil: "selTehsil", mauza: "selMauza" };
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
  const m = state.mauza;
  const cachedM = state.mauzas.filter((x) => x.cached);
  const tiles = m ? [
    ["Parcels on server", fmtN(m.count), m.name],
    ["Cached parcels", fmtN(m.cached_count), m.cached ? "synced " + ago(m.last_synced) : "not cached yet"],
  ] : [
    ["Mauzas", fmtN(state.mauzas.length), state.tehsil.name],
    ["Cached", `${cachedM.length}/${state.mauzas.length}`, fmtN(cachedM.reduce((a, x) => a + (x.cached_count || 0), 0)) + " parcels"],
  ];
  if (state.view) tiles.push(["On map", fmtN(state.view.n), state.view.label], ["Area on map", fmtAcres(state.view.area) + " ac", (state.view.area / 505.857).toLocaleString(undefined, { maximumFractionDigits: 0 }) + " kanal"]);
  t.innerHTML = tiles.map(([k, v, s]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s || "")}</div></div>`).join("");
}

const metaQS = () => new URLSearchParams({
  layer_id: state.district.layer_id, tehsil_id: state.tehsil.id,
  district: state.district.name, tehsil: state.tehsil.name, division: state.division.name,
});

async function loadMauza(refresh = false) {
  const m = state.mauza;
  const qs = metaQS();
  qs.set("mouza_id", m.mouza_id); qs.set("name", m.name);
  if (refresh) qs.set("refresh", "1");
  msg(m.cached ? `Loading ${m.name} from cache…` : `Downloading ${m.name} (${fmtN(m.count)} parcels) from the server…`);
  $("btnLoadMauza").disabled = true;
  try {
    const gj = await api("/api/parcels?" + qs);
    drawGeojson(gj);
    const area = gj.features.reduce((a, f) => a + (f.properties.area_m2 || 0), 0);
    state.view = { n: gj.features.length, area, label: m.name, scope: "mauza" };
    msg(`${m.name}: ${fmtN(gj.features.length)} parcels shown. Click a parcel for details.`);
    const idx = $("selMauza").value;
    await loadMauzaList(idx);
    state.mauza = state.mauzas[idx];
    renderSelTiles();
  } catch (err) { msg(err.message, true); }
  $("btnLoadMauza").disabled = false;
}
$("btnLoadMauza").onclick = () => loadMauza(false);

$("btnShowTehsil").onclick = async () => {
  msg("Drawing cached mauzas of " + state.tehsil.name + "…");
  try {
    const gj = await api(`/api/parcels/tehsil?layer_id=${state.district.layer_id}&tehsil_id=${state.tehsil.id}`);
    if (!gj.features.length) return msg("Nothing cached for this tehsil yet. Load a mauza or use “Cache whole tehsil”.", true);
    drawGeojson(gj);
    const area = gj.features.reduce((a, f) => a + (f.properties.area_m2 || 0), 0);
    state.view = { n: gj.features.length, area, label: state.tehsil.name + " (cached)", scope: "tehsil" };
    renderSelTiles();
    msg(`${fmtN(gj.features.length)} cached parcels of ${state.tehsil.name} shown.`);
  } catch (err) { msg(err.message, true); }
};

$("btnCacheTehsil").onclick = async () => {
  const missing = state.mauzas.filter((m) => !m.cached);
  const n = missing.reduce((a, m) => a + (m.count || 0), 0);
  if (!missing.length) return msg("Every mauza of this tehsil is already cached. Auto-sync keeps them fresh.");
  try {
    const job = await api("/api/cache/tehsil?" + metaQS(), { method: "POST" });
    msg(`Started: ${job.label} (about ${fmtN(n)} parcels). Progress is on the Auto-sync tab.`);
    pollJobsForTehsil();
  } catch (err) { msg(err.message, true); }
};

let tehsilPoll = null;
function pollJobsForTehsil() {
  clearInterval(tehsilPoll);
  tehsilPoll = setInterval(async () => {
    const jobs = await api("/api/jobs");
    const running = jobs.filter((j) => j.status === "running");
    if (running.length) {
      const j = running[0];
      $("hdrStatus").textContent = `${j.label}: ${j.done}/${j.total}`;
    } else {
      clearInterval(tehsilPoll);
      if (state.tehsil) loadMauzaList($("selMauza").value);
      refreshHeader();
    }
  }, 4000);
}

/* ---------------- search ---------------- */
async function doSearch() {
  const q = $("searchBox").value.trim();
  if (!q) return;
  const qs = new URLSearchParams({ q });
  if (state.tehsil) { qs.set("layer_id", state.district.layer_id); qs.set("tehsil_id", state.tehsil.id); }
  const res = await api("/api/search?" + qs);
  $("searchResults").innerHTML = res.length ? res.map((r, i) =>
    `<div class="result" data-i="${i}"><b>${esc(r.label)}</b> · ${esc(r.mauza || r.mouza_id)} <small>${esc(r.tehsil || "")}, ${esc(r.district || "")} · ${esc(r.area_KM)}</small></div>`).join("")
    : `<div class="hint">No match in cached data${state.tehsil ? " for this tehsil" : ""}. Search covers cached mauzas only.</div>`;
  $("searchResults").querySelectorAll(".result").forEach((el) => el.onclick = async () => {
    const r = res[el.dataset.i];
    const gj = await api(`/api/parcels?layer_id=${r.layer_id}&tehsil_id=${r.tehsil_id}&mouza_id=${encodeURIComponent(r.mouza_id)}`);
    drawGeojson(gj, false);
    state.view = { n: gj.features.length, area: gj.features.reduce((a, f) => a + (f.properties.area_m2 || 0), 0), label: r.mauza, scope: "mauza" };
    renderSelTiles();
    let target = null;
    parcelLayer.eachLayer((l) => { if (l.feature.properties._pkey === r.pkey) target = l; });
    if (target) { map.fitBounds(target.getBounds(), { maxZoom: 18 }); selectParcel(target); }
  });
}
$("btnSearch").onclick = doSearch;
$("searchBox").addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

/* ---------------- export ---------------- */
document.querySelectorAll(".exp").forEach((b) => b.onclick = () => {
  if (!state.tehsil) return msg("Choose a tehsil (and mauza) first.", true);
  const scope = $("exportScope").value;
  const qs = new URLSearchParams({ layer_id: state.district.layer_id, tehsil_id: state.tehsil.id, fmt: b.dataset.fmt });
  let name = `${state.district.name}_${state.tehsil.name}`;
  if (scope === "mauza") {
    if (!state.mauza || !state.mauza.cached) return msg("Load the mauza first, then export it.", true);
    qs.set("mouza_id", state.mauza.mouza_id);
    name += "_" + state.mauza.name;
  }
  qs.set("name", name + "_Cadastral");
  window.location = "/api/export?" + qs;
});

/* ---------------- dashboard ---------------- */
async function loadDashboard() {
  const s = await api("/api/summary");
  const t = s.totals;
  const wk = s.changes_7d.reduce((a, r) => a + r.n, 0);
  $("dashTiles").innerHTML = [
    ["Cached mauzas", fmtN(t.mauzas), (t.errors ? t.errors + " with errors" : "all OK")],
    ["Cached parcels", fmtN(t.parcels), ""],
    ["Total area", fmtAcres(t.area_m2) + " ac", ""],
    ["Changes (7 days)", fmtN(wk), "last sync " + ago(t.last_synced)],
  ].map(([k, v, x]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${esc(x)}</div></div>`).join("");
  $("tehsilTable").innerHTML = `<tr><th>District / Tehsil</th><th class="num">Mauzas</th><th class="num">Parcels</th><th>Synced</th></tr>` +
    (s.by_tehsil.map((r) => `<tr><td>${esc(r.district)} / ${esc(r.tehsil)}</td><td class="num">${fmtN(r.mauzas)}</td><td class="num">${fmtN(r.parcels)}</td><td>${ago(r.oldest_sync)}</td></tr>`).join("")
      || `<tr><td colspan="4" class="hint">Nothing cached yet.</td></tr>`);
  const ch = await api("/api/changes?limit=150");
  $("changesTable").innerHTML = `<tr><th>When</th><th>Mauza</th><th>Khasra</th><th>Change</th></tr>` +
    (ch.map((c) => `<tr><td title="${when(c.ts)}">${ago(c.ts)}</td><td>${esc(c.mauza)}<br><small class="hint">${esc(c.tehsil || "")}</small></td><td>${esc(c.label || c.pkey)}</td><td><span class="badge ${c.kind}">${c.kind}</span></td></tr>`).join("")
      || `<tr><td colspan="4" class="hint">No changes detected yet. Changes appear after the next refresh of a cached mauza.</td></tr>`);
}

/* ---------------- sync ---------------- */
async function loadSync() {
  const [st, jobs, sum] = await Promise.all([api("/api/sync/status"), api("/api/jobs"), api("/api/summary")]);
  $("syncTiles").innerHTML = [
    ["Refresh interval", st.refresh_hours + " h", st.running ? "refresh running now" : "idle"],
    ["Next refresh due", st.next_due ? new Date(st.next_due * 1000).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "–", st.cached_mauzas + " cached mauzas"],
    ["Server requests", fmtN(st.upstream.requests), fmtN(st.upstream.errors) + " errors"],
    ["Last server reply", st.upstream.last_ok ? ago(st.upstream.last_ok) : "–", st.upstream.last_error ? "last error: " + st.upstream.last_error.slice(0, 60) : ""],
  ].map(([k, v, x]) => `<div class="tile"><div class="k">${k}</div><div class="v">${esc(v)}</div><div class="s">${esc(x)}</div></div>`).join("");
  $("jobsList").innerHTML = jobs.map((j) => {
    const pct = j.total ? Math.round((100 * j.done) / j.total) : 100;
    return `<div class="job"><b>${esc(j.label)}</b> <span class="badge">${j.status.replace(/_/g, " ")}</span>
      <div class="bar"><span style="width:${pct}%"></span></div>
      <div class="meta">${j.done}/${j.total} mauzas · +${j.added} added, ${j.changed} changed, ${j.removed} removed${j.errors.length ? " · " + j.errors.length + " errors" : ""}${j.current ? "<br>Now: " + esc(j.current) : ""}</div>
      ${j.status === "running" ? `<button data-cancel="${j.id}">Cancel</button>` : ""}</div>`;
  }).join("") || `<div class="hint">No jobs yet.</div>`;
  $("jobsList").querySelectorAll("[data-cancel]").forEach((b) => b.onclick = async () => { await api(`/api/jobs/${b.dataset.cancel}/cancel`, { method: "POST" }); loadSync(); });
  $("runsTable").innerHTML = `<tr><th>Started</th><th>Type</th><th class="num">Mauzas</th><th class="num">Changes</th><th class="num">Errors</th></tr>` +
    (sum.runs.map((r) => `<tr><td>${when(r.started)}</td><td>${esc(r.kind)}</td><td class="num">${r.mauzas}</td><td class="num">${r.added + r.changed + r.removed}</td><td class="num">${r.errors}</td></tr>`).join("")
      || `<tr><td colspan="5" class="hint">No runs yet.</td></tr>`);
}
$("btnSyncNow").onclick = async () => {
  try { await api("/api/sync/run", { method: "POST" }); } catch (e) { alert(e.message); }
  setTimeout(loadSync, 800);
};
setInterval(() => { if ($("tab-sync").classList.contains("active")) loadSync(); }, 5000);

async function refreshHeader() {
  try {
    const st = await api("/api/sync/status");
    $("hdrStatus").textContent = `${fmtN(st.cached_mauzas)} mauzas cached · auto-refresh every ${st.refresh_hours} h${st.running ? " · refreshing…" : ""}`;
  } catch (e) { $("hdrStatus").textContent = "Server not reachable"; }
}

init();
