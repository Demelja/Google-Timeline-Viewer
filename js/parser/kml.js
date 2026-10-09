/**
 * kml.js
 * Парсер KML-файлов (Keyhole Markup Language) — экспорт GPS-треков из
 * Google Earth, различных GPX→KML конвертеров, других сервисов.
 * В отличие от google_old/google_new, KML — это XML, а не JSON, поэтому
 * в общий пайплайн он попадает по отдельной ветке в parser.js (см. detect
 * по сырому тексту файла, а не по уже распарсенному JSON-объекту).
 *
 * Поддерживаются три формы данных внутри <Placemark>, по убыванию точности:
 *   1. <gx:Track>      — пары <when>/<gx:coord>, самый надёжный источник:
 *                         у каждой точки есть реальная метка времени.
 *   2. <Point>          — одиночная точка, трактуется как "визит"
 *                         (аналог visit-сегмента google_new). Время берётся
 *                         из <TimeStamp> или <TimeSpan>, если есть.
 *   3. <LineString>     — трек без времени на каждую точку. Если на
 *                         Placemark есть <TimeSpan>, время интерполируется
 *                         равномерно по точкам; иначе используются
 *                         синтетические возрастающие метки, а вызывающей
 *                         стороне возвращается предупреждение (warnings).
 */

const GX_COORD_RE = /^\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/; // "lng lat [alt]"

function text(el) {
  return el?.textContent?.trim() ?? '';
}

/** "lng,lat,alt lng,lat,alt ..." -> [{lat,lng}, ...] (перенosы строк/лишние пробелы допустимы). */
function parseCoordinatesBlock(raw) {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((triplet) => {
      const [lng, lat] = triplet.split(',').map(parseFloat);
      if (Number.isNaN(lat) || Number.isNaN(lng)) return null;
      return { lat, lng };
    })
    .filter(Boolean);
}

/** Грубая эвристика типа активности по названию Placemark (если оно осмысленное). */
function guessActivityType(name) {
  if (!name) return 'UNKNOWN';
  const n = name.toLowerCase();
  if (/walk|пеш/.test(n)) return 'WALKING';
  if (/run|бег|беж/.test(n)) return 'RUNNING';
  if (/bike|cycl|велос/.test(n)) return 'ON_BICYCLE';
  if (/bus/.test(n)) return 'IN_BUS';
  if (/train|поезд/.test(n)) return 'IN_TRAIN';
  if (/drive|car|vehicle|авто|машин/.test(n)) return 'IN_VEHICLE';
  return 'UNKNOWN';
}

/** Похож ли сырой текст файла на KML (вызывается до любого JSON.parse). */
export function detect(rawText) {
  return typeof rawText === 'string' && /<kml[\s>]/i.test(rawText);
}

function parseGxTrack(trackEl) {
  const whens = Array.from(trackEl.getElementsByTagName('when')).map((el) =>
    new Date(text(el)).getTime()
  );
  const coordEls = Array.from(trackEl.getElementsByTagName('gx:coord'));
  const points = [];
  const n = Math.min(whens.length, coordEls.length);

  for (let i = 0; i < n; i++) {
    if (Number.isNaN(whens[i])) continue;
    const m = GX_COORD_RE.exec(text(coordEls[i]));
    if (!m) continue;
    points.push({ lat: parseFloat(m[2]), lng: parseFloat(m[1]), timestamp: whens[i], source: 'kml' });
  }

  points.sort((a, b) => a.timestamp - b.timestamp);
  return points;
}

function parseTimeSpan(placemarkEl) {
  const span = placemarkEl.getElementsByTagName('TimeSpan')[0];
  if (!span) return null;
  const begin = span.getElementsByTagName('begin')[0];
  const end = span.getElementsByTagName('end')[0];
  const startMs = begin ? new Date(text(begin)).getTime() : null;
  const endMs = end ? new Date(text(end)).getTime() : null;
  if (!startMs && !endMs) return null;
  return { start: startMs ?? endMs, end: endMs ?? startMs };
}

