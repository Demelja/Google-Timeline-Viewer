/**
 * app.js
 * Точка входа приложения. Связывает воедино: загрузку файлов -> парсинг ->
 * индексацию -> анализ -> фильтрацию -> рендер карты и UI.
 * Держит единственный источник правды — `state`.
 */

import { CONFIG } from './config.js';
import { parseFiles, TimelineParseError } from './parser/parser.js';
import { buildIndex } from './parser/indexer.js';
import { buildSummary, findSpeedAnomalies, clusterPlaces, buildHeatPoints } from './parser/analyzer.js';
import { applyFilters, createEmptyFilterState } from './filters.js';
import { TimelineMap } from './map.js';
import { UI } from './ui.js';

class App {
  constructor() {
    this.ui = new UI();
    // Если здесь не та версия, что в config.js, браузер отдаёт закэшированные
    // модули — обновите страницу с очисткой кэша (Ctrl+Shift+R).
    console.log(`[TimelineViewer] ${CONFIG.APP_NAME} v${CONFIG.APP_VERSION} запущен`);

    // Название/версия берутся только из CONFIG — одно место правды,
    // <title> и шапка страницы просто отражают его.
    this.ui.applyBranding({
      name: CONFIG.APP_NAME,
      version: CONFIG.APP_VERSION,
      tagline: 'автономный анализ Google Timeline',
    });

    const initialTheme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    this.map = new TimelineMap('map', initialTheme);

    /** Единственный источник правды */
    this.state = {
      rawTimeline: null, // результат parser.js — неизменный после загрузки
      index: null, // TimelineIndex
      filters: createEmptyFilterState(),
      heatmapEnabled: UI.loadHeatmapPreference(),
      lastFiltered: null, // последний отфильтрованный таймлайн — для расчёта "тепла" при включении
    };

    this._bindEvents();

    // Переключатель тепловой карты: данные считаются только когда слой включён,
    // чтобы не тратить время на сотни тысяч точек, пока он никому не нужен.
    this.ui.initHeatmapToggle(this.state.heatmapEnabled, (enabled) => {
      this.state.heatmapEnabled = enabled;
      console.log(`[TimelineViewer] тепловая карта: ${enabled ? 'включена' : 'выключена'}`);
      if (enabled) {
        this._updateHeatmap();
      } else {
        // Выключение тепловой карты действует как кнопка "Сбросить фильтры":
        // фильтры очищаются, а маршруты, места и аномалии рисуются заново.
        this._updateHeatmap();
        this._resetFilters();
      }
    });

    // initTheme вешает обработчик на кнопку-переключатель и синхронизирует
    // подложку карты при каждом переключении темы пользователем.
    this.ui.initTheme((theme) => this.map.setTheme(theme));
  }

  _bindEvents() {
    this.ui.onFilesSelected((files) => this.loadFiles(files));

    this.ui.onDateRangeChange((fromMs, toMs) => {
      this.state.filters.dateFrom = fromMs;
      this.state.filters.dateTo = toMs;
      this._rerender();
    });

    this.ui.onResetFilters(() => this._resetFilters());

    this.map.onSegmentClick((segment) => {
      this.ui.setStatus(
        `${segment.activityType || 'Сегмент'}: ${new Date(segment.start).toLocaleString('ru-RU')}`
      );
    });

    this.map.onPlaceClick((place) => {
      this.map.map.setView([place.location.lat, place.location.lng], 15);
    });
  }

