/**
 * analyzer.js
 * Считает статистику по нормализованному таймлайну: пройденное расстояние,
 * время по типам активности, посещённые места, аномалии скорости.
 * Также умеет достраивать сегменты движения из "сырых" точек старого
 * формата, у которого нет готовых semanticSegments.
 */

import { haversineDistance, speedKmh, centroid } from './geometry.js';
import { CONFIG } from '../config.js';

/**
 * Строит сегменты движения из последовательности точек (для старого формата,
 * где сегментов изначально нет). Точки группируются по признаку activityType,
 * соседние точки с одинаковым типом активности объединяются в один сегмент.
 * @param {Array} points отсортированные по времени точки
 * @returns {Array} сегменты вида { type: 'move', activityType, start, end, points }
 */
export function buildSegmentsFromPoints(points) {
  if (points.length === 0) return [];

  const segments = [];
  let current = null;

  for (const p of points) {
    const type = p.activityType || 'UNKNOWN';
    if (!current || current.activityType !== type) {
      if (current) segments.push(current);
      current = {
        type: 'move',
        activityType: type,
        start: p.timestamp,
        end: p.timestamp,
        points: [p],
      };
    } else {
      current.points.push(p);
      current.end = p.timestamp;
    }
  }
  if (current) segments.push(current);
  return segments;
}

/**
 * Находит точки, где скорость между соседними замерами превышает
 * физически правдоподобный порог — обычно признак сбоя GPS.
 * @param {Array} points
 * @returns {Array<{from:object, to:object, speedKmh:number}>}
 */
export function findSpeedAnomalies(points) {
  const anomalies = [];
  for (let i = 1; i < points.length; i++) {
    const v = speedKmh(points[i - 1], points[i]);
    if (v > CONFIG.ANALYSIS.MAX_PLAUSIBLE_SPEED_KMH) {
      anomalies.push({ from: points[i - 1], to: points[i], speedKmh: v });
    }
  }
  return anomalies;
}

/**
 * Группирует сегменты типа "visit" в места, объединяя близкие визиты
 * в пределах PLACE_CLUSTER_RADIUS_M в один "place" со счётчиком посещений
 * и суммарной длительностью.
 * @param {Array} segments
 * @returns {Array<{location:object, visitCount:number, totalDurationMs:number, semanticTypes:Set}>}
 */
export function clusterPlaces(segments) {
  const visits = segments.filter(
    (s) => s.type === 'visit' && s.end - s.start >= CONFIG.ANALYSIS.MIN_VISIT_DURATION_MS
  );

  const places = [];

  for (const visit of visits) {
    const loc = visit.placeLocation ?? visit.points[0];
    if (!loc) continue;

    let place = places.find(
      (p) => haversineDistance(p.location, loc) <= CONFIG.ANALYSIS.PLACE_CLUSTER_RADIUS_M
    );

    if (!place) {
      place = {
        location: loc,
        visitCount: 0,
        totalDurationMs: 0,
        semanticTypes: new Set(),
        visits: [],
      };
      places.push(place);
    }

    place.visitCount += 1;
    place.totalDurationMs += visit.end - visit.start;
    if (visit.semanticType) place.semanticTypes.add(visit.semanticType);
    place.visits.push(visit);

    // Пересчитываем центроид места по всем визитам для большей точности
    place.location = centroid(place.visits.map((v) => v.placeLocation ?? v.points[0]));
  }

  return places.sort((a, b) => b.totalDurationMs - a.totalDurationMs);
}

/**
 * Основной отчёт по таймлайну: сводная статистика для дашборда.
 * @param {{points: Array, segments: Array}} timeline
 */
export function buildSummary(timeline) {
  const { points, segments } = timeline;

  const moveSegments = segments.filter((s) => s.type === 'move');
  const visitSegments = segments.filter((s) => s.type === 'visit');

  const distanceByActivity = {};
  let totalDistanceM = 0;

  for (const seg of moveSegments) {
    const dist = seg.distanceMeters ?? sumSegmentDistance(seg.points);
    totalDistanceM += dist;
    const key = seg.activityType || 'UNKNOWN';
    distanceByActivity[key] = (distanceByActivity[key] || 0) + dist;
  }

  const timeByActivity = {};
  for (const seg of moveSegments) {
    const key = seg.activityType || 'UNKNOWN';
    timeByActivity[key] = (timeByActivity[key] || 0) + (seg.end - seg.start);
  }

  const places = clusterPlaces(visitSegments.length ? visitSegments : segments);
  const anomalies = findSpeedAnomalies(points);

  const dayKeys = new Set(points.map((p) => new Date(p.timestamp).toISOString().slice(0, 10)));

  return {
    pointCount: points.length,
    segmentCount: segments.length,
    daysCovered: dayKeys.size,
    totalDistanceKm: totalDistanceM / 1000,
    distanceByActivityKm: mapValuesToKm(distanceByActivity),
    timeByActivityMs: timeByActivity,
    topPlaces: places.slice(0, 20),
    speedAnomalyCount: anomalies.length,
    dateRange: points.length
      ? { from: points[0].timestamp, to: points[points.length - 1].timestamp }
      : null,
  };
}

