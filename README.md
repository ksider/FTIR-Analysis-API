# FTIR Analysis API

Standalone backend for the static FTIR frontend.

## Local

```bash
cp .env.example .env
# Put GEMINI_API_KEY in .env locally.
npm start
```

Default endpoint: `http://127.0.0.1:8787`.

## Docker

```bash
cp .env.example .env
docker compose up --build -d
curl http://127.0.0.1:8787/health
```

Required production settings:

```env
HOST=0.0.0.0
PORT=8787
REFERENCE_DIR=/app/references
LLM_PROVIDER=gemini
LLM_MODEL=gemini-3.5-flash-lite
GEMINI_API_KEY=...
ALLOWED_ORIGIN=https://your-frontend.example
```

Never commit `.env`. Use the hosting provider's encrypted environment variables
or secret manager in production. The `references/` directory must contain
`bands_master.md` and `diagnostic_zones.md`.

## Frontend connection

In the static frontend's `config.js`, set:

```js
analysisApi: 'https://your-api.example/api/analyze'
```

The backend accepts only confirmed peaks and returns the interpretation result.
