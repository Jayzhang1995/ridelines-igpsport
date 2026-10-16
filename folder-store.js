const DB_NAME = 'ridelines-browser-only';
const STORE = 'settings';

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getFolder() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get('folder');
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

export async function setFolder(folder) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(folder, 'folder');
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

export async function readRides(folder) {
  try {
    const file = await folder.getFileHandle('ridelines-rides.json');
    const data = JSON.parse(await (await file.getFile()).text());
    if (data.ridelines !== 2 || !Array.isArray(data.rides)) throw new Error('轨迹索引格式不正确');
    return data.rides.filter(ride => ride && /^igps:\d{1,20}$/.test(ride.id) && typeof ride.polyline === 'string')
      .map(ride => ({ ...ride, distance: Math.max(0, Number(ride.distance) || 0),
        duration: Math.max(0, Number(ride.duration) || 0), date: String(ride.date || '') }));
  } catch (error) {
    if (error.name === 'NotFoundError') return [];
    throw error;
  }
}

export async function writeRide(folder, rides, ride, gpx) {
  const position = rides.findIndex(item => item.id === ride.id);
  if (gpx) {
    const tracks = await folder.getDirectoryHandle('GPX', { create: true });
    const file = await tracks.getFileHandle(`${ride.id.slice(5)}.gpx`, { create: true });
    const writer = await file.createWritable();
    try { await writer.write(gpx); await writer.close(); }
    catch (error) { await writer.abort().catch(() => {}); throw error; }
  }
  if (position < 0) rides.push(ride); else rides[position] = ride;
  const file = await folder.getFileHandle('ridelines-rides.json', { create: true });
  const writer = await file.createWritable();
  try { await writer.write(JSON.stringify({ ridelines: 2, rides }, null, 2)); await writer.close(); }
  catch (error) { await writer.abort().catch(() => {}); throw error; }
  return rides;
}
