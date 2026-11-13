import fs from 'node:fs'; import zlib from 'node:zlib';
import { toWorld } from '../akl-frame.mjs';
const load = (n) => JSON.parse(zlib.gunzipSync(fs.readFileSync(`tools/data/osm_${n}.json.gz`)));
const count = (arr, f) => { const m = new Map(); for (const a of arr) { const k = f(a); m.set(k, (m.get(k) || 0) + 1); } return [...m].sort((a, b) => b[1] - a[1]); };
const reg = load('region').elements;
console.log('region:', count(reg, e => e.type + ':' + ((e.tags||{}).highway || (e.tags||{}).leisure || (e.tags||{}).natural || (e.tags||{}).landuse || (e.tags||{}).place || '?')).map(([k, n]) => `${k}:${n}`).join(' '));
const mw = reg.filter(e => e.type === 'way' && e.tags.highway === 'motorway');
console.log('motorway names:', count(mw, w => `${w.tags.name || '-'}|${w.tags.ref||''}`).map(([k, n]) => `${k}:${n}`).join(' | '));
const br = mw.filter(w => w.tags.bridge && Math.abs(toWorld(w.geometry[0].lon, w.geometry[0].lat)[0]) < 4000);
for (const w of br) { const a = toWorld(w.geometry[0].lon, w.geometry[0].lat), b = toWorld(w.geometry.at(-1).lon, w.geometry.at(-1).lat); const L = Math.hypot(a[0]-b[0], a[1]-b[1]); if (L > 150) console.log('bridge', w.tags.name, w.tags['bridge:name'] || '', 'lanes', w.tags.lanes, 'layer', w.tags.layer, a.map(Math.round), b.map(Math.round), Math.round(L)); }
console.log('peaks:', reg.filter(e => e.type === 'node' && /peak|volcano/.test(e.tags.natural || '')).map(e => `${e.tags.name || '?'}:${e.tags.ele || '?'}@${toWorld(e.lon, e.lat).map(Math.round)}`).join(' | '));
console.log('islands:', reg.filter(e => e.type === 'node' && e.tags.place === 'island').map(e => `${e.tags.name}@${toWorld(e.lon, e.lat).map(Math.round)}`).join(' | '));
const b = load('buildings').elements.filter(e => e.tags && e.tags.building && e.tags.name);
const big = b.map(e => { const g = e.geometry || (e.members && e.members[0] && e.members[0].geometry) || []; const p = g[0] ? toWorld(g[0].lon, g[0].lat).map(Math.round) : [0,0]; return [e.tags.name, e.tags.height || (e.tags['building:levels'] ? 'L' + e.tags['building:levels'] : ''), p, e.tags.building, e.tags.tourism || e.tags.amenity || '']; });
const want = /Museum|Ferry|Town Hall|Britomart|Station|Arena|Gallery|Aotea|Civic|Library|Vero|PwC|Commercial Bay|Hospital|Fish Market|Maritime|Hilton|Cloud|Shed|SkyCity|Sky City|Clock|Cathedral|Matthew|Winter|Market|Westfield|University|Stadium|Park Hyatt|Theatre|Viaduct|Bank|Customs|Chief Post|Mosque|Temple|Church/i;
console.log(big.filter(x => want.test(x[0])).map(x => `${x[0]} [${x[1]}] @${x[2]} ${x[3]} ${x[4]}`).join('\n'));
