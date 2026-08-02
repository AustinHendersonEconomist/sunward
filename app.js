/* Sunward static web UI: search form -> Engine.search cards; clicking a card
 * draws the trail as per-point sun/shade segments from Engine.trailDetail,
 * and the time scrubber recomputes the detail to recolour the trail live.
 * All scoring runs client-side (engine.js); only the map tiles, regional
 * data shards, geocoding, photos and the Open-Meteo cloud forecast come from
 * the network. The search origin is user-movable (draggable pin, map click,
 * address search or geolocation) and persists in localStorage. Vanilla JS. */

"use strict";

const SUN_COLOR = "#FDB515";
const SHADE_COLOR = "#64748B";
const SUN_RGB = [253, 181, 21];
const SHADE_RGB = [203, 213, 225]; // light grey for 0%-sun timeline slots
const DRIVE_KM_PER_MIN = 0.85; // crow-flies km per minute of driving
const SCRUB_HINT = "Drag the slider to move the sun; click a trail to see its sunlight";

// Search origin: user-movable, persisted; default is Cathedral Square,
// Christchurch (same default as the API). Stored as {lon, lat, label}.
const DEFAULT_ORIGIN = { lon: 172.6362, lat: -43.5321, label: "Christchurch (default)" };
const ORIGIN_STORE_KEY = "hikesun-origin";
const RANKMODE_STORE_KEY = "hikesun-rankmode";
const SHADOWS_STORE_KEY = "hikesun-shadows";
const SHADOW_DEBOUNCE_MS = 150;
const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";

const SOURCE_LABELS = {
  doc: ["DOC", "Department of Conservation"],
  osm: ["OSM", "OpenStreetMap"],
  hnk: ["HNK", "Herenga ā Nuku Outdoor Access Commission"],
};

/* place kinds (beaches/gardens/parks/reserves): chip emoji, and the unnamed
 * fallback — "Unnamed track" for hikes, "Unnamed beach" etc. for places */
const KIND_EMOJI = { beach: "🏖", garden: "🌳", park: "🌳", reserve: "🦜" };

function displayName(r) {
  if (r.name) return r.name;
  const kind = r.kind || "hike";
  return kind === "hike" ? "Unnamed track" : `Unnamed ${kind}`;
}

/* fetch with a hard timeout so a dead third-party service can't hang the UI */
function fetchTimeout(url, ms = 8000) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  return fetch(url, { signal: abort.signal }).finally(() => clearTimeout(timer));
}

const el = (id) => document.getElementById(id);
const form = el("search-form");
const dateInput = el("date");
const timeInput = el("time");
const statusBox = el("status");
const resultsBox = el("results");
const scrub = el("scrub");
const scrubLabel = el("scrub-label");
const scrubInfo = el("scrub-info");

let selected = null;      // currently selected search result
let searchSeq = 0;        // guards against out-of-order searches
let photoSeq = 0;         // guards against out-of-order photo-strip loads
let scrubTimer = null;
let engineReady = false;  // Engine.loadIndex succeeded
let lastResults = [];     // most recent search results, re-sorted client-side
                           // by the rank toggle (no refetch)
let lastSearchOpts = null; // opts of the last search, for "show all on map"
let lastCardById = new Map(); // result id -> its card element (current render)
const SHOWALL_STORE_KEY = "hikesun-showall";
const SHOWALL_CAP = 500;   // don't paint more than this many markers at once
function loadShowAll() {
  try { return localStorage.getItem(SHOWALL_STORE_KEY) === "on"; }
  catch (err) { return false; }
}
let showAllOnMap = loadShowAll();

/* ---- rank mode (terrain vs forecast) ------------------------------------- */

function loadRankMode() {
  try {
    const v = localStorage.getItem(RANKMODE_STORE_KEY);
    if (v === "terrain" || v === "forecast") return v;
  } catch (err) { /* corrupt/unavailable storage — fall back to default */ }
  return "forecast";
}

let rankMode = loadRankMode();
let rankLocked = false; // true when forecast is unavailable for this search

/* ---- origin state -------------------------------------------------------- */

function loadStoredOrigin() {
  try {
    const raw = localStorage.getItem(ORIGIN_STORE_KEY);
    if (raw) {
      const o = JSON.parse(raw);
      if (o && Number.isFinite(o.lon) && Number.isFinite(o.lat)) {
        return { lon: o.lon, lat: o.lat, label: String(o.label || "Saved origin") };
      }
    }
  } catch (err) { /* corrupt storage — fall back to the default */ }
  return { ...DEFAULT_ORIGIN };
}

let origin = loadStoredOrigin();

/* ---- map ---------------------------------------------------------------- */

const map = L.map("map", { zoomControl: true })
  .setView([origin.lat, origin.lon], 11);

const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

const esri = L.tileLayer(
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
  { maxZoom: 19, attribution: "Imagery &copy; Esri &amp; contributors" }
);

L.control.layers({ "Map": osm, "Satellite": esri }).addTo(map);

const markersLayer = L.layerGroup().addTo(map);
const trailLayer = L.layerGroup().addTo(map);

/* map marker for a result: hikes stay a sun-tinted dot; places (beaches,
 * parks, gardens, reserves) get a recognisable emoji badge, still tinted by
 * how sunny they are, so you can spot a beach on the map at a glance. */
function makeMarker(r) {
  const kind = r.kind || "hike";
  const tint = sunTint(headlineFrac(r));
  if (kind === "hike") {
    return L.circleMarker([r.start[1], r.start[0]], {
      radius: 7, color: "#fff", weight: 2, fillColor: tint, fillOpacity: 1,
    });
  }
  const icon = L.divIcon({
    className: "place-marker",
    html: `<span style="background:${tint}">${KIND_EMOJI[kind] || "📍"}</span>`,
    iconSize: [26, 26], iconAnchor: [13, 13],
  });
  return L.marker([r.start[1], r.start[0]], { icon });
}

/* ---- terrain shadow overlay ----------------------------------------------
 * Dedicated shadowPane (zIndex 350, between basemap tiles 200 and trails
 * 400), pointer-events:none, opacity ~0.45 so trails stay visible above it.
 * ShadowLayer creates the pane itself on first onAdd, but we also create it
 * here up front so it exists (and is correctly ordered) even before the
 * layer is toggled on for the first time. */
map.createPane("shadowPane");
map.getPane("shadowPane").style.zIndex = 350;
map.getPane("shadowPane").style.pointerEvents = "none";

const isCoarsePointer = typeof matchMedia === "function"
  && matchMedia("(pointer: coarse)").matches;

function loadShadowsEnabled() {
  try {
    const v = localStorage.getItem(SHADOWS_STORE_KEY);
    if (v === "on" || v === "off") return v === "on";
  } catch (err) { /* corrupt/unavailable storage — fall back to default */ }
  return !isCoarsePointer; // default ON for desktop, OFF for coarse pointers
}

let shadowsEnabled = loadShadowsEnabled();

const shadowLayer = new ShadowLayer({
  workerUrl: "shadow-worker.js",
  mode: "auto",
  opacity: 0.45,
});
const shadowBusyChip = el("shadow-busy");
shadowLayer.on("shadow:busy", () => { shadowBusyChip.hidden = false; });
shadowLayer.on("shadow:idle", () => { shadowBusyChip.hidden = true; });

const shadowToggleBtn = el("shadow-toggle");

function syncShadowToggleUI() {
  shadowToggleBtn.classList.toggle("on", shadowsEnabled);
  shadowToggleBtn.setAttribute("aria-pressed", String(shadowsEnabled));
}

function applyShadowEnabled() {
  if (shadowsEnabled) {
    if (!map.hasLayer(shadowLayer)) shadowLayer.addTo(map);
    shadowLayer.setEnabled(true);
    shadowLayer.setTime(currentShadowEpochMs());
  } else {
    shadowLayer.setEnabled(false);
    shadowBusyChip.hidden = true;
  }
}

function setShadowsEnabled(on) {
  shadowsEnabled = on;
  try {
    localStorage.setItem(SHADOWS_STORE_KEY, on ? "on" : "off");
  } catch (err) { /* private mode etc. — preference just won't persist */ }
  syncShadowToggleUI();
  applyShadowEnabled();
}

shadowToggleBtn.addEventListener("click", () => setShadowsEnabled(!shadowsEnabled));

/* "Show all on map": mark every in-range option, not just the ranked top list
 * — for surveying a new area. Only repaints markers; no re-search needed. */
const showAllBtn = el("showall-toggle");
function syncShowAllUI() {
  showAllBtn.classList.toggle("on", showAllOnMap);
  showAllBtn.setAttribute("aria-pressed", String(showAllOnMap));
}
function setShowAll(on) {
  showAllOnMap = on;
  try { localStorage.setItem(SHOWALL_STORE_KEY, on ? "on" : "off"); }
  catch (err) { /* private mode — preference just won't persist */ }
  syncShowAllUI();
  if (lastResults.length) renderMarkers();
  else if (!on) clearStatus();
}
showAllBtn.addEventListener("click", () => setShowAll(!showAllOnMap));
syncShowAllUI();

/* ---- live satellite cloud overlay (NASA GIBS / Himawari Band 13 IR) ------
 * LIVE ONLY: shows the most recent published frame (typically 20-30 min old)
 * and deliberately does NOT follow the time scrubber — the terrain shadows
 * do, but the satellite cannot show the future. Infrared greyscale:
 * bright/white = cloud tops. Frames are published every 10 minutes with some
 * latency, so we probe one known tile and step back until a frame exists. */
const CLOUDS_STORE_KEY = "hikesun-clouds"; // legacy key prefix kept on purpose
const GIBS_URL_PREFIX = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/" +
  "Himawari_AHI_Band13_Clean_Infrared/default/";
const GIBS_URL_SUFFIX = "/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png";
const CLOUD_FRAME_LAG_MIN = 20;         // first candidate: now minus this
const CLOUD_PROBE_TRIES = 6;            // then step back 10 min at a time
const CLOUD_REFRESH_MS = 10 * 60 * 1000;
const GIBS_NATIVE_MAXZOOM = 6;          // GoogleMapsCompatible_Level6 tops out here
const MAP_MAX_ZOOM = 19;                // must match the basemap layers' maxZoom

// cloudPane: above the shadow overlay (350), below the trail lines (400)
map.createPane("cloudPane");
map.getPane("cloudPane").style.zIndex = 360;
map.getPane("cloudPane").style.pointerEvents = "none";

const cloudToggleBtn = el("cloud-toggle");
const cloudCaption = el("cloud-caption");

