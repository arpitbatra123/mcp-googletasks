# Dockerfile for Google Tasks MCP Server

FROM node:22-alpine AS builder

# set working directory
WORKDIR /app

# copy package manifests
COPY package.json package-lock.json tsconfig.json ./

# install dependencies
RUN npm ci

# copy source files
COPY src ./src

# build the project
RUN npm run build

# production image
FROM node:22-alpine
WORKDIR /app

# copy built files and dependencies
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY package.json .

# set environment to production
ENV NODE_ENV=production

# default command
CMD ["node", "build/index.js"]