  /** @param {FileList} files */
  async loadFiles(files) {
    this.ui.showLoading('Разбор файлов Timeline...');
    this.ui.clearStatus();

    try {
      const timeline = await parseFiles(files);

      if (timeline.points.length === 0 && timeline.segments.length === 0) {
        this.ui.setStatus('Файл разобран, но не найдено ни одной точки.', 'warn');
        this.ui.hideLoading();
        return;
      }

      this.state.rawTimeline = timeline;
      this.state.lastFiltered = null;
      this.ui.setHeatmapInfo('');
      this.state.index = buildIndex(timeline);
      this.state.filters = createEmptyFilterState();
      this.ui.resetFilterInputs();

      if (timeline.points.length) {
        this.ui.setDateBounds(
          timeline.points[0].timestamp,
          timeline.points[timeline.points.length - 1].timestamp
        );
      }

      this.ui.renderActivityFilterOptions(this.state.index.getAvailableActivityTypes(), (checked) => {
        this.state.filters.activityTypes = new Set(checked);
        this._rerender();
      });

      this._rerender();

      const baseMsg = `Загружено: ${timeline.points.length.toLocaleString('ru-RU')} точек, формат: ${timeline.format}`;
      if (timeline.warnings?.length) {
        // В основном актуально для KML без временных меток на точках —
        // предупреждаем, но не блокируем загрузку.
        console.warn('Предупреждения при разборе файла:', timeline.warnings);
        this.ui.setStatus(
          `${baseMsg}. ⚠ ${timeline.warnings.length} предупреждений о времени — подробности в консоли.`,
          'warn'
        );
      } else {
        this.ui.setStatus(baseMsg, 'success');
      }
    } catch (err) {
      if (err instanceof TimelineParseError) {
        this.ui.setStatus(err.message, 'error');
      } else {
        console.error(err);
        this.ui.setStatus('Непредвиденная ошибка при разборе файла. Подробности в консоли.', 'error');
      }
    } finally {
      this.ui.hideLoading();
    }
  }

  /** Сброс всех фильтров (кнопка "Сбросить фильтры" и выключение тепловой карты). */
  _resetFilters() {
    this.state.filters = createEmptyFilterState();
    this.ui.resetFilterInputs();
    this._rerender();
  }

  /** Пересчитывает производные данные (фильтр -> анализ -> карта/UI). */
  _rerender() {
    if (!this.state.rawTimeline) return;

    const filtered = applyFilters(this.state.rawTimeline, this.state.filters);
    this._logFilterDiagnostics(filtered);

    const summary = buildSummary(filtered);
    const places = summary.topPlaces.length
      ? summary.topPlaces
      : clusterPlaces(filtered.segments);

    // В режиме тепловой карты маршруты, жёлтые маркеры мест и аномалии не
    // рисуются (слои скрыты в map.setHeatmapVisible), поэтому и считать их нет смысла.
    if (!this.state.heatmapEnabled) {
      const anomalies = findSpeedAnomalies(filtered.points);
      this.map.renderSegments(filtered.segments, { simplify: !this._isNarrowDateRange() });
      this.map.renderPlaces(places);
      this.map.renderAnomalies(anomalies);
    }
    if (filtered.points.length) this.map.fitToPoints(filtered.points);

    this.state.lastFiltered = filtered;
    this._updateHeatmap();

    this.ui.renderSummary(summary);
    this.ui.renderPlaces(places, (place) => {
      this.map.map.setView([place.location.lat, place.location.lng], 15);
    });
  }

  /** Пересчитывает и показывает/скрывает тепловую карту по текущим фильтрам. */
  _updateHeatmap() {
    if (!this.state.heatmapEnabled) {
      this.map.setHeatmapVisible(false);
      this.ui.setHeatmapInfo(''); // не держим в подсказке данные прошлой сборки
      return;
    }
    if (!this.state.lastFiltered) {
      this.ui.setHeatmapInfo('Загрузите файл, чтобы построить тепловую карту.');
      this.map.setHeatmapVisible(true);
      return;
    }

    const heat = buildHeatPoints(this.state.lastFiltered);
    console.log(
      `[TimelineViewer] тепловая карта: визитов=${heat.visits}, точек UNKNOWN=${heat.unknownPoints}, ячеек=${heat.points.length}`
    );

    this.map.renderHeatmap(heat.points);
    this.map.setHeatmapVisible(true);

    this.ui.setHeatmapInfo(
      heat.points.length
        ? `Учтено: визитов — ${heat.visits}, точек с активностью UNKNOWN — ${heat.unknownPoints}. ` +
            'Остальные слои скрыты; выключение переключателя сбрасывает фильтры.'
        : 'Для выбранных фильтров нет визитов и точек с активностью UNKNOWN.'
    );
  }