let cloudsEnabled = false;
let cloudLayer = null;
let cloudRefreshTimer = null;
let cloudSeq = 0; // guards overlapping enable/refresh probe chains
let cloudFrameStep = 0;             // step-back of the frame on screen
let cloudFallbackPending = false;   // debounces the tileerror fallback

function loadCloudsEnabled() {
  try {
    const v = localStorage.getItem(CLOUDS_STORE_KEY);
    if (v === "on" || v === "off") return v === "on";
  } catch (err) { /* corrupt/unavailable storage — fall back to default */ }
  return false; // default OFF
}

function storeCloudsEnabled(on) {
  try {
    localStorage.setItem(CLOUDS_STORE_KEY, on ? "on" : "off");
  } catch (err) { /* private mode etc. — preference just won't persist */ }
}

function gibsUrl(frameIso) {
  return GIBS_URL_PREFIX + frameIso + GIBS_URL_SUFFIX;
}

/* UTC ISO "YYYY-MM-DDTHH:MM:00Z" for (now − lag − stepBack·10 min), floored
 * to a 10-minute boundary (GIBS publishes Himawari frames every 10 min). */
function cloudFrameIso(stepBack) {
  const tenMinMs = 10 * 60000;
  const t = Math.floor((Date.now() - CLOUD_FRAME_LAG_MIN * 60000
    - stepBack * tenMinMs) / tenMinMs) * tenMinMs;
  return new Date(t).toISOString().slice(0, 17) + "00Z";
}

/* probe a single tile that covers NZ at z=6 (row y=40, col x=62 — note GIBS
 * WMTS puts the row before the column) to see if the frame is published */
async function probeCloudFrame(frameIso) {
  const url = gibsUrl(frameIso)
    .replace("{z}", "6").replace("{y}", "40").replace("{x}", "62");
  try {
    const resp = await fetchTimeout(url);
    return resp.ok;
  } catch (err) {
    return false;
  }
}

/* Newest available frame at or older than `fromStep`, as {iso, step}, or null
 * if none of the remaining candidates exists. */
async function findCloudFrame(fromStep = 0) {
  for (let step = fromStep; step < CLOUD_PROBE_TRIES; step++) {
    const iso = cloudFrameIso(step);
    if (await probeCloudFrame(iso)) return { iso, step };
  }
  return null;
}

function syncCloudToggleUI() {
  cloudToggleBtn.classList.toggle("on", cloudsEnabled);
  cloudToggleBtn.setAttribute("aria-pressed", String(cloudsEnabled));
}

/* create-or-retarget the tile layer for a frame and update the caption
 * (frame time shown as NZ local wall clock).
 *
 * maxZoom must match the map's own max (not the imagery's): a tile layer's
 * maxZoom is the zoom past which Leaflet stops drawing the layer at all, so
 * capping it at the Level6 native zoom made the clouds silently vanish the
 * moment you zoomed into a trail. maxNativeZoom is the one that says "stop
 * asking for deeper tiles, upscale instead". */
function applyCloudFrame(frameIso, step = 0) {
  const url = gibsUrl(frameIso);
  cloudFrameStep = step;
  if (!cloudLayer) {
    cloudLayer = L.tileLayer(url, {
      tms: false,
      maxNativeZoom: GIBS_NATIVE_MAXZOOM,
      maxZoom: MAP_MAX_ZOOM,
      opacity: 0.55,
      pane: "cloudPane",
    });
    cloudLayer.on("tileerror", onCloudTileError);
  } else if (cloudLayer._url !== url) {
    cloudLayer.setUrl(url);
  }
  if (!map.hasLayer(cloudLayer)) cloudLayer.addTo(map);
  cloudCaption.textContent =
    `clouds: live satellite ${SunMath.isoNZ(Date.parse(frameIso)).slice(11, 16)}`;
  cloudCaption.hidden = false;
}

/* A frame can pass the single-tile probe and still 404 for the tiles the map
 * actually wants (GIBS publishes a frame's tiles progressively, and its
 * backends briefly disagree about whether a frame exists). Rather than leave
 * a caption promising imagery that never paints, fall back to the next older
 * frame. Debounced because one bad frame fires tileerror per visible tile. */
function onCloudTileError() {
  if (!cloudsEnabled || cloudFallbackPending) return;
  if (cloudFrameStep + 1 >= CLOUD_PROBE_TRIES) {
    showToast("live cloud imagery unavailable right now");
    disableClouds();
    return;
  }
  cloudFallbackPending = true;
  const seq = cloudSeq;
  setTimeout(async () => {
    cloudFallbackPending = false;
    if (seq !== cloudSeq || !cloudsEnabled) return;
    const next = await findCloudFrame(cloudFrameStep + 1);
    if (seq !== cloudSeq || !cloudsEnabled) return;
    if (next == null) {
      showToast("live cloud imagery unavailable right now");
      disableClouds();
      return;
    }
    applyCloudFrame(next.iso, next.step);
  }, 400);
}

function disableClouds({ persist = true } = {}) {
  cloudSeq++; // cancels any in-flight probe chain (and any pending fallback)
  cloudsEnabled = false;
  cloudFrameStep = 0;
  if (persist) storeCloudsEnabled(false);
  clearInterval(cloudRefreshTimer);
  cloudRefreshTimer = null;
  if (cloudLayer && map.hasLayer(cloudLayer)) map.removeLayer(cloudLayer);
  cloudCaption.hidden = true;
  syncCloudToggleUI();
}

async function enableClouds({ persist = true } = {}) {
  const seq = ++cloudSeq;
  cloudsEnabled = true;
  if (persist) storeCloudsEnabled(true);
  syncCloudToggleUI();
  const frame = await findCloudFrame();
  if (seq !== cloudSeq) return; // toggled off (or re-toggled) meanwhile
  if (frame == null) {
    showToast("live cloud imagery unavailable right now");
    disableClouds(); // leaves the toggle off
    return;
  }
  applyCloudFrame(frame.iso, frame.step);
  clearInterval(cloudRefreshTimer);
  cloudRefreshTimer = setInterval(refreshCloudFrame, CLOUD_REFRESH_MS);
}

/* every 10 min while enabled: look for a newer frame and retarget the layer;
 * if GIBS is briefly unreachable just keep showing the last good frame */
async function refreshCloudFrame() {
  const seq = cloudSeq;
  const frame = await findCloudFrame();
  if (seq !== cloudSeq || !cloudsEnabled || frame == null) return;
  applyCloudFrame(frame.iso, frame.step);
}

cloudToggleBtn.addEventListener("click", () => {
  if (cloudsEnabled) disableClouds();
  else enableClouds();
});

if (loadCloudsEnabled()) enableClouds({ persist: false });

/* full-screen map: hide the sidebar so the map fills the viewport. Leaflet
 * needs invalidateSize() once the container has resized. */
const mapExpandBtn = el("map-expand");
mapExpandBtn.addEventListener("click", () => {
  const full = document.body.classList.toggle("map-full");
  mapExpandBtn.textContent = full ? "✕" : "⛶";
  mapExpandBtn.setAttribute("aria-pressed", String(full));
  mapExpandBtn.title = full ? "Exit full-screen map" : "Toggle full-screen map";
  setTimeout(() => map.invalidateSize(), 60);
});

/* current scrubber time as an NZ epoch (ms), for the shadow layer */
function currentShadowEpochMs() {
  return SunMath.nzEpoch(dateInput.value, minutesToHHMM(+scrub.value));
}

let shadowTimer = null;
function scheduleShadowUpdate() {
  if (!shadowsEnabled) return;
  clearTimeout(shadowTimer);
  shadowTimer = setTimeout(() => {
    shadowLayer.setTime(currentShadowEpochMs());
  }, SHADOW_DEBOUNCE_MS);
}

// sun-yellow draggable origin pin, kept above the result markers
const originIcon = L.divIcon({
  className: "origin-pin",
  iconSize: [30, 42],
  iconAnchor: [15, 41],
  html:
    '<svg width="30" height="42" viewBox="0 0 30 42" xmlns="http://www.w3.org/2000/svg">' +
    '<path d="M15 41C15 41 3 24.5 3 13a12 12 0 1 1 24 0c0 11.5-12 28-12 28z"' +
    ' fill="#FDB515" stroke="#fff" stroke-width="2.5"/>' +
    '<circle cx="15" cy="13" r="4.5" fill="#7a5200"/></svg>',
});

const originMarker = L.marker([origin.lat, origin.lon], {
  icon: originIcon,
  draggable: true,
  zIndexOffset: 1000,
  title: "Search origin — drag to move",
}).addTo(map);
originMarker.bindTooltip("Search origin — drag to move");

originMarker.on("dragend", () => {
  const ll = originMarker.getLatLng();
  setOrigin(ll.lng, ll.lat,
    `Dropped pin (${ll.lat.toFixed(4)}, ${ll.lng.toFixed(4)})`, { recenter: false });
});

/* ---- helpers ------------------------------------------------------------ */

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function showStatus(msg, isError) {
  statusBox.hidden = false;
  statusBox.textContent = msg;
  statusBox.classList.toggle("error", !!isError);
}

function clearStatus() {
  statusBox.hidden = true;
}

let toastTimer = null;
function showToast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

