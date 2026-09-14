FROM node:20-bookworm-slim

WORKDIR /app

COPY requirements.txt /tmp/ftir-requirements.txt

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv \
  && python3 -m venv /opt/ftir-venv \
  && apt-get purge -y --auto-remove python3-venv \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY server.js ./
COPY peak_comparison.js ./
COPY references ./references
COPY peak_detector ./peak_detector

RUN /opt/ftir-venv/bin/pip install --no-cache-dir -r /tmp/ftir-requirements.txt

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
ENV REFERENCE_DIR=/app/references
ENV PYTHON_BIN=/opt/ftir-venv/bin/python

EXPOSE 8787

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "server.js"]
