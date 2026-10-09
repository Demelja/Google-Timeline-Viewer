/**
 * indexer.js
 * Строит индексы поверх нормализованного таймлайна, чтобы UI и фильтры
 * могли быстро находить нужные точки/сегменты без полного перебора
 * (важно — выгрузки Timeline легко достигают сотен тысяч точек).
 */

import { CONFIG } from '../config.js';

function dayKey(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10); // YYYY-MM-DD
}

function monthKey(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 7); // YYYY-MM
}

/** Ключ ячейки пространственной сетки ~0.01° (примерно 1 км на широте 50°). */
function gridKey(lat, lng, precision = 2) {
  return `${lat.toFixed(precision)}:${lng.toFixed(precision)}`;
}

export class TimelineIndex {
  constructor(timeline) {
    this.timeline = timeline;
    /** @type {Map<string, Array>} день -> точки */
    this.byDay = new Map();
    /** @type {Map<string, Array>} месяц -> точки */
    this.byMonth = new Map();
    /** @type {Map<string, Array>} тип активности -> сегменты */
    this.byActivity = new Map();
    /** @type {Map<string, Array>} ячейка сетки -> точки */
    this.byGrid = new Map();

    this._build();
  }

  _build() {
    for (const p of this.timeline.points) {
      this._pushTo(this.byDay, dayKey(p.timestamp), p);
      this._pushTo(this.byMonth, monthKey(p.timestamp), p);
      this._pushTo(this.byGrid, gridKey(p.lat, p.lng), p);
    }
    for (const seg of this.timeline.segments) {
      const key = seg.activityType || seg.type || 'UNKNOWN';
      this._pushTo(this.byActivity, key, seg);
    }
  }

  _pushTo(map, key, value) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  }

  /** Все точки за конкретный день (YYYY-MM-DD). */
  getPointsForDay(day) {
    return this.byDay.get(day) ?? [];
  }

  /** Все точки за конкретный месяц (YYYY-MM). */
  getPointsForMonth(month) {
    return this.byMonth.get(month) ?? [];
  }

  /** Все сегменты заданного типа активности (например 'WALKING'). */
  getSegmentsByActivity(activityType) {
    return this.byActivity.get(activityType) ?? [];
  }

  /** Список дней, за которые есть данные, отсортированный по возрастанию. */
  getAvailableDays() {
    return Array.from(this.byDay.keys()).sort();
  }

  /** Список типов активности, встречающихся в данных. */
  getAvailableActivityTypes() {
    return Array.from(this.byActivity.keys()).sort();
  }

  /**
   * Точки, попадающие в прямоугольник bounds ({minLat,maxLat,minLng,maxLng}).
   * Использует пространственную сетку, чтобы не сканировать все точки.
   */
  getPointsInBounds(bounds) {
    const result = [];
    const precision = 2;
    const latSteps = Math.ceil((bounds.maxLat - bounds.minLat) * 10 ** precision) + 1;
    const lngSteps = Math.ceil((bounds.maxLng - bounds.minLng) * 10 ** precision) + 1;

    // Если регион слишком большой, дешевле пройтись по всем точкам напрямую.
    if (latSteps * lngSteps > this.timeline.points.length) {
      return this.timeline.points.filter(
        (p) =>
          p.lat >= bounds.minLat &&
          p.lat <= bounds.maxLat &&
          p.lng >= bounds.minLng &&
          p.lng <= bounds.maxLng
      );
    }

    for (const [key, points] of this.byGrid) {
      const [latStr, lngStr] = key.split(':');
      const lat = parseFloat(latStr);
      const lng = parseFloat(lngStr);
      if (lat < bounds.minLat || lat > bounds.maxLat) continue;
      if (lng < bounds.minLng || lng > bounds.maxLng) continue;
      result.push(...points);
    }
    return result;
  }
}

/** Фабрика — удобная точка входа без прямого использования класса. */
export function buildIndex(timeline) {
  return new TimelineIndex(timeline);
}