/* grey -> sun-yellow tint for a sun fraction in [0, 1] */
function sunTint(frac) {
  const f = Math.max(0, Math.min(1, frac));
  const c = SHADE_RGB.map((s, i) => Math.round(s + (SUN_RGB[i] - s) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function fmtMinutes(min) {
  if (min == null) return "time n/a";
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${rest} min` : `${h} h`;
}

// canopy chip: native bush vs plantation (LCDB land-cover), or null to omit
const CANOPY_KIND = {
  native: ["🌿", "native bush"],
  exotic: ["🌲", "plantation"],
  mixed: ["🌳", "mixed forest"],
};
function canopyMeta(r) {
  if (r.canopy_frac == null || r.canopy_type === "none") return null;
  const pct = Math.round(r.canopy_frac * 100);
  if (pct === 0) return null;   // barely clips bush — not worth a chip
  const [emoji, label] = CANOPY_KIND[r.canopy_type] || ["🌲", "canopy"];
  return `<span title="Tree canopy (LCDB land cover)">${emoji} ${pct}% ${label}</span>`;
}

function minutesToHHMM(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + (m || 0);
}

/* ---- origin controls ----------------------------------------------------- */

function setOrigin(lon, lat, label, opts = {}) {
  origin = { lon, lat, label };
  try {
    localStorage.setItem(ORIGIN_STORE_KEY, JSON.stringify(origin));
  } catch (err) { /* private mode etc. — origin just won't persist */ }
  originMarker.setLatLng([lat, lon]);
  el("origin-label").textContent = `📍 Origin: ${label}`;
  if (opts.recenter) {
    suppressMove(() => map.setView([lat, lon], Math.max(map.getZoom(), 11)));
  }
  showToast("Origin set");
  runSearch();
}

/* "set origin by clicking the map" toggle */
const armBtn = el("origin-arm");
let picking = false;

function setPicking(on) {
  picking = on;
  armBtn.classList.toggle("armed", on);
  armBtn.textContent = on ? "Click the map to set origin…" : "📍 Set origin";
  el("map").classList.toggle("picking", on);
}

armBtn.addEventListener("click", () => setPicking(!picking));

map.on("click", (ev) => {
  if (!picking) return;
  setPicking(false);
  setOrigin(ev.latlng.lng, ev.latlng.lat,
    `Dropped pin (${ev.latlng.lat.toFixed(4)}, ${ev.latlng.lng.toFixed(4)})`,
    { recenter: false });
});

/* address search (Nominatim, debounced, Enter/button only per fair use) */
const addrInput = el("addr");
const addrResults = el("addr-results");
let addrTimer = null;
let geocodeSeq = 0;

function requestGeocode() {
  clearTimeout(addrTimer);
  addrTimer = setTimeout(geocode, 400);
}

async function geocode() {
  const q = addrInput.value.trim();
  if (!q) {
    hideAddrResults();
    return;
  }
  const seq = ++geocodeSeq;
  let places;
  try {
    const resp = await fetchTimeout(
      `${NOMINATIM_URL}?format=json&countrycodes=nz&limit=5&q=${encodeURIComponent(q)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    places = await resp.json();
  } catch (err) {
    if (seq === geocodeSeq) {
      showStatus("Address lookup failed — check your connection and try again.", true);
    }
    return;
  }
  if (seq !== geocodeSeq) return;
  renderAddrResults(places);
}

function renderAddrResults(places) {
  addrResults.innerHTML = "";
  if (!places.length) {
    const none = document.createElement("div");
    none.className = "addr-empty";
    none.textContent = "No NZ matches — try adding a suburb or town.";
    addrResults.appendChild(none);
  }
  for (const p of places) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = p.display_name;
    btn.title = p.display_name;
    btn.addEventListener("click", () => {
      const label = String(p.display_name).split(",").slice(0, 2).join(",");
      hideAddrResults();
      addrInput.value = label;
      setOrigin(parseFloat(p.lon), parseFloat(p.lat), label, { recenter: true });
    });
    addrResults.appendChild(btn);
  }
  const credit = document.createElement("div");
  credit.className = "addr-credit";
  credit.textContent = "search © OpenStreetMap Nominatim";
  addrResults.appendChild(credit);
  addrResults.hidden = false;
}

function hideAddrResults() {
  addrResults.hidden = true;
  addrResults.innerHTML = "";
}

el("addr-go").addEventListener("click", requestGeocode);
addrInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") {
    ev.preventDefault(); // find the address; don't submit the search form
    requestGeocode();
  } else if (ev.key === "Escape") {
    hideAddrResults();
  }
});
document.addEventListener("click", (ev) => {
  if (!addrResults.hidden && !ev.target.closest(".addr-row")) hideAddrResults();
});

/* "use my location" (may be blocked — degrade with a message) */
el("locate-btn").addEventListener("click", () => {
  if (!navigator.geolocation) {
    showStatus("Geolocation is not available in this browser — try the address box.", true);
    return;
  }
  showStatus("Locating…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      clearStatus();
      setOrigin(pos.coords.longitude, pos.coords.latitude, "My location",
        { recenter: true });
    },
    () => showStatus(
      "Could not get your location (it may be blocked) — try the address box.", true),
    { timeout: 10000 },
  );
});

/* ---- search ------------------------------------------------------------- */

/* checked "Show" kinds as a flat array (one chip may carry several comma-
 * separated kinds, e.g. "park,garden"), or null when every chip is checked —
 * all-on means no kind constraint. All-off yields [] (matches nothing). */
function selectedKinds() {
  const boxes = [...document.querySelectorAll("#kinds input")];
  const checked = boxes.filter((b) => b.checked);
  if (!boxes.length || checked.length === boxes.length) return null;
  return checked.flatMap((b) => b.value.split(","));
}

/* `area: true` searches the map's current bounds instead of the drive radius.
 * The origin is left where it is, so drive times still read from home. */
async function runSearch({ area = false } = {}) {
  if (!engineReady) return; // index not loaded (message already shown)
  const btn = el("search-btn");
  const seq = ++searchSeq;
  btn.disabled = true;
  clearStatus();
  try {
    const dateStr = dateInput.value;
    const timeStr = timeInput.value || "10:00";
    const driveMin = Number(el("drive-min").value) || 30;
    const startMs = Engine.nzEpoch(dateStr, timeStr);

    const view = map.getBounds();
    const bounds = area
      ? [[view.getSouth(), view.getWest()], [view.getNorth(), view.getEast()]]
      : null;

    // Load the shards covering whatever is being searched: the drive radius,
    // or the viewport plus a margin when searching an area.
    showStatus("Loading region data…");
    if (area) {
      const c = view.getCenter();
      const halfKm = map.distance(view.getSouthWest(), view.getNorthEast()) / 2000;
      await Engine.ensureCells([c.lng, c.lat], halfKm);
    } else {
      await Engine.ensureCells([origin.lon, origin.lat], driveMin * DRIVE_KM_PER_MIN);
    }
    if (seq !== searchSeq) return; // superseded by a newer search

    const minM = el("min-minutes").value;
    const maxM = el("max-minutes").value;
    const checked = [...document.querySelectorAll("#difficulty input:checked")]
      .map((c) => c.value);
    // shared by the ranked search and the "show all on map" candidate sweep
    lastSearchOpts = {
      lat: origin.lat, lon: origin.lon, driveMin, startMs, bounds,
      minMinutes: minM ? Number(minM) : null,
      maxMinutes: maxM ? Number(maxM) : null,
      difficulties: checked.length ? checked : null,
      kinds: selectedKinds(),
    };
    const results = await Engine.search({
      ...lastSearchOpts, limit: 20, useWeather: true, rankBy: rankMode,
    });
    if (seq !== searchSeq) return; // superseded by a newer search
    lastResults = results;
    lastSearchBounds = view;   // any search anchors 'moved since'
    renderResults(results);
    if (typeof syncAreaUi === "function") syncAreaUi();
  } catch (err) {
    if (seq !== searchSeq) return;
    resultsBox.innerHTML = "";
    showStatus(`Search failed: ${err.message}`, true);
  } finally {
    if (seq === searchSeq) btn.disabled = false;
  }
}

/* headline metric for a result under the current rank mode: "forecast" shows
 * sun.effective (terrain x cloud), "terrain" shows sun.terrain_frac. When a
 * trail has no forecast, effective === terrain_frac already, so this never
 * needs a special case. */
function headlineFrac(r) {
  return rankMode === "terrain" ? r.sun.terrain_frac : r.sun.effective;
}

function sortResults(results) {
  const sorted = results.slice();
  if (rankMode === "terrain") {
    sorted.sort((a, b) => b.sun.terrain_frac - a.sun.terrain_frac);
  } else {
    sorted.sort((a, b) => b.sun.effective - a.sun.effective);
  }
  return sorted;
}

/* Lock the rank toggle to terrain (with an explanatory note) when NONE of
 * the results has a forecast — e.g. date beyond the ~16-day horizon, or
 * Open-Meteo unreachable. Never an error state. */
function updateRankLock(results) {
  rankLocked = results.length > 0 && results.every((r) => r.sun.no_forecast);
  const toggle = el("rank-toggle");
  const note = el("rank-lock-note");
  if (toggle) toggle.classList.toggle("locked", rankLocked);
  const forecastBtn = el("rank-forecast");
  if (forecastBtn) forecastBtn.disabled = rankLocked;
  if (rankLocked && rankMode !== "terrain") {
    rankMode = "terrain";
    syncRankToggleUI();
  }
  if (note) note.hidden = !rankLocked;
}

function syncRankToggleUI() {
  const terrainBtn = el("rank-terrain");
  const forecastBtn = el("rank-forecast");
  if (!terrainBtn || !forecastBtn) return;
  terrainBtn.classList.toggle("active", rankMode === "terrain");
  forecastBtn.classList.toggle("active", rankMode === "forecast");
  terrainBtn.setAttribute("aria-pressed", String(rankMode === "terrain"));
  forecastBtn.setAttribute("aria-pressed", String(rankMode === "forecast"));
}

function setRankMode(mode) {
  if (mode === rankMode) return;
  rankMode = mode;
  try {
    localStorage.setItem(RANKMODE_STORE_KEY, rankMode);
  } catch (err) { /* private mode etc. — rank mode just won't persist */ }
  syncRankToggleUI();
  if (lastResults.length) renderResults(lastResults);
}

function renderResults(results) {
  resultsBox.innerHTML = "";
  markersLayer.clearLayers();
  trailLayer.clearLayers();
  selected = null;
  hidePhotoStrip();
  scrubInfo.textContent = SCRUB_HINT;
  // start the shared scrubber at the searched time; from here the user can
  // drag it freely (moving the shadows) and any trail they pick is shown at
  // whatever time the slider is on.
  const searchMin = hhmmToMinutes(timeInput.value || "10:00");
  scrub.value = Math.max(480, Math.min(1020, Math.round(searchMin / 15) * 15));
  scrubLabel.textContent = minutesToHHMM(+scrub.value);
  scheduleShadowUpdate();

  updateRankLock(results);
  syncRankToggleUI();

  if (!results.length) {
    markersLayer.clearLayers();
    lastCardById = new Map();
    showStatus("No trails found — try a longer drive time or fewer filters.");
    return;
  }
  const sorted = sortResults(results);
  showStatus(`${sorted.length} trail${sorted.length > 1 ? "s" : ""} found, sunniest first.`);

  lastCardById = new Map();
  for (const r of sorted) {
    const card = buildCard(r);
    resultsBox.appendChild(card);
    lastCardById.set(r.id, card);
  }
  renderMarkers();
}

/* Paint map markers. Default: just the ranked result cards. With "show all
 * on map" on, every in-range option is marked (terrain-scored, no weather) so
 * you can survey a whole city's walks/beaches at a glance — clicking any
 * marker selects it, and the top-list ones also highlight their card. */
