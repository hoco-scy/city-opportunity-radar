FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    RADAR_DB_PATH=/data/menglin-opportunity-radar.sqlite \
    RADAR_COLLECTORS_ROOT=/app/collectors \
    RADAR_BACKUP_DIR=/backups \
    RADAR_IMPORT_ON_START=1

WORKDIR /app

# The repository is a self-contained monorepo: the service and all four city
# collectors are copied from one Docker build context.
COPY --chown=node:node . /app/

RUN for city in beijing shanghai guangzhou shenzhen; do \
      cd "/app/collectors/${city}" && npm ci --omit=dev --ignore-scripts; \
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
