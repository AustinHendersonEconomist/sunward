/* HikeSun shadow-worker — pure-geometry terrain shading, off the main thread.
 *
 * No importScripts: the layer (main thread) computes sun azimuth/elevation
 * via SunMath and includes it in every job, so this worker only ever does
 * DEM decode + ray-march arithmetic. Runs as one of a small pool created by
 * shadow-layer.js (`new Worker(workerUrl)`).
 *
 * Conventions (same as hikesun/horizon.py + hikesun/dem.py):
 *   - Terrarium decode: elev = R*256 + G + B/256 - 32768.
 *   - Azimuths: degrees clockwise from TRUE NORTH, [0, 360).
 *   - Curvature/refraction: effective earth radius R_EFF_M = 7.32e6; a ray
 *     sample at ground distance d (m) is "beaten" when a terrain sample's
 *     elevation exceeds h0 + d*tan(sunElevDeg) + d^2/(2*R_EFF_M).
 *
 * Message protocol:
 *   in  -> {id, type:'render', tile:{z,x,y}, tileUrl, epochMs,
 *           sunAzDeg, sunElevDeg, mode:'cast'|'hillshade'}
 *   out <- {id, phase:'hillshade'|'cast', buffer: ArrayBuffer (RGBA8 raw,
 *           TILE_PX*TILE_PX*4 bytes), tile:{z,x,y}}  (buffer transferred)
 *   out <- {id, phase:'error', message}
 *
 * A render job for mode:'cast' produces TWO responses: a fast 'hillshade'
 * phase first, then a 'cast' phase once the neighbour ring has been fetched
 * and ray-marched. mode:'hillshade' produces exactly one 'hillshade' phase
 * response (used below zoom 11 where cast shadows are meaningless).
 *
 * Also handles a dev-only synthetic test message (see shadow-harness.html):
 *   in  -> {id, type:'renderSynthetic', dem: Float32Array (side*side),
 *           side, pxSize: metres/px, sunAzDeg, sunElevDeg}
 *   out <- {id, phase:'cast', buffer: ArrayBuffer (RGBA8, side*side*4)}
 */

"use strict";

const TILE_PX = 256;
const R_EFF_M = 7.32e6; // same as hikesun/horizon.py R_EARTH_EFF
const DEG = Math.PI / 180.0;
const SHADOW_RGB = [30, 41, 59]; // slate-800, matches the plan's swatch

/* ---- terrarium decode --------------------------------------------------- */

/* Decode a terrarium PNG (as an ArrayBuffer) to a Float32Array of elevations
 * (metres), row-major, TILE_PX x TILE_PX. Uses createImageBitmap +
 * OffscreenCanvas when available (the fast path in every worker-capable
 * browser); falls through to an explicit error otherwise so the caller can
 * fall back to a main-thread decode (see shadow-layer.js degraded path). */
async function decodeTerrarium(pngBuffer) {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    throw new Error("OffscreenCanvas/createImageBitmap unavailable in worker");
  }
  const blob = new Blob([pngBuffer], { type: "image/png" });
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  const n = bitmap.width * bitmap.height;
  const elev = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    elev[i] = r * 256.0 + g + b / 256.0 - 32768.0;
  }
  return { elev, width: bitmap.width, height: bitmap.height };
}

/* ---- tile fetch (with small in-worker cache for the neighbour ring) ----- */

const tileCache = new Map(); // "z/x/y" -> Promise<{elev,width,height}|null>

function tileKey(z, x, y) {
  return `${z}/${x}/${y}`;
}

/* Fetch + decode one terrarium tile at (z,x,y) via urlTemplate (a string
 * with {z}/{x}/{y} placeholders, same as hikesun config.TILE_URL). Returns
 * null (never throws) on any fetch/decode failure so a missing edge tile
 * just contributes no terrain rather than aborting the whole render. */
