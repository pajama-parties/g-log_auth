# auth 서버 이미지. 같은 이미지로 마이그레이션도 실행함 (docker-compose.yml의 migrate 서비스)
# 빌드 전에 Entity 서브모듈이 받아져 있어야 함: git submodule update --init

# ── 빌드 ──
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN test -f src/database/schema/entities/index.ts || (echo 'Entity 서브모듈이 비어 있습니다. git submodule update --init 을 먼저 실행하세요.' && exit 1)
RUN npm run build

# ── 실행 ──
FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
