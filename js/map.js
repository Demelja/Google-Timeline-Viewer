/**
 * map.js
 * Обёртка над Leaflet: инициализация карты и рендер треков/визитов.
 * Leaflet подключается в index.html через CDN и доступен как глобальный L.
 */

import { CONFIG } from './config.js';
import { simplifyTrack } from './parser/simplifier.js';

export class TimelineMap {
  /**
   * @param {string} containerId id DOM-элемента под карту
   * @param {'dark'|'light'} [initialTheme]
   */
  constructor(containerId, initialTheme = 'dark') {
    if (typeof L === 'undefined') {
      throw new Error('Leaflet (L) не найден — проверьте подключение CDN в index.html');
    }

    this.map = L.map(containerId, {
      zoomControl: true,
      preferCanvas: true,
    }).setView(CONFIG.MAP.DEFAULT_CENTER, CONFIG.MAP.DEFAULT_ZOOM);

    this._tileLayer = null; // создаётся в setTheme()
    this.setTheme(initialTheme);

    this.trackLayer = L.layerGroup().addTo(this.map);
    this.placeLayer = L.layerGroup().addTo(this.map);
    this.anomalyLayer = L.layerGroup().addTo(this.map);

    this._onSegmentClick = null;
    this._onPlaceClick = null;

    // Тепловой слой создаётся лениво — при первом включении
    this._heatLayer = null;
    this._heatPoints = [];
    this._heatVisible = false;
  }

  // --- Тепловая карта мест пребывания --------------------------------------

  /**
   * Сохраняет данные тепловой карты ([lat, lng, интенсивность 0..1]) и, если
   * слой уже показан, обновляет его.
   */
  renderHeatmap(heatPoints) {
    this._heatPoints = heatPoints;
    // У снятого с карты слоя Leaflet обнуляет _map, и setLatLngs() падает
    // (leaflet-heat обращается к this._map._animating). Поэтому на скрытый
    // слой данные только запоминаются — они подставятся при показе.
    if (this._heatLayer && this.map.hasLayer(this._heatLayer)) this._heatLayer.setLatLngs(heatPoints);
  }

  /** Показывает/прячет слои маршрутов, мест и аномалий (данные в них сохраняются). */
  _setOverlaysVisible(visible) {
    for (const layer of [this.trackLayer, this.placeLayer, this.anomalyLayer]) {
      const onMap = this.map.hasLayer(layer);
      if (visible && !onMap) layer.addTo(this.map);
      if (!visible && onMap) this.map.removeLayer(layer);
    }
  }

  /** Показывает/скрывает тепловой слой (переключатель в интерфейсе). */
  setHeatmapVisible(visible) {
    this._heatVisible = visible;

    if (!visible) {
      if (this._heatLayer && this.map.hasLayer(this._heatLayer)) {
        // Отменяем уже запланированную перерисовку: иначе она сработает
        // после снятия слоя, когда this._map уже null.
        if (this._heatLayer._frame) {
          L.Util.cancelAnimFrame(this._heatLayer._frame);
          this._heatLayer._frame = null;
        }
        this.map.removeLayer(this._heatLayer);
      }
      this._setOverlaysVisible(true);
      return;
    }

    if (typeof L.heatLayer !== 'function') {
      console.warn('[TimelineMap] Leaflet.heat не загружен (vendor/leaflet-heat/leaflet-heat.js) — тепловая карта недоступна');
      return;
    }

    // Тепловая карта показывается вместо остальных слоёв: маршруты всех
    // активностей, жёлтые маркеры мест и красные маркеры аномалий скрываются.
    this._setOverlaysVisible(false);

    const cfg = CONFIG.HEATMAP;
    if (!this._heatLayer) {
      this._heatLayer = L.heatLayer(this._heatPoints, {
        radius: cfg.RADIUS,
        blur: cfg.BLUR,
        maxZoom: cfg.MAX_ZOOM,
        minOpacity: cfg.MIN_OPACITY,
        gradient: cfg.GRADIENT,
        max: 1.0,
      });
    } else if (this.map.hasLayer(this._heatLayer)) {
      this._heatLayer.setLatLngs(this._heatPoints);
    } else {
      // Слой был скрыт: подменяем данные напрямую, перерисовка произойдёт в onAdd
      this._heatLayer._latlngs = this._heatPoints;
    }

    if (!this.map.hasLayer(this._heatLayer)) this._heatLayer.addTo(this.map);

    // Leaflet.heat кладёт canvas в overlayPane поверх уже нарисованных
    // линий маршрутов. Переносим его в начало панели, чтобы маршруты и
    // маркеры оставались поверх "тепла", и отключаем перехват мыши.
    const canvas = this._heatLayer._canvas;
    if (canvas && canvas.parentNode) {
      canvas.style.pointerEvents = 'none';
      canvas.parentNode.insertBefore(canvas, canvas.parentNode.firstChild);
    }
  }

  /**
   * Переключает тайловую подложку карты между тёмной и светлой CARTO-темой.
   * Вызывается и при инициализации, и при переключении темы страницы —
   * чтобы светлый UI не сочетался с тёмной картой (и наоборот).
   * @param {'dark'|'light'} theme
   */
  setTheme(theme) {
    const base = theme === 'light' ? CONFIG.MAP.TILE_URL_LIGHT : CONFIG.MAP.TILE_URL_DARK;
    const tileUrl = CONFIG.MAP.CARTO_API_KEY
      ? `${base}?key=${encodeURIComponent(CONFIG.MAP.CARTO_API_KEY)}`
      : base;

    if (this._tileLayer) this.map.removeLayer(this._tileLayer);

    this._tileLayer = L.tileLayer(tileUrl, {
      attribution: CONFIG.MAP.TILE_ATTRIBUTION,
      minZoom: CONFIG.MAP.MIN_ZOOM,
      maxZoom: CONFIG.MAP.MAX_ZOOM,
      subdomains: 'abcd',
    }).addTo(this.map);

    // Тайловый слой — всегда самый нижний
    this._tileLayer.bringToBack();
  }

