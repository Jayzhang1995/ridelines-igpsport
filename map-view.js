import { decodePolyline, localYearMonth } from './lib.mjs';
import { Map, setWorkerUrl } from './vendor/maplibre-gl.mjs';
const $ = id => document.getElementById(id);
const state = { rides: [], year: 'all', month: 'all', zoom: 3, center: [35, 105], fitted: false, drag: null };
let renderPending = false;
const map = $('map'), canvas = $('heat'), tiles = $('tiles');
let basemap = null;
function missingCircleIcon(id) {
  const match = /^circle-(\d{1,2})$/.exec(id);
  if (!match) return null;
  const size = Number(match[1]);
  if (size < 3 || size > 32) return null;
  const data = new Uint8ClampedArray(size * size * 4);
  const radius = (size - 1) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = (y * size + x) * 4;
    const alpha = Math.max(0, Math.min(255, Math.round((radius + .5 - Math.hypot(x - radius, y - radius)) * 255)));
    data[offset] = data[offset + 1] = data[offset + 2] = 255;
    data[offset + 3] = alpha;
  }
  return { width: size, height: size, data };
}
try {
  setWorkerUrl(new URL('./vendor/maplibre-gl-worker.mjs', import.meta.url).href);
  basemap = new Map({
    container: tiles,
    style: 'https://tiles.openfreemap.org/styles/dark',
    center: [state.center[1], state.center[0]],
    zoom: state.zoom - 1,
    interactive: false,
    attributionControl: false,
    preserveDrawingBuffer: true
  });
  basemap.setMissingStyleImageResolver(id => {
    const icon = missingCircleIcon(id);
    if (icon) basemap.addImage(id, icon);
  });
  basemap.on('error', error => {
    const detail = error.error || error;
    if (/Image "[^"]+" could not be loaded/.test(String(detail?.message || detail))) return;
    console.warn('底图加载失败', detail);
    $('basemapStatus').classList.remove('hidden');
  });
  basemap.on('load', () => $('basemapStatus').classList.add('hidden'));
} catch (error) {
  console.warn('底图初始化失败', error);
  $('basemapStatus').classList.remove('hidden');
}