function fetchTile(urlTemplate, z, x, y) {
  const key = tileKey(z, x, y);
  let pending = tileCache.get(key);
  if (pending) return pending;
  const url = urlTemplate.replace("{z}", z).replace("{x}", x).replace("{y}", y);
  pending = fetch(url)
    .then((resp) => {
      if (!resp.ok) return null;
      return resp.arrayBuffer();
    })
    .then((buf) => (buf ? decodeTerrarium(buf) : null))
    .catch(() => null);
  tileCache.set(key, pending);
  return pending;
}

/* Web Mercator tile-index helpers (same convention as hikesun/geo.py's
 * lonlat_to_global_px, just expressed in tile units). */
function tilesAtZoom(z, x, y, fromZ) {
  // Convert tile (x,y) at zoom z down to the covering tile at zoom fromZ
  // (fromZ <= z): integer division by 2^(z-fromZ).
  const shift = z - fromZ;
  return { x: x >> shift, y: y >> shift };
}

/* Ring size (in target-zoom tiles) to stitch around the centre tile, per
 * the plan: ring 1 (3x3) at z>=13, ring 2 (5x5) at z11-12. Below z11 no
 * cast-shadow ray-march is attempted (caller uses hillshade mode there). */
function ringRadius(z) {
  return z >= 13 ? 1 : 2;
}

/* Stitch a (2*ring+1)*TILE_PX square mosaic of elevations centred on tile
 * (z,x,y), fetching neighbours at the SAME zoom (simplest correct stitch;
 * ring 2 at z11-12 already covers ~19 km, per the plan). Missing tiles are
 * filled with NaN so they never win the ray-march comparison. Returns
 * {mosaic: Float32Array, side, originTileX, originTileY, maxElev}. */
async function stitchMosaic(urlTemplate, z, x, y) {
  const ring = ringRadius(z);
  const n = 2 * ring + 1;
  const side = n * TILE_PX;
  const mosaic = new Float32Array(side * side).fill(NaN);
  const originTileX = x - ring;
  const originTileY = y - ring;
  const fetches = [];
  for (let dy = -ring; dy <= ring; dy++) {
    for (let dx = -ring; dx <= ring; dx++) {
      const tx = x + dx, ty = y + dy;
      fetches.push(
        fetchTile(urlTemplate, z, tx, ty).then((tile) => {
          if (!tile) return;
          const r0 = (dy + ring) * TILE_PX;
          const c0 = (dx + ring) * TILE_PX;
          for (let row = 0; row < TILE_PX; row++) {
            const srcOff = row * TILE_PX;
            const dstOff = (r0 + row) * side + c0;
            mosaic.set(tile.elev.subarray(srcOff, srcOff + TILE_PX), dstOff);
          }
        }),
      );
    }
  }
  await Promise.all(fetches);
  let maxElev = -Infinity;
  for (let i = 0; i < mosaic.length; i++) {
    if (!Number.isNaN(mosaic[i]) && mosaic[i] > maxElev) maxElev = mosaic[i];
  }
  return { mosaic, side, originTileX, originTileY, ring, maxElev };
}

/* ---- hillshade (no neighbours needed) ------------------------------------ */

/* Simple Lambertian hillshade from the local gradient of a single tile's
 * elevation, modulating the shadow-tint alpha (darker on slopes facing
 * away from the sun, transparent on slopes facing it). pxSize is metres
 * per pixel at this tile's zoom (used to scale the gradient to slope). */
