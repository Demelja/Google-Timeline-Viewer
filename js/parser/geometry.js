/**
 * geometry.js
 * Чистые геометрические функции без побочных эффектов.
 * Используются simplifier'ом, analyzer'ом и картой.
 */

const EARTH_RADIUS_M = 6371008.8;

/** Градусы -> радианы */
export function toRad(deg) {
  return (deg * Math.PI) / 180;
}

/** Радианы -> градусы */
export function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

/**
 * Расстояние между двумя точками (в метрах) по формуле гаверсинуса.
 * @param {{lat:number, lng:number}} a
 * @param {{lat:number, lng:number}} b
 */
export function haversineDistance(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);

  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_M * c;
}

/**
 * Суммарная длина трека (метры).
 * @param {Array<{lat:number, lng:number}>} points
 */
export function trackLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += haversineDistance(points[i - 1], points[i]);
  }
  return total;
}

/**
 * Азимут (bearing) от точки a к точке b, в градусах [0, 360).
 */
export function bearing(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Скорость между двумя точками с временными метками, км/ч.
 * @param {{lat:number,lng:number,timestamp:number}} a
 * @param {{lat:number,lng:number,timestamp:number}} b
 */
export function speedKmh(a, b) {
  const dtMs = b.timestamp - a.timestamp;
  if (dtMs <= 0) return 0;
  const distM = haversineDistance(a, b);
  return (distM / (dtMs / 1000)) * 3.6;
}

/**
 * Перпендикулярное расстояние от точки p до отрезка [a, b].
 * Используется алгоритмом Дугласа-Пекера. Приближение через
 * проекцию на плоскость (достаточно точно для локальных треков).
 */
export function perpendicularDistance(p, a, b) {
  if (a.lat === b.lat && a.lng === b.lng) {
    return haversineDistance(p, a);
  }

  // Переводим в локальные метровые координаты относительно a
  const toXY = (pt) => ({
    x: haversineDistance(a, { lat: a.lat, lng: pt.lng }) * (pt.lng < a.lng ? -1 : 1),
    y: haversineDistance(a, { lat: pt.lat, lng: a.lng }) * (pt.lat < a.lat ? -1 : 1),
  });

  const A = toXY(a); // {0,0}
  const B = toXY(b);
  const P = toXY(p);

  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) return haversineDistance(p, a);

  const t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / lenSq;
  const tClamped = Math.max(0, Math.min(1, t));

  const projX = A.x + tClamped * dx;
  const projY = A.y + tClamped * dy;

  return Math.sqrt((P.x - projX) ** 2 + (P.y - projY) ** 2);
}

/** Центроид набора точек (простое среднее). */
export function centroid(points) {
  const n = points.length;
  const sum = points.reduce(
    (acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }),
    { lat: 0, lng: 0 }
  );
  return { lat: sum.lat / n, lng: sum.lng / n };
}

/** Прямоугольные границы (bounding box) набора точек. */
export function bounds(points) {
  return points.reduce(
    (acc, p) => ({
      minLat: Math.min(acc.minLat, p.lat),
      maxLat: Math.max(acc.maxLat, p.lat),
      minLng: Math.min(acc.minLng, p.lng),
      maxLng: Math.max(acc.maxLng, p.lng),
    }),
    { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180 }
  );
}
