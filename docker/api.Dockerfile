# syntax=docker/dockerfile:1

FROM node:26-alpine AS base
RUN npm install --global pnpm@12.16.1
WORKDIR /repo

FROM base AS build
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @vizscript/api run build
RUN pnpm --filter @vizscript/api deploy --prod --legacy /out

FROM node:26-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/package.json ./package.json
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
USER node
EXPOSE 3333
CMD ["node", "--enable-source-maps", "dist/main.mjs"]
