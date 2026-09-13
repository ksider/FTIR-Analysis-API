# FTIR Merger backend

Отдельный Node.js backend для FTIR Merger. Он не содержит frontend и работает
как самостоятельный API-модуль:

- принимает точки спектров и запускает Python peak detector;
- возвращает пики, baseline diagnostics и обработанную кривую;
- сравнивает пики между спектрами;
- отправляет подтверждённые данные выбранному LLM-провайдеру;
- хранит reference bands и diagnostic zones на стороне сервера.

Полная документация проекта находится в корневом [README.md](../README.md).

## Локальный запуск

Требуется Node.js `>=20.6` и Python `>=3.9`.

```bash
cp .env.example .env
python3 -m pip install -r requirements.txt
npm start
```

По умолчанию API доступен по адресу `http://127.0.0.1:8787`.

```bash
curl http://127.0.0.1:8787/health
```

Для smoke-тестов без внешней LLM:

```env
LLM_PROVIDER=mock
```

Для Gemini:

```env
LLM_PROVIDER=gemini
LLM_MODEL=gemini-3.5-flash-lite
GEMINI_API_KEY=your_key
```

Также поддерживается Mistral через `MISTRAL_API_KEY`.

## Endpoints

### `POST /api/peaks/detect`

Получает `schemaVersion: "2.0"`, точки одного или нескольких спектров и
параметры detector. Каждый спектр обрабатывается независимо. Ответ содержит
`peakObservations[]`, `spectrumId`, информацию о baseline engine и массивы
для визуального preview.

Основной алгоритм использует `scipy.signal.find_peaks`. Baseline-коррекция
работает через `pybaselines`; при отсутствии научных зависимостей backend
возвращает builtin fallback и предупреждение.

Поддерживаются `arPLS`, `airPLS`, `AsLS`, `SNIP`, `Rubberband`, `Linear` и `None`.

### `POST /api/analyze`

Получает подтверждённые пики, все спектры и сравнительные группы. LLM получает
данные пиков по всем спектрам, чтобы интерпретировать сдвиги, появление,
исчезновение и изменение интенсивности/ширины полос.

JSON Schema находятся в `contracts/`:

- `peaks-detect-request.schema.json`;
- `peaks-detect-response.schema.json`;
- `analyze-request.schema.json`;
- `analyze-response.schema.json`.

## Docker

```bash
cp .env.example .env
docker compose up --build -d
curl http://127.0.0.1:8787/health
```

Dockerfile устанавливает Python-зависимости в отдельное virtualenv и задаёт
`PYTHON_BIN=/opt/ftir-venv/bin/python`.

Перед публичным запуском задай `ALLOWED_ORIGIN` точным origin frontend и
передай API-ключи через secret manager или переменные окружения.

## Python dependencies and licenses

| Пакет | Лицензия | Использование |
|---|---|---|
| SciPy `>=1.11,<2` | BSD-3-Clause | поиск пиков и измерение ширины |
| pybaselines `>=1.2,<2` | BSD-3-Clause | baseline correction |
| NumPy (транзитивная зависимость) | BSD-3-Clause | численные массивы |

При распространении Docker-образа необходимо сохранять notices SciPy,
pybaselines, NumPy и их bundled-зависимостей.
