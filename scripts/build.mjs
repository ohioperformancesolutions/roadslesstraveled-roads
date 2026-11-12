// Build one road file per county for a US state, from a Geofabrik OpenStreetMap extract.
//
//   node scripts/build.mjs <state.osm.pbf> <out-dir> <State Name>
//
// Needs osmium-tool. Each file (<county relation id>.json) holds the county's roads in the same compact
// form the Roads Less Traveled app uses, plus the county's outline. Road data © OpenStreetMap contributors
// (ODbL).
import { execFileSync } from 'node:child_process';
import { appendFileSync, createReadStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// Same road rules as the app (src/lib/coverage.ts).
const HIGHWAYS = new Set(
  'motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street'.split('|'),
);
const SERVICE_SKIP = new Set('driveway|parking_aisle|drive-through|emergency_access'.split('|'));
const UNPAVED = new Set('unpaved|gravel|fine_gravel|dirt|earth|ground|compacted|sand|mud|grass|pebblestone|rock|woodchips'.split('|'));
const MAJOR = new Set(['motorway', 'trunk', 'primary']);

const osmium = (...args) => execFileSync('osmium', args, { stdio: ['ignore', 'inherit', 'inherit'] });

/** Read a GeoJSON-sequence file one feature at a time. */
async function* features(file) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const raw of rl) {
    const line = raw.replace(/^\x1e/, '').trim();
    if (line) yield JSON.parse(line);
  }
}

/** OSM id from osmium's unique id: "r123" / "w123", or an area id "a<2*id+1>" for relations. */
function osmId(fid, want) {
  const m = /^([a-z])(\d+)$/.exec(String(fid ?? ''));
  if (!m) return null;
  const n = Number(m[2]);
  if (m[1] === want) return n;
  if (m[1] === 'a') return want === 'r' ? (n % 2 ? (n - 1) / 2 : null) : n % 2 ? null : n / 2;
  return null;
}

// Exported for the tests.
export function wantRoad(t) {
  if (!t.highway || t.access === 'private' || t.access === 'no' || t.area === 'yes') return null;
  const main = HIGHWAYS.has(t.highway);
  const service = t.highway === 'service' && !!t.name && !SERVICE_SKIP.has(t.service);
  if (!main && !service) return null;
  return (UNPAVED.has(t.surface) ? 1 : 0) | (MAJOR.has(t.highway) ? 2 : 0) | (service ? 4 : 0);
}

export function encodeWay(flags, coords, enc) {
  enc.push(flags, coords.length);
  let pLat = 0;
  let pLon = 0;
  for (const [lon, lat] of coords) {
    const a = Math.round(lat * 1e6);
    const o = Math.round(lon * 1e6);
    enc.push(a - pLat, o - pLon);
    pLat = a;
    pLon = o;
  }
}

/** County outline in the app's format: per ring [count, lat, lon, ...] (millionths), thinned to ~50 m. */
export function encodeOutline(rings) {
  const out = [];
  for (const ring of rings) {
    const kept = [];
    let pLat = NaN;
    let pLon = NaN;
    ring.forEach(([lon, lat], k) => {
      const a = Math.round(lat * 1e6);
      const o = Math.round(lon * 1e6);
      if (k > 0 && k < ring.length - 1 && Math.abs(a - pLat) < 450 && Math.abs(o - pLon) < 550) return;
      kept.push(a, o);
      pLat = a;
      pLon = o;
    });
    if (kept.length >= 4) out.push(kept.length / 2, ...kept);
  }
  return out;
}

// ---------- Which county is a point in? (fast lookup over a ~1 km grid) ----------

const CELL = 0.01; // degrees

/** Is [lon, lat] inside these rings (outer rings and holes; odd crossings = inside)? */
export function insideRings(rings, lon, lat) {
  let inside = false;
  for (const ring of rings)
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < xi + ((lat - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
    }
  return inside;
}

/** Thin a ring to points ~50 m apart (exact enough for county lines, much faster to test). */
function thinRing(ring) {
  const out = [];
  let p = null;
  ring.forEach((pt, k) => {
    if (p && k < ring.length - 1 && Math.abs(pt[0] - p[0]) < 0.0005 && Math.abs(pt[1] - p[1]) < 0.0004) return;
    out.push(pt);
    p = pt;
  });
  return out;
}

/**
 * Grid over the state: each cell lists the counties it's fully inside of (sure) and the counties whose
 * border passes through it (check exactly).
 */
export function buildLocator(counties) {
  const grid = new Map(); // "x,y" -> { sure: number|undefined, edge: number[] }
  const key = (x, y) => `${x},${y}`;
  const cellOf = (v) => Math.floor(v / CELL);
  counties.forEach((c, ci) => {
    c.thin = c.rings.map(thinRing);
    const border = new Set();
    for (const ring of c.thin)
      for (let i = 1; i < ring.length; i++) {
        const [x0, y0] = ring[i - 1];
        const [x1, y1] = ring[i];
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / (CELL / 3)));
        for (let k = 0; k <= steps; k++) {
          const cx = cellOf(x0 + ((x1 - x0) * k) / steps);
          const cy = cellOf(y0 + ((y1 - y0) * k) / steps);
          for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) border.add(key(cx + dx, cy + dy));
        }
      }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const ring of c.thin) for (const [x, y] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    for (let cx = cellOf(minX) - 1; cx <= cellOf(maxX) + 1; cx++)
      for (let cy = cellOf(minY) - 1; cy <= cellOf(maxY) + 1; cy++) {
        const k = key(cx, cy);
        let cell = grid.get(k);
        if (border.has(k)) {
          if (!cell) grid.set(k, (cell = { sure: undefined, edge: [] }));
          cell.edge.push(ci);
        } else if (insideRings(c.thin, (cx + 0.5) * CELL, (cy + 0.5) * CELL)) {
          if (!cell) grid.set(k, (cell = { sure: undefined, edge: [] }));
          cell.sure = ci;
        }
      }
  });
  /** Indexes of the counties this point is in (normally one). */
  return (lon, lat) => {
    const cell = grid.get(key(cellOf(lon), cellOf(lat)));
    if (!cell) return [];
    const out = cell.sure !== undefined ? [cell.sure] : [];
    for (const ci of cell.edge) if (insideRings(counties[ci].thin, lon, lat)) out.push(ci);
    return out;
  };
}