function renderMarkers() {
  markersLayer.clearLayers();
  const rich = new Map(lastResults.map((r) => [r.id, r]));
  let list = lastResults;
  let truncated = false;
  if (showAllOnMap && lastSearchOpts) {
    list = Engine.candidatesInRange(lastSearchOpts);
    if (list.length > SHOWALL_CAP) { list = list.slice(0, SHOWALL_CAP); truncated = true; }
  }
  for (const r of list) {
    const marker = makeMarker(r).addTo(markersLayer);
    marker.bindTooltip(displayName(r));
    marker.on("click", () => {
      const card = lastCardById.get(r.id) || null;
      selectTrail(rich.get(r.id) || r, card);
      if (card) card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }
  if (showAllOnMap && lastSearchOpts) {
    showStatus(`${lastResults.length} sunniest listed · ${list.length}`
      + `${truncated ? "+" : ""} shown on the map — click any marker.`);
  } else {
    // say WHICH filter produced these, since the two answer different questions
    const where = (lastSearchOpts && lastSearchOpts.bounds)
      ? "in view" : "within your drive";
    showStatus(`${lastResults.length} trail${lastResults.length > 1 ? "s" : ""}`
      + ` ${where}, sunniest first.`);
  }
}

function sourceBadge(source) {
  const key = String(source || "").toLowerCase();
  const [label, full] = SOURCE_LABELS[key] || [key.toUpperCase() || "?", ""];
  const cls = SOURCE_LABELS[key] ? key : "osm";
  return `<span class="badge ${cls}" title="${escapeHtml(full)}">${escapeHtml(label)}</span>`;
}

/* thin cloud strip above a card's sun timeline: one segment per timeline_cloud
 * slot, grey-scale by cloud fraction (dark = cloudy). Absent/all-null ->
 * caller omits the strip entirely (no forecast for this trail). */
function cloudStripHtml(r) {
  const tc = r.timeline_cloud;
  if (!tc || !tc.length || tc.every((c) => c == null)) return "";
  const slots = r.timeline.map((s, i) => {
    const c = tc[i];
    const label = c == null
      ? `${s.t.slice(11, 16)} — ${Math.round(s.frac * 100)}% terrain sun · no forecast`
      : `${s.t.slice(11, 16)} — ${Math.round(s.frac * 100)}% terrain sun · ${Math.round(c * 100)}% cloud`;
    const bg = c == null ? "#e2e6eb" : cloudTint(c);
    return `<i style="background:${bg}" title="${escapeHtml(label)}"></i>`;
  }).join("");
  return `<div class="cloud-strip">${slots}</div>`;
}

/* white (clear) -> mid-grey (overcast) tint for a cloud fraction in [0, 1] */
function cloudTint(frac) {
  const f = Math.max(0, Math.min(1, frac));
  const v = Math.round(245 - 110 * f);
  return `rgb(${v},${v},${v})`;
}

function buildCard(r) {
  const card = document.createElement("div");
  card.className = "card";

  const headline = headlineFrac(r);
  const sunPct = Math.round(headline * 100);
  const meta = [];
  meta.push(sourceBadge(r.source));
  const kind = r.kind || "hike";
  if (kind !== "hike") {
    meta.push(`<span class="chip kind" title="Place type">` +
      `${KIND_EMOJI[kind] || "📍"} ${escapeHtml(kind)}</span>`);
  }
  if (r.difficulty) {
    meta.push(`<span class="chip ${escapeHtml(r.difficulty)}">${escapeHtml(r.difficulty)}</span>`);
  }
  if (r.region) {
    meta.push(`<span title="Region">📍 ${escapeHtml(r.region)}</span>`);
  }
  meta.push(`<span>🥾 ${fmtMinutes(r.est_minutes)}</span>`);
  meta.push(`<span>🚗 ~${Math.round(r.drive_min_est)} min (${r.drive_km.toFixed(0)} km)</span>`);
  const canopy = canopyMeta(r);
  if (canopy) meta.push(canopy);

  const slots = r.timeline.map((s) =>
    `<i style="background:${sunTint(s.frac)}" title="${s.t.slice(11, 16)} — ${Math.round(s.frac * 100)}% in sun"></i>`
  ).join("");
  const tlStart = r.timeline.length ? r.timeline[0].t.slice(11, 16) : "";
  const tlEnd = r.timeline.length ? r.timeline[r.timeline.length - 1].t.slice(11, 16) : "";
  const cloudStrip = cloudStripHtml(r);

  const photo = r.photo_url
    ? `<img class="card-photo" src="${escapeHtml(r.photo_url)}" alt="" loading="lazy">`
    : "";
  if (photo) card.classList.add("has-photo");

  const componentsLine = r.sun.no_forecast
    ? `<small>sun · no forecast</small>`
    : `<small title="sun score = terrain sun × (1 − 0.75 × cloud), duration-weighted over your hike window">` +
      `☀ ${Math.round(r.sun.terrain_frac * 100)}% terrain · ` +
      `☁ ${Math.round(r.sun.cloud_cover * 100)}% cloud</small>`;

  card.innerHTML = `
    ${photo}
    <div class="card-main">
      <div class="card-top">
        <h3>${escapeHtml(displayName(r))}</h3>
        <div class="sunpct">
          <b>${sunPct}%</b>
          ${componentsLine}
        </div>
      </div>
      <div class="meta">${meta.join("")}</div>
      ${cloudStrip}
      <div class="timeline">${slots}</div>
      <div class="tl-caption"><span>${tlStart}</span><span>sun along your hike</span><span>${tlEnd}</span></div>
    </div>
  `;
  const img = card.querySelector(".card-photo");
  if (img) {
    // broken/blocked thumbnails degrade to the photo-less card look
    img.addEventListener("error", () => {
      img.remove();
      card.classList.remove("has-photo");
    });
  }
  card.addEventListener("click", () => selectTrail(r, card));
  return card;
}

/* ---- photos (trail photo + nearby Wikimedia Commons) --------------------- */

function hidePhotoStrip() {
  photoSeq++;
  el("photo-strip").hidden = true;
  el("photos").innerHTML = "";
  el("photo-credit").hidden = true;
}

/* up to 4 CC photos geotagged within 2 km of (lat, lon); [] on ANY failure */
async function fetchCommonsPhotos(lat, lon) {
  try {
    const geoResp = await fetchTimeout(
      `${COMMONS_API}?action=query&list=geosearch&gscoord=${lat.toFixed(5)}%7C${lon.toFixed(5)}` +
      "&gsradius=2000&gsnamespace=6&gslimit=4&format=json&origin=*");
    if (!geoResp.ok) return [];
    const geoBody = await geoResp.json();
    const found = (geoBody.query && geoBody.query.geosearch) || [];
    if (!found.length) return [];
    const ids = found.map((p) => p.pageid).join("|");
    const infoResp = await fetchTimeout(
      `${COMMONS_API}?action=query&prop=imageinfo&iiprop=url&iiurlwidth=200` +
      `&pageids=${encodeURIComponent(ids)}&format=json&origin=*`);
    if (!infoResp.ok) return [];
    const infoBody = await infoResp.json();
    const out = [];
    for (const page of Object.values((infoBody.query && infoBody.query.pages) || {})) {
      const ii = page.imageinfo && page.imageinfo[0];
      if (ii && ii.thumburl) {
        out.push({
          thumb: ii.thumburl,
          href: ii.descriptionurl || null,
          title: String(page.title || "").replace(/^File:/, ""),
        });
      }
    }
    return out.slice(0, 4);
  } catch (err) {
    return []; // photos are decoration — never let them break the UI
  }
}

async function loadPhotoStrip(r) {
  const seq = ++photoSeq;
  const strip = el("photo-strip");
  const box = el("photos");
  strip.hidden = true;
  box.innerHTML = "";
  el("photo-credit").hidden = true;

  const items = [];
  if (r.photo_url) {
    items.push({ thumb: r.photo_url, href: r.url || null, title: displayName(r) });
  }
  const commons = await fetchCommonsPhotos(r.start[1], r.start[0]);
  if (seq !== photoSeq) return; // a newer selection superseded this load
  items.push(...commons);
  if (!items.length) return;

  for (const it of items) {
    let wrap;
    if (it.href) {
      wrap = document.createElement("a");
      wrap.href = it.href;
      wrap.target = "_blank";
      wrap.rel = "noopener";
    } else {
      wrap = document.createElement("span");
    }
    wrap.className = "photo";
    wrap.title = it.title || "";
    const img = document.createElement("img");
    img.src = it.thumb;
    img.alt = it.title || "";
    img.loading = "lazy";
    img.addEventListener("error", () => wrap.remove());
    wrap.appendChild(img);
    box.appendChild(wrap);
  }
  el("photo-credit").hidden = !commons.length;
  strip.hidden = false;
}

/* ---- trail detail + scrubber -------------------------------------------- */

function selectTrail(result, card) {
  selected = result;
  for (const c of resultsBox.querySelectorAll(".card")) c.classList.remove("selected");
  if (card) card.classList.add("selected");   // "show all" markers have no card

  // keep the scrubber wherever the user left it (they may have been
  // exploring shadows at another time); show this trail's sun for that time
  loadTrailDetail(true, true);
  loadPhotoStrip(result);
}

/* fullRender: rebuild the whole detail panel (on selection). Scrubber ticks
 * pass false so only the time-dependent parts are repainted. */
function loadTrailDetail(fitMap, fullRender = false) {
  if (!selected) return;
  try {
    const atMs = Engine.nzEpoch(dateInput.value, minutesToHHMM(+scrub.value));
    const detail = Engine.trailDetail(selected.id, atMs);
    drawTrail(detail, fitMap);
    if (fullRender) renderDetail(detail);
    else updateDetailNow(detail);
  } catch (err) {
    showStatus(`Could not load trail: ${err.message}`, true);
  }
}

function drawTrail(detail, fitMap) {
  trailLayer.clearLayers();
  const pts = detail.points;
  if (pts.length < 2) return;

  const latlngs = pts.map((p) => [p.lat, p.lon]);
  // white casing underneath makes the colours pop on both base layers
  L.polyline(latlngs, { color: "#fff", weight: 9, opacity: 0.9, lineCap: "round" })
    .addTo(trailLayer);
  // per-point segments: segment i takes the sun state of its leading point
  for (let i = 0; i < pts.length - 1; i++) {
    L.polyline([latlngs[i], latlngs[i + 1]], {
      color: pts[i].sun ? SUN_COLOR : SHADE_COLOR,
      weight: 5,
      opacity: 1,
      lineCap: "round",
    }).addTo(trailLayer);
  }

  if (fitMap) {
    suppressMove(() => map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40] }));
  }

  const sunny = pts.filter((p) => p.sun).length;
  const pct = Math.round((100 * sunny) / pts.length);
  const cloudPct = cloudAtScrub();
  const cloudPart = cloudPct == null ? "" : ` · ${cloudPct}% cloud`;
  scrubInfo.textContent =
    `${displayName(detail)} — ${pct}% of the trail in sun at ${minutesToHHMM(+scrub.value)}${cloudPart}`;
}

