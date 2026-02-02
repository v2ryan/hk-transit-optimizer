import fetch from 'node-fetch';
import JSZip from 'jszip';
import { parseCsv } from './csv.js';

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const s = Math.sin(dLat/2)**2 + Math.cos(lat1)*Math.cos(lat2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function walkSeconds(from, to, speedMps = 1.2) {
  const m = haversineMeters(from, to);
  return Math.round(m / speedMps);
}

export class MtrRouter {
  constructor({ gtfsUrl, waitSec = 180, xferSec = 120, tstEtsSec = 600 } = {}) {
    this.gtfsUrl = gtfsUrl;
    this.waitSec = waitSec;
    this.xferSec = xferSec;
    this.tstEtsSec = tstEtsSec;
    this._loaded = false;
    this._stops = new Map(); // stop_id -> {name, lat, lon}
    this._platformsByCode = new Map(); // code -> [stop_id]
    this._edges = new Map(); // fromStop -> Map(toStop -> sec)
  }

  async load() {
    if (this._loaded) return;
    if (!this.gtfsUrl) throw new Error('MTR GTFS URL not configured');

    const res = await fetch(this.gtfsUrl, { headers: { 'User-Agent': 'hk-transit-optimizer/0.1 (contact: local)' } });
    if (!res.ok) throw new Error(`MTR GTFS download failed: ${res.status}`);
    const buf = await res.arrayBuffer();
    const zip = await JSZip.loadAsync(buf);

    const readCsv = async (name) => {
      const f = zip.file(name);
      if (!f) throw new Error(`MTR GTFS missing ${name}`);
      const text = await f.async('string');
      return parseCsv(text);
    };

    const routes = await readCsv('routes.txt');
    const trips = await readCsv('trips.txt');
    const stopTimes = await readCsv('stop_times.txt');
    const stops = await readCsv('stops.txt');

    // Build stop map (MTR only) + platform index by station code
    for (const s of stops) {
      const id = String(s.stop_id || '');
      if (!id.startsWith('MTR-')) continue;
      this._stops.set(id, {
        name: s.stop_name,
        lat: Number(s.stop_lat),
        lon: Number(s.stop_lon)
      });
      // Platform stop_id format: MTR-PLATFORM-<CODE>-<N>
      const m = id.match(/^MTR-PLATFORM-([A-Z0-9]+)-\d+$/);
      if (m) {
        const code = m[1];
        const arr = this._platformsByCode.get(code) || [];
        arr.push(id);
        this._platformsByCode.set(code, arr);
      }
    }

    // Identify rail routes: route_type=1 (subway/rail)
    const railRouteIds = new Set(routes.filter(r => r.route_type === '1').map(r => r.route_id));

    // trip_id -> route_id for rail
    const tripToRoute = new Map();
    for (const t of trips) {
      if (railRouteIds.has(t.route_id)) tripToRoute.set(t.trip_id, t.route_id);
    }

    // group stop_times by trip_id
    const byTrip = new Map();
    for (const st of stopTimes) {
      if (!tripToRoute.has(st.trip_id)) continue;
      const seq = Number(st.stop_sequence || 0);
      const stopId = st.stop_id;
      if (!this._stops.has(stopId)) continue;
      const arrSec = parseHms(st.arrival_time);
      const depSec = parseHms(st.departure_time);
      if (arrSec == null || depSec == null) continue;
      const list = byTrip.get(st.trip_id) || [];
      list.push({ seq, stopId, arrSec, depSec });
      byTrip.set(st.trip_id, list);
    }

    // derive min edge travel times between consecutive stops
    for (const [tripId, list] of byTrip.entries()) {
      list.sort((a,b)=>a.seq-b.seq);
      for (let i=0;i<list.length-1;i++) {
        const a = list[i];
        const b = list[i+1];
        const dt = b.arrSec - a.depSec;
        if (!(dt > 0 && dt < 3600)) continue;
        addEdge(this._edges, a.stopId, b.stopId, dt);
        addEdge(this._edges, b.stopId, a.stopId, dt);
      }
    }

    // Add in-station transfers between platforms (connect lines at the same station code)
    const XFER_SEC = this.xferSec;
    for (const [code, ids] of this._platformsByCode.entries()) {
      for (let i=0;i<ids.length;i++) {
        for (let j=0;j<ids.length;j++) {
          if (i===j) continue;
          addEdge(this._edges, ids[i], ids[j], XFER_SEC);
        }
      }
    }

    // Special pedestrian linkage: TST <-> ETS (Tsim Sha Tsui <-> East Tsim Sha Tsui)
    const WALKWAY_SEC = this.tstEtsSec;
    const tst = this._platformsByCode.get('TST') || [];
    const ets = this._platformsByCode.get('ETS') || [];
    for (const a of tst) for (const b of ets) {
      addEdge(this._edges, a, b, WALKWAY_SEC);
      addEdge(this._edges, b, a, WALKWAY_SEC);
    }

    this._loaded = true;
  }

  // Compute MTR travel time between two points.
  // Prefer station codes (select platform stops), otherwise fall back to nearest platform stop.
  async plan({ from, to, fromStationCode, toStationCode }) {
    await this.load();

    const fromCandidates = fromStationCode ? (this._platformsByCode.get(fromStationCode) || []) : [];
    const toCandidates = toStationCode ? (this._platformsByCode.get(toStationCode) || []) : [];

    let fromIds = fromCandidates;
    let toIds = toCandidates;

    if (!fromIds.length) {
      const ns = nearestStop(this._stops, from);
      fromIds = ns ? [ns._id] : [];
    }
    if (!toIds.length) {
      const ns = nearestStop(this._stops, to);
      toIds = ns ? [ns._id] : [];
    }

    if (!fromIds.length || !toIds.length) return null;

    let best = null;
    for (const a of fromIds) {
      for (const b of toIds) {
        const rail = dijkstra(this._edges, a, b);
        if (rail == null) continue;
        const fromStop = this._stops.get(a);
        const toStop = this._stops.get(b);
        if (!fromStop || !toStop) continue;
        const walk1 = from ? walkSeconds(from, {lat: fromStop.lat, lon: fromStop.lon}) : 0;
        const walk2 = to ? walkSeconds({lat: toStop.lat, lon: toStop.lon}, to) : 0;
        const total = walk1 + this.waitSec + rail + walk2;
        if (!best || total < best.durationSec) {
          best = {
            durationSec: total,
            legs: [
              { mode: 'WALK', route: null, from: 'Origin', to: fromStop.name || a, durationSec: walk1 },
              { mode: 'MTR', route: 'MTR', from: fromStop.name || a, to: toStop.name || b, durationSec: this.waitSec + rail },
              { mode: 'WALK', route: null, from: toStop.name || b, to: 'Destination', durationSec: walk2 }
            ]
          };
        }
      }
    }

    return best;
  }
}

function parseHms(hms) {
  if (!hms) return null;
  const m = String(hms).match(/^(\d+):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = Number(m[3]);
  return h*3600 + mi*60 + s;
}

function addEdge(edges, a, b, w) {
  let m = edges.get(a);
  if (!m) { m = new Map(); edges.set(a, m); }
  const prev = m.get(b);
  if (prev == null || w < prev) m.set(b, w);
}

function nearestStop(stopsMap, p) {
  if (!p) return null;
  let best = null;
  let bestD = Infinity;
  for (const [id, s] of stopsMap.entries()) {
    const d = haversineMeters({lat: s.lat, lon: s.lon}, p);
    if (d < bestD) { bestD = d; best = { ...s, _id: id }; }
  }
  // Only accept within ~1.5km to avoid silly snaps
  if (bestD > 1500) return null;
  return best;
}

function dijkstra(edges, start, goal) {
  if (start === goal) return 0;
  const dist = new Map([[start, 0]]);
  const visited = new Set();
  // naive O(V^2) is fine for smallish graph; still ok
  while (true) {
    let u = null;
    let best = Infinity;
    for (const [k, v] of dist.entries()) {
      if (visited.has(k)) continue;
      if (v < best) { best = v; u = k; }
    }
    if (u == null) return null;
    if (u === goal) return best;
    visited.add(u);
    const neigh = edges.get(u);
    if (!neigh) continue;
    for (const [v, w] of neigh.entries()) {
      const nd = best + w;
      const cur = dist.get(v);
      if (cur == null || nd < cur) dist.set(v, nd);
    }
  }
}
