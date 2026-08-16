FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

FROM deps AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production
EXPOSE 8080
EXPOSE 8090
CMD ["bun", "run", "src/cmd/zenproxy.ts"]