/* ---- address sun-hours lookup --------------------------------------------
 * "How much winter sun does this spot get?" for any address, not just the
 * mapped walks. Terrain only: this is bare-earth shading from ridges and
 * hills, computed from the same DEM and the same geometry as the trail
 * profiles. It does NOT know about buildings, fences or trees — a city
 * section can read 7 h here and get almost none in reality. Building-level
 * shading needs a LiDAR surface model and is a separate product. */

const SUN_MIN_ELEV_DEG = 0.25;      // matches engine.js
const SUNHOURS_STEP_MIN = 10;       // resolution of the day sweep
const MIDWINTER = "-06-21";         // shortest day, the number that matters

let sunHoursSeq = 0;

/* sunlit at this instant, from a raw 120-bin profile */
function inSunProfile(profile, elevDeg, azDeg) {
  if (elevDeg <= SUN_MIN_ELEV_DEG) return false;
  const bin = Math.floor((((azDeg % 360) + 360) % 360) / (360 / profile.length))
    % profile.length;
  return elevDeg > profile[bin];
}

/* ask a shadow worker for a horizon profile at an arbitrary point */
function requestHorizon(lon, lat) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("shadow-worker.js");
    const id = `hz-${Date.now()}`;
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error("timed out reading elevation tiles"));
    }, 60000);
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.id !== id) return;
      clearTimeout(timer);
      worker.terminate();
      if (m.phase === "error") reject(new Error(m.message));
      else if (!m.profile) reject(new Error("no elevation data covers that point"));
      else resolve({ profile: new Float32Array(m.profile), elev: m.elev });
    };
    worker.onerror = (e) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(e.message || "worker failed"));
    };
    const tileUrl = (typeof HIKESUN_TILE_URL !== "undefined")
      ? HIKESUN_TILE_URL
      : "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
    worker.postMessage({ type: "horizon", id, lon, lat, tileUrl });
  });
}

/* Sweep a whole day at SUNHOURS_STEP_MIN and report sunlit hours plus the
 * first and last sunlit instant. openHours is the same sweep ignoring
 * terrain, so the difference is what the skyline costs you. */
function sunHoursForDay(profile, lon, lat, dateStr) {
  const slots = [];
  let first = null;
  let last = null;
  for (let min = 0; min < 24 * 60; min += SUNHOURS_STEP_MIN) {
    const ms = Engine.nzEpoch(dateStr, minutesToHHMM(min));
    const sun = Engine.sunPosition(lat, lon, ms);
    const lit = inSunProfile(profile, sun.elevation, sun.azimuth);
    const up = sun.elevation > SUN_MIN_ELEV_DEG;
    slots.push({ min, lit, up, elev: sun.elevation, az: sun.azimuth });
    if (lit) {
      if (first == null) first = min;
      last = min;
    }
  }
  const stepH = SUNHOURS_STEP_MIN / 60;
  return {
    slots,
    hours: slots.filter((s) => s.lit).length * stepH,
    openHours: slots.filter((s) => s.up).length * stepH,
    first,
    last,
  };
}

/* horizon skyline: the profile as the wall of terrain around the point,
 * N through E/S/W back to N, with the sun's own arc for the day over it */
function skylineSvg(profile, slots) {
  const W = 320, H = 84, PAD_B = 14;
  const maxAng = Math.max(12, Math.ceil(Math.max(...profile) + 3));
  const y = (deg) => (H - PAD_B) * (1 - Math.max(0, deg) / maxAng);
  const x = (az) => (az / 360) * W;

  const n = profile.length;
  const step = 360 / n;
  let wall = `M0,${H - PAD_B}`;
  for (let k = 0; k < n; k++) {
    wall += `L${x(k * step).toFixed(1)},${y(profile[k]).toFixed(1)}`
      + `L${x((k + 1) * step).toFixed(1)},${y(profile[k]).toFixed(1)}`;
  }
  wall += `L${W},${H - PAD_B}Z`;

  const arc = slots.filter((s) => s.elev > 0).map((s, i) =>
    `${i ? "L" : "M"}${x(s.az).toFixed(1)},${y(s.elev).toFixed(1)}`).join("");
  const dots = slots.filter((s) => s.elev > 0 && s.min % 60 === 0)
    .map((s) => `<circle cx="${x(s.az).toFixed(1)}" cy="${y(s.elev).toFixed(1)}"`
      + ` r="2" fill="${s.lit ? "#e09b00" : "#94a3b8"}"/>`).join("");

  const labels = [[0, "N"], [90, "E"], [180, "S"], [270, "W"]].map(([a, t]) =>
    `<text class="detail-tick" x="${x(a).toFixed(1)}" y="${H - 2}"`
    + ` text-anchor="${a === 0 ? "start" : "middle"}">${t}</text>`).join("");

  return `<svg class="detail-chart" viewBox="0 0 ${W} ${H}" role="img"
     aria-label="Terrain skyline around this point with the sun's path">
    <path d="${wall}" fill="#cbd5e1" opacity="0.9"/>
    <path d="${arc}" fill="none" stroke="#e09b00" stroke-width="1.6"
          stroke-dasharray="3 2"/>
    ${dots}${labels}
  </svg>`;
}

/* the sunlit part of the day as a bar: gold = sun reaches you, grey = the
 * sun is up but behind terrain */
function dayBarSvg(slots) {
  const W = 320, H = 20;
  const up = slots.filter((s) => s.up);
  if (!up.length) return "";
  const from = up[0].min, to = up[up.length - 1].min;
  const span = to - from || 1;
  const w = (SUNHOURS_STEP_MIN / span) * W;
  const bars = up.map((s) =>
    `<rect x="${(((s.min - from) / span) * W).toFixed(2)}" y="0"`
    + ` width="${(w + 0.5).toFixed(2)}" height="${H}"`
    + ` fill="${s.lit ? SUN_COLOR : SHADE_COLOR}"/>`).join("");
  const ticks = [from, Math.round((from + to) / 2), to].map((m, i) =>
    `<text class="detail-tick" x="${(((m - from) / span) * W).toFixed(1)}"`
    + ` y="${H + 11}" text-anchor="${i === 0 ? "start" : i === 2 ? "end" : "middle"}">`
    + `${minutesToHHMM(Math.round(m / 15) * 15)}</text>`).join("");
  return `<svg class="detail-chart" viewBox="0 0 ${W} ${H + 14}" role="img"
     aria-label="Sunlit and shaded parts of the day">${bars}${ticks}</svg>`;
}

async function runSunHours(lon, lat, label) {
  const seq = ++sunHoursSeq;
  const box = el("sunhours");
  const closer = () => {
    const b = el("sunhours-close");
    if (b) b.addEventListener("click", () => { box.hidden = true; });
  };
  box.hidden = false;
  box.innerHTML = `<div class="detail-head"><div><h2>☀ Sun at this address</h2>
      <div class="meta">${escapeHtml(label || "")}</div></div>
      <button type="button" class="detail-close" id="sunhours-close"
              title="Close" aria-label="Close">×</button></div>
    <p class="sunhours-loading">Reading elevation tiles and tracing the
      skyline in 120 directions…</p>`;
  closer();
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });

  let hz;
  try {
    hz = await requestHorizon(lon, lat);
  } catch (err) {
    if (seq !== sunHoursSeq) return;
    box.querySelector(".sunhours-loading").textContent =
      `Could not compute sun hours: ${err.message}`;
    return;
  }
  if (seq !== sunHoursSeq) return;

  const dateStr = dateInput.value || Engine.nzDateStr();
  const winter = `${dateStr.slice(0, 4)}${MIDWINTER}`;
  const w = sunHoursForDay(hz.profile, lon, lat, winter);
  const today = sunHoursForDay(hz.profile, lon, lat, dateStr);
  const lostH = Math.max(0, w.openHours - w.hours);

  box.innerHTML = `
    <div class="detail-head">
      <div><h2>☀ Sun at this address</h2>
        <div class="meta">${escapeHtml(label || "")}
          <span class="chip">${Math.round(hz.elev)} m</span></div>
      </div>
      <button type="button" class="detail-close" id="sunhours-close"
              title="Close" aria-label="Close">×</button>
    </div>

    <div class="detail-headline">
      <div class="detail-big"><b>${fmtHours(w.hours)}</b>
        <small>midwinter sun (21 Jun)</small></div>
      <div class="detail-big"><b>${fmtHours(today.hours)}</b>
        <small>on ${escapeHtml(dateStr)}</small></div>
    </div>

    <div class="detail-section">
      <div class="detail-sub">Midwinter day
        <span class="detail-dim">· gold = sun reaches you, grey = behind terrain</span>
      </div>
      ${dayBarSvg(w.slots)}
      <div class="sunhours-times">
        ${w.first != null
          ? `First sun <b>${minutesToHHMM(w.first)}</b> · last sun <b>${minutesToHHMM(w.last)}</b>`
          : "<b>No direct sun at all on the shortest day.</b>"}
      </div>
    </div>

    <div class="detail-section">
      <div class="detail-sub">Skyline around this point
        <span class="detail-dim">· grey = terrain, dashed = the sun's midwinter path</span>
      </div>
      ${skylineSvg(hz.profile, w.slots)}
    </div>

    <dl class="detail-facts">
      <div><dt>Terrain costs you</dt><dd>${fmtHours(lostH)} of midwinter sun</dd></div>
      <div><dt>Sun above horizon</dt><dd>${fmtHours(w.openHours)} (flat ground)</dd></div>
    </dl>

    <div class="detail-dim sunhours-note">Bare-earth terrain only, from the
      same DEM and geometry as the walk scores. It does not model buildings,
      fences or trees, so a built-up section will read sunnier than it is.</div>`;
  closer();
}

/* ---- detail panel --------------------------------------------------------
 * Selecting a walk used to only highlight its card and draw the line. The
 * panel surfaces what trailDetail already returns but nothing displayed: the
 * whole-day sun curve (not just the search window), when the sun first and
 * last reaches the track, the elevation profile, canopy/status/description —
 * and, for anything at the coast, a tide chart. */

