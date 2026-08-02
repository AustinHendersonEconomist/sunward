/* Sunward client-side scoring engine — a faithful port of hikesun/sun.py and
 * hikesun/score.py so the app can run 100% statically (GitHub Pages).
 *
 * Data comes from tools/export_static.py, sharded into 1-degree cells so the
 * browser only downloads the regions it needs:
 *   data/index.json — az_bins, quant {scale, offset}, cell_deg and the list
 *                     of non-empty cells {id, bbox, n_trails}
 *   data/cells/{id}/trails.json  — trail metadata + sampled points + `hoff`
 *                     row offsets LOCAL to that cell's horizons.bin
 *   data/cells/{id}/horizons.bin — Uint8 rows of az_bins bytes per trail
 *                     point; angle_deg = byte * quant.scale + quant.offset
 *
 * Call Engine.loadIndex() once, then Engine.ensureCells([lon, lat], radiusKm)
 * before searching around a new origin; loaded cells are merged into one
 * in-memory store (each trail's hoff is rebased to the global row space).
 *
 * Conventions (same as the Python code): coordinates are WGS84 (lon, lat);
 * azimuths degrees clockwise from TRUE NORTH [0, 360); horizon bin k covers
 * azimuths [k*3, (k+1)*3). Plain ES6, no dependencies.
 */

"use strict";

