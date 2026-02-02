import express from 'express';
import fetch from 'node-fetch';
import { MtrRouter } from './mtr.js';

const app = express();
app.use(express.json({limit: '1mb'}));

const OTP_BASE_URL = process.env.OTP_BASE_URL || 'http://localhost:8080';
const NOMINATIM_BASE_URL = process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org';
const MTR_GTFS_URL = process.env.MTR_GTFS_URL || 'https://feed.justusewheels.com/hk.gtfs.zip';

const mtr = new MtrRouter({
  gtfsUrl: MTR_GTFS_URL,
  waitSec: Number(process.env.MTR_WAIT_SEC || 60),
  xferSec: Number(process.env.MTR_XFER_SEC || 120),
  tstEtsSec: Number(process.env.MTR_TST_ETS_SEC || 420)
});

const MTR_PENALTY_SEC = Number(process.env.MTR_PENALTY_SEC || 300); // discourage all-MTR solutions


// Simple, static UI
app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="zh-HK">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>香港公共交通最佳順序（OTP + TSP）</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;margin:20px;line-height:1.5;}
  textarea{width:100%;min-height:140px;}
  button{padding:10px 12px;font-weight:700;}
  .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:10px 0;}
  pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto;}
  .hint{color:#555;font-size:13px;}
  .out{background:#f6f8fa;padding:12px;border-radius:8px;white-space:pre-wrap;}
  .seg{margin:10px 0;padding:10px;border:1px solid #eee;border-radius:10px;}
  .seg-title{font-weight:800;}
  .muted{color:#555;font-size:13px;}
</style>
</head>
<body>
<h2>香港公共交通最佳順序（黃大仙出發）</h2>
<div class="hint">輸入 5 個地點（每行一個）。系統會用 OpenTripPlanner 計算公共交通時間矩陣，然後用暴力枚舉（5!=120）找最短總時間順序。</div>
<div class="row">
  <label>出發點：</label>
  <input id="origin" value="Wong Tai Sin Station, Hong Kong" style="flex:1;min-width:220px;" />
  <button id="btn">計算</button>
</div>
<textarea id="dest">大埔中心\n沙田好運中心\n尖沙咀碼頭\n觀塘 apm\n藍田匯景</textarea>
<div id="out" class="out">(結果會喺呢度顯示)</div>
<details style="margin-top:12px;">
  <summary>顯示原始 JSON</summary>
  <pre id="raw"></pre>
</details>
<script src="/app.js"></script>
</body>
</html>`);
});

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

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

function walkPlan(from, to) {
  const distM = haversineMeters(from, to);
  // Assume 1.2 m/s walking speed
  const durationSec = Math.round(distM / 1.2);
  return {
    durationSec,
    legs: [
      { mode: 'WALK', route: null, from: 'Origin', to: 'Destination', durationSec }
    ]
  };
}


const FIXED_STATIONS = {
  // MTR station codes (used to select platform stops in GTFS)
  'Wong Tai Sin Station, Hong Kong': 'WTS',
  '黃大仙': 'WTS',
  '黃大仙站': 'WTS',
  '黃大仙站A2': 'WTS',

  'apm, Kwun Tong, Hong Kong': 'KWT',
  'apm, Kwun Tong': 'KWT',
  '觀塘 apm': 'KWT',

  'Sceneway Garden, Lam Tin, Hong Kong': 'LAT',
  'Sceneway Garden, Lam Tin': 'LAT',
  '匯景花園': 'LAT',
  '藍田匯景': 'LAT',

  '尖沙咀碼頭': 'ETS',
  'Tsim Sha Tsui Ferry Pier, Hong Kong': 'ETS',

  '沙田好運中心': 'SHT',
  'Lucky Plaza, Sha Tin, Hong Kong': 'SHT',

  '大埔中心': 'TAP',
  'Tai Po Centre, Hong Kong': 'TAP'
};

async function geocode(q) {
  const url = new URL('/search', NOMINATIM_BASE_URL);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');
  url.searchParams.set('q', q);

  const res = await fetch(url, {
    headers: {
      // Nominatim requires a valid User-Agent
      'User-Agent': 'hk-transit-optimizer/0.1 (contact: local)',
      'Accept': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`geocode failed: ${res.status}`);
  const arr = await res.json();
  if (!arr?.length) throw new Error(`geocode no results for: ${q}`);
  return {
    lat: Number(arr[0].lat),
    lon: Number(arr[0].lon),
    display: arr[0].display_name
  };
}

async function resolvePoint(_label, query) {
  // Keep POI coordinates for bus routing; stationId is used separately for MTR fallback.
  return geocode(query);
}

function stationIdFor(label, query) {
  return FIXED_STATIONS[label] || FIXED_STATIONS[query] || null;
}

async function otpPlan(from, to) {
  // OTP /plan (bus-only graph)
  const url = new URL('/otp/routers/default/plan', OTP_BASE_URL);
  url.searchParams.set('fromPlace', `${from.lat},${from.lon}`);
  url.searchParams.set('toPlace', `${to.lat},${to.lon}`);
  url.searchParams.set('mode', 'WALK,TRANSIT');
  url.searchParams.set('numItineraries', '3');
  const now = new Date();
  url.searchParams.set('date', now.toISOString().slice(0,10));
  url.searchParams.set('time', '12:00');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) throw new Error(`otp plan failed: ${res.status} ${String(text).slice(0,200)}`);
  const itins = json?.plan?.itineraries || [];
  if (!itins.length) throw new Error(`otp no itinerary`);
  const itin = itins.reduce((best, cur) => (!best || cur.duration < best.duration ? cur : best), null);
  return {
    durationSec: itin.duration,
    legs: itin.legs?.map(l => ({
      mode: l.mode,
      route: l.routeShortName || l.routeLongName || null,
      from: l.from?.name || null,
      to: l.to?.name || null,
      durationSec: l.duration
    })) || []
  };
}

function permutations(arr) {
  // Heap's algorithm (small n)
  const res = [];
  const a = arr.slice();
  const c = Array(a.length).fill(0);
  res.push(a.slice());
  let i = 0;
  while (i < a.length) {
    if (c[i] < i) {
      if (i % 2 === 0) {
        [a[0], a[i]] = [a[i], a[0]];
      } else {
        [a[c[i]], a[i]] = [a[i], a[c[i]]];
      }
      res.push(a.slice());
      c[i] += 1;
      i = 0;
    } else {
      c[i] = 0;
      i += 1;
    }
  }
  return res;
}

app.get('/app.js', (_req, res) => {
  // Note: Avoid JS template literals here to prevent escaping bugs.
  res.type('js').send(
    "(function(){\n" +
    "  const btn = document.getElementById('btn');\n" +
    "  const out = document.getElementById('out');\n" +
    "  const raw = document.getElementById('raw');\n\n" +
    "  function secToMin(s){ return Math.round((Number(s)||0)/60); }\n\n" +
    "  function summarizeLegs(legs){\n" +
    "    if (!Array.isArray(legs) || legs.length === 0) return '（無明細）';\n" +
    "    return legs.map(function(l){\n" +
    "      if (!l) return '';\n" +
    "      if (l.mode === 'WALK') return '步行';\n" +
    "      if (l.route) return (l.mode + ' ' + l.route);\n" +
    "      return l.mode || '';\n" +
    "    }).filter(Boolean).join(' → ');\n" +
    "  }\n\n" +
    "  function render(result){\n" +
    "    raw.textContent = JSON.stringify(result, null, 2);\n\n" +
    "    const lines = [];\n" +
    "    lines.push('最佳次序（總時間約 ' + result.totalMin + ' 分鐘）');\n" +
    "    lines.push('');\n" +
    "    (result.order||[]).forEach(function(name, idx){\n" +
    "      lines.push((idx+1) + ') ' + name);\n" +
    "    });\n" +
    "    lines.push('');\n" +
    "    lines.push('每段：');\n\n" +
    "    const segs = result.segments || [];\n" +
    "    for (const seg of segs) {\n" +
    "      lines.push('');\n" +
    "      lines.push('• ' + seg.from + ' → ' + seg.to + '（約 ' + seg.durationMin + ' 分鐘）');\n" +
    "      lines.push('  ' + summarizeLegs(seg.legs));\n" +
    "      if (Array.isArray(seg.legs) && seg.legs.length) {\n" +
    "        for (const l of seg.legs) {\n" +
    "          const label = (l.mode === 'WALK') ? '步行' : (l.route ? (l.mode + ' ' + l.route) : (l.mode||''));\n" +
    "          lines.push('    - ' + label + '：' + secToMin(l.durationSec) + ' 分');\n" +
    "        }\n" +
    "      }\n" +
    "    }\n\n" +
    "    out.textContent = lines.join('\\n');\n" +
    "  }\n\n" +
    "  btn.onclick = async function(){\n" +
    "    try {\n" +
    "      btn.disabled = true;\n" +
    "      out.textContent = '計算中…（第一次可能較慢，約 10–60 秒）';\n" +
    "      raw.textContent = '';\n" +
    "      const origin = document.getElementById('origin').value.trim() || 'Wong Tai Sin Station, Hong Kong';\n" +
    "      const dest = document.getElementById('dest').value.split(/\\n+/).map(function(s){return s.trim();}).filter(Boolean);\n" +
    "      if (dest.length !== 5) {\n" +
    "        out.textContent = '請輸入 5 個地點（每行一個）。目前：' + dest.length;\n" +
    "        return;\n" +
    "      }\n" +
    "      const res = await fetch('/api/optimize', {\n" +
    "        method: 'POST',\n" +
    "        headers: { 'Content-Type': 'application/json' },\n" +
    "        body: JSON.stringify({ origin: origin, destinations: dest })\n" +
    "      });\n" +
    "      const text = await res.text();\n" +
    "      if (!res.ok) {\n" +
    "        out.textContent = 'API error ' + res.status + ':\\n' + text;\n" +
    "        return;\n" +
    "      }\n" +
    "      render(JSON.parse(text));\n" +
    "    } catch (e) {\n" +
    "      out.textContent = '前端錯誤：' + (e && e.stack ? e.stack : e);\n" +
    "    } finally {\n" +
    "      btn.disabled = false;\n" +
    "    }\n" +
    "  };\n" +
    "})();\n"
  );
});

app.post('/api/optimize', async (req, res) => {
  try {
    const { origin, destinations } = req.body || {};
    if (!origin || !Array.isArray(destinations) || destinations.length !== 5) {
      return res.status(400).json({error: 'Need origin + exactly 5 destinations'});
    }

    // Guard against duplicates (common copy/paste issue)
    const counts = new Map();
    for (const d of destinations) counts.set(d, (counts.get(d) || 0) + 1);
    const dups = [...counts.entries()].filter(([,c]) => c > 1);
    if (dups.length) {
      return res.status(400).json({
        error: 'Destinations must be 5 UNIQUE places (no duplicates).',
        duplicates: dups.map(([k,c]) => ({ place: k, count: c }))
      });
    }

    const ALIASES = {
      // Start
      '黃大仙站A2': 'Wong Tai Sin Station, Hong Kong',
      '黃大仙站': 'Wong Tai Sin Station, Hong Kong',
      // Destinations
      '大埔中心': 'Tai Po Centre, Hong Kong',
      '沙田好運中心': 'Lucky Plaza, Sha Tin, Hong Kong',
      '尖沙咀碼頭': 'Tsim Sha Tsui Ferry Pier, Hong Kong',
      '觀塘 apm': 'apm Kwun Tong, Hong Kong',
      '觀塘APM': 'apm Kwun Tong, Hong Kong',
      '藍田匯景': 'Sceneway Garden, Lam Tin, Hong Kong'
    };

    // Geocode all points (rate-limit friendly)
    const labels = [origin, ...destinations];
    const points = [];
    for (const label of labels) {
      const q = ALIASES[label] || label;
      const p = await resolvePoint(label, q);
      const stationId = stationIdFor(label, q);
      points.push({ label, query: q, stationId, ...p });
      await sleep(350); // be gentle to Nominatim
    }

    // Build duration matrix using OTP (6x6)
    const n = points.length;
    const matrix = Array.from({length:n}, () => Array(n).fill(0));
    const legsMap = {}; // key i-j => legs

    for (let i=0;i<n;i++) {
      for (let j=0;j<n;j++) {
        if (i===j) continue;
        const key = `${i}-${j}`;
        // Hybrid: consider walking, bus via OTP, and MTR via GTFS graph.
        let bestPlan = null;

        // 0) Walking-only candidate for very close points (or when everything else is bad)
        const walk = walkPlan(points[i], points[j]);
        // If within ~1.2km, strongly prefer walking.
        const distM = haversineMeters(points[i], points[j]);
        if (distM <= 1200) bestPlan = walk;

        // 1) Bus/other via OTP (may fail for some OD pairs)
        try {
          const p1 = await otpPlan(points[i], points[j]);
          if (!bestPlan || p1.durationSec < bestPlan.durationSec) bestPlan = p1;
        } catch (_e) {
          // ignore
        }

        // 2) MTR option (only if both have stationId)
        if (points[i].stationId && points[j].stationId) {
          try {
            // If same station code, don't force MTR; walking within station is more realistic.
            if (points[i].stationId === points[j].stationId) {
              // keep bestPlan as-is (likely walk)
            } else {
              const p2raw = await mtr.plan({
                from: { lat: points[i].lat, lon: points[i].lon },
                to: { lat: points[j].lat, lon: points[j].lon },
                fromStationCode: points[i].stationId,
                toStationCode: points[j].stationId
              });
              if (p2raw) {
                // Apply penalty so the optimizer won't choose MTR for every leg unless it's clearly faster.
                const extra = MTR_PENALTY_SEC + (
                  ((points[i].stationId === 'LAT' && points[j].stationId === 'ETS') || (points[i].stationId === 'ETS' && points[j].stationId === 'LAT'))
                    ? 300
                    : 0
                );
                const p2 = { ...p2raw, durationSec: p2raw.durationSec + extra };
                if (!bestPlan || p2.durationSec < bestPlan.durationSec) bestPlan = p2;
              }
            }
          } catch (_e) {
            // ignore
          }
        }

        // Fallback: allow walking even if far, if OTP is down and MTR not available.
        if (!bestPlan) bestPlan = walk;

        matrix[i][j] = Math.round(bestPlan.durationSec);
        legsMap[key] = bestPlan.legs;
        await sleep(80);
      }
    }

    // Solve best order visiting 1..5 starting at 0 (no return)
    const destIdx = [1,2,3,4,5];
    let best = null;
    for (const perm of permutations(destIdx)) {
      let sum = 0;
      let prev = 0;
      for (const k of perm) {
        sum += matrix[prev][k];
        prev = k;
      }
      if (!best || sum < best.totalSec) best = { order: [0, ...perm], totalSec: sum };
    }

    // Build detailed legs for best order
    const segments = [];
    for (let t=0;t<best.order.length-1;t++) {
      const i = best.order[t];
      const j = best.order[t+1];
      segments.push({
        from: points[i].label,
        to: points[j].label,
        durationMin: Math.round(matrix[i][j]/60),
        legs: legsMap[`${i}-${j}`] || []
      });
    }

    res.json({
      origin: points[0],
      destinations: points.slice(1),
      order: best.order.map(i => points[i].label),
      totalMin: Math.round(best.totalSec/60),
      segments,
      notes: [
        'This requires OTP to be built with Hong Kong GTFS + OSM data.',
        'If OTP has no transit data, results will degrade to walking-only.'
      ]
    });
  } catch (e) {
    res.status(500).json({error: String(e)});
  }
});

app.listen(3000, () => {
  console.log('server listening on :3000');
});
