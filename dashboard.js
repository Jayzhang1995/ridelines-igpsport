import { encodePolyline } from './lib.mjs';
import { getFolder, setFolder, readRides, writeRide } from './folder-store.js';
import { setRides } from './map-view.js';

const $ = id => document.getElementById(id);
const IGPS_HOME = 'https://app.igpsport.cn/user/home';
let folder = null;
let rides = [];
let busy = false;
let lastSync = 0;
let loginState = 'checking';
let folderReady = false;

function message(value) { $('syncStatus').textContent = value; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function findIgpsTab() {
  const tabs = await chrome.tabs.query({ url: 'https://app.igpsport.cn/*' });
  return tabs.find(tab => tab.url?.startsWith('https://app.igpsport.cn/user/home')) || tabs[0] || null;
}

function updateSetupGuide() {
  $('setupGuide').textContent = loginState === 'ready'
    ? folderReady ? '已就绪：打开本页自动检查新骑行。' : '下一步：选择本地文件夹。'
    : loginState === 'checking' ? '正在检查 iGPSPORT 登录状态…' : '下一步：在 iGPSPORT 网页完成登录。';
}

async function refreshLoginState() {
  try {
    const tab = await findIgpsTab();
    if (!tab?.id) {
      loginState = 'missing';
      $('loginStatus').textContent = '未找到 iGPSPORT 标签页';
      $('openIgps').firstChild.textContent = '打开 iGPSPORT 登录 ';
      $('loginHint').textContent = '打开网页登录后返回本页。';
    } else {
      const status = await pageStatus(tab.id);
      if (status.url.startsWith(IGPS_HOME) && status.ready === 'complete') {
        loginState = 'ready';
        $('loginStatus').textContent = '已登录 · 当前 Chrome 网页可用';
        $('openIgps').firstChild.textContent = '查看已登录的 iGPSPORT ';
        $('loginHint').textContent = '已登录，无需重复打开。';
      } else {
        loginState = 'login';
        $('loginStatus').textContent = status.ready === 'complete' ? '已打开网页 · 请完成登录' : '正在等待 iGPSPORT 网页加载';
        $('openIgps').firstChild.textContent = '继续登录 iGPSPORT ';
        $('loginHint').textContent = '网页已打开，点击按钮可切换过去。';
      }
    }
  } catch (error) {
    loginState = 'missing';
    $('loginStatus').textContent = '暂时无法检查登录状态';
    $('openIgps').firstChild.textContent = '打开 iGPSPORT ';
    $('loginHint').textContent = '可点击按钮查看 iGPSPORT 网页。';
  }
  $('igpsDot').classList.toggle('on', loginState === 'ready');
  updateSetupGuide();
}

async function pageCall(tabId, func, args = []) {
  const result = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args });
  const value = result[0]?.result;
  if (!value) throw new Error('iGPSPORT 页面没有返回数据，请刷新其网页后重试');
  if (value.error) throw new Error(value.error);
  return value;
}

async function pageStatus(tabId) {
  return pageCall(tabId, () => ({ url: location.href, ready: document.readyState }));
}

async function queryPage(tabId, pageNo) {
  return pageCall(tabId, async page => {
    try {
      const entry = [...document.scripts].find(item => item.type === 'module' && /\/assets\/js\/[^/]+\.js$/.test(item.src));
      if (!entry) return { error: 'iGPSPORT 网页模块未加载；请确认已登录并刷新页面' };
      const site = await import(entry.src);
      if (!site.a3?.get) return { error: 'iGPSPORT 网页接口已变化，需要更新扩展' };
      if (page === 1 && typeof site.a4 === 'function') await site.a4();
      const data = await site.a3.get('/web-analyze/activity/queryMyActivity', { pageNo: page, pageSize: 50, reqType: 0, sort: 1, sortType: 1 });
      if (!Array.isArray(data?.rows)) return { error: 'iGPSPORT 活动列表格式不正确，请确认已登录' };
      return {
        total: Number(data.totalRows) || 0,
        seen: data.rows.length,
        rows: data.rows.map(row => ({
          id: String(row.rideId || ''), type: Number(row.exerciseType),
          name: String(row.title || 'iGPSPORT 骑行').slice(0, 160),
          date: String(row.startTime || '').replace(/[./]/g, '-').slice(0, 32),
          distance: Math.max(0, Number(row.rideDistance) || 0),
          duration: Math.max(0, Number(row.movingTime) || 0)
        }))
      };
    } catch (error) { return { error: error.message }; }
  }, [pageNo]);
}