function parseTimeStamp(placemarkEl) {
  const stamp = placemarkEl.getElementsByTagName('TimeStamp')[0];
  if (!stamp) return null;
  const when = stamp.getElementsByTagName('when')[0];
  if (!when) return null;
  const ms = new Date(text(when)).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * @param {string} kmlText сырой текст .kml файла
 * @returns {{points: Array, segments: Array, format: string, warnings: string[]}}
 */
export function parse(kmlText) {
  const doc = new DOMParser().parseFromString(kmlText, 'application/xml');

  if (doc.getElementsByTagName('parsererror')[0]) {
    throw new Error('файл повреждён или не является корректным XML');
  }

  const points = [];
  const segments = [];
  const warnings = [];
  // Запасной "синтетический" якорь времени — используется только когда
  // в самом файле нет вообще никакой информации о времени.
  let syntheticClock = Date.UTC(2000, 0, 1);

  for (const pm of Array.from(doc.getElementsByTagName('Placemark'))) {
    const name = text(pm.getElementsByTagName('name')[0]);
    const activityType = guessActivityType(name);

    // --- 1. gx:Track: своя метка времени на каждую точку ---
    const gxTrack = pm.getElementsByTagName('gx:Track')[0];
    if (gxTrack) {
      const segPoints = parseGxTrack(gxTrack);
      if (segPoints.length === 0) continue;
      segments.push({
        type: 'move',
        activityType,
        start: segPoints[0].timestamp,
        end: segPoints[segPoints.length - 1].timestamp,
        points: segPoints,
      });
      points.push(...segPoints.map((p) => ({ ...p, activityType })));
      continue;
    }

    // --- 2. Point: одиночная точка -> трактуем как визит ---
    const pointEl = pm.getElementsByTagName('Point')[0];
    if (pointEl) {
      const coords = parseCoordinatesBlock(text(pointEl.getElementsByTagName('coordinates')[0]))[0];
      if (!coords) continue;

      let ts = parseTimeStamp(pm) ?? parseTimeSpan(pm)?.start ?? null;
      if (ts === null) {
        ts = syntheticClock;
        syntheticClock += 1000;
        warnings.push(`«${name || 'Без имени'}»: нет времени в файле, использована синтетическая метка`);
      }

      const point = { ...coords, timestamp: ts, source: 'kml' };
      segments.push({
        type: 'visit',
        start: ts,
        end: ts,
        placeLocation: coords,
        semanticType: name || 'UNKNOWN',
        points: [point],
      });
      points.push(point);
      continue;
    }

    // --- 3. LineString: трек без покоординатных меток времени ---
    const lineEl = pm.getElementsByTagName('LineString')[0];
    if (lineEl) {
      const coordsList = parseCoordinatesBlock(text(lineEl.getElementsByTagName('coordinates')[0]));
      if (coordsList.length === 0) continue;

      const span = parseTimeSpan(pm);
      let segPoints;

      if (span?.start && span?.end && span.end > span.start) {
        const step = (span.end - span.start) / Math.max(coordsList.length - 1, 1);
        segPoints = coordsList.map((c, i) => ({ ...c, timestamp: span.start + step * i, source: 'kml' }));
      } else {
        warnings.push(`«${name || 'Без имени'}»: нет времени в файле, использованы синтетические метки`);
        segPoints = coordsList.map((c) => {
          const ts = syntheticClock;
          syntheticClock += 1000;
          return { ...c, timestamp: ts, source: 'kml' };
        });
      }

      segments.push({
        type: 'move',
        activityType,
        start: segPoints[0].timestamp,
        end: segPoints[segPoints.length - 1].timestamp,
        points: segPoints,
      });
      points.push(...segPoints.map((p) => ({ ...p, activityType })));
    }
  }

  points.sort((a, b) => a.timestamp - b.timestamp);
  segments.sort((a, b) => a.start - b.start);

  return { points, segments, format: 'kml', warnings };
}