const Engine = (() => {
  const SUN_MIN_ELEV_DEG = 0.25;   // sun must clear this to count as up at all
  const CLOUD_ATTENUATION = 0.75; // effective = terrain * (1 - 0.75 * cloud)
  const SAMPLE_MIN = 10;           // timeline sampling step (minutes)
  const DRIVE_KM_PER_MIN = 0.85;   // crow-flies km per minute of driving
  const R_EARTH_KM = 6371.0;
  const DEG = Math.PI / 180.0;
  const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
  const FORECAST_CACHE_TTL_MS = 60 * 60 * 1000; // 60 min, matches the plan

  /* Solar position + Pacific/Auckland wall-clock helpers now live in
   * sunmath.js (loaded before this file) so shadow-worker.js can share them
   * via importScripts. Delegate rather than re-implement. */
  const { sunPosition, nzEpoch, isoNZ, nzDateStr } = SunMath;

  /* ---- data loading (sharded cells) -------------------------------------- */

  const CELL_MARGIN_KM = 30; // extra half-width padding around search squares
  const M_PER_DEG_LON_EQ = Math.PI / 180.0 * 6371000.0;

  let dataBase = "."; // base URL holding the data/ tree (set by loadIndex)
  // Merged store over all loaded cells. cellState: id -> Promise that settles
  // when the cell is merged (or confirmed missing); loadedCells counts cells
  // that finished loading, including empty/404 ones.
  let data = null; // { cells, cellDeg, azBins, quant, generated,
                   //   trails, byId, horizons: Uint8Array, rows,
                   //   cellState: Map, loadedCells }

  /* Fetch {base}/data/index.json and reset the in-memory store. Must be
   * called (and awaited) before any other data function. */
  async function loadIndex(baseUrl = ".") {
    const base = baseUrl.replace(/\/+$/, "");
    const resp = await fetch(`${base}/data/index.json`);
    if (!resp.ok) throw new Error(`data/index.json: HTTP ${resp.status}`);
    const meta = await resp.json();
    dataBase = base;
    data = {
      cells: meta.cells,
      cellDeg: meta.cell_deg,
      azBins: meta.az_bins,
      quant: meta.quant,
      generated: meta.generated,
      trails: [],
      byId: new Map(),
      horizons: new Uint8Array(0),
      rows: 0,
      cellState: new Map(),
      loadedCells: 0,
    };
    return data;
  }

  function requireData() {
    if (!data) throw new Error("trail index not loaded — call loadIndex() first");
    return data;
  }

  /* (metres per degree longitude, latitude) at lat — mirrors geo.m_per_deg. */
  function mPerDeg(latDeg) {
    const latR = latDeg * DEG;
    return {
      lon: M_PER_DEG_LON_EQ * Math.cos(latR),
      lat: 111132.954 - 559.822 * Math.cos(2 * latR)
        + 1.175 * Math.cos(4 * latR),
    };
  }

  /* Synchronously splice one fetched cell into the merged store; the trail
   * hoff values in the file are LOCAL and get rebased to the global rows. */
  function mergeCell(id, meta, bytes) {
    const d = requireData();
    if (bytes.length % d.azBins !== 0) {
      throw new Error(`cell ${id}: horizons.bin size ${bytes.length}` +
        ` is not a multiple of az_bins=${d.azBins}`);
    }
    const rowsBefore = d.rows;
    for (const trail of meta.trails) {
      trail.hoff += rowsBefore;
      d.trails.push(trail);
      d.byId.set(trail.id, trail);
    }
    const merged = new Uint8Array(d.horizons.length + bytes.length);
    merged.set(d.horizons, 0);
    merged.set(bytes, d.horizons.length);
    d.horizons = merged;
    d.rows = rowsBefore + bytes.length / d.azBins;
  }

  async function fetchCell(id) {
    const dir = `${dataBase}/data/cells/${id}`;
    const [metaResp, binResp] = await Promise.all([
      fetch(`${dir}/trails.json`),
      fetch(`${dir}/horizons.bin`),
    ]);
    if (metaResp.status === 404 || binResp.status === 404) {
      // deployed index lists a cell whose files are gone: treat as empty
      console.warn(`Sunward: cell ${id} files missing (404), treating as empty`);
      data.loadedCells++;
      return;
    }
    if (!metaResp.ok) throw new Error(`${dir}/trails.json: HTTP ${metaResp.status}`);
    if (!binResp.ok) throw new Error(`${dir}/horizons.bin: HTTP ${binResp.status}`);
    const [meta, buf] = await Promise.all([metaResp.json(), binResp.arrayBuffer()]);
    mergeCell(id, meta, new Uint8Array(buf));
    data.loadedCells++;
  }

  /* Load cell id exactly once; concurrent callers share the same promise.
   * A failed (non-404) fetch is forgotten so a later call can retry. */
  function loadCell(id) {
    const d = requireData();
    let pending = d.cellState.get(id);
    if (!pending) {
      pending = fetchCell(id);
      d.cellState.set(id, pending);
      pending.catch(() => d.cellState.delete(id));
    }
    return pending;
  }

  /* Ensure every cell within reach of a search around origin [lon, lat]
   * (WGS84) with radiusKm is loaded: cells whose bbox intersects the square
   * of half-width (radiusKm + 30) km around the origin are fetched in
   * parallel; already-loaded cells are never refetched. Resolves with the
   * total number of loaded cells (across all calls so far). */
  async function ensureCells([lon, lat], radiusKm) {
    const d = requireData();
    const m = mPerDeg(lat);
    const halfM = (radiusKm + CELL_MARGIN_KM) * 1000.0;
    const dLon = halfM / m.lon;
    const dLat = halfM / m.lat;
    const wanted = d.cells.filter((c) =>
      c.bbox[0] <= lon + dLon && c.bbox[2] >= lon - dLon &&
      c.bbox[1] <= lat + dLat && c.bbox[3] >= lat - dLat);
    await Promise.all(wanted.map((c) => loadCell(c.id)));
    return d.loadedCells;
  }

  /* ---- scoring (port of hikesun/score.py) -------------------------------- */

  /* Place kind of a trail: 'place:' categories (beaches, gardens, parks,
   * reserves ingested with source='place') expose their kind after the
   * prefix; everything else is a plain hike. Mirrors the Python mapping. */
  function trailKind(trail) {
    const cat = trail.category;
    return (typeof cat === "string" && cat.startsWith("place:"))
      ? cat.slice(6) : "hike";
  }

  /* True iff global trail point pointIndexGlobal is in sun for a sun at
   * (elevDeg, azDeg): the sun is up AND clears the precomputed terrain
   * horizon for its 3-degree azimuth bin. */
  function inSun(pointIndexGlobal, elevDeg, azDeg) {
    const d = requireData();
    if (elevDeg <= SUN_MIN_ELEV_DEG) return false;
    const bin = Math.floor(azDeg / (360.0 / d.azBins)) % d.azBins;
    const byte = d.horizons[pointIndexGlobal * d.azBins + bin];
    return elevDeg > byte * d.quant.scale + d.quant.offset;
  }

  /* Sunlit fraction of a trail's points at one instant. The sun position is
   * evaluated once at the trail's FIRST point; the Python code uses the
   * point centroid, but across a <=25 km trail the two differ by well under
   * one 3-degree azimuth bin, so scores match. */
  function sunFracAt(trail, epochMs) {
    const sun = sunPosition(trail.points[0][1], trail.points[0][0], epochMs);
    let sunny = 0;
    for (let i = 0; i < trail.points.length; i++) {
      if (inSun(trail.hoff + i, sun.elevation, sun.azimuth)) sunny++;
    }
    return sunny / trail.points.length;
  }

  /* cloudSeries[hour] for a given epoch ms, if epochMs's NZ-local calendar
   * date matches cloudDate, else null. Mirrors Python's _cloud_at_slot:
   * cloudSeries is a 24-entry array for ONE local date, so this only misses
   * at the very tail of a very late-starting long hike. */
  function cloudAtSlot(cloudSeries, cloudDate, epochMs) {
    if (cloudSeries == null) return null;
    const dateStr = nzDateStr(epochMs);
    if (dateStr !== cloudDate) return null;
    const hour = Number(isoNZ(epochMs).slice(11, 13));
    const v = cloudSeries[hour];
    return v == null ? null : v;
  }

  /* Score how sunny a trail is over a hike starting at startMs (UTC epoch
   * ms). Same result shape as Python score_trail: {trail_id, terrain_frac,
   * timeline: [{t, frac}], timeline_cloud, effective, cloud_cover,
   * no_forecast} with 10-min sampling inclusive of both endpoints.
   *
   * Cloud input is EITHER a single scalar `cloud` (0..1, applied uniformly —
   * legacy/simple mode) OR a 24-hour `cloudSeries` (as from getCloudSeries)
   * for the local calendar date `cloudDate` ("YYYY-MM-DD", required when
   * cloudSeries is given), in which case `effective` is duration-weighted:
   * for each 10-min slot, terrainSlotFrac * (1 - CLOUD_ATTENUATION *
   * cloud(slotHour)), averaged over all slots (slots with no cloud value for
   * that hour count as terrain-only). Only one of cloud/cloudSeries may be
   * given. */
  function scoreTrail(trail, startMs, durationMin = null,
                       { cloud = null, cloudSeries = null, cloudDate = null } = {}) {
    requireData();
    if (cloud != null && cloudSeries != null) {
      throw new Error("scoreTrail: pass only one of cloud, cloudSeries");
    }
    if (cloudSeries != null && cloudDate == null) {
      throw new Error("scoreTrail: cloudDate is required when cloudSeries is given");
    }
    let duration;
    if (durationMin != null) {
      duration = durationMin;
    } else {
      const est = trail.est_minutes != null ? trail.est_minutes : 60.0;
      duration = Math.min(600.0, Math.max(30.0, est));
    }
    const n = Math.floor(duration / SAMPLE_MIN) + 1;
    const timeline = [];
    const fracs = [];
    const times = [];
    let total = 0;
    for (let k = 0; k < n; k++) {
      const t = startMs + k * SAMPLE_MIN * 60000;
      const frac = sunFracAt(trail, t);
      total += frac;
      fracs.push(frac);
      times.push(t);
      timeline.push({ t: isoNZ(t), frac });
    }
    const terrainFrac = total / n;

    let effective;
    let cloudCover;
    let noForecast;
    let timelineCloud;
    if (cloudSeries != null) {
      noForecast = false;
      const windowClouds = [];
      let slotSum = 0;
      timelineCloud = times.map((t) => cloudAtSlot(cloudSeries, cloudDate, t));
      for (let k = 0; k < n; k++) {
        const c = timelineCloud[k];
        slotSum += c == null ? fracs[k] : fracs[k] * (1.0 - CLOUD_ATTENUATION * c);
        if (c != null) windowClouds.push(c);
      }
      effective = slotSum / n;
      cloudCover = windowClouds.length
        ? windowClouds.reduce((a, b) => a + b, 0) / windowClouds.length
        : null;
    } else if (cloud != null) {
      noForecast = false;
      effective = terrainFrac * (1.0 - CLOUD_ATTENUATION * cloud);
      timelineCloud = times.map(() => cloud);
      cloudCover = cloud;
    } else {
      noForecast = true;
      effective = terrainFrac;
      cloudCover = null;
      timelineCloud = times.map(() => null);
    }

    return {
      trail_id: trail.id,
      terrain_frac: terrainFrac,
      timeline,
      timeline_cloud: timelineCloud,
      effective,
      cloud_cover: cloudCover,
      no_forecast: noForecast,
    };
  }

  /* Great-circle distance in km between two (lon, lat) WGS84 points. */
  function haversineKm(lon1, lat1, lon2, lat2) {
    const dLon = (lon2 - lon1) * DEG;
    const dLat = (lat2 - lat1) * DEG;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
    return 2 * R_EARTH_KM * Math.asin(Math.sqrt(a));
  }

  /* Sunny-trail search; same filters, result shape and ordering as Python
   * score.search.
   *
   * Two-pass scoring: every candidate within radius/filters is scored on
   * TERRAIN ALONE first; the top `limit` by terrain_frac are kept, and (when
   * useWeather) a SINGLE batched Open-Meteo call (getCloudSeriesBatch)
   * fetches per-trail hourly cloud series for those candidates' start
   * coordinates. Each kept trail is then rescored with its own
   * duration-weighted cloud series so `effective` reflects the actual
   * weather over THAT trail's hike window. Fallback chain per trail: batch
   * entry -> a single shared origin series (getCloudSeries, fetched at most
   * once) -> no forecast at all (sun.cloud_source becomes null, no_forecast
   * true).
   *
   * opts.rankBy selects the final sort key: "forecast" (default) sorts by
   * sun.effective descending (falls back to terrain_frac for any trail with
   * no forecast, since effective === terrain_frac in that case); "terrain"
   * sorts by sun.terrain_frac descending regardless of weather.
   *
   * Returns a Promise resolving to up to limit result dicts (async because
   * of the batched forecast fetch). */
  async function search({ lat, lon, driveMin = 30, startMs, minMinutes = null,
                          maxMinutes = null, difficulties = null, kinds = null,
                          bounds = null,
                          limit = 20, useWeather = true, rankBy = "forecast" }) {
    if (rankBy !== "forecast" && rankBy !== "terrain") {
      throw new Error(`search: rankBy must be "forecast" or "terrain", got ${rankBy}`);
    }
    // every in-range, filter-passing trail, terrain-scored + sorted; then
    // keep only the top `limit` so the (single) batched forecast call covers
    // exactly the trails we return.
    const candidates = gatherCandidates({ lat, lon, driveMin, startMs,
      minMinutes, maxMinutes, difficulties, kinds, bounds });
    const kept = candidates.slice(0, limit);

    const cloudDate = nzDateStr(startMs);
    let batchSeries = null;
    if (useWeather && kept.length) {
      const coords = kept.map((c) => [c.trail.points[0][1], c.trail.points[0][0]]);
      batchSeries = await getCloudSeriesBatch(coords, cloudDate);
    }

    let originSeries = null;
    let originSeriesFetched = false;
    const results = [];
    for (let i = 0; i < kept.length; i++) {
      const { trail, distKm, terrainScore } = kept[i];
      const est = trail.est_minutes;
      let cloudSource = null;
      let finalScore = terrainScore;
      if (useWeather) {
        let series = batchSeries != null ? batchSeries[i] : null;
        let source = "trail";
        if (series == null) {
          if (!originSeriesFetched) {
            originSeries = await getCloudSeries(lat, lon, cloudDate);
            originSeriesFetched = true;
          }
          series = originSeries;
          source = "origin";
        }
        if (series != null) {
          finalScore = scoreTrail(trail, startMs, null,
            { cloudSeries: series, cloudDate });
          cloudSource = source;
        }
      }
      results.push({
        id: trail.id,
        name: trail.name,
        source: trail.source,
        category: trail.category,
        kind: trailKind(trail),
        difficulty: trail.difficulty,
        length_m: trail.length_m,
        est_minutes: est,
        canopy_frac: trail.canopy_frac,
        canopy_type: trail.canopy_type,
        region: trail.region,
        url: trail.url,
        photo_url: trail.photo_url,
        drive_km: distKm,
        drive_min_est: distKm / DRIVE_KM_PER_MIN,
        start: trail.start,
        sun: {
          terrain_frac: finalScore.terrain_frac,
          cloud_cover: finalScore.cloud_cover,
          effective: finalScore.effective,
          cloud_source: cloudSource,
          no_forecast: finalScore.no_forecast,
        },
        timeline: finalScore.timeline,
        timeline_cloud: finalScore.timeline_cloud,
      });
    }

    // Final ordering: ties break by ascending id (parity with score.py).
    if (rankBy === "terrain") {
      results.sort((a, b) =>
        (b.sun.terrain_frac - a.sun.terrain_frac) || (a.id - b.id));
    } else {
      results.sort((a, b) =>
        (b.sun.effective - a.sun.effective) || (a.id - b.id));
    }
    return results;
  }

  /* Every in-range, filter-passing trail, terrain-scored and sorted by
   * terrain sun (ties by ascending id). Shared by search() and
   * candidatesInRange(). opts.kinds: array/Set of kinds, or null = all. */
  /* `bounds` is [[south, west], [north, east]] — when given it REPLACES the
   * drive-radius filter, so "what is in view" decides which walks are
   * considered. (lat, lon) still matters: it is what drive distances are
   * measured from, so a result panned to on the far side of the island still
   * reports an honest drive time from wherever the user actually is. */
  function inBounds(bounds, lon, lat) {
    const [[s, w], [n, e]] = bounds;
    if (lat < s || lat > n) return false;
    return w <= e
      ? (lon >= w && lon <= e)
      : (lon >= w || lon <= e);       // the map has been dragged across 180E
  }

  function gatherCandidates({ lat, lon, driveMin = 30, startMs,
                              minMinutes = null, maxMinutes = null,
                              difficulties = null, kinds = null,
                              bounds = null }) {
    const d = requireData();
    const radiusKm = driveMin * DRIVE_KM_PER_MIN;
    const kindSet = kinds == null
      ? null : (kinds instanceof Set ? kinds : new Set(kinds));
    const candidates = [];
    for (const trail of d.trails) {
      if (!trail.start) continue;
      if (kindSet != null && !kindSet.has(trailKind(trail))) continue;
      const distKm = haversineKm(lon, lat, trail.start[0], trail.start[1]);
      if (bounds) {
        if (!inBounds(bounds, trail.start[0], trail.start[1])) continue;
      } else if (distKm > radiusKm) continue;
      const est = trail.est_minutes;
      if (minMinutes != null && (est == null || est < minMinutes)) continue;
      if (maxMinutes != null && (est == null || est > maxMinutes)) continue;
      if (difficulties != null && !difficulties.includes(trail.difficulty)) continue;
      const terrainScore = scoreTrail(trail, startMs, null);
      candidates.push({ trail, distKm, terrainScore });
    }
    candidates.sort((a, b) =>
      (b.terrainScore.terrain_frac - a.terrainScore.terrain_frac)
      || (a.trail.id - b.trail.id));
    return candidates;
  }

  /* Every in-range option — no weather, no limit — terrain-scored, for the
   * "show all on map" view. Lightweight result objects tinted by terrain sun
   * (sun.effective mirrors terrain_frac so the same card/marker code works).
   * Synchronous: no forecast fetch. */
  function candidatesInRange(opts) {
    return gatherCandidates(opts).map(({ trail, distKm, terrainScore }) => ({
      id: trail.id,
      name: trail.name,
      source: trail.source,
      category: trail.category,
      kind: trailKind(trail),
      difficulty: trail.difficulty,
      length_m: trail.length_m,
      est_minutes: trail.est_minutes,
      canopy_frac: trail.canopy_frac,
      canopy_type: trail.canopy_type,
      region: trail.region,
      url: trail.url,
      photo_url: trail.photo_url,
      drive_km: distKm,
      drive_min_est: distKm / DRIVE_KM_PER_MIN,
      start: trail.start,
      sun: {
        terrain_frac: terrainScore.terrain_frac,
        effective: terrainScore.terrain_frac,
        cloud_cover: null, cloud_source: null, no_forecast: true,
      },
      timeline: terrainScore.timeline,
      timeline_cloud: terrainScore.timeline_cloud,
    }));
  }


  /* ---- route planning -------------------------------------------------------
   *
   * A trail gets one sun score, but a two-hour loop passes through sun and
   * shade, and the DIRECTION you walk it changes everything: one way you take
   * the sunny face in the morning, the other you are in its shadow. Nothing
   * else can answer this, because it needs per-point skylines AND the walker's
   * position as a function of time.
   *
   * Cost is the catch. Naively this is (start times x directions x points)
   * solar-position calls — tens of thousands. But the sun's position depends
   * only on the CLOCK, not on which walker is where, so it is precomputed once
   * on a 5-minute grid for the day and every arrival snaps to the nearest
   * slot. That turns the inner loop into an array lookup and a horizon-bin
   * compare, and the whole sweep into a few hundred solar evaluations.
   */

  const ROUTE_SLOT_MIN = 5;

  function minutesToHHMM_(total) {
    const h = Math.floor(total / 60), m = Math.round(total) % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }

  /* Signed area of the trail's footprint (shoelace, in lon/lat — we only need
   * the SIGN). Positive means the points wind anticlockwise on a north-up map,
   * which lets a loop be described the way a walker thinks about it. */
  function windingSign(points) {
    let a = 0;
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      a += x1 * y2 - x2 * y1;
    }
    return a >= 0 ? 1 : -1;
  }

  function isLoop(trail) {
    const p = trail.points;
    if (p.length < 4) return false;
    const [lon1, lat1] = p[0];
    const [lon2, lat2] = p[p.length - 1];
    return haversineKm(lon1, lat1, lon2, lat2) * 1000 < 250;
  }

  /* Human labels for the two ways round. A loop is clockwise or anticlockwise;
   * anything else is described by the end you set off from. */
  function directionLabels(trail) {
    if (isLoop(trail)) {
      const anti = windingSign(trail.points) > 0;
      return anti
        ? { forward: "anticlockwise", reverse: "clockwise" }
        : { forward: "clockwise", reverse: "anticlockwise" };
    }
    const p = trail.points;
    const northFirst = p[0][1] > p[p.length - 1][1];
    return northFirst
      ? { forward: "from the north end", reverse: "from the south end" }
      : { forward: "from the south end", reverse: "from the north end" };
  }

  /* Best direction and start time for a walk on `dateStr`.
   *
   * Walks the trail at a constant pace over est_minutes, samples whether each
   * point is sunlit at the time the walker would actually be standing on it,
   * and reports the fraction of the walk spent in sun. */
  function routePlan(id, dateStr, opts = {}) {
    const d = requireData();
    const trail = d.byId.get(id);
    if (!trail) throw new Error(`no trail with id ${id}`);

    const stepMin = opts.stepMin || 30;
    const fromMin = opts.fromMin != null ? opts.fromMin : 6 * 60;
    const toMin = opts.toMin != null ? opts.toMin : 18 * 60;
    const durMin = Math.max(10, trail.est_minutes != null ? trail.est_minutes : 60);
    const pts = trail.points;
    const n = pts.length;

    // Solar positions on a 5-minute grid covering every arrival time we might
    // ask about, computed once at the trail's first point (across <=25 km the
    // difference is well inside one azimuth bin, same assumption as scoreTrail).
    const gridFrom = fromMin;
    const gridTo = toMin + durMin;
    const nSlots = Math.ceil((gridTo - gridFrom) / ROUTE_SLOT_MIN) + 1;
    const elev = new Float64Array(nSlots);
    const azim = new Float64Array(nSlots);
    for (let k = 0; k < nSlots; k++) {
      const m = gridFrom + k * ROUTE_SLOT_MIN;
      const s = sunPosition(pts[0][1], pts[0][0],
                            nzEpoch(dateStr, minutesToHHMM_(m)));
      elev[k] = s.elevation;
      azim[k] = s.azimuth;
    }
    const slotAt = (m) => {
      const k = Math.round((m - gridFrom) / ROUTE_SLOT_MIN);
      return k < 0 ? 0 : (k >= nSlots ? nSlots - 1 : k);
    };

    const options = [];
    for (let start = fromMin; start <= toMin; start += stepMin) {
      for (const reverse of [false, true]) {
        let sunny = 0;
        for (let i = 0; i < n; i++) {
          // position along the walk, 0..1, then the clock time there
          const f = n === 1 ? 0 : i / (n - 1);
          const k = slotAt(start + f * durMin);
          const idx = reverse ? (n - 1 - i) : i;
          if (inSun(trail.hoff + idx, elev[k], azim[k])) sunny++;
        }
        options.push({
          start_min: start,
          start: minutesToHHMM_(start),
          reverse,
          frac: sunny / n,
        });
      }
    }

    const labels = directionLabels(trail);
    for (const o of options) o.direction = o.reverse ? labels.reverse : labels.forward;

    // A tie on sun should go to the earlier start, not to whichever the loop
    // happened to reach first.
    const rank = (a, b) => (b.frac - a.frac) || (a.start_min - b.start_min);
    const sorted = options.slice().sort(rank);
    const best = sorted[0];
    const bestForward = options.filter((o) => !o.reverse).sort(rank)[0];
    const bestReverse = options.filter((o) => o.reverse).sort(rank)[0];

    return {
      trail_id: trail.id,
      date: dateStr,
      duration_min: durMin,
      is_loop: isLoop(trail),
      labels,
      options,
      best,
      best_forward: bestForward,
      best_reverse: bestReverse,
      // what the choice is actually worth: best against the median option
      spread: best.frac - sorted[Math.floor(sorted.length / 2)].frac,
    };
  }

  /* Full detail for one trail: metadata, geometry, per-point sun state at
   * atMs and a 10-min sun timeline for 08:00-17:00 NZ local on atMs's date
   * (55 entries). Same shape as Python trail_detail. */
  function trailDetail(id, atMs) {
    const d = requireData();
    const trail = d.byId.get(id);
    if (!trail) throw new Error(`no trail with id ${id}`);

    const sunNow = sunPosition(trail.points[0][1], trail.points[0][0], atMs);
    const points = trail.points.map(([lon, lat, elev], i) => ({
      lon, lat, elev_m: elev,
      sun: inSun(trail.hoff + i, sunNow.elevation, sunNow.azimuth),
    }));

    const dayStart = nzEpoch(nzDateStr(atMs), "08:00");
    const n = (17 - 8) * 60 / SAMPLE_MIN + 1;
    const timeline = [];
    for (let k = 0; k < n; k++) {
      const t = dayStart + k * SAMPLE_MIN * 60000;
      timeline.push({ t: isoNZ(t), frac: sunFracAt(trail, t) });
    }

    return {
      id: trail.id,
      name: trail.name,
      source: trail.source,
      category: trail.category,
      kind: trailKind(trail),
      difficulty: trail.difficulty,
      status: trail.status,
      length_m: trail.length_m,
      est_minutes: trail.est_minutes,
      canopy_frac: trail.canopy_frac,
      canopy_type: trail.canopy_type,
      region: trail.region,
      description: trail.description,
      url: trail.url,
      photo_url: trail.photo_url,
      geometry: trail.geometry,
      points,
      timeline,
    };
  }

  /* ---- weather (port of hikesun/score.py get_cloud_cover/get_cloud_series/
   * get_cloud_series_batch) --------------------------------------------- */

  // In-memory forecast cache: key -> { value, expiresAt }. Mirrors the
  // Python in-process dict cache; localStorage backs it across page loads
  // with the same 60-min TTL (see FORECAST_CACHE_TTL_MS).
  const forecastMemCache = new Map();
  const LS_PREFIX = "hikesun-wx:";

  function round01(x) {
    return Math.round(x * 10) / 10;
  }

  function seriesCacheKey(lat, lon, dateStr) {
    return `series:${round01(lat)},${round01(lon)},${dateStr}`;
  }

  function readCache(key) {
    const hit = forecastMemCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    if (hit) forecastMemCache.delete(key);
    try {
      const raw = window.localStorage && window.localStorage.getItem(LS_PREFIX + key);
      if (!raw) return undefined;
      const parsed = JSON.parse(raw);
      if (parsed.expiresAt <= Date.now()) {
        window.localStorage.removeItem(LS_PREFIX + key);
        return undefined;
      }
      forecastMemCache.set(key, parsed);
      return parsed.value;
    } catch (err) {
      return undefined;
    }
  }

  function writeCache(key, value) {
    const entry = { value, expiresAt: Date.now() + FORECAST_CACHE_TTL_MS };
    forecastMemCache.set(key, entry);
    try {
      if (window.localStorage) {
        window.localStorage.setItem(LS_PREFIX + key, JSON.stringify(entry));
      }
    } catch (err) {
      // localStorage full/unavailable (private browsing etc.) — memory
      // cache still works, just doesn't survive a reload.
    }
  }

  function cloudCoverFracs(values) {
    return values.map((v) =>
      v == null ? null : Math.min(1.0, Math.max(0.0, v / 100.0)));
  }

  /* Open-Meteo hourly cloud cover fraction (0..1) for the NZ-local dateStr
   * ("YYYY-MM-DD") at the given NZ-local hour, or null on ANY failure so
   * weather can never break scoring. Kept for backward compatibility; new
   * code should prefer getCloudSeries (one call gets all 24 hours). */
  async function getCloudCover(lat, lon, dateStr, hour) {
    const series = await getCloudSeries(lat, lon, dateStr);
    return series == null ? null : series[hour] ?? null;
  }

  /* Open-Meteo hourly cloud cover fractions (0..1) for all 24 hours of
   * dateStr ("YYYY-MM-DD", Pacific/Auckland local date) at (lat, lon).
   *
   * Returns an array of 24 numbers (null entries where Open-Meteo itself has
   * a null), or null on any failure (network error, bad payload, date beyond
   * the ~16-day forecast horizon) so weather can never break scoring.
   * Cached in-memory + localStorage, keyed on (lat/lon rounded to 0.1 deg,
   * dateStr), TTL 60 min. */
  async function getCloudSeries(lat, lon, dateStr) {
    const key = seriesCacheKey(lat, lon, dateStr);
    const cached = readCache(key);
    if (cached !== undefined) return cached;

    let series;
    try {
      const url = `${OPEN_METEO_URL}?latitude=${lat.toFixed(4)}` +
        `&longitude=${lon.toFixed(4)}&hourly=cloud_cover` +
        `&timezone=Pacific%2FAuckland&start_date=${dateStr}&end_date=${dateStr}`;
      // hard 8 s cap: weather being down must never stall the UI
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 8000);
      const resp = await fetch(url, { signal: abort.signal }).finally(
        () => clearTimeout(timer));
      if (!resp.ok) return null;
      const body = await resp.json();
      series = cloudCoverFracs(body.hourly.cloud_cover);
    } catch (err) {
      return null;
    }
    writeCache(key, series);
    return series;
  }

  /* Open-Meteo hourly cloud series for MULTIPLE (lat, lon) points at once.
   *
   * coords is an array of [lat, lon] pairs. Uses Open-Meteo's
   * comma-separated multi-coordinate form (one HTTP request for all points)
   * and returns an array, same length/order as coords, of per-point 24-hour
   * series (each an array like getCloudSeries's return, or null for that
   * point on a per-point failure). Returns null (not an array) if the whole
   * batch request fails (network error, bad payload, date beyond the
   * forecast horizon) so callers can fall back to a single-point lookup.
   *
   * Open-Meteo returns a bare object for a single coordinate and an array
   * (one object per point, in request order) for multiple — both shapes are
   * handled. Per-point results are cached the same way as getCloudSeries. */
  async function getCloudSeriesBatch(coords, dateStr) {
    if (!coords.length) return [];

    // any already-cached points can skip the network entirely if ALL are hit
    const cachedAll = coords.map(([lat, lon]) => readCache(seriesCacheKey(lat, lon, dateStr)));
    if (cachedAll.every((v) => v !== undefined)) return cachedAll;

    let seriesList;
    try {
      const lats = coords.map(([lat]) => lat.toFixed(4)).join(",");
      const lons = coords.map(([, lon]) => lon.toFixed(4)).join(",");
      const url = `${OPEN_METEO_URL}?latitude=${lats}&longitude=${lons}` +
        `&hourly=cloud_cover&timezone=Pacific%2FAuckland` +
        `&start_date=${dateStr}&end_date=${dateStr}`;
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 8000);
      const resp = await fetch(url, { signal: abort.signal }).finally(
        () => clearTimeout(timer));
      if (!resp.ok) return null;
      const body = await resp.json();
      // single-coord responses are a bare object; multi-coord an array.
      const entries = Array.isArray(body) ? body : [body];
      if (entries.length !== coords.length) return null;
      seriesList = entries.map((entry) => cloudCoverFracs(entry.hourly.cloud_cover));
    } catch (err) {
      return null;
    }
    coords.forEach(([lat, lon], i) => writeCache(seriesCacheKey(lat, lon, dateStr), seriesList[i]));
    return seriesList;
  }

  return {
    sunPosition, nzEpoch, isoNZ, nzDateStr, loadIndex, ensureCells, inSun,
    scoreTrail, search, candidatesInRange, trailDetail, getCloudCover,
    getCloudSeries, getCloudSeriesBatch, routePlan, haversineKm,
  };
})();