async function downloadGpx(tabId, id) {
  return pageCall(tabId, async rideId => {
    try {
      const entry = [...document.scripts].find(item => item.type === 'module' && /\/assets\/js\/[^/]+\.js$/.test(item.src));
      if (!entry) return { error: 'iGPSPORT 网页模块未加载' };
      const site = await import(entry.src);
      if (typeof site.a5 !== 'function') return { error: 'iGPSPORT 签名接口已变化' };
      const url = `https://prod.zh.igpsport.com/service/web-gateway/web-analyze/activity/exportGpx/${encodeURIComponent(rideId)}`;
      for (let attempt = 0; attempt < 3; attempt++) {
        const headers = await site.a5({ method: 'GET', url });
        const response = await fetch(url, { method: 'GET', headers, credentials: 'include' });
        if (response.ok) return { gpx: await response.text() };
        if (response.status === 404) return { gpx: '' };
        if (response.status === 403 && attempt === 0 && typeof site.a4 === 'function') await site.a4();
        else if (![403, 429, 502, 503, 504].includes(response.status) || attempt === 2) return { error: `GPX 下载失败 (${response.status})` };
        await new Promise(resolve => setTimeout(resolve, 1500 * 2 ** attempt));
      }
      return { gpx: '' };
    } catch (error) { return { error: error.message }; }
  }, [id]);
}