function renderHillshade(elev, width, height, sunAzDeg, sunElevDeg, pxSize) {
  const out = new Uint8ClampedArray(width * height * 4);
  const azR = sunAzDeg * DEG;
  const elR = sunElevDeg * DEG;
  // Sun unit vector: x=east, y=north, z=up.
  const sx = Math.sin(azR) * Math.cos(elR);
  const sy = Math.cos(azR) * Math.cos(elR);
  const sz = Math.sin(elR);
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(width - 1, i + 1);
      const j0 = Math.max(0, j - 1), j1 = Math.min(height - 1, j + 1);
      const hL = elev[j * width + i0], hR = elev[j * width + i1];
      const hT = elev[j0 * width + i], hB = elev[j1 * width + i];
      const dzdx = (hR - hL) / ((i1 - i0) * pxSize || pxSize);
      const dzdy = (hB - hT) / ((j1 - j0) * pxSize || pxSize);
      // Surface normal (unnormalised): (-dzdx, -dzdy, 1); y flipped because
      // pixel row j increases southward while our sun vector's y is north.
      const nx = -dzdx, ny = dzdy, nz = 1.0;
      const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz);
      let cosIncidence = (nx * sx + ny * sy + nz * sz) / nlen;
      if (Number.isNaN(cosIncidence)) cosIncidence = 1.0;
      // alpha: 0 when fully lit (cosIncidence>=~0.5), ramps to full shade
      // tint as the surface faces away from the sun.
      const lit = Math.max(0.0, Math.min(1.0, cosIncidence));
      const alpha = Math.round(255 * (1.0 - lit) * 0.9);
      const p = (j * width + i) * 4;
      out[p] = SHADOW_RGB[0];
      out[p + 1] = SHADOW_RGB[1];
      out[p + 2] = SHADOW_RGB[2];
      out[p + 3] = alpha;
    }
  }
  return out;
}

/* ---- cast shadow ray-march ------------------------------------------------
 *
 * For each pixel of the TARGET tile (the centre TILE_PX x TILE_PX block of
 * the stitched mosaic), march from that pixel toward the sun azimuth in
 * 1-px steps out to the edge of the stitched mosaic. The pixel is shadowed
 * if any sampled elevation beats h0 + d*tan(sunElev) + d^2/(2*R_EFF_M)
 * (curvature + refraction drop, same constant as hikesun/horizon.py).
 * Early-exit per pixel once the remaining possible terrain (mosaic max
 * elevation) can no longer beat the required height at the ray's current
 * distance — this bounds worst-case work far below ring-radius*TILE_PX
 * steps per pixel for most rays. */
function renderCastShadow(mosaicInfo, sunAzDeg, sunElevDeg, pxSize) {
  const { mosaic, side, ring, maxElev } = mosaicInfo;
  const out = new Uint8ClampedArray(TILE_PX * TILE_PX * 4);
  if (sunElevDeg <= 0.0) {
    // Sun below the geometric horizon: whole tile is shadow (dusk handled
    // one level up by the layer's uniform tint; this path is only reached
    // for the near-horizon edge case where the layer still asks for cast).
    for (let p = 0; p < TILE_PX * TILE_PX; p++) {
      out[p * 4] = SHADOW_RGB[0];
      out[p * 4 + 1] = SHADOW_RGB[1];
      out[p * 4 + 2] = SHADOW_RGB[2];
      out[p * 4 + 3] = 255;
    }
    return out;
  }
  const azR = sunAzDeg * DEG;
  // Step direction TOWARD the sun, in pixel space. Pixel x increases east,
  // pixel y increases south (screen/raster convention), so the north
  // component maps to -y.
  const stepX = Math.sin(azR);
  const stepY = -Math.cos(azR);
  const tanElev = Math.tan(sunElevDeg * DEG);
  const originOffset = ring * TILE_PX; // centre tile's top-left within mosaic
  const maxSteps = side; // ray can't usefully travel further than the mosaic

  for (let ty = 0; ty < TILE_PX; ty++) {
    for (let tx = 0; tx < TILE_PX; tx++) {
      const mx0 = originOffset + tx;
      const my0 = originOffset + ty;
      const h0 = mosaic[my0 * side + mx0];
      let shadowed = false;
      if (!Number.isNaN(h0)) {
        // Early-exit bound: at distance d, required height to beat is
        // h0 + d*tanElev + d^2/(2R). Solve for the distance beyond which
        // even maxElev terrain could never beat it (monotonically
        // increasing requirement), and stop the march there.
        for (let step = 1; step <= maxSteps; step++) {
          const mx = Math.round(mx0 + stepX * step);
          const my = Math.round(my0 + stepY * step);
          if (mx < 0 || mx >= side || my < 0 || my >= side) break;
          const d = step * pxSize;
          const required = h0 + d * tanElev + (d * d) / (2 * R_EFF_M);
          if (required > maxElev) break; // no terrain anywhere can beat this
          const h = mosaic[my * side + mx];
          if (!Number.isNaN(h) && h > required) {
            shadowed = true;
            break;
          }
        }
      }
      const p = (ty * TILE_PX + tx) * 4;
      if (shadowed) {
        out[p] = SHADOW_RGB[0];
        out[p + 1] = SHADOW_RGB[1];
        out[p + 2] = SHADOW_RGB[2];
        out[p + 3] = 255;
      } else {
        out[p] = SHADOW_RGB[0];
        out[p + 1] = SHADOW_RGB[1];
        out[p + 2] = SHADOW_RGB[2];
        out[p + 3] = 0;
      }
    }
  }
  return out;
}