function sumSegmentDistance(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversineDistance(points[i - 1], points[i]);
  return d;
}

function mapValuesToKm(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = v / 1000;
  return out;
}

/**
 * Данные для тепловой карты. Рисуются только два вида данных:
 *  1) VISIT — визиты (visit-сегменты), вес = длительность визита. Визиты
 *     короче MIN_VISIT_DURATION_MS отбрасываются; "точечные" визиты без
 *     длительности (например, Point из KML) получают фиксированный вес
 *     HEATMAP.POINT_VISIT_WEIGHT_MS;
 *  2) UNKNOWN — точки, у которых тип активности UNKNOWN (нет данных об
 *     активности: старый JSON, KML без распознанного названия, сегменты
 *     timelinePath без activity). Вес точки = время до следующей точки
 *     (не больше MAX_POINT_DWELL_MS).
 * Точки всех остальных активностей (WALKING, IN_VEHICLE, ...) не учитываются.
 *
 * Результат агрегируется по ячейкам сетки (CELL_DEG), чтобы сотни тысяч точек
 * превратились в тысячи, и нормализуется: интенсивность 0..1 по корню из веса,
 * чтобы одно самое частое место не затмевало остальные.
 *
 * @param {{points: Array, segments: Array}} timeline уже отфильтрованный таймлайн
 * @returns {{points: Array<[number, number, number]>, visits: number, unknownPoints: number}}
 */
export function buildHeatPoints(timeline) {
  const cfg = CONFIG.HEATMAP;
  const items = [];
  let visits = 0;
  let unknownPoints = 0;

  // --- VISIT ---
  for (const seg of timeline.segments) {
    if (seg.type !== 'visit') continue;
    const loc = seg.placeLocation ?? seg.points?.[0];
    if (!loc) continue;

    const duration = seg.end - seg.start;
    let weight;
    if (duration === 0) weight = cfg.POINT_VISIT_WEIGHT_MS;
    else if (duration >= CONFIG.ANALYSIS.MIN_VISIT_DURATION_MS) weight = duration;
    else continue;

    items.push({ lat: loc.lat, lng: loc.lng, weight });
    visits += 1;
  }

  // --- UNKNOWN ---
  // У точек визитов activityType не задан (undefined), поэтому строгая
  // проверка на 'UNKNOWN' не даёт посчитать один визит дважды.
  const pts = timeline.points;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p.activityType !== 'UNKNOWN') continue;
    const next = pts[i + 1];
    const dwell = next ? next.timestamp - p.timestamp : 60 * 1000;
    const weight = Math.min(Math.max(dwell, 30 * 1000), cfg.MAX_POINT_DWELL_MS);
    items.push({ lat: p.lat, lng: p.lng, weight });
    unknownPoints += 1;
  }

  if (items.length === 0) return { points: [], visits, unknownPoints };

  // --- Агрегация по сетке (средневзвешенный центр ячейки) ---
  const cells = new Map();
  for (const it of items) {
    const key = `${Math.round(it.lat / cfg.CELL_DEG)}:${Math.round(it.lng / cfg.CELL_DEG)}`;
    let c = cells.get(key);
    if (!c) {
      c = { w: 0, latW: 0, lngW: 0 };
      cells.set(key, c);
    }
    c.w += it.weight;
    c.latW += it.lat * it.weight;
    c.lngW += it.lng * it.weight;
  }

  let maxW = 0;
  for (const c of cells.values()) if (c.w > maxW) maxW = c.w;

  const points = [];
  for (const c of cells.values()) {
    const intensity = Math.max(Math.sqrt(c.w / maxW), 0.05);
    points.push([c.latW / c.w, c.lngW / c.w, intensity]);
  }

  return { points, visits, unknownPoints };
}
