// Build one road file per county for a US state, from a Geofabrik OpenStreetMap extract.
//
//   node scripts/build.mjs <state.osm.pbf> <out-dir> <State Name>
//
// Needs osmium-tool. Each file (<county relation id>.json) holds the county's roads in the same compact
// form the Roads Less Traveled app uses, plus the county's outline. Road data © OpenStreetMap contributors
// (ODbL).
import { execFileSync } from 'node:child_process';
import { createReadStream, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

async function main() {
  const [pbf, outDir, stateName] = process.argv.slice(2);
  if (!pbf || !outDir || !stateName) {
    console.error('usage: node scripts/build.mjs <state.osm.pbf> <out-dir> <State Name>');
    process.exit(2);
  }
  const work = resolve(outDir, '.work'); // absolute: osmium reads extract paths relative to its config file
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
    writeFileSync(join(work, `${id}.geojson`), JSON.stringify({ type: 'Feature', properties: {}, geometry: f.geometry }));
    counties.push({ id, name: p.name, rings: polys.flat() });
  }
  console.log(`${stateName}: ${counties.length} counties`);
  if (!counties.length) throw new Error('no counties found');

  // 2. Only roads, then cut one file per county (roads touching the county, whole roads, like the app's query).
  osmium('tags-filter', pbf, 'w/highway', '-o', join(work, 'hw.pbf'), '--overwrite');
  for (let i = 0; i < counties.length; i += 40) {
    const batch = counties.slice(i, i + 40);
    const config = {
      directory: work,
      extracts: batch.map((c) => ({ output: `${c.id}.osm.pbf`, polygon: { file_name: join(work, `${c.id}.geojson`), file_type: 'geojson' } })),
    };
    writeFileSync(join(work, 'extracts.json'), JSON.stringify(config));
    osmium('extract', '-c', join(work, 'extracts.json'), '-s', 'complete_ways', join(work, 'hw.pbf'), '--overwrite');
  }

  // 3. Each county's roads -> compact file.
  const index = [];
  for (const c of counties) {
    const src = join(work, `${c.id}.osm.pbf`);
    const seq = join(work, `${c.id}.geojsonseq`);
    osmium('export', src, '-f', 'geojsonseq', '--geometry-types=linestring', '--add-unique-id=type_id', '-o', seq, '--overwrite');
    const enc = [];
    let roads = 0;
    for await (const f of features(seq)) {
      if (osmId(f.id, 'w') == null || f.geometry?.type !== 'LineString') continue;
      const flags = wantRoad(f.properties ?? {});
      if (flags == null || f.geometry.coordinates.length < 2) continue;
      encodeWay(flags, f.geometry.coordinates, enc);
      roads++;
    }
    const file = { v: 1, built, state: stateName, county: c.name, id: c.id, enc, outline: encodeOutline(c.rings) };
    writeFileSync(join(outDir, `${c.id}.json`), JSON.stringify(file));
    index.push({ id: c.id, county: c.name, roads });
    rmSync(src);
    rmSync(seq);
  }
  index.sort((a, b) => a.county.localeCompare(b.county));
  writeFileSync(join(outDir, 'counties.json'), JSON.stringify({ v: 1, built, state: stateName, counties: index }));
  rmSync(work, { recursive: true, force: true });
  console.log(`${stateName}: wrote ${index.length} county files`);
}

if (process.argv[1]?.endsWith('build.mjs')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
