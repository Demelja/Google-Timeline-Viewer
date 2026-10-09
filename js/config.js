/**
 * config.js
 * Глобальная конфигурация приложения Timeline Viewer 3.0.
 * Никакой логики — только константы, к которым обращаются остальные модули.
 */

export const CONFIG = {
  APP_NAME: 'Timeline Viewer',
  APP_VERSION: '4C.5',

  // --- Карта -------------------------------------------------------------
  MAP: {
    DEFAULT_CENTER: [52.2297, 21.0122], // Варшава — просто безопасный дефолт
    DEFAULT_ZOOM: 11,
    MIN_ZOOM: 2,
    MAX_ZOOM: 19,
    // С 2026 года CARTO требует API-ключ для растровых тайлов (новый путь —
    // /rastertiles/...). Без ключа запрос всё равно вернёт 200 OK, но на
    // тайле будет водяной знак "API KEY REQUIRED" — поэтому в консоли это
    // не видно как ошибка. Ключ можно получить на carto.com/basemaps/apikey.
    // Два варианта подложки — карта следует за темой страницы (см. map.js setTheme).
    TILE_URL_DARK: 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png',
    TILE_URL_LIGHT: 'https://{s}.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png',
    CARTO_API_KEY: '', // <-- вставьте сюда свой ключ
    TILE_ATTRIBUTION:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },

  // --- Цвета типов активности (используются картой и UI) -----------------
  ACTIVITY_COLORS: {
    WALKING: '#4ADE80',
    RUNNING: '#22D3EE',
    CYCLING: '#60A5FA',
    IN_PASSENGER_VEHICLE: '#F472B6',
    IN_BUS: '#FB923C',
    IN_TRAIN: '#A78BFA',
    IN_SUBWAY: '#C084FC',
    IN_TRAM: '#F59E0B',
    IN_FERRY: '#38BDF8',
    FLYING: '#F87171',
    // Старый формат (Android Activity Recognition API) использует другие
    // имена типов активности, чем новый Timeline.json — добавляем алиасы,
    // чтобы и там треки красились осмысленно, а не серым UNKNOWN.
    IN_VEHICLE: '#F472B6',
    ON_BICYCLE: '#60A5FA',
    ON_FOOT: '#4ADE80',
    EXITING_VEHICLE: '#FDBA74',
    TILTING: '#94A3B8',
    STILL: '#94A3B8',
    UNKNOWN: '#64748B',
    VISIT: '#FACC15',
  },

  // --- Пороговые значения для анализа --------------------------------------
  ANALYSIS: {
    // Скорость (км/ч), выше которой точка считается выбросом/аномалией
    MAX_PLAUSIBLE_SPEED_KMH: 300,
    // Минимальная длительность визита (мс), чтобы попасть в статистику мест
    MIN_VISIT_DURATION_MS: 5 * 60 * 1000,
    // Радиус (м) для группировки близких визитов в одно "место"
    PLACE_CLUSTER_RADIUS_M: 150,
  },

  // --- Тепловая карта --------------------------------------------------------
  // Рисуются только визиты (VISIT) и точки с активностью UNKNOWN; пока
  // тепловая карта включена, остальные слои (маршруты, маркеры мест,
  // аномалии) скрыты. Подробнее — buildHeatPoints в parser/analyzer.js.
  HEATMAP: {
    // Вес визита без длительности (например, Point из KML), мс
    POINT_VISIT_WEIGHT_MS: 5 * 60 * 1000,
    // Ограничение веса одной UNKNOWN-точки (мс): длинные паузы в записи не
    // должны превращаться в "многочасовое пребывание"
    MAX_POINT_DWELL_MS: 15 * 60 * 1000,
    // Размер ячейки агрегации в градусах (~55 м по широте): сотни тысяч
    // точек схлопываются в тысячи ячеек, иначе карта будет тормозить
    CELL_DEG: 0.0005,
    // Параметры слоя Leaflet.heat
    RADIUS: 22,
    BLUR: 18,
    // В Leaflet.heat это масштаб, на котором точки достигают полной
    // интенсивности; на более мелких масштабах она ослабевает в 2^N раз и
    // карта выглядит почти пустой. Малое значение отключает это затухание.
    MAX_ZOOM: 1,
    MIN_OPACITY: 0.3,
    GRADIENT: { 0.2: '#4ecbe0', 0.5: '#f0a94e', 0.8: '#ef4444', 1.0: '#fff3d6' },
  },

  // --- Упрощение геометрии (Douglas-Peucker) ------------------------------
  SIMPLIFIER: {
    // Допуск в метрах: чем больше, тем сильнее упрощение трека
    DEFAULT_TOLERANCE_M: 15,
    // Если точек в треке меньше — упрощение не применяется
    MIN_POINTS_TO_SIMPLIFY: 3,
    // Если диапазон дат в фильтрах задан целиком (и от, и до) и не превышает
    // это число дней — упрощение трека отключается полностью: при разборе
    // короткого периода важнее максимальная детализация, чем скорость рендера.
    DETAIL_THRESHOLD_DAYS: 14,
  },

  // --- Индексация ----------------------------------------------------------
  INDEXER: {
    // Гранулярность временного индекса
    TIME_BUCKET: 'day', // 'day' | 'month'
  },

  STORAGE_KEYS: {
    LAST_FILTERS: 'tlv3.lastFilters',
  },
};
