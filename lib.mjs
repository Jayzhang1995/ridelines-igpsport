export const CYCLING = new Set(['Ride', 'EBikeRide', 'GravelRide', 'MountainBikeRide', 'EMountainBikeRide', 'VirtualRide', 'Handcycle', 'Velomobile']);

export function isRide(activity) {
  return CYCLING.has(activity.sport_type || activity.type) && !activity.trainer;
}

export function normalizeActivity(activity) {
  return {
    id: String(activity.id),
    source: 'strava',
    name: String(activity.name || '未命名骑行'),
    date: String(activity.start_date_local || activity.start_date || ''),
    distance: Number(activity.distance) || 0,
    duration: Number(activity.moving_time) || 0,
    polyline: String(activity.map?.summary_polyline || ''),
    detailed: false
  };
}

export function decodePolyline(encoded) {
  const result = [];
  let index = 0, lat = 0, lon = 0;
  while (index < encoded.length) {
    const deltas = [];
    for (let axis = 0; axis < 2; axis++) {
      let shift = 0, value = 0, byte;
      do {
        if (index >= encoded.length || shift > 30) throw new Error('无效的轨迹编码');
        byte = encoded.charCodeAt(index++) - 63;
        value |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      deltas.push(value & 1 ? ~(value >> 1) : value >> 1);
    }
    lat += deltas[0]; lon += deltas[1];
    const point = [lat / 1e5, lon / 1e5];
    if (Math.abs(point[0]) <= 90 && Math.abs(point[1]) <= 180) result.push(point);
  }
  return result;
}

export function encodePolyline(points) {
  let output = '', lastLat = 0, lastLon = 0;
  for (const point of points) {
    const lat = Math.round(point[0] * 1e5), lon = Math.round(point[1] * 1e5);
    for (let value of [lat - lastLat, lon - lastLon]) {
      value = value < 0 ? ~(value << 1) : value << 1;
      while (value >= 0x20) { output += String.fromCharCode((0x20 | (value & 0x1f)) + 63); value >>>= 5; }
      output += String.fromCharCode(value + 63);
    }
    lastLat = lat; lastLon = lon;
  }
  return output;
}

export function localYearMonth(date) {
  const match = /^(\d{4})-(\d{2})/.exec(date);
  return match ? [Number(match[1]), Number(match[2])] : [null, null];
}
