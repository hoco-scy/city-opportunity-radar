FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    RADAR_DB_PATH=/data/menglin-opportunity-radar.sqlite \
    RADAR_LEGACY_ROOT=/radars \
    RADAR_BACKUP_DIR=/backups \
    RADAR_IMPORT_ON_START=1

WORKDIR /app

# The Compose build context is the common parent of the unified repository and
# the four city repositories. The resulting image therefore contains the full
# collection runtime instead of serving only a static snapshot.
COPY --chown=node:node city-opportunity-radar-public/ /app/
COPY --chown=node:node beijing-opportunity-radar-public/ /radars/beijing-opportunity-radar-public/
COPY --chown=node:node shanghai-opportunity-radar-public/ /radars/shanghai-opportunity-radar-public/
COPY --chown=node:node guangzhou-opportunity-radar-public/ /radars/guangzhou-opportunity-radar-public/
COPY --chown=node:node shenzhen-opportunity-radar-public/ /radars/shenzhen-opportunity-radar-public/

RUN for city in beijing shanghai guangzhou shenzhen; do \
      cd "/radars/${city}-opportunity-radar-public" && npm ci --omit=dev --ignore-scripts; \
    done \
    && mkdir -p /data /backups \
    && chown node:node /data /backups \
    && chmod 0755 /app/docker-entrypoint.sh

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.mjs"]
