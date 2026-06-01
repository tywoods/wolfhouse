FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV STAFF_QUERY_API_PORT=3036
ENV STAFF_QUERY_API_HOST=0.0.0.0

COPY package*.json ./
RUN npm ci --omit=dev

COPY scripts ./scripts
COPY database ./database
COPY config ./config

EXPOSE 3036

CMD ["npm", "run", "staff:api"]
