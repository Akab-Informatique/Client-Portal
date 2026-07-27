# AKAB Portal v1 — multi-stage production image
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install tsx@4.19.2 --no-save
COPY --from=build /app/dist ./dist
COPY api ./api
COPY server ./server
COPY vite-plugins ./vite-plugins
EXPOSE 3000
CMD ["node", "--import", "tsx", "server/prod-server.mjs"]