  /** Регистрирует обработчик клика по сегменту трека. */
  onSegmentClick(cb) {
    this._onSegmentClick = cb;
  }

  /** Регистрирует обработчик клика по маркеру места. */
  onPlaceClick(cb) {
    this._onPlaceClick = cb;
  }

  clearAll() {
    this.trackLayer.clearLayers();
    this.placeLayer.clearLayers();
    this.anomalyLayer.clearLayers();
  }

  /**
   * Рисует сегменты движения как полилинии, цвет — по типу активности.
   * @param {Array} segments
   * @param {{simplify?: boolean}} [options] simplify=false отключает
   *   упрощение Дугласом-Пекером — используется для узких диапазонов дат
   *   в фильтрах, где важна максимальная детализация трека (см. app.js).
   */
  renderSegments(segments, { simplify = true } = {}) {
    this.trackLayer.clearLayers();

    let drawnSegments = 0;
    let rawPointTotal = 0;
    let renderedPointTotal = 0;

    for (const seg of segments) {
      if (seg.type !== 'move' || !seg.points || seg.points.length < 2) continue;

      const renderedPoints = simplify ? simplifyTrack(seg.points) : seg.points;
      const latlngs = renderedPoints.map((p) => [p.lat, p.lng]);
      const color = CONFIG.ACTIVITY_COLORS[seg.activityType] || CONFIG.ACTIVITY_COLORS.UNKNOWN;

      drawnSegments += 1;
      rawPointTotal += seg.points.length;
      renderedPointTotal += renderedPoints.length;

      const polyline = L.polyline(latlngs, {
        color,
        weight: 3,
        opacity: 0.75,
        lineJoin: 'round',
      });

      polyline.on('click', () => this._onSegmentClick?.(seg));
      polyline.bindTooltip(this._segmentTooltip(seg), { sticky: true });
      polyline.addTo(this.trackLayer);
    }

    // Диагностика детализации: если simplify=false, а "после" всё равно
    // равно "до" — упрощение и не должно было ничего срезать (это не баг,
    // значит у исходных точек и так нет лишней плотности на этом участке).
    // Если simplify=true и "после" заметно меньше "до" — упрощение реально
    // сработало. Если же simplify=false, а "после" меньше "до" — вот это
    // уже повод разбираться, сюда попасть в текущей логике нельзя.
    console.log(
      `[TimelineMap] renderSegments: simplify=${simplify}, сегментов=${drawnSegments}, ` +
        `точек до=${rawPointTotal}, точек после=${renderedPointTotal}` +
        (rawPointTotal > 0
          ? ` (сокращение ${(100 - (renderedPointTotal / rawPointTotal) * 100).toFixed(1)}%)`
          : '')
    );
  }

  /**
   * Рисует места (кластеры визитов) как маркеры с размером по числу визитов.
   * @param {Array} places
   */
  renderPlaces(places) {
    this.placeLayer.clearLayers();

    for (const place of places) {
      if (!place.location) continue;
      const radius = Math.min(8 + place.visitCount * 1.5, 28);

      const marker = L.circleMarker([place.location.lat, place.location.lng], {
        radius,
        color: CONFIG.ACTIVITY_COLORS.VISIT,
        fillColor: CONFIG.ACTIVITY_COLORS.VISIT,
        fillOpacity: 0.55,
        weight: 2,
      });

      marker.on('click', () => this._onPlaceClick?.(place));
      marker.bindTooltip(this._placeTooltip(place), { sticky: true });
      marker.addTo(this.placeLayer);
    }
  }

  /**
   * Отмечает точки с аномальной скоростью — обычно GPS-сбои.
   * @param {Array<{from:object,to:object,speedKmh:number}>} anomalies
   */
  renderAnomalies(anomalies) {
    this.anomalyLayer.clearLayers();

    for (const a of anomalies) {
      const marker = L.circleMarker([a.to.lat, a.to.lng], {
        radius: 6,
        color: '#EF4444',
        fillColor: '#EF4444',
        fillOpacity: 0.9,
        weight: 1,
      });
      marker.bindTooltip(
        `Аномалия: ${a.speedKmh.toFixed(0)} км/ч · ${this._fmtDateTime(a.to.timestamp)}`,
        { sticky: true }
      );
      marker.addTo(this.anomalyLayer);
    }
  }

  /** Подгоняет вьюпорт карты под переданные точки. */
  fitToPoints(points) {
    if (!points.length) return;
    const latlngs = points.map((p) => [p.lat, p.lng]);
    this.map.fitBounds(latlngs, { padding: [24, 24] });
  }

  _segmentTooltip(seg) {
    const durationMin = Math.round((seg.end - seg.start) / 60000);
    const km = seg.distanceMeters ? (seg.distanceMeters / 1000).toFixed(1) : '?';
    return `${seg.activityType || 'UNKNOWN'} · ${km} км · ${durationMin} мин · ${this._fmtDateTime(seg.start)}`;
  }

  _placeTooltip(place) {
    const hours = (place.totalDurationMs / 3600000).toFixed(1);
    const types = Array.from(place.semanticTypes || []).join(', ') || 'Место';
    return `${types} · ${place.visitCount} визитов · ${hours} ч`;
  }

  /** Форматирует метку времени как "DD.MM.YYYY HH:mm" в локальном часовом поясе браузера. */
  _fmtDateTime(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}