  /**
   * Подробная диагностика потерь данных при фильтрации. Сравнивает:
   *  а) сколько сегментов вообще есть в исходном файле;
   *  б) сколько из них попадает в выбранный диапазон ДАТ (без учёта
   *     фильтра по типу активности) — это ближе всего к "что реально есть
   *     в файле на эту дату";
   *  в) сколько осталось после ВСЕХ фильтров (дата + тип активности).
   * Если (б) уже маленькое — проблема в парсинге/границах дат, а не в
   * фильтре активности. Если (б) большое, а (в) маленькое — обрезает
   * именно фильтр по типу активности.
   */
  _logFilterDiagnostics(filtered) {
    const raw = this.state.rawTimeline;
    const { dateFrom, dateTo } = this.state.filters;

    const inDateRange = (seg) =>
      (dateFrom === null || seg.end >= dateFrom) && (dateTo === null || seg.start <= dateTo);

    const rawInRange = raw.segments.filter(inDateRange);

    const byType = {};
    for (const seg of rawInRange) {
      const key = `${seg.type}/${seg.activityType || seg.semanticType || '-'}`;
      if (!byType[key]) byType[key] = { count: 0, points: 0 };
      byType[key].count += 1;
      byType[key].points += seg.points?.length ?? 0;
    }

    console.log(
      `[TimelineViewer] диагностика фильтра: всего сегментов в файле=${raw.segments.length}, ` +
        `в выбранном диапазоне дат (БЕЗ учёта фильтра активности)=${rawInRange.length}, ` +
        `после ВСЕХ фильтров=${filtered.segments.length}`
    );
    console.log('[TimelineViewer] разбивка по типам в диапазоне дат (тип/активность: сегментов, точек):', byType);
    console.log(
      '[TimelineViewer] активный фильтр типов активности:',
      this.state.filters.activityTypes ? Array.from(this.state.filters.activityTypes) : '(не задан — разрешены все типы)'
    );
  }

  /**
   * true, если в фильтрах заданы обе границы периода ("от" и "до") и
   * промежуток между ними не превышает CONFIG.SIMPLIFIER.DETAIL_THRESHOLD_DAYS.
   * Открытый с одной стороны диапазон (задано только "от" либо только "до")
   * трактуется как неограниченный — упрощение в этом случае остаётся.
   */
  _isNarrowDateRange() {
    const { dateFrom, dateTo } = this.state.filters;

    if (dateFrom === null || dateTo === null) {
      console.log(
        `[TimelineViewer] диапазон дат: dateFrom=${dateFrom}, dateTo=${dateTo} — ` +
          'одна из границ не задана, считаем диапазон неограниченным, упрощение остаётся включённым'
      );
      return false;
    }

    const thresholdMs = CONFIG.SIMPLIFIER.DETAIL_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    const rangeDays = (dateTo - dateFrom) / (24 * 60 * 60 * 1000);
    const isNarrow = dateTo - dateFrom <= thresholdMs;

    console.log(
      `[TimelineViewer] диапазон дат: ${new Date(dateFrom).toISOString()} — ${new Date(dateTo).toISOString()} ` +
        `(${rangeDays.toFixed(1)} дн., порог ${CONFIG.SIMPLIFIER.DETAIL_THRESHOLD_DAYS} дн.) -> ` +
        `${isNarrow ? 'узкий, упрощение ОТКЛЮЧЕНО' : 'широкий, упрощение включено'}`
    );

    return isNarrow;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  window.app = new App(); // на window — удобно для отладки из консоли
});
