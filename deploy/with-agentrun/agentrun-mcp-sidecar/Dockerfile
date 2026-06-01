# 构建阶段
FROM node:20-alpine AS builder

WORKDIR /app

# 复制依赖文件
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# 复制源码并构建
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm ci && npm run build

# 运行阶段
FROM node:20-alpine

WORKDIR /app

# 复制生产依赖和构建产物
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --production

COPY --from=builder /app/dist ./dist

# 暴露端口
EXPOSE 3000

# 默认启动 HTTP 服务
CMD ["node", "dist/server.js"]
