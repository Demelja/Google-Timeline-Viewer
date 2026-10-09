/**
 * simplifier.js
 * Упрощение полилиний алгоритмом Дугласа-Пекера.
 * Нужен, чтобы не рендерить на карте сотни тысяч точек трека.
 */

import { perpendicularDistance } from './geometry.js';
import { CONFIG } from '../config.js';

/**
 * Упрощает массив точек, сохраняя форму трека в пределах tolerance (метры).
 * @param {Array<{lat:number, lng:number}>} points
 * @param {number} [tolerance]
 * @returns {Array<{lat:number, lng:number}>}
 */
export function simplifyTrack(points, tolerance = CONFIG.SIMPLIFIER.DEFAULT_TOLERANCE_M) {
  if (points.length < CONFIG.SIMPLIFIER.MIN_POINTS_TO_SIMPLIFY) {
    return points.slice();
  }
  const keepMask = new Array(points.length).fill(false);
  keepMask[0] = true;
  keepMask[points.length - 1] = true;

  douglasPeuckerRange(points, 0, points.length - 1, tolerance, keepMask);

  return points.filter((_, i) => keepMask[i]);
}

function douglasPeuckerRange(points, startIdx, endIdx, tolerance, keepMask) {
  if (endIdx <= startIdx + 1) return;

  const a = points[startIdx];
  const b = points[endIdx];

  let maxDist = -1;
  let maxIdx = -1;

  for (let i = startIdx + 1; i < endIdx; i++) {
    const d = perpendicularDistance(points[i], a, b);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > tolerance) {
    keepMask[maxIdx] = true;
    douglasPeuckerRange(points, startIdx, maxIdx, tolerance, keepMask);
    douglasPeuckerRange(points, maxIdx, endIdx, tolerance, keepMask);
  }
}

/**
 * Упрощает сразу набор сегментов трека (каждый сегмент — отдельная поездка),
 * не смешивая точки соседних поездок.
 * @param {Array<{points: Array}>} segments
 * @param {number} [tolerance]
 */
export function simplifySegments(segments, tolerance) {
  return segments.map((seg) => ({
    ...seg,
    points: simplifyTrack(seg.points, tolerance),
  }));
}
