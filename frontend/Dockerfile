FROM node:24.18.0-bookworm-slim AS dev
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
EXPOSE 4200
CMD ["sh", "docker-entrypoint.sh"]
