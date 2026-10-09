/**
 * google_old.js
 * Парсер "старого" формата Google Location History (Records.json,
 * выгружался через Google Takeout до перехода Timeline на локальное
 * хранение на устройстве).
 *
 * Ожидаемая форма:
 * {
 *   "locations": [
 *     {
 *       "timestampMs": "1584000000000",       // либо "timestamp": ISO-строка
 *       "latitudeE7": 522297000,
 *       "longitudeE7": 210122000,
 *       "accuracy": 12,
 *       "altitude": 100,
 *       "velocity": 3,                         // м/с, опционально
 *       "activity": [ { "activity": [ { "type": "WALKING", "confidence": 80 } ] } ]
 *     }
 *   ]
 * }
 */

import { buildSegmentsFromPoints } from './analyzer.js';

/** Определяет, похож ли объект на старый формат. */
export function detect(json) {
  return !!json && Array.isArray(json.locations);
}

function parseTimestamp(raw) {
  if (raw.timestampMs !== undefined) {
    return Number(raw.timestampMs);
  }
  if (raw.timestamp) {
    return new Date(raw.timestamp).getTime();
  }
  return null;
}

function topActivity(raw) {
  const bucket = raw.activity?.[0]?.activity;
  if (!Array.isArray(bucket) || bucket.length === 0) return 'UNKNOWN';
  const best = bucket.reduce((a, b) => (b.confidence > a.confidence ? b : a), bucket[0]);
  return best.type || 'UNKNOWN';
}

/**
 * Преобразует сырой JSON старого формата в нормализованный список точек.
 * @returns {{points: Array, segments: Array}}
 */
export function parse(json) {
  const points = [];

  for (const raw of json.locations) {
    if (raw.latitudeE7 === undefined || raw.longitudeE7 === undefined) continue;
    const timestamp = parseTimestamp(raw);
    if (!timestamp) continue;

    points.push({
      lat: raw.latitudeE7 / 1e7,
      lng: raw.longitudeE7 / 1e7,
      timestamp,
      accuracy: raw.accuracy ?? null,
      altitude: raw.altitude ?? null,
      speedMs: raw.velocity ?? null,
      activityType: topActivity(raw),
      source: 'google_old',
    });
  }

  points.sort((a, b) => a.timestamp - b.timestamp);

  // Старый формат не даёт готовых сегментов/визитов, в отличие от нового —
  // собираем их сами из последовательности точек, группируя по типу
  // активности. Без этого шага нечего рисовать на карте линиями и не из
  // чего считать дистанцию/время/фильтры по типу активности.
  const segments = buildSegmentsFromPoints(points);

  return { points, segments, format: 'google_old' };
}
