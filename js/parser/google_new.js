/**
 * google_new.js
 * Парсер "нового" формата Google Timeline (экспорт с телефона,
 * начиная с 2024 — данные хранятся локально, экспортируются как
 * Timeline.json с массивом semanticSegments и rawSignals).
 *
 * Реальная форма координат в этом экспорте — строка вида
 * "52.3676000°, 4.9041000°" (градусы, запятая, НЕ "geo:"-URI, в отличие
 * от более старых неофициальных описаний формата в интернете). Парсер
 * ниже на всякий случай понимает оба варианта.
 *
 * Ожидаемая форма (упрощённо):
 * {
 *   "semanticSegments": [
 *     {
 *       "startTime": "2024-01-01T08:00:00.000+01:00",
 *       "endTime":   "2024-01-01T08:20:00.000+01:00",
 *       "timelinePath": [ { "point": "52.123°, 21.012°", "time": "..." } ],
 *       "activity": {
 *         "start": { "latLng": "52.123°, 21.012°" },
 *         "end":   { "latLng": "52.456°, 21.789°" },
 *         "topCandidate": { "type": "walking", "probability": 0.8 },
 *         "distanceMeters": 1500
 *       },
 *       "visit": {
 *         "topCandidate": { "placeLocation": { "latLng": "52.1°, 21.0°" }, "semanticType": "Home" },
 *         "probability": 0.9
 *       }
 *     }
 *   ]
 * }
 */

/** Определяет, похож ли объект на новый формат. */
export function detect(json) {
  return !!json && Array.isArray(json.semanticSegments);
}

/**
 * Парсит координатную строку. Поддерживает оба варианта, встречающиеся
 * в реальных экспортах и в разных описаниях формата в сети:
 *   "52.3676000°, 4.9041000°"  — реальный формат Timeline.json
 *   "geo:52.3676,4.9041"       — альтернативный/устаревший вариант
 */
function parseGeoString(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const match = /(-?\d+(?:\.\d+)?)\s*°?\s*,\s*(-?\d+(?:\.\d+)?)\s*°?/.exec(raw);
  if (!match) return null;
  return { lat: parseFloat(match[1]), lng: parseFloat(match[2]) };
}

/** Координаты бывают как голой строкой, так и объектом { latLng: "..." }. */
function extractLatLng(obj) {
  if (!obj) return null;
  const raw = typeof obj === 'string' ? obj : obj.latLng;
  return parseGeoString(raw);
}

function parseTimelinePath(path, segStart) {
  if (!Array.isArray(path)) return [];
  const points = [];
  for (const step of path) {
    const coords = parseGeoString(step.point);
    if (!coords) continue;
    const t = step.time ? new Date(step.time).getTime() : null;
    points.push({
      lat: coords.lat,
      lng: coords.lng,
      timestamp: t ?? segStart,
      source: 'google_new',
    });
  }
  return points;
}

/**
 * Преобразует сырой JSON нового формата в нормализованные точки и сегменты.
 * @returns {{points: Array, segments: Array}}
 */
export function parse(json) {
  const points = [];
  const segments = [];
  const warnings = [];

  for (const raw of json.semanticSegments ?? []) {
    const startMs = raw.startTime ? new Date(raw.startTime).getTime() : null;
    const endMs = raw.endTime ? new Date(raw.endTime).getTime() : null;
    if (!startMs || !endMs) continue;

    if (raw.visit) {
      const loc = extractLatLng(raw.visit.topCandidate?.placeLocation);
      const segment = {
        type: 'visit',
        start: startMs,
        end: endMs,
        placeLocation: loc,
        semanticType: raw.visit.topCandidate?.semanticType ?? 'UNKNOWN',
        probability: raw.visit.probability ?? null,
        points: loc ? [{ ...loc, timestamp: startMs, source: 'google_new' }] : [],
      };
      segments.push(segment);
      points.push(...segment.points);
      continue;
    }

    // Сегмент движения может нести timelinePath и БЕЗ вложенного activity —
    // в реальных экспортах такое встречается (например, для некоторых типов
    // трека активность распознаётся отдельно/позже и временно отсутствует).
    // Раньше это условие требовало raw.activity, из-за чего такие сегменты
    // молча терялись целиком, хотя содержали полноценный GPS-трек.
    if (raw.activity || raw.timelinePath) {
      // Основной источник трека — timelinePath. Если его нет или он пустой
      // (так бывает для коротких/старых сегментов), используем точки начала
      // и конца activity как грубую прямую линию — лучше, чем совсем не
      // показать сегмент на карте. Без activity фолбэка нет вообще.
      let segPoints = parseTimelinePath(raw.timelinePath, startMs);
      if (segPoints.length === 0 && raw.activity) {
        const startLoc = extractLatLng(raw.activity.start);
        const endLoc = extractLatLng(raw.activity.end);
        if (startLoc) segPoints.push({ ...startLoc, timestamp: startMs, source: 'google_new' });
        if (endLoc) segPoints.push({ ...endLoc, timestamp: endMs, source: 'google_new' });
      }

      if (segPoints.length > 0) {
        const segment = {
          type: 'move',
          start: startMs,
          end: endMs,
          activityType: (raw.activity?.topCandidate?.type ?? 'unknown').toUpperCase(),
          probability: raw.activity?.topCandidate?.probability ?? null,
          distanceMeters: raw.activity?.distanceMeters ?? sumHaversine(segPoints),
          points: segPoints,
        };
        segments.push(segment);
        points.push(...segPoints.map((p) => ({ ...p, activityType: segment.activityType })));
      } else {
        warnings.push(
          `Сегмент ${raw.startTime} — ${raw.endTime}: есть activity/timelinePath, но координаты не извлеклись (нераспознанный формат точек)`
        );
      }
      continue;
    }

    // Ни visit, ни activity, ни timelinePath — совсем незнакомая форма
    // сегмента. Раньше такое пропускалось молча; теперь хотя бы видно,
    // что что-то потерялось, и можно прислать пример для разбора.
    warnings.push(`Сегмент ${raw.startTime} — ${raw.endTime}: неизвестная структура (нет visit/activity/timelinePath), пропущен`);
  }

  points.sort((a, b) => a.timestamp - b.timestamp);
  segments.sort((a, b) => a.start - b.start);

  return { points, segments, format: 'google_new', warnings };
}

/** Грубая суммарная длина трека по точкам (используется, когда distanceMeters не пришёл явно). */
function sumHaversine(pts) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    total += 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }
  return total;
}