/* ---- self-test (paste into the browser console) ---------------------------
 * Expected values computed with the Python reference implementation
 * (hikesun.sun.sun_position) — the port should agree to ~1e-6 deg. Requires
 * sunmath.js to be loaded before this file (it is delegated to for
 * sunPosition/nzEpoch/isoNZ/nzDateStr — see SunMath in sunmath.js for the
 * same self-test against the SunMath global directly):
 *
 *   Engine.nzEpoch("2026-07-02", "10:00")            // 1782943200000 (NZST, UTC+12)
 *   Engine.nzEpoch("2026-01-15", "10:00")            // 1768424400000 (NZDT, UTC+13)
 *   Engine.isoNZ(1782943200000)                      // "2026-07-02T10:00:00+12:00"
 *   Engine.isoNZ(1768424400000)                      // "2026-01-15T10:00:00+13:00"
 *
 *   // Christchurch (lat -43.5321, lon 172.6362), winter morning/afternoon:
 *   Engine.sunPosition(-43.5321, 172.6362, 1782943200000)
 *     // { elevation: 14.7362, azimuth: 36.1774 }    (2026-07-02 10:00 NZST)
 *   Engine.sunPosition(-43.5321, 172.6362, 1782961200000)
 *     // { elevation: 15.4740, azimuth: 325.2813 }   (2026-07-02 15:00 NZST)
 *   Engine.sunPosition(-43.5321, 172.6362, 1768424400000)
 *     // { elevation: 39.8035, azimuth: 81.8071 }    (2026-01-15 10:00 NZDT)
 *
 *   // Load the shard index, then the cells around Christchurch (30 min
 *   // drive => 25.5 km search radius; cells within radius + 30 km load):
 *   await Engine.loadIndex(".")                       // { cells: [...], ... }
 *   await Engine.ensureCells([172.6362, -43.5321], 30 * 0.85)
 *     // -> total loaded cell count (e.g. 2: "172_-44" + "172_-43");
 *     //    calling it again with the same origin resolves without refetching
 *   await Engine.search({ lat: -43.5321, lon: 172.6362, driveMin: 30,
 *                         startMs: Engine.nzEpoch("2026-07-02", "10:00") })
 *     // search is now ASYNC (it batches one Open-Meteo call for the top
 *     // candidates' start coords) — results default-sorted by sun.effective
 *     // desc (opts.rankBy: "forecast" default | "terrain"); each result
 *     // gains sun.cloud_source ("trail"|"origin"|null), sun.cloud_cover
 *     // (window mean) and a timeline_cloud array aligned 1:1 with timeline.
 * --------------------------------------------------------------------------- */