async function main() {
  const [pbf, outDir, stateName] = process.argv.slice(2);
  if (!pbf || !outDir || !stateName) {
    console.error('usage: node scripts/build.mjs <state.osm.pbf> <out-dir> <State Name>');
    process.exit(2);
  }
  const work = resolve(outDir, '.work');
  mkdirSync(work, { recursive: true });
  const built = new Date().toISOString().slice(0, 10);

  // 1. County outlines (admin_level 6 boundaries).
  osmium('tags-filter', pbf, 'r/boundary=administrative', '-o', join(work, 'bnd.pbf'), '--overwrite');
  osmium('export', join(work, 'bnd.pbf'), '-f', 'geojsonseq', '--geometry-types=polygon', '--add-unique-id=type_id', '-o', join(work, 'bnd.geojsonseq'), '--overwrite');
  const counties = [];
  for await (const f of features(join(work, 'bnd.geojsonseq'))) {
    const p = f.properties ?? {};
    if (p.admin_level !== '6' || !p.name) continue;
    const id = osmId(f.id, 'r');
    if (id == null) continue;
    const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
    counties.push({ id, name: p.name, rings: polys.flat() });
  }
  console.log(`${stateName}: ${counties.length} counties`);
  if (!counties.length) throw new Error('no counties found');
  const locate = buildLocator(counties);
  console.log('county grid ready');

  // 2. One pass over the state's roads: each road goes to every county it has a point in (like the app's
  //    "roads in this county" query, whole roads kept). Written out in chunks to keep memory low.
  osmium('tags-filter', pbf, 'w/highway', '-o', join(work, 'hw.pbf'), '--overwrite');
  osmium('export', join(work, 'hw.pbf'), '-f', 'geojsonseq', '--geometry-types=linestring', '--add-unique-id=type_id', '-o', join(work, 'hw.geojsonseq'), '--overwrite');
  const bufs = counties.map(() => []);
  const sizes = counties.map(() => 0);
  const roads = counties.map(() => 0);
  const flush = (ci) => {
    if (!bufs[ci].length) return;
    appendFileSync(join(work, `${counties[ci].id}.part`), (sizes[ci] ? ',' : '') + bufs[ci].join(','));
    sizes[ci] += bufs[ci].length;
    bufs[ci] = [];
  };
  let n = 0;
  for await (const f of features(join(work, 'hw.geojsonseq'))) {
    if (osmId(f.id, 'w') == null || f.geometry?.type !== 'LineString') continue;
    const flags = wantRoad(f.properties ?? {});
    const coords = f.geometry.coordinates;
    if (flags == null || coords.length < 2) continue;
    const hit = new Set();
    for (const [lon, lat] of coords) for (const ci of locate(lon, lat)) hit.add(ci);
    if (!hit.size) continue;
    const enc = [];
    encodeWay(flags, coords, enc);
    const text = enc.join(',');
    for (const ci of hit) {
      bufs[ci].push(text);
      roads[ci]++;
      if (bufs[ci].length >= 2000) flush(ci);
    }
    if (++n % 200000 === 0) console.log(`${n} roads sorted`);
  }
  counties.forEach((_, ci) => flush(ci));

  // 3. Write each county's file.
  const index = [];
  counties.forEach((c, ci) => {
    const part = join(work, `${c.id}.part`);
    const body = sizes[ci] ? readFileSync(part, 'utf8') : '';
    const head = JSON.stringify({ v: 1, built, state: stateName, county: c.name, id: c.id, outline: encodeOutline(c.rings) });
    writeFileSync(join(outDir, `${c.id}.json`), `${head.slice(0, -1)},"enc":[${body}]}`);
    index.push({ id: c.id, county: c.name, roads: roads[ci] });
  });
  index.sort((a, b) => a.county.localeCompare(b.county));
  writeFileSync(join(outDir, 'counties.json'), JSON.stringify({ v: 1, built, state: stateName, counties: index }));
  rmSync(work, { recursive: true, force: true });
  console.log(`${stateName}: wrote ${index.length} county files, ${n} roads`);
}

if (process.argv[1]?.endsWith('build.mjs')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
