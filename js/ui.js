/**
 * ui.js
 * Всё взаимодействие с DOM живёт здесь: рендер статистики, списка мест,
 * элементов управления фильтрами и статуса загрузки файла.
 * Модуль не знает про парсинг/анализ — получает уже готовые данные
 * и эмитит события через переданные колбэки (см. app.js).
 */

import { CONFIG } from './config.js';

const el = (id) => document.getElementById(id);

export class UI {
  constructor() {
    this.elements = {
      dropzone: el('dropzone'),
      fileInput: el('file-input'),
      statusBar: el('status-bar'),
      stats: el('stats-panel'),
      placesList: el('places-list'),
      activityFilters: el('activity-filters'),
      dateFrom: el('date-from'),
      dateTo: el('date-to'),
      resetFiltersBtn: el('reset-filters'),
      loadingOverlay: el('loading-overlay'),
      brandName: el('brand-name'),
      brandVersion: el('brand-version'),
      themeToggle: el('theme-toggle'),
      themeToggleIcon: document.querySelector('.theme-toggle-icon'),
      heatmapToggle: el('heatmap-toggle'),
      heatmapRow: el('heatmap-row'),
    };
  }

  // --- Слои карты: тепловая карта ---------------------------------------------

  static HEATMAP_STORAGE_KEY = 'tlv3.heatmap';

  /** Сохранённое состояние переключателя (по умолчанию выключено). */
  static loadHeatmapPreference() {
    try {
      return localStorage.getItem(UI.HEATMAP_STORAGE_KEY) === '1';
    } catch {
      return false;
    }
  }

  /**
   * Выставляет начальное состояние переключателя и вешает обработчик.
   * @param {boolean} initial
   * @param {(enabled: boolean) => void} onChange
   */
  initHeatmapToggle(initial, onChange) {
    const toggle = this.elements.heatmapToggle;
    if (!toggle) return;
    toggle.checked = initial;
    toggle.addEventListener('change', () => {
      try {
        localStorage.setItem(UI.HEATMAP_STORAGE_KEY, toggle.checked ? '1' : '0');
      } catch {
        // не критично — просто не переживёт перезагрузку
      }
      onChange(toggle.checked);
    });
  }

  /**
   * Дополняет всплывающую подсказку переключателя строкой о том, по каким
   * данным сейчас построена тепловая карта. Базовый текст подсказки берётся
   * из атрибута title в index.html.
   */
  setHeatmapInfo(text) {
    const row = this.elements.heatmapRow;
    if (!row) return;
    if (this._heatmapBaseTitle === undefined) this._heatmapBaseTitle = row.title;
    row.title = text ? `${this._heatmapBaseTitle}\n${text}` : this._heatmapBaseTitle;
  }

  // --- Брендинг (имя/версия из config.js, без дублирования в HTML) -------

  /**
   * Заполняет заголовок вкладки и шапку страницы из CONFIG, чтобы версия
   * и название жили в одном месте (js/config.js), а не дублировались в HTML.
   */
  applyBranding({ name, version, tagline }) {
    document.title = name;
    if (this.elements.brandName) this.elements.brandName.textContent = name;
    if (this.elements.brandVersion) {
      this.elements.brandVersion.textContent = `v${version} — ${tagline}`;
    }
  }

  // --- Тема (тёмная/светлая) ------------------------------------------------

  static THEME_STORAGE_KEY = 'tlv3.theme';