const detailBox = el("detail");
const SUN_LIT = 0.5;          // a slot counts as "in sun" above this fraction
const TIDE_NEAR_KM = 25;      // farther than this from the model point = inland
const TIDE_LOW_ELEV_M = 5;    // touches the sea/an estuary at this elevation

/* minutes between timeline slots, read off the timeline itself rather than
 * assumed, so this keeps working if SAMPLE_MIN ever changes */
function timelineStepMin(timeline) {
  if (!timeline || timeline.length < 2) return 10;
  return Math.max(1, Math.round(
    (hhmmToMinutes(timeline[1].t.slice(11, 16))
      - hhmmToMinutes(timeline[0].t.slice(11, 16)))));
}

/* Hours of terrain sun across the timeline window, plus the first and last
 * time the track is meaningfully lit. Trapezoidal: the timeline is a series
 * of instants, so N samples bound N-1 intervals — summing N slots would
 * report 9 h 10 min for an 08:00-17:00 window that is only 9 h long. */
function sunDayStats(timeline) {
  if (!timeline || timeline.length < 2) return null;
  const stepH = timelineStepMin(timeline) / 60;
  let hours = 0;
  let first = null;
  let last = null;
  for (let i = 0; i < timeline.length; i++) {
    const s = timeline[i];
    const edge = (i === 0 || i === timeline.length - 1) ? 0.5 : 1;
    hours += s.frac * stepH * edge;
    if (s.frac >= SUN_LIT) {
      if (first == null) first = s.t.slice(11, 16);
      last = s.t.slice(11, 16);
    }
  }
  const from = timeline[0].t.slice(11, 16);
  const to = timeline[timeline.length - 1].t.slice(11, 16);
  // the window, not the whole day: say so rather than imply a sunrise-to-sunset total
  return { hours, first, last, from, to, clamped: first === from || last === to };
}

function fmtHours(h) {
  const total = Math.round(h * 60);
  return fmtMinutes(total);
}

/* Whole-day sun curve: filled area = fraction of the track in sun, with the
 * cloud forecast as a strip along the top and a marker at the scrubber time.
 * viewBox units; CSS scales it to the panel width. */
function sunArcSvg(timeline, timelineCloud, nowMin) {
  const W = 320, H = 76, PAD_T = 12;
  const n = timeline.length;
  if (!n) return "";
  const x = (i) => (i / (n - 1)) * W;
  const y = (f) => PAD_T + (1 - Math.max(0, Math.min(1, f))) * (H - PAD_T);

  const line = timeline.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s.frac).toFixed(1)}`).join("");
  const area = `${line}L${W},${H}L0,${H}Z`;

  let clouds = "";
  if (timelineCloud && timelineCloud.some((c) => c != null)) {
    const w = W / n;
    clouds = timelineCloud.map((c, i) => (c == null ? "" :
      `<rect x="${(x(i) - w / 2).toFixed(1)}" y="0" width="${w.toFixed(2)}" height="7"`
      + ` fill="${cloudTint(c)}"/>`)).join("");
  }

  const startMin = hhmmToMinutes(timeline[0].t.slice(11, 16));
  const endMin = hhmmToMinutes(timeline[n - 1].t.slice(11, 16));
  let marker = "";
  if (nowMin >= startMin && nowMin <= endMin) {
    const mx = ((nowMin - startMin) / (endMin - startMin)) * W;
    marker = `<line class="detail-now" x1="${mx.toFixed(1)}" y1="0" x2="${mx.toFixed(1)}" y2="${H}"/>`;
  }

  const ticks = [startMin, Math.round((startMin + endMin) / 2), endMin].map((m, i) => {
    const tx = ((m - startMin) / (endMin - startMin)) * W;
    const anchor = i === 0 ? "start" : i === 2 ? "end" : "middle";
    return `<text class="detail-tick" x="${tx.toFixed(1)}" y="${H + 11}"`
      + ` text-anchor="${anchor}">${minutesToHHMM(m)}</text>`;
  }).join("");

  return `<svg class="detail-chart" viewBox="0 0 ${W} ${H + 15}" role="img"
     aria-label="Fraction of the track in sun through the day">
    <defs><linearGradient id="sunGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#fdb515" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="#fdb515" stop-opacity="0.12"/>
    </linearGradient></defs>
    ${clouds}
    <path d="${area}" fill="url(#sunGrad)"/>
    <path d="${line}" fill="none" stroke="#e09b00" stroke-width="1.6"
          stroke-linejoin="round" stroke-linecap="round"/>
    ${marker}${ticks}
  </svg>`;
}

/* Elevation profile along the track, coloured by whether each point is in sun
 * at the scrubber time — the same sun/shade split the map line shows. */
function elevProfileSvg(points) {
  const elevs = points.map((p) => p.elev_m).filter((e) => e != null);
  if (elevs.length < 2) return "";
  const lo = Math.min(...elevs);
  const hi = Math.max(...elevs);
  if (!(hi > lo)) return "";
  const W = 320, H = 40;
  const n = points.length;
  const x = (i) => (i / (n - 1)) * W;
  const y = (e) => H - ((e - lo) / (hi - lo)) * (H - 4) - 2;

  let bars = "";
  for (let i = 0; i < n - 1; i++) {
    if (points[i].elev_m == null) continue;
    bars += `<rect x="${x(i).toFixed(2)}" y="${y(points[i].elev_m).toFixed(1)}"`
      + ` width="${(W / (n - 1) + 0.6).toFixed(2)}"`
      + ` height="${(H - y(points[i].elev_m)).toFixed(1)}"`
      + ` fill="${points[i].sun ? SUN_COLOR : SHADE_COLOR}" opacity="0.85"/>`;
  }
  return `<div class="detail-sub">Elevation ${Math.round(lo)}–${Math.round(hi)} m`
    + ` <span class="detail-dim">· climb shown in sun/shade at this time</span></div>`
    + `<svg class="detail-chart elev" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Elevation profile, coloured by sun and shade">${bars}</svg>`;
}

/* ---- tides ---------------------------------------------------------------
 * Open-Meteo Marine (keyless, same family as the cloud forecast) gives hourly
 * sea level relative to MSL. It is a global tide MODEL, not LINZ's official
 * predictions for a standard port, so the panel says so and shows how far the
 * model point is from the walk. */

const tideCache = new Map();

function tideCacheKey(lat, lon, dateStr) {
  return `${lat.toFixed(2)},${lon.toFixed(2)},${dateStr}`;
}

/* local copy so this section is identical in both UIs (web/ has no engine.js) */
function tideDistKm(lon1, lat1, lon2, lat2) {
  const D = Math.PI / 180;
  const dLon = (lon2 - lon1) * D, dLat = (lat2 - lat1) * D;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * D) * Math.cos(lat2 * D) * Math.sin(dLon / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function fetchTide(lat, lon, dateStr) {
  const key = tideCacheKey(lat, lon, dateStr);
  if (tideCache.has(key)) return tideCache.get(key);
  const url = "https://marine-api.open-meteo.com/v1/marine"
    + `?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}`
    + "&hourly=sea_level_height_msl&timezone=Pacific%2FAuckland"
    + `&start_date=${dateStr}&end_date=${dateStr}`;
  const p = fetchTimeout(url).then(async (resp) => {
    if (!resp.ok) return null;
    const body = await resp.json();
    const h = body && body.hourly;
    if (!h || !h.time || !h.sea_level_height_msl) return null;
    if (h.sea_level_height_msl.every((v) => v == null)) return null;
    return {
      times: h.time,
      levels: h.sea_level_height_msl,
      lat: body.latitude,
      lon: body.longitude,
    };
  }).catch(() => null);
  tideCache.set(key, p);
  return p;
}

/* local minima/maxima of the hourly series -> high and low waters */
function tideExtremes(levels, times) {
  const out = [];
  for (let i = 1; i < levels.length - 1; i++) {
    const a = levels[i - 1], b = levels[i], c = levels[i + 1];
    if (a == null || b == null || c == null) continue;
    if (b >= a && b >= c && !(b === a && b === c)) out.push({ i, kind: "high", m: b });
    else if (b <= a && b <= c && !(b === a && b === c)) out.push({ i, kind: "low", m: b });
  }
  return out.map((e) => ({ ...e, hhmm: times[e.i].slice(11, 16) }));
}

function tideChartSvg(tide, nowMin) {
  const { levels, times } = tide;
  const vals = levels.filter((v) => v != null);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = hi - lo || 1;
  const W = 320, H = 64, PAD = 8;
  const n = levels.length;
  const x = (i) => (i / (n - 1)) * W;
  const y = (v) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);

  const pts = levels.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const area = `${line}L${W},${H}L0,${H}Z`;

  const ext = tideExtremes(levels, times);
  const marks = ext.map((e) => {
    const px = x(e.i), py = y(e.m);
    const up = e.kind === "high";
    return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.6"`
      + ` fill="${up ? "#0369a1" : "#0891b2"}"/>`
      + `<text class="detail-tick tide-lab" x="${Math.max(16, Math.min(W - 16, px)).toFixed(1)}"`
      + ` y="${(up ? py - 5 : py + 10).toFixed(1)}" text-anchor="middle">`
      + `${up ? "▲" : "▼"} ${e.hhmm}</text>`;
  }).join("");

  let marker = "";
  const mi = Math.round((nowMin / 60));
  if (mi >= 0 && mi < n) {
    marker = `<line class="detail-now" x1="${x(mi).toFixed(1)}" y1="0"`
      + ` x2="${x(mi).toFixed(1)}" y2="${H}"/>`;
  }

  return `<svg class="detail-chart tide" viewBox="0 0 ${W} ${H}" role="img"
     aria-label="Tide height through the day">
    <defs><linearGradient id="tideGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.7"/>
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.1"/>
    </linearGradient></defs>
    <path d="${area}" fill="url(#tideGrad)"/>
    <path d="${line}" fill="none" stroke="#0284c7" stroke-width="1.6"
          stroke-linejoin="round"/>
    ${marker}${marks}
  </svg>`;
}

/* Is this option at the coast? Explicit beaches always; otherwise anything
 * that drops to about sea level (coastal tracks, estuary walks). */
function looksCoastal(detail) {
  if ((detail.kind || "hike") === "beach") return true;
  const elevs = detail.points.map((p) => p.elev_m).filter((e) => e != null);
  return elevs.length > 0 && Math.min(...elevs) <= TIDE_LOW_ELEV_M;
}

