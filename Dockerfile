FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server.mjs us-markets.mjs us-session.mjs cfets-market.mjs cny-market.mjs hk-stocks.mjs hstech-market.mjs mainland-stocks.mjs fundamentals.mjs ./
COPY data/global-history ./data/global-history
COPY data/hk-stocks ./data/hk-stocks
EXPOSE 4174
CMD ["node", "server.mjs"]