function project([lat, lon], zoom) {
  const size = 256 * 2 ** zoom;
  const bounded = Math.max(-85.0511, Math.min(85.0511, lat));
  const sine = Math.sin(bounded * Math.PI / 180);
  return [(lon + 180) / 360 * size, (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * size];
}
function unproject([x, y], zoom) {
  const size = 256 * 2 ** zoom;
  return [Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI, x / size * 360 - 180];
}
function visibleRides() { return state.rides.filter(ride => { const [year, month] = localYearMonth(ride.date); return (state.year === 'all' || year === state.year) && (state.month === 'all' || month === state.month); }); }
function routePoints(ride) {
  if (!ride._points) { try { ride._points = decodePolyline(ride.polyline || ''); } catch { ride._points = []; } }
  return ride._points;
}
function scheduleRender() { if (renderPending) return; renderPending = true; requestAnimationFrame(() => { renderPending = false; render(); }); }
function render() {
  const width = map.clientWidth, height = map.clientHeight;
  if (!width || !height) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const center = project(state.center, state.zoom), left = center[0] - width / 2, top = center[1] - height / 2;
  basemap?.resize();
  basemap?.jumpTo({ center: [state.center[1], state.center[0]], zoom: state.zoom - 1 });
  drawGrid(ctx, left, top, width, height);
  ctx.globalCompositeOperation = 'screen';
  const rides = visibleRides();
  for (const ride of rides) {
    const points = routePoints(ride); if (points.length < 2) continue;
    const path = new Path2D(); let started = false, previous = null;
    for (const point of points) {
      const projected = project(point, state.zoom), x = projected[0] - left, y = projected[1] - top;
      if (previous && Math.hypot(x - previous[0], y - previous[1]) > 240) started = false;
      if (!started) { path.moveTo(x, y); started = true; } else path.lineTo(x, y);
      previous = [x, y];
    }
    ctx.strokeStyle = 'rgba(255,85,32,.18)'; ctx.lineWidth = 8; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke(path);
    ctx.strokeStyle = 'rgba(255,116,44,.44)'; ctx.lineWidth = 2.2; ctx.stroke(path);
    ctx.strokeStyle = 'rgba(255,218,101,.31)'; ctx.lineWidth = .7; ctx.stroke(path);
  }
  $('empty').classList.toggle('hidden', rides.some(ride => routePoints(ride).length > 1));
}
function drawGrid(ctx, left, top, width, height) {
  const degreesAcross = width * 360 / (256 * 2 ** state.zoom);
  const raw = degreesAcross / 6, base = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].find(n => n * base >= raw) * base;
  const west = unproject([left, top], state.zoom)[1], east = unproject([left + width, top], state.zoom)[1];
  const north = unproject([left, top], state.zoom)[0], south = unproject([left, top + height], state.zoom)[0];
  ctx.strokeStyle = 'rgba(180,213,177,.11)'; ctx.fillStyle = 'rgba(189,218,183,.27)'; ctx.lineWidth = 1;
  ctx.font = '10px IBM Plex Mono, monospace';
  for (let lon = Math.ceil(west / step) * step; lon <= east; lon += step) {
    const x = project([0, lon], state.zoom)[0] - left;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    ctx.fillText(`${lon.toFixed(step < 1 ? 2 : 0)}°`, x + 5, height - 14);
  }
  for (let lat = Math.ceil(south / step) * step; lat <= north; lat += step) {
    const y = project([lat, 0], state.zoom)[1] - top;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    ctx.fillText(`${lat.toFixed(step < 1 ? 2 : 0)}°`, 10, y - 5);
  }
}
function fitRoutes() {
  const points = visibleRides().flatMap(routePoints);
  if (!points.length) return;
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lat, lon] of points) { minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon); }
  const width = Math.max(map.clientWidth - 100, 200), height = Math.max(map.clientHeight - 100, 200);
  for (let zoom = 13; zoom >= 2; zoom--) {
    const a = project([minLat, minLon], zoom), b = project([maxLat, maxLon], zoom);
    if (Math.abs(b[0] - a[0]) <= width && Math.abs(a[1] - b[1]) <= height) { state.zoom = zoom; break; }
  }
  state.center = [(minLat + maxLat) / 2, (minLon + maxLon) / 2];
  state.fitted = true; scheduleRender();
}
function updateFilters() {
  const years = [...new Set(state.rides.map(ride => localYearMonth(ride.date)[0]).filter(Boolean))].sort((a,b) => b-a);
  if (state.year !== 'all' && !years.includes(state.year)) state.year = 'all';
  $('yearList').replaceChildren();
  for (const value of ['all', ...years]) {
    const button = document.createElement('button'); button.textContent = value === 'all' ? '全部记录' : value;
    button.classList.toggle('selected', state.year === value); button.onclick = () => { state.year = value; state.month = 'all'; updateFilters(); fitRoutes(); };
    $('yearList').append(button);
  }
  const available = new Set(state.rides.filter(ride => state.year === 'all' || localYearMonth(ride.date)[0] === state.year).map(ride => localYearMonth(ride.date)[1]));
  $('monthList').replaceChildren();
  for (const month of ['all', ...Array.from({length:12},(_,i)=>i+1)]) {
    const button = document.createElement('button'); button.textContent = month === 'all' ? '全年' : String(month).padStart(2,'0');
    button.disabled = month !== 'all' && !available.has(month); button.classList.toggle('selected', state.month === month);
    button.onclick = () => { state.month = month; updateFilters(); fitRoutes(); };
    $('monthList').append(button);
  }
  updateSummary(); scheduleRender();
}
function updateSummary() {
  const rides = visibleRides(); const tracked = rides.filter(ride => routePoints(ride).length > 1);
  const period = state.year === 'all' ? (state.month === 'all' ? '全部时间' : `所有年份 · ${state.month}月`) : `${state.year}年${state.month === 'all' ? '' : ` · ${state.month}月`}`;
  $('periodLabel').textContent = period; $('mapTitle').textContent = state.year === 'all' && state.month === 'all' ? '每一程，都有迹可循。' : `${period} · 骑行轨迹`;
  $('mapTag').textContent = state.year === 'all' && state.month === 'all' ? 'ALL RIDES' : `${state.year === 'all' ? 'ALL YEARS' : state.year} / ${state.month === 'all' ? 'ALL MONTHS' : String(state.month).padStart(2,'0')}`;
  $('rideCount').textContent = rides.length.toLocaleString(); $('distance').textContent = (rides.reduce((sum, ride) => sum + ride.distance, 0)/1000).toLocaleString('zh-CN',{maximumFractionDigits:0}); $('trackCount').textContent = tracked.length.toLocaleString();
  const missing = rides.length - tracked.length;
  $('missingHint').textContent = missing ? `${missing} 条记录暂无 GPS 轨迹，未画在地图上。` : '';
  $('bottomInfo').textContent = rides.length ? `当前展示 ${rides.length} 次骑行 · ${tracked.length} 条可绘制轨迹` : '选择年份与月份，查看那段时间走过的路。';
}

function zoom(delta) { state.zoom = Math.max(2, Math.min(17, state.zoom + delta)); scheduleRender(); }
map.addEventListener('pointerdown', event => { if (event.target.closest('button')) return; state.drag = { x:event.clientX, y:event.clientY, center: project(state.center,state.zoom) }; map.setPointerCapture(event.pointerId); map.classList.add('dragging'); });
map.addEventListener('pointermove', event => { if (!state.drag) return; state.center = unproject([state.drag.center[0] - (event.clientX - state.drag.x), state.drag.center[1] - (event.clientY - state.drag.y)],state.zoom); scheduleRender(); });
map.addEventListener('pointerup', () => { state.drag = null; map.classList.remove('dragging'); });
map.addEventListener('wheel', event => { event.preventDefault(); zoom(event.deltaY < 0 ? 1 : -1); }, { passive:false });
$('zoomIn').onclick = () => zoom(1); $('zoomOut').onclick = () => zoom(-1); $('fitButton').onclick = fitRoutes;
$('downloadButton').onclick = () => { try { const output = document.createElement('canvas'); output.width = canvas.width; output.height = canvas.height; const ctx=output.getContext('2d'); if (basemap) ctx.drawImage(basemap.getCanvas(),0,0,output.width,output.height);ctx.drawImage(canvas,0,0,output.width,output.height); const a=document.createElement('a');a.download=`骑行热力图-${state.year}-${state.month}.png`;a.href=output.toDataURL('image/png');a.click(); } catch { $('bottomInfo').textContent='地图暂时无法导出，请检查网络后重试。'; } };
new ResizeObserver(scheduleRender).observe(map);
export function setRides(rides) { state.rides = rides; state.fitted = false; updateFilters(); if (rides.length) fitRoutes(); }
setRides([]);
