/**
 * filters.js
 * Логика фильтрации данных таймлайна по дате, типу активности и месту.
 * Модуль не знает про DOM — принимает/возвращает чистые данные,
 * состояние фильтров хранит и рендерит ui.js.
 */

/**
 * @typedef {Object} FilterState
 * @property {number|null} dateFrom  мс с эпохи, включительно
 * @property {number|null} dateTo    мс с эпохи, включительно
 * @property {Set<string>|null} activityTypes  null = все типы
 * @property {{lat:number,lng:number,radiusM:number}|null} place
 */

/** Создаёт пустое (не ограничивающее) состояние фильтров. */
export function createEmptyFilterState() {
  return {
    dateFrom: null,
    dateTo: null,
    activityTypes: null,
    place: null,
  };
}

function haversineDistance(a, b) {
  const R = 6371008.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function pointMatchesFilters(point, filters) {
  if (filters.dateFrom !== null && point.timestamp < filters.dateFrom) return false;
  if (filters.dateTo !== null && point.timestamp > filters.dateTo) return false;
  if (filters.activityTypes && !filters.activityTypes.has(point.activityType || 'UNKNOWN')) {
    return false;
  }
  if (filters.place && haversineDistance(point, filters.place) > filters.place.radiusM) {
    return false;
  }
  return true;
}

function segmentMatchesFilters(segment, filters) {
  if (filters.dateFrom !== null && segment.end < filters.dateFrom) return false;
  if (filters.dateTo !== null && segment.start > filters.dateTo) return false;
  if (filters.activityTypes) {
    const key = segment.activityType || segment.type || 'UNKNOWN';
    if (!filters.activityTypes.has(key)) return false;
  }
  if (filters.place) {
    const ref = segment.placeLocation ?? segment.points?.[0];
    if (!ref || haversineDistance(ref, filters.place) > filters.place.radiusM) return false;
  }
  return true;
}

/**
 * Применяет фильтры к нормализованному таймлайну.
 * @param {{points: Array, segments: Array}} timeline
 * @param {FilterState} filters
 */
export function applyFilters(timeline, filters) {
  return {
    ...timeline,
    points: timeline.points.filter((p) => pointMatchesFilters(p, filters)),
    segments: timeline.segments.filter((s) => segmentMatchesFilters(s, filters)),
  };
}

/** Есть ли активные (сужающие выборку) фильтры. */
export function hasActiveFilters(filters) {
  return (
    filters.dateFrom !== null ||
    filters.dateTo !== null ||
    (filters.activityTypes && filters.activityTypes.size > 0) ||
    filters.place !== null
  );
}
