FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
COPY --chown=node:node . .
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production
USER node
CMD ["./node_modules/.bin/tsx", "server/workers/run.ts"]