/* Metres per pixel at zoom z, at the tile's approximate latitude. Uses the
 * standard Web Mercator scale factor; latY is the tile's centre latitude
 * in degrees (passed by the layer, which already knows the tile bounds). */
function metresPerPixel(z, latDeg) {
  const C = 40075016.686; // equatorial circumference, metres
  return (C * Math.cos(latDeg * DEG)) / (TILE_PX * Math.pow(2, z));
}

/* ---- horizon profile for an arbitrary point -------------------------------
 *
 * Port of hikesun/horizon.py compute_horizons() for a single point, so the
 * address lookup can score a spot that has no precomputed profile. Same
 * constants and the same geometry, so a result here is comparable with the
 * trail profiles baked into the shards.
 *
 * Sampling uses two mosaics rather than one: the geometric radius grid puts
 * 52 of its 64 samples inside 5 km, where resolution actually decides
 * whether a ridge shades you, and only 12 beyond. So the near field comes
 * from z13 (~14 m/px, matching the Python pipeline) and the far field from
 * z11 (~55 m/px). Covering 16 km at z13 alone would need an 11x11 = 121
 * tile stitch; this needs 9 + 25. */

const AZ_BINS = 120;
const AZ_STEP_DEG = 360.0 / AZ_BINS;
const RAY_MIN_M = 30.0;
const RAY_MAX_M = 16000.0;
const RAY_STEPS = 64;
const EYE_HEIGHT_M = 2.0;
const HORIZON_FLOOR_DEG = -2.0;
const R_EARTH = 6371000.0;
const HORIZON_NEAR_Z = 13;
const HORIZON_FAR_Z = 11;

function mPerDeg(lat) {
  const latR = lat * DEG;
  return {
    lon: (Math.PI / 180.0) * R_EARTH * Math.cos(latR),
    lat: 111132.954 - 559.822 * Math.cos(2 * latR) + 1.175 * Math.cos(4 * latR),
  };
}

function lonLatToGlobalPx(lon, lat, z) {
  const n = TILE_PX * Math.pow(2, z);
  const latR = lat * DEG;
  return {
    x: ((lon + 180.0) / 360.0) * n,
    y: ((1.0 - Math.log(Math.tan(latR) + 1.0 / Math.cos(latR)) / Math.PI) / 2.0) * n,
  };
}

/* bilinear elevation from a stitched mosaic; NaN outside its coverage (which
 * is what the reference does too — a missing sample never raises the horizon) */
