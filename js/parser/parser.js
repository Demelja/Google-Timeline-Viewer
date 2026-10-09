/**
 * parser.js
 * Единая точка входа для разбора файлов Google Timeline (и, отдельной
 * веткой, KML). Определяет формат и делегирует конкретному парсеру,
 * затем возвращает нормализованную структуру, одинаковую для всех
 * форматов, с которой уже работают analyzer/indexer/map/ui.
 */

import * as googleOld from './google_old.js';
import * as googleNew from './google_new.js';
import * as kml from './kml.js';

/**
 * @typedef {Object} NormalizedPoint
 * @property {number} lat
 * @property {number} lng
 * @property {number} timestamp  мс с эпохи
 * @property {string} [activityType]
 * @property {string} source
 */

/**
 * @typedef {Object} ParsedTimeline
 * @property {NormalizedPoint[]} points
 * @property {Array} segments
 * @property {string} format
 * @property {string[]} warnings  непустой только для KML с неполным временем
 */

// JSON-форматы (Google Timeline) определяются по структуре уже распарсенного
// объекта. KML обрабатывается отдельно — он XML, а не JSON (см. parseFile).
const JSON_PARSERS = [googleNew, googleOld];

export class TimelineParseError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'TimelineParseError';
    this.cause = cause;
  }
}

function sortMerged(merged) {
  merged.points.sort((a, b) => a.timestamp - b.timestamp);
  merged.segments.sort((a, b) => a.start - b.start);
}

/**
 * Разбирает уже распарсенный JSON-объект (или массив JSON-объектов,
 * если пользователь загрузил несколько файлов сразу).
 * @param {object|object[]} json
 * @returns {ParsedTimeline}
 */
export function parseJson(json) {
  const inputs = Array.isArray(json) ? json : [json];
  const merged = { points: [], segments: [], format: null, warnings: [] };

  for (const doc of inputs) {
    const parserModule = JSON_PARSERS.find((p) => p.detect(doc));
    if (!parserModule) {
      throw new TimelineParseError(
        'Не удалось распознать формат файла Timeline. Поддерживаются: ' +
          'новый экспорт (semanticSegments), старый экспорт (locations) и KML.'
      );
    }
    const result = parserModule.parse(doc);
    merged.points.push(...result.points);
    merged.segments.push(...result.segments);
    merged.format = merged.format ? `${merged.format}+${result.format}` : result.format;
    if (result.warnings?.length) merged.warnings.push(...result.warnings);
  }

  sortMerged(merged);
  return merged;
}

/** .kml по расширению файла ИЛИ по сигнатуре <kml ...> в начале содержимого. */
function looksLikeKml(file, rawText) {
  return /\.kml$/i.test(file.name) || kml.detect(rawText);
}

/**
 * Читает File/Blob (из <input type="file"> или drag&drop) и возвращает
 * нормализованный таймлайн. Асинхронно, чтобы не блокировать UI на больших
 * выгрузках (иногда десятки МБ).
 * @param {File} file
 * @returns {Promise<ParsedTimeline>}
 */
export async function parseFile(file) {
  const rawText = await file.text();

  if (looksLikeKml(file, rawText)) {
    try {
      const result = kml.parse(rawText);
      return {
        points: result.points,
        segments: result.segments,
        format: result.format,
        warnings: result.warnings ?? [],
      };
    } catch (err) {
      throw new TimelineParseError(`Не удалось разобрать KML-файл "${file.name}": ${err.message}`, err);
    }
  }

  let json;
  try {
    json = JSON.parse(rawText);
  } catch (err) {
    throw new TimelineParseError(
      `Файл "${file.name}" не является ни корректным JSON, ни KML.`,
      err
    );
  }
  return parseJson(json);
}

/**
 * Разбирает несколько файлов и объединяет их в один таймлайн (полезно,
 * если пользователь выгрузил историю по годам отдельными файлами, или
 * смешал JSON и KML в одной загрузке).
 * @param {FileList|File[]} files
 * @returns {Promise<ParsedTimeline>}
 */
export async function parseFiles(files) {
  const results = await Promise.all(Array.from(files).map(parseFile));
  const merged = { points: [], segments: [], format: null, warnings: [] };

  for (const r of results) {
    merged.points.push(...r.points);
    merged.segments.push(...r.segments);
    merged.format = merged.format ? `${merged.format}+${r.format}` : r.format;
    if (r.warnings?.length) merged.warnings.push(...r.warnings);
  }

  sortMerged(merged);
  return merged;
}