async function renderTide(detail, container) {
  if (!looksCoastal(detail)) return;
  const p = detail.points[0];
  const tide = await fetchTide(p.lat, p.lon, dateInput.value);
  if (!tide) return;
  if (!selected || selected.id !== detail.id) return; // selection moved on
  const km = tideDistKm(p.lon, p.lat, tide.lon, tide.lat);
  if (km > TIDE_NEAR_KM) return; // model point is out at sea/inland — not useful
  const ext = tideExtremes(tide.levels, tide.times);
  const lows = ext.filter((e) => e.kind === "low").map((e) => e.hhmm).join(", ");
  const highs = ext.filter((e) => e.kind === "high").map((e) => e.hhmm).join(", ");
  container.insertAdjacentHTML("beforeend", `
    <div class="detail-section tide-section">
      <div class="detail-sub">🌊 Tide
        <span class="detail-dim">· widest sand around low water</span>
      </div>
      ${tideChartSvg(tide, +scrub.value)}
      <div class="tide-times">
        ${lows ? `<span class="tide-low">▼ Low ${escapeHtml(lows)}</span>` : ""}
        ${highs ? `<span class="tide-high">▲ High ${escapeHtml(highs)}</span>` : ""}
      </div>
      <div class="detail-dim tide-note">Modelled tide (Open-Meteo Marine),
        ${km < 1 ? "at" : `~${Math.round(km)} km from`} this spot — not an
        official LINZ prediction. Check a tide table before you rely on it.</div>
    </div>`);
}

/* full panel render — called on selection, not on every scrubber tick */
function renderDetail(detail) {
  const stats = sunDayStats(detail.timeline);
  const r = selected || {};
  const kind = detail.kind || "hike";
  const nowMin = +scrub.value;

  const facts = [];
  if (detail.length_m != null) {
    facts.push(["Length", detail.length_m >= 1000
      ? `${(detail.length_m / 1000).toFixed(1)} km` : `${Math.round(detail.length_m)} m`]);
  }
  if (detail.est_minutes != null) facts.push(["Walk time", fmtMinutes(detail.est_minutes)]);
  if (detail.difficulty) facts.push(["Difficulty", detail.difficulty]);
  if (r.drive_min_est != null) {
    facts.push(["Drive", `~${Math.round(r.drive_min_est)} min (${r.drive_km.toFixed(0)} km)`]);
  }
  if (stats && stats.first) {
    // still lit at a window edge -> the real first/last sun is outside it
    facts.push(["Sun on track", `${stats.first} – ${stats.last}`
      + (stats.clamped ? " (at least)" : "")]);
  }
  if (detail.region) facts.push(["Region", detail.region]);
  if (detail.status) facts.push(["Status", detail.status]);

  const canopy = canopyMeta(detail);
  const sunNowPct = Math.round(
    100 * (detail.points.filter((p) => p.sun).length / detail.points.length));

  detailBox.innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${kind === "hike" ? "" : (KIND_EMOJI[kind] || "📍") + " "}${escapeHtml(displayName(detail))}</h2>
        <div class="meta">${sourceBadge(detail.source)}
          ${canopy || ""}
          ${detail.category ? `<span class="chip">${escapeHtml(detail.category)}</span>` : ""}
        </div>
      </div>
      <button type="button" class="detail-close" id="detail-close"
              title="Close details" aria-label="Close details">×</button>
    </div>

    <div class="detail-headline">
      <div class="detail-big"><b>${sunNowPct}%</b><small>in sun at ${minutesToHHMM(nowMin)}</small></div>
      ${stats ? `<div class="detail-big"><b>${fmtHours(stats.hours)}</b>
        <small>of sun ${stats.from}–${stats.to}</small></div>` : ""}
    </div>

    <div class="detail-section">
      <div class="detail-sub">☀ Sun through the day
        <span class="detail-dim">· terrain only; grey strip = cloud forecast</span>
      </div>
      ${sunArcSvg(detail.timeline, r.timeline_cloud, nowMin)}
    </div>

    ${facts.length ? `<dl class="detail-facts">${facts.map(([k, v]) =>
      `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join("")}</dl>` : ""}

    <div class="detail-section">${elevProfileSvg(detail.points)}</div>

    ${detail.description ? `<p class="detail-desc">${escapeHtml(detail.description)}</p>` : ""}
    ${detail.url ? `<a class="detail-link" href="${escapeHtml(detail.url)}"
       target="_blank" rel="noopener">More about this ${kind === "hike" ? "track" : kind} ↗</a>` : ""}
  `;
  detailBox.hidden = false;
  el("detail-close").addEventListener("click", closeDetail);
  renderRoutePlan(detail, detailBox);
  renderTide(detail, detailBox);
  detailBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/* cheap refresh while the scrubber moves: only the bits that depend on time */
function updateDetailNow(detail) {
  if (detailBox.hidden || !detail) return;
  const nowMin = +scrub.value;
  const big = detailBox.querySelector(".detail-big b");
  const lab = detailBox.querySelector(".detail-big small");
  if (big && lab) {
    big.textContent = `${Math.round(
      100 * (detail.points.filter((p) => p.sun).length / detail.points.length))}%`;
    lab.textContent = `in sun at ${minutesToHHMM(nowMin)}`;
  }
  const chartHost = detailBox.querySelector(".detail-section");
  if (chartHost) {
    const old = chartHost.querySelector("svg.detail-chart");
    if (old) old.outerHTML = sunArcSvg(detail.timeline, (selected || {}).timeline_cloud, nowMin);
  }
  const elevHost = detailBox.querySelectorAll(".detail-section")[1];
  if (elevHost) elevHost.innerHTML = elevProfileSvg(detail.points);
}

function closeDetail() {
  detailBox.hidden = true;
  detailBox.innerHTML = "";
  selected = null;
  trailLayer.clearLayers();
  for (const c of resultsBox.querySelectorAll(".card")) c.classList.remove("selected");
  scrubInfo.textContent = shadowsEnabled
    ? `Terrain shadows at ${minutesToHHMM(+scrub.value)} — click a trail to see its sunlight`
    : `${minutesToHHMM(+scrub.value)} — turn on 🌗 Shadows, or click a trail`;
}

/* cloud fraction (0-100) at the scrubber's current time for the selected
 * result's own timeline_cloud, or null if no forecast covers that slot. */
function cloudAtScrub() {
  if (!selected || !selected.timeline_cloud || !selected.timeline) return null;
  const scrubMin = +scrub.value;
  let best = null;
  let bestDiff = Infinity;
  for (let i = 0; i < selected.timeline.length; i++) {
    const slotMin = hhmmToMinutes(selected.timeline[i].t.slice(11, 16));
    const diff = Math.abs(slotMin - scrubMin);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = selected.timeline_cloud[i];
    }
  }
  return best == null ? null : Math.round(best * 100);
}

scrub.addEventListener("input", () => {
  scrubLabel.textContent = minutesToHHMM(+scrub.value);
  scheduleShadowUpdate();  // move the shadows regardless of any selection
  if (selected) {
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => loadTrailDetail(false), 120);
  } else {
    // no trail chosen yet: reflect the time and keep nudging toward the map
    scrubInfo.textContent = shadowsEnabled
      ? `Terrain shadows at ${minutesToHHMM(+scrub.value)} — click a trail to see its sunlight`
      : `${minutesToHHMM(+scrub.value)} — turn on 🌗 Shadows, or click a trail`;
  }
});

/* date change also drives the shadow overlay (bound to both the scrubber
 * and the date input, per the plan) */
dateInput.addEventListener("change", () => scheduleShadowUpdate());

/* ---- address sun hours trigger ------------------------------------------- */

const sunHoursBtn = el("sunhours-btn");
if (sunHoursBtn) {
  sunHoursBtn.addEventListener("click", () => {
    runSunHours(origin.lon, origin.lat, origin.label);
  });
}

/* ---- rank toggle ---------------------------------------------------------- */

const rankTerrainBtn = el("rank-terrain");
const rankForecastBtn = el("rank-forecast");
if (rankTerrainBtn && rankForecastBtn) {
  rankTerrainBtn.addEventListener("click", () => setRankMode("terrain"));
  rankForecastBtn.addEventListener("click", () => {
    if (!rankLocked) setRankMode("forecast");
  });
}

/* ---- boot ---------------------------------------------------------------- */

form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  runSearch();
});

(async function init() {
  // Default to today's date in NZ (the server resolved date=None the same
  // way), so viewers in other timezones still search the right NZ day.
  dateInput.value = Engine.nzDateStr();
  el("origin-label").textContent = `📍 Origin: ${origin.label}`;
  syncRankToggleUI();
  syncShadowToggleUI();
  applyShadowEnabled();

  // Sanity numbers for manual verification (see engine.js self-test block):
  // sunPosition(-43.5321, 172.6362, nzEpoch("2026-07-02","10:00")) should
  // give elevation ~14.7362, azimuth ~36.1774.
  const probe = Engine.sunPosition(-43.5321, 172.6362,
    Engine.nzEpoch("2026-07-02", "10:00"));
  console.log("Sunward static: sun @ Chch 2026-07-02 10:00 NZ =",
    probe.elevation.toFixed(4), "deg elev,", probe.azimuth.toFixed(4),
    "deg az (expect ~14.7362 / ~36.1774)");

  el("search-btn").disabled = true;
  showStatus("loading trail index…");
  try {
    await Engine.loadIndex(".");
    engineReady = true;
    console.log("Sunward static: trail index loaded");
  } catch (err) {
    showStatus(`Could not load trail data: ${err.message}`, true);
    return;
  } finally {
    el("search-btn").disabled = false;
  }
  runSearch();
})();

/* ---- sunny right now -----------------------------------------------------
 * Sunward answers a planning question well — where should I go on Saturday.
 * This answers the one people actually have: it is 11am on a changeable day,
 * where is the sun ON right now. Same engine, but pinned to this minute and
 * ranked with the cloud forecast in, because "sunny now" that ignores the
 * cloud overhead is worse than useless. */

function nowMinutesNZ() {
  const nz = new Date(Date.now()).toLocaleTimeString("en-NZ", {
    timeZone: "Pacific/Auckland", hour12: false,
    hour: "2-digit", minute: "2-digit",
  });
  const [h, m] = nz.split(":").map(Number);
  return h * 60 + m;
}

/* First and last minute the sun is above the horizon at the origin today,
 * so the button can tell the truth when it is asked after dark. */
