FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY *.mjs ./
USER node
EXPOSE 8080
ENV NODE_ENV=production
CMD ["node", "--max-old-space-size=384", "server.mjs"]