function gpxPoints(gpx) {
  if (!gpx) return [];
  const xml = new DOMParser().parseFromString(gpx, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('iGPSPORT 返回的 GPX 文件格式错误');
  let entries = [...xml.getElementsByTagNameNS('*', 'trkpt')];
  if (!entries.length) entries = [...xml.getElementsByTagNameNS('*', 'rtept')];
  const points = entries.map(item => [Number(item.getAttribute('lat')), Number(item.getAttribute('lon'))])
    .filter(point => Number.isFinite(point[0]) && Number.isFinite(point[1]) && Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180);
  if (points.length <= 250000) return points;
  const stride = Math.ceil(points.length / 250000);
  return points.filter((_, index) => index % stride === 0 || index === points.length - 1);
}

async function openFolder() {
  // The picker must be called directly from the user's click.
  const selected = await window.showDirectoryPicker({ mode: 'readwrite', startIn: 'documents' });
  folder = selected;
  await setFolder(selected);
  rides = await readRides(selected);
  setRides(rides);
  $('folderName').textContent = `保存位置：${selected.name} · ${rides.length} 条记录`;
  folderReady = true;
  updateSetupGuide();
  $('syncNow').disabled = false;
  message('文件夹已就绪。正在检查 iGPSPORT 登录状态…');
  await sync();
}

async function sync() {
  if (busy || !folder) return;
  busy = true;
  $('syncNow').disabled = true;
  $('pickFolder').disabled = true;
  try {
    if (await folder.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      folderReady = false;
      updateSetupGuide();
      message('需要重新授权文件夹：请点击“选择本地文件夹”。');
      return;
    }
    const tab = await findIgpsTab();
    if (!tab?.id) { await refreshLoginState(); message('请先打开 iGPSPORT 并登录，登录后会自动同步。'); return; }
    const status = await pageStatus(tab.id);
    if (!status.url.startsWith('https://app.igpsport.cn/') || /\/login(?:[/?#]|$)/.test(status.url) || status.ready !== 'complete') {
      await refreshLoginState();
      message('请在 iGPSPORT 标签页完成登录，返回本页后会自动同步。');
      return;
    }
    await refreshLoginState();
    const known = new Map(rides.map((ride, index) => [ride.id, index]));
    let page = 1, seen = 0, total = Infinity, saved = 0, failed = 0;
    while (seen < total) {
      const result = await queryPage(tab.id, page++);
      total = result.total;
      if (!result.seen) break;
      seen += result.seen;
      for (const item of result.rows) {
        if (item.type !== 0 || !/^\d{1,20}$/.test(item.id)) continue;
        const key = `igps:${item.id}`;
        if (known.has(key) && rides[known.get(key)].polyline) continue;
        let gpx = '', points = [];
        try {
          const result = await downloadGpx(tab.id, item.id);
          if (result.error) throw new Error(result.error);
          gpx = result.gpx || '';
          points = gpxPoints(gpx);
        } catch (error) { gpx = ''; failed++; console.warn('GPX 下载失败', item.id, error); }
        const ride = { id: key, source: 'igps', name: item.name, date: item.date,
          distance: item.distance, duration: item.duration,
          polyline: points.length > 1 ? encodePolyline(points) : '', detailed: true };
        rides = await writeRide(folder, rides, ride, gpx);
        known.set(key, rides.findIndex(value => value.id === key));
        saved++;
        message(`正在检查 ${seen}/${total} 条运动 · 已保存 ${saved} 条骑行${failed ? ` · ${failed} 条轨迹下载失败` : ''}`);
        if (saved % 10 === 0) setRides(rides.slice());
        await sleep(300);
      }
      if (result.seen < 50) break;
    }
    lastSync = Date.now();
    setRides(rides.slice());
    $('folderName').textContent = `保存位置：${folder.name} · ${rides.length} 条记录`;
    message(`同步完成：检查 ${seen} 条运动，本次保存 ${saved} 条骑行${failed ? `；${failed} 条 GPX 待重试` : ''}。`);
  } catch (error) {
    message(`同步失败：${error.message}`);
  } finally {
    busy = false;
    $('syncNow').disabled = !folder;
    $('pickFolder').disabled = false;
  }
}

$('pickFolder').addEventListener('click', () => openFolder().catch(error => {
  if (error.name !== 'AbortError') message(`无法使用文件夹：${error.message}`);
}));
$('openIgps').addEventListener('click', async () => {
  try {
    const tab = await findIgpsTab();
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    } else {
      await chrome.tabs.create({ url: IGPS_HOME });
    }
    await refreshLoginState();
  } catch (error) { message(`无法打开 iGPSPORT：${error.message}`); }
});
$('syncNow').addEventListener('click', () => sync());
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.startsWith('https://app.igpsport.cn/')) {
    refreshLoginState();
    if (Date.now() - lastSync > 30000) sync();
  }
});
chrome.tabs.onRemoved.addListener(() => refreshLoginState());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    refreshLoginState();
    if (Date.now() - lastSync > 30000) sync();
  }
});
setInterval(() => sync(), 60 * 60 * 1000);

try {
  await refreshLoginState();
  folder = await getFolder();
  if (folder && await folder.queryPermission({ mode: 'readwrite' }) === 'granted') {
    folderReady = true;
    updateSetupGuide();
    rides = await readRides(folder);
    setRides(rides);
    $('folderName').textContent = `保存位置：${folder.name} · ${rides.length} 条记录`;
    $('syncNow').disabled = false;
    await sync();
  } else if (folder) {
    folderReady = false;
    updateSetupGuide();
    message('已记住文件夹；请点击“选择本地文件夹”重新授权。');
  }
} catch (error) { message(`读取本地记录失败：${error.message}`); }