function daylightWindowNZ(dateStr) {
  let first = null, last = null;
  for (let m = 0; m < 24 * 60; m += 10) {
    const s = Engine.sunPosition(origin.lat, origin.lon,
                                 Engine.nzEpoch(dateStr, minutesToHHMM(m)));
    if (s.elevation > 0) {
      if (first == null) first = m;
      last = m;
    }
  }
  return { first, last };
}

/* The button's own explanation line. runSearch() owns #status and will
 * overwrite it, so anything the user needs to keep reading lives here. */
function nowNote(msg) {
  const n = el("now-note");
  if (!n) return;
  n.textContent = msg || "";
  n.hidden = !msg;
}

function sunnyNow() {
  nowNote("");
  const mins = nowMinutesNZ();
  const today = Engine.nzDateStr();
  const day = daylightWindowNZ(today);

  // Asked after dark, the honest answer is not a list of twenty sunny walks.
  // Say so, and show tomorrow morning instead of pretending.
  const afterDark = day.first == null || mins > day.last;
  const beforeDawn = day.first != null && mins < day.first;

  let useDate = today;
  let useMin = mins;
  let note = null;
  if (afterDark) {
    useDate = Engine.nzDateStr(Engine.nzEpoch(today, "12:00") + 24 * 3600e3);
    useMin = daylightWindowNZ(useDate).first;
    if (useMin == null) useMin = 9 * 60;
    note = (t) => `The sun set at ${minutesToHHMM(day.last)}. Showing tomorrow`
      + ` morning from ${t} instead.`;
  } else if (beforeDawn) {
    useMin = day.first;
    note = (t) => `The sun is not up yet. Showing from first light, ${t}.`;
  }

  dateInput.value = useDate;
  // snap BEFORE writing the note, so it quotes the time actually searched
  const snapped = Math.round(useMin / 15) * 15;
  if (note) nowNote(note(minutesToHHMM(snapped)));
  timeInput.value = minutesToHHMM(snapped);
  // keep the scrubber honest: it drives the shadows, so put it on the same time
  scrub.value = Math.min(+scrub.max, Math.max(+scrub.min, snapped));
  scrubLabel.textContent = minutesToHHMM(+scrub.value);
  if (!rankLocked) setRankMode("forecast");
  scheduleShadowUpdate();
  runSearch();
}

const nowBtn = el("now-btn");
if (nowBtn) nowBtn.addEventListener("click", sunnyNow);


/* ---- which way round, and when -------------------------------------------
 * A trail gets one score, but a long walk passes through sun and shade and
 * the direction you take it changes the answer — on the Little River rail
 * trail it is the difference between 68% and 94% of the walk in sun. */

function fmtPct(f) { return `${Math.round(f * 100)}%`; }

function renderRoutePlan(detail, container) {
  let plan;
  try {
    plan = Engine.routePlan(detail.id, dateInput.value);
  } catch (err) {
    return; // no geometry or no horizons for this one — just omit the section
  }
  const b = plan.best;
  const fwd = plan.best_forward, rev = plan.best_reverse;
  const dirMatters = Math.abs(fwd.frac - rev.frac) >= 0.05;
  const timeMatters = plan.spread >= 0.1;

  // nothing useful to say about a walk that is sunny whenever and whichever
  // way you do it — better to stay quiet than pad the panel
  if (!dirMatters && !timeMatters && b.frac > 0.98) return;

  const other = b.reverse ? fwd : rev;
  const dirLine = dirMatters
    ? `<div class="rp-row">Going <b>${escapeHtml(b.direction)}</b> keeps you in sun
       ${fmtPct(b.frac)} of the way; the other way round,
       ${fmtPct(other.frac)}.</div>`
    : `<div class="rp-row">Direction barely matters here — either way is about
       ${fmtPct(b.frac)}.</div>`;
  const timeLine = timeMatters
    ? `<div class="rp-row">Timing matters more: starting at <b>${b.start}</b>
       beats the middling start by ${Math.round(plan.spread * 100)} points.</div>`
    : "";

  container.insertAdjacentHTML("beforeend", `
    <div class="detail-section rp">
      <div class="detail-sub">🧭 Best way round
        <span class="detail-dim">· ${fmtMinutes(plan.duration_min)} at a steady pace</span>
      </div>
      <div class="rp-head"><b>${b.start}</b>, ${escapeHtml(b.direction)}
        <span class="rp-frac">${fmtPct(b.frac)} in sun</span></div>
      ${dirLine}${timeLine}
      ${routeSparkSvg(plan)}
      <div class="detail-dim rp-note">Assumes a steady pace over the whole
        walk, and terrain shade only — cloud is handled separately.</div>
    </div>`);
}

/* Two lines, one per direction: sunlit fraction against start time. Where
 * they diverge is exactly where the choice is worth making. */
function routeSparkSvg(plan) {
  const W = 320, H = 54, PAD = 10;
  const starts = [...new Set(plan.options.map((o) => o.start_min))].sort((a, b) => a - b);
  if (starts.length < 2) return "";
  const x = (m) => ((m - starts[0]) / (starts[starts.length - 1] - starts[0])) * W;
  const y = (f) => PAD + (1 - f) * (H - 2 * PAD);
  const line = (rev) => plan.options.filter((o) => o.reverse === rev)
    .sort((a, b) => a.start_min - b.start_min)
    .map((o, i) => `${i ? "L" : "M"}${x(o.start_min).toFixed(1)},${y(o.frac).toFixed(1)}`)
    .join("");
  const b = plan.best;
  return `<svg class="detail-chart rp-spark" viewBox="0 0 ${W} ${H + 13}" role="img"
     aria-label="Fraction of the walk in sun against start time, both directions">
    <path d="${line(false)}" fill="none" stroke="#fdb515" stroke-width="1.8"/>
    <path d="${line(true)}" fill="none" stroke="#7dd3fc" stroke-width="1.8"
          stroke-dasharray="4 3"/>
    <circle cx="${x(b.start_min).toFixed(1)}" cy="${y(b.frac).toFixed(1)}" r="3.2"
            fill="#1f2937"/>
    <text class="detail-tick" x="0" y="${H + 10}">${minutesToHHMM(starts[0])}</text>
    <text class="detail-tick" x="${W}" y="${H + 10}" text-anchor="end">
      ${minutesToHHMM(starts[starts.length - 1])}</text>
  </svg>`;
}

/* ---- search this area ----------------------------------------------------
 * The drive-radius search answers "where should I go from home". Panning the
 * map asks a different question — "what about over there" — and previously the
 * only way to ask it was to move the origin pin, which also threw away your
 * drive time from home.
 *
 * So an area search REPLACES the radius filter with the map's bounds and
 * leaves the origin alone: what is considered is what you can see, while the
 * drive time on each card is still measured from wherever you actually are.
 *
 * The trap here is a feedback loop. Selecting a trail fits the map to it, and
 * an address search recentres — both fire `moveend`. Either would kick off a
 * search that moves the map again. `suppressMove()` marks the moves the app
 * makes itself so only a real pan or zoom counts.
 */

const AREA_AUTO_KEY = "hikesun-area-auto";
const AREA_MAX_KM = 220;      // refuse to search a viewport wider than this
const AREA_MOVE_FRAC = 0.15;  // recentre by this much of the view to offer again

let autoArea = loadAutoArea();
let lastSearchBounds = null;  // Leaflet bounds used by the last search
let programmaticMove = 0;     // >0 while the app is moving the map itself
let areaTimer = null;

function loadAutoArea() {
  try {
    return localStorage.getItem(AREA_AUTO_KEY) === "on";
  } catch (err) { return false; }
}

/* Wrap a map move the APP makes, so it is not mistaken for the user panning. */
function suppressMove(fn) {
  programmaticMove++;
  try { fn(); } finally {
    // moveend fires asynchronously after an animated move
    setTimeout(() => { programmaticMove = Math.max(0, programmaticMove - 1); }, 400);
  }
}

function viewportKm() {
  const b = map.getBounds();
  return Engine.haversineKm
    ? Engine.haversineKm(b.getWest(), b.getSouth(), b.getEast(), b.getNorth())
    : map.distance(b.getSouthWest(), b.getNorthEast()) / 1000;
}

/* Has the user moved far enough that offering a re-search is useful? */
function movedSinceSearch() {
  if (!lastSearchBounds) return true;
  const now = map.getBounds();
  const c1 = lastSearchBounds.getCenter();
  const c2 = now.getCenter();
  const span = map.distance(now.getSouthWest(), now.getNorthEast());
  if (!span) return true;
  if (map.distance(c1, c2) > span * AREA_MOVE_FRAC) return true;
  // a zoom change moves no centre but changes what is in view
  const prevSpan = map.distance(lastSearchBounds.getSouthWest(),
                                lastSearchBounds.getNorthEast());
  return prevSpan > 0 && Math.abs(Math.log(span / prevSpan)) > 0.35;
}

function syncAreaUi() {
  const btn = el("area-search");
  const auto = el("area-auto");
  if (auto) {
    auto.classList.toggle("on", autoArea);
    auto.setAttribute("aria-pressed", String(autoArea));
  }
  if (!btn) return;
  const tooBig = viewportKm() > AREA_MAX_KM;
  // nothing to re-search until a first search has happened, and no point
  // offering it while the map still shows what was just searched
  const offer = engineReady && !autoArea && lastSearchOpts != null
    && movedSinceSearch();
  btn.textContent = tooBig ? "Zoom in to search this area" : "🔍 Search this area";
  btn.disabled = tooBig;
  btn.hidden = !offer;
}

map.on("moveend zoomend", () => {
  if (programmaticMove > 0) return;      // the app moved the map, not the user
  if (!engineReady) return;
  if (autoArea) {
    if (viewportKm() > AREA_MAX_KM) { syncAreaUi(); return; }
    clearTimeout(areaTimer);
    areaTimer = setTimeout(() => runSearch({ area: true }), 450);
    return;
  }
  syncAreaUi();
});

const areaBtn = el("area-search");
if (areaBtn) {
  areaBtn.addEventListener("click", () => runSearch({ area: true }));
}

const areaAutoBtn = el("area-auto");
if (areaAutoBtn) {
  areaAutoBtn.addEventListener("click", () => {
    autoArea = !autoArea;
    try { localStorage.setItem(AREA_AUTO_KEY, autoArea ? "on" : "off"); }
    catch (err) { /* private mode — the preference just will not persist */ }
    syncAreaUi();
    if (autoArea && movedSinceSearch()) runSearch({ area: true });
  });
}
