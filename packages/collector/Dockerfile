# Build from the repository root:
#   docker build -f packages/collector/Dockerfile -t backloop-collector .
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @backloop/collector... \
 && pnpm --filter @backloop/sdk --filter @backloop/collector run build \
 && pnpm --filter @backloop/collector deploy --prod --legacy /out

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out .
ENV PORT=4700 COLLECTOR_DATA_FILE=/data/feedback.jsonl
VOLUME /data
EXPOSE 4700
CMD ["node", "dist/cli.js"]
