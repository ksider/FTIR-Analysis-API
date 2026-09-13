# FTIR API contract v2

Версия `2.0` вводит явную принадлежность каждого наблюдения к спектру.

## Идентификаторы

- `spectrum.id` — стабильный ID загруженного спектра в рамках сессии.
- `peakObservation.id` — стабильный ID конкретного пика в конкретном спектре.
- `peakGroup.id` — ID сопоставленной полосы между спектрами; это не новый пик.
- `peakGroup.members[]` связывает `spectrumId` и `peakId`.

Одинаковое волновое число в разных файлах не означает один и тот же пик. Объединение выполняется только через `peakGroups` и с явным `toleranceCm1`.

## Endpoints

### `POST /api/peaks/detect`

Получает исходные точки всех спектров и настройки детектора. Детектирует каждый спектр независимо.

- request: `peaks-detect-request.schema.json`;
- response: `peaks-detect-response.schema.json`.

### `POST /api/analyze`

Получает рассчитанные пики всех спектров, группы сопоставления и список подтверждённых пользователем пиков. Полные массивы точек для LLM не обязательны и в этот endpoint не входят.

- request: `analyze-request.schema.json`;
- response: `analyze-response.schema.json`.

## Текущий статус

Frontend и backend используют `schemaVersion: "2.0"` для peak detection и
comparative analysis. Backend сохраняет обработку legacy payload `version:
"1.0"` для старых сохранённых сессий.
