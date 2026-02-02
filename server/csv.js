// Minimal CSV parser that handles quoted fields + commas.
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(l => l.length);
  if (!lines.length) return [];
  const header = splitLine(lines[0]);
  const rows = [];
  for (const line of lines.slice(1)) {
    const cols = splitLine(line);
    const row = {};
    for (let i=0;i<header.length;i++) row[header[i]] = cols[i] ?? '';
    rows.push(row);
  }
  return rows;
}

function splitLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i=0;i<line.length;i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i+1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') { out.push(cur); cur=''; }
      else if (ch === '"') inQ = true;
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}
