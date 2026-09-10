# 构建阶段 (多阶段分离构建)
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
COPY web/package*.json ./web/

RUN npm install

COPY . .

RUN npm run build

# 运行阶段 (纯协议极轻量 Alpine 环境，彻底移除 Chromium 与 GUI 字体库)
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV CTYUN_PORT=3088
ENV CTYUN_DATA_DIR=/app/data
ENV TZ=Asia/Shanghai

RUN apk add --no-cache \
    tzdata \
    ca-certificates && \
    cp /usr/share/zoneinfo/Asia/Shanghai /etc/localtime && \
    echo "Asia/Shanghai" > /etc/timezone

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist

VOLUME ["/app/data"]

EXPOSE 3088

CMD ["node", "dist/server.js"]