function sampleMosaic(info, z, lon, lat) {
  const { mosaic, side, originTileX, originTileY } = info;
  const g = lonLatToGlobalPx(lon, lat, z);
  const px = g.x - originTileX * TILE_PX;
  const py = g.y - originTileY * TILE_PX;
  if (!(px >= 0 && py >= 0 && px <= side - 1 && py <= side - 1)) return NaN;
  const x0 = Math.floor(px), y0 = Math.floor(py);
  const x1 = Math.min(x0 + 1, side - 1), y1 = Math.min(y0 + 1, side - 1);
  const fx = px - x0, fy = py - y0;
  const a = mosaic[y0 * side + x0], b = mosaic[y0 * side + x1];
  const c = mosaic[y1 * side + x0], d = mosaic[y1 * side + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/* near mosaic first, far mosaic where the near one does not reach */
function elevationAt(near, far, lon, lat) {
  const e = sampleMosaic(near, HORIZON_NEAR_Z, lon, lat);
  if (!Number.isNaN(e)) return e;
  return sampleMosaic(far, HORIZON_FAR_Z, lon, lat);
}

async function handleHorizon(msg) {
  const { id, lon, lat, tileUrl } = msg;

  const nearG = lonLatToGlobalPx(lon, lat, HORIZON_NEAR_Z);
  const farG = lonLatToGlobalPx(lon, lat, HORIZON_FAR_Z);
  const near = await stitchMosaic(tileUrl, HORIZON_NEAR_Z,
    Math.floor(nearG.x / TILE_PX), Math.floor(nearG.y / TILE_PX));
  const far = await stitchMosaic(tileUrl, HORIZON_FAR_Z,
    Math.floor(farG.x / TILE_PX), Math.floor(farG.y / TILE_PX));

  const h0 = elevationAt(near, far, lon, lat);
  if (Number.isNaN(h0)) {
    self.postMessage({ id, phase: "horizon", profile: null, elev: null });
    return;
  }
  const eye = h0 + EYE_HEIGHT_M;

  // geometric radius grid, identical to np.geomspace(RAY_MIN_M, RAY_MAX_M, RAY_STEPS)
  const radii = new Float64Array(RAY_STEPS);
  const ratio = Math.pow(RAY_MAX_M / RAY_MIN_M, 1 / (RAY_STEPS - 1));
  for (let i = 0; i < RAY_STEPS; i++) radii[i] = RAY_MIN_M * Math.pow(ratio, i);

  const md = mPerDeg(lat);
  const profile = new Float32Array(AZ_BINS);
  for (let k = 0; k < AZ_BINS; k++) {
    const az = (k + 0.5) * AZ_STEP_DEG * DEG;
    const sinAz = Math.sin(az), cosAz = Math.cos(az);
    let best = -Infinity;
    for (let i = 0; i < RAY_STEPS; i++) {
      const r = radii[i];
      const h = elevationAt(near, far, lon + (r * sinAz) / md.lon,
        lat + (r * cosAz) / md.lat);
      if (Number.isNaN(h)) continue;
      // curvature + refraction drop, same constant as hikesun/horizon.py
      const ang = Math.atan2(h - eye - (r * r) / (2.0 * R_EFF_M), r) / DEG;
      if (ang > best) best = ang;
    }
    profile[k] = Math.max(best, HORIZON_FLOOR_DEG);
  }
  self.postMessage({ id, phase: "horizon", profile: profile.buffer, elev: h0 },
    [profile.buffer]);
}

/* ---- message handling ----------------------------------------------------- */

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    if (msg.type === "renderSynthetic") {
      await handleRenderSynthetic(msg);
      return;
    }
    if (msg.type === "render") {
      await handleRender(msg);
      return;
    }
    if (msg.type === "horizon") {
      await handleHorizon(msg);
      return;
    }
    throw new Error(`unknown message type: ${msg.type}`);
  } catch (err) {
    self.postMessage({ id: msg.id, phase: "error", message: String(err && err.message || err) });
  }
};

