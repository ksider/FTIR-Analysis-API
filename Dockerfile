FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY references ./references

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
ENV REFERENCE_DIR=/app/references

EXPOSE 8787

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/health').then(r => { if (!r.ok) process.exit(1); }).catch(() => process.exit(1))"

CMD ["node", "server.js"]
