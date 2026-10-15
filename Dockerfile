# modelwharf — 模型码头
# 多阶段构建：deps 阶段带编译工具链（better-sqlite3 系原生模块），
# 运行阶段用 slim 镜像，只留 node_modules 与源码。
FROM node:24-bookworm-slim AS deps
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    WH_PORT=8317 \
    WH_DATA_DIR=/app/data \
    WH_LOG_DIR=/app/logs
COPY --from=deps /app/node_modules ./node_modules
COPY package.json README.md CHANGELOG.md LICENSE ./
COPY src ./src
COPY scripts ./scripts
EXPOSE 8317
VOLUME ["/app/data", "/app/logs"]
CMD ["node", "src/server.js"]