  /**
   * Инициализирует тему при старте (сохранённая -> системная -> тёмная по
   * умолчанию) и вешает обработчик на кнопку-переключатель. onThemeChange
   * вызывается сразу с начальной темой и далее при каждом переключении —
   * используется в app.js, чтобы синхронно переключить подложку карты.
   * @param {(theme: 'dark'|'light') => void} onThemeChange
   */
  initTheme(onThemeChange) {
    let stored = null;
    try {
      stored = localStorage.getItem(UI.THEME_STORAGE_KEY);
    } catch {
      // localStorage недоступен (приватный режим и т.п.) — просто не сохраняем
    }

    const systemPrefersLight =
      window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
    const theme = stored === 'light' || stored === 'dark' ? stored : systemPrefersLight ? 'light' : 'dark';

    this._applyTheme(theme);
    onThemeChange?.(theme);

    this.elements.themeToggle?.addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      this._applyTheme(next);
      try {
        localStorage.setItem(UI.THEME_STORAGE_KEY, next);
      } catch {
        // некритично — просто не переживёт перезагрузку страницы
      }
      onThemeChange?.(next);
    });
  }

  _applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    if (this.elements.themeToggleIcon) {
      this.elements.themeToggleIcon.textContent = theme === 'light' ? '☀' : '☾';
    }
  }

  // --- Статус / загрузка --------------------------------------------------

  showLoading(message = 'Обработка...') {
    this.elements.loadingOverlay.textContent = message;
    this.elements.loadingOverlay.classList.remove('hidden');
  }

  hideLoading() {
    this.elements.loadingOverlay.classList.add('hidden');
  }

  setStatus(message, kind = 'info') {
    const bar = this.elements.statusBar;
    bar.textContent = message;
    bar.dataset.kind = kind;
    bar.classList.remove('hidden');
  }

  clearStatus() {
    this.elements.statusBar.classList.add('hidden');
  }

  // --- Загрузка файлов ------------------------------------------------------

  onFilesSelected(callback) {
    this.elements.fileInput.addEventListener('change', (e) => {
      if (e.target.files.length) callback(e.target.files);
    });

    const dz = this.elements.dropzone;

    // dragenter и dragover оба должны отменять действие по умолчанию —
    // без этого часть браузеров (в частности Firefox) не считает элемент
    // валидной зоной сброса и событие 'drop' просто не возникает.
    const allowDrop = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      dz.classList.add('dragover');
    };

    dz.addEventListener('dragenter', allowDrop);
    dz.addEventListener('dragover', allowDrop);

    dz.addEventListener('dragleave', (e) => {
      // dragleave всплывает и от дочерних элементов (иконка, текст) —
      // снимаем подсветку только когда курсор реально покинул dropzone.
      if (!dz.contains(e.relatedTarget)) dz.classList.remove('dragover');
    });

    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.remove('dragover');
      const files = e.dataTransfer?.files;
      if (files && files.length) callback(files);
    });

    // Подстраховка: если пользователь промахнулся мимо dropzone на пару
    // пикселей, браузер по умолчанию откроет файл как страницу —
    // блокируем это на уровне всего документа.
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());

    // Клик по зоне открывает системный диалог выбора файла. Игнорируем
    // клики, пришедшие от самого <input>, чтобы не вызывать click() дважды
    // (иначе в части браузеров диалог открывается и тут же закрывается).
    dz.addEventListener('click', (e) => {
      if (e.target === this.elements.fileInput) return;
      this.elements.fileInput.click();
    });

    // Сбрасываем value, иначе повторный выбор/drop того же файла
    // не вызовет событие 'change'.
    this.elements.fileInput.addEventListener('click', (e) => {
      e.target.value = '';
    });
  }

  // --- Статистика -----------------------------------------------------------

  /** @param {ReturnType<import('./parser/analyzer.js').buildSummary>} summary */
  renderSummary(summary) {
    const fmtKm = (km) => `${km.toFixed(1)} км`;
    const fmtHours = (ms) => `${(ms / 3600000).toFixed(1)} ч`;

    const activityRows = Object.entries(summary.distanceByActivityKm)
      .sort((a, b) => b[1] - a[1])
      .map(
        ([type, km]) => `
          <div class="stat-row">
            <span class="dot" style="background:${this._colorFor(type)}"></span>
            <span class="stat-label">${type}</span>
            <span class="stat-value">${fmtKm(km)}</span>
            <span class="stat-sub">${fmtHours(summary.timeByActivityMs[type] || 0)}</span>
          </div>`
      )
      .join('');

    const range = summary.dateRange
      ? `${this._fmtDate(summary.dateRange.from)} — ${this._fmtDate(summary.dateRange.to)}`
      : '—';

    this.elements.stats.innerHTML = `
      <div class="stat-highlight">
        <div class="stat-big">${summary.totalDistanceKm.toFixed(0)}</div>
        <div class="stat-big-label">км пройдено</div>
      </div>
      <div class="stat-grid">
        <div><span class="stat-value">${summary.pointCount.toLocaleString('ru-RU')}</span><span class="stat-label">точек</span></div>
        <div><span class="stat-value">${summary.daysCovered}</span><span class="stat-label">дней</span></div>
        <div><span class="stat-value">${summary.topPlaces.length}</span><span class="stat-label">мест</span></div>
        <div><span class="stat-value">${summary.speedAnomalyCount}</span><span class="stat-label">аномалий</span></div>
      </div>
      <div class="stat-range">${range}</div>
      <h3 class="panel-subtitle">По типам активности</h3>
      <div class="stat-rows">${activityRows || '<p class="muted">Нет данных о движении</p>'}</div>
    `;
  }

  /** @param {Array} places из analyzer.clusterPlaces */
  renderPlaces(places, onSelect) {
    this.elements.placesList.innerHTML = '';
    for (const place of places) {
      const item = document.createElement('button');
      item.className = 'place-item';
      const types = Array.from(place.semanticTypes || []).join(', ') || 'Неизвестное место';
      const hours = (place.totalDurationMs / 3600000).toFixed(1);
      item.innerHTML = `
        <span class="place-name">${types}</span>
        <span class="place-meta">${place.visitCount}× · ${hours} ч</span>
      `;
      item.addEventListener('click', () => onSelect?.(place));
      this.elements.placesList.appendChild(item);
    }
  }

  // --- Фильтры ---------------------------------------------------------------

  /** Заполняет список чекбоксов типов активности на основе имеющихся данных. */
  renderActivityFilterOptions(activityTypes, onChange) {
    const container = this.elements.activityFilters;
    container.innerHTML = '';
    for (const type of activityTypes) {
      const label = document.createElement('label');
      label.className = 'filter-checkbox';
      label.innerHTML = `
        <input type="checkbox" value="${type}" checked />
        <span class="dot" style="background:${this._colorFor(type)}"></span>
        ${type}
      `;
      label.querySelector('input').addEventListener('change', () => onChange(this._collectCheckedActivities()));
      container.appendChild(label);
    }
  }

  _collectCheckedActivities() {
    const boxes = this.elements.activityFilters.querySelectorAll('input[type="checkbox"]');
    return Array.from(boxes)
      .filter((b) => b.checked)
      .map((b) => b.value);
  }

  onDateRangeChange(callback) {
    this.elements.dateFrom.addEventListener('change', () =>
      callback(this._dateValue(this.elements.dateFrom), this._dateValue(this.elements.dateTo))
    );
    this.elements.dateTo.addEventListener('change', () =>
      callback(this._dateValue(this.elements.dateFrom), this._dateValue(this.elements.dateTo))
    );
  }

  onResetFilters(callback) {
    this.elements.resetFiltersBtn.addEventListener('click', callback);
  }

  resetFilterInputs() {
    this.elements.dateFrom.value = '';
    this.elements.dateTo.value = '';
    this.elements.activityFilters
      .querySelectorAll('input[type="checkbox"]')
      .forEach((b) => (b.checked = true));
  }

  setDateBounds(fromMs, toMs) {
    this.elements.dateFrom.min = this._toInputDate(fromMs);
    this.elements.dateFrom.max = this._toInputDate(toMs);
    this.elements.dateTo.min = this._toInputDate(fromMs);
    this.elements.dateTo.max = this._toInputDate(toMs);
  }

  // --- Утилиты -----------------------------------------------------------

  _colorFor(type) {
    return CONFIG.ACTIVITY_COLORS[type] || CONFIG.ACTIVITY_COLORS.UNKNOWN;
  }

  _fmtDate(ms) {
    return new Date(ms).toLocaleDateString('ru-RU', { year: 'numeric', month: 'short', day: 'numeric' });
  }

  _toInputDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  _dateValue(inputEl) {
    if (!inputEl.value) return null;
    return new Date(inputEl.value).getTime();
  }
}
