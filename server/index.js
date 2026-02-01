import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json({limit: '1mb'}));

const OTP_BASE_URL = process.env.OTP_BASE_URL || 'http://localhost:8080';
const NOMINATIM_BASE_URL = process.env.NOMINATIM_BASE_URL || 'https://nominatim.openstreetmap.org';

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
<pre id="out">(結果會喺呢度顯示)</pre>
<script>
  const btn=document.getElementById('btn');
  const out=document.getElementById('out');
  btn.onclick=async()=>{
    out.textContent='計算中…（第一次可能較慢）';
    const origin=document.getElementById('origin').value.trim() || 'Wong Tai Sin Station, Hong Kong';
    const dest=document.getElementById('dest').value.split(/\n+/).map(s=>s.trim()).filter(Boolean);
    const res=await fetch('/api/optimize',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({origin, destinations: dest})});
    const json=await res.json();
    out.textContent=JSON.stringify(json,null,2);
  };
</script>
</body>
</html>`);
});

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

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

async function otpPlan(from, to) {
  // OTP /plan
  const url = new URL('/otp/routers/default/plan', OTP_BASE_URL);
  url.searchParams.set('fromPlace', `${from.lat},${from.lon}`);
  url.searchParams.set('toPlace', `${to.lat},${to.lon}`);
  url.searchParams.set('mode', 'WALK,TRANSIT');
  url.searchParams.set('numItineraries', '1');
  // Use current time (OTP needs a date/time)
  const now = new Date();
  url.searchParams.set('date', now.toISOString().slice(0,10));
  url.searchParams.set('time', now.toTimeString().slice(0,5));

  const res = await fetch(url);
  const json = await res.json();
  if (!res.ok) throw new Error(`otp plan failed: ${res.status} ${JSON.stringify(json).slice(0,200)}`);
  const itin = json?.plan?.itineraries?.[0];
  if (!itin) throw new Error(`otp no itinerary`);
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

app.post('/api/optimize', async (req, res) => {
  try {
    const { origin, destinations } = req.body || {};
    if (!origin || !Array.isArray(destinations) || destinations.length !== 5) {
      return res.status(400).json({error: 'Need origin + exactly 5 destinations'});
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
      '藍田匯景': 'Laguna City, Hong Kong'
    };

    // Geocode all points (rate-limit friendly)
    const labels = [origin, ...destinations];
    const points = [];
    for (const label of labels) {
      const q = ALIASES[label] || label;
      const p = await geocode(q);
      points.push({ label, query: q, ...p });
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
        const plan = await otpPlan(points[i], points[j]);
        matrix[i][j] = Math.round(plan.durationSec);
        legsMap[key] = plan.legs;
        await sleep(120);
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
