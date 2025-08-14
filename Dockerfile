FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production || npm ci

# Copy source
COPY server ./server
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server/index.js"]
