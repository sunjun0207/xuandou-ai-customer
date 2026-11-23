# 国内构建默认走 DaoCloud 基础镜像和 npmmirror。
ARG NODE_IMAGE=docker.m.daocloud.io/library/node:20-alpine
FROM ${NODE_IMAGE}

WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmmirror.com
COPY package.json package-lock.json* ./
RUN npm config set registry ${NPM_REGISTRY} && npm install
COPY . .
RUN npm run build

EXPOSE 4100
CMD ["npm", "start"]
