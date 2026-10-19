FROM node:24-bookworm-slim
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.12.4 --activate
ENV CI=true
COPY --chown=node:node package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json prisma.config.ts ./
COPY --chown=node:node prisma ./prisma
COPY --chown=node:node lib ./lib
COPY --chown=node:node server ./server
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production
USER node
CMD ["./node_modules/.bin/tsx", "server/workers/run.ts"]