async function handleRender(msg) {
  const { id, tile, tileUrl, sunAzDeg, sunElevDeg, mode, latDeg } = msg;
  const { z, x, y } = tile;
  const pxSize = metresPerPixel(z, latDeg != null ? latDeg : 0);

  const centreTile = await fetchTile(tileUrl, z, x, y);
  if (!centreTile) {
    // No terrain data for this tile: fully transparent (nothing to shade).
    const empty = new Uint8ClampedArray(TILE_PX * TILE_PX * 4);
    self.postMessage(
      { id, phase: "hillshade", tile, buffer: empty.buffer },
      [empty.buffer],
    );
    return;
  }

  // Phase 1: fast hillshade from just the centre tile.
  const hillshadeAlpha = sunElevDeg <= -1.0 ? null : renderHillshade(
    centreTile.elev, centreTile.width, centreTile.height, sunAzDeg, sunElevDeg, pxSize);
  const hillshadeBuf = hillshadeAlpha
    ? hillshadeAlpha.buffer
    : duskTile();
  self.postMessage(
    { id, phase: "hillshade", tile, buffer: hillshadeBuf },
    [hillshadeBuf],
  );

  if (mode !== "cast" || sunElevDeg <= -1.0) return;

  // Phase 2: cast-shadow refinement using the stitched neighbour ring.
  const mosaicInfo = await stitchMosaic(tileUrl, z, x, y);
  const castBuf = renderCastShadow(mosaicInfo, sunAzDeg, sunElevDeg, pxSize).buffer;
  self.postMessage(
    { id, phase: "cast", tile, buffer: castBuf },
    [castBuf],
  );
}

/* Uniform dusk-tint tile buffer (sun below -1deg elevation): flat shadow
 * tint at a fixed alpha, no ray-march. */
function duskTile() {
  const out = new Uint8ClampedArray(TILE_PX * TILE_PX * 4);
  for (let p = 0; p < TILE_PX * TILE_PX; p++) {
    out[p * 4] = SHADOW_RGB[0];
    out[p * 4 + 1] = SHADOW_RGB[1];
    out[p * 4 + 2] = SHADOW_RGB[2];
    out[p * 4 + 3] = 200;
  }
  return out.buffer;
}

/* Dev-only synthetic golden-cone test entry point (see shadow-harness.html):
 * given a square Float32Array DEM (side x side, pxSize metres/px), ray-march
 * every pixel against the WHOLE array as its own neighbourhood (no tiling —
 * the harness hands over one self-contained DEM) and return the cast-shadow
 * buffer, so the harness can assert the shadow falls opposite sunAzDeg with
 * the expected length h/tan(elev). Same physics as renderCastShadow, just
 * without the tile/ring indirection since there is only one "tile" here. */
async function handleRenderSynthetic(msg) {
  const { id, dem, side, pxSize, sunAzDeg, sunElevDeg } = msg;
  const mosaic = dem instanceof Float32Array ? dem : new Float32Array(dem);
  let maxElev = -Infinity;
  for (let i = 0; i < mosaic.length; i++) {
    if (!Number.isNaN(mosaic[i]) && mosaic[i] > maxElev) maxElev = mosaic[i];
  }
  const azR = sunAzDeg * DEG;
  const stepX = Math.sin(azR);
  const stepY = -Math.cos(azR);
  const tanElev = Math.tan(Math.max(sunElevDeg, 0.001) * DEG);
  const out = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const h0 = mosaic[y * side + x];
      let shadowed = false;
      if (!Number.isNaN(h0)) {
        for (let step = 1; step < side; step++) {
          const mx = Math.round(x + stepX * step);
          const my = Math.round(y + stepY * step);
          if (mx < 0 || mx >= side || my < 0 || my >= side) break;
          const d = step * pxSize;
          const required = h0 + d * tanElev + (d * d) / (2 * R_EFF_M);
          if (required > maxElev) break;
          const h = mosaic[my * side + mx];
          if (!Number.isNaN(h) && h > required) {
            shadowed = true;
            break;
          }
        }
      }
      const p = (y * side + x) * 4;
      out[p] = SHADOW_RGB[0];
      out[p + 1] = SHADOW_RGB[1];
      out[p + 2] = SHADOW_RGB[2];
      out[p + 3] = shadowed ? 255 : 0;
    }
  }
  self.postMessage({ id, phase: "cast", buffer: out.buffer, side }, [out.buffer]);
}
