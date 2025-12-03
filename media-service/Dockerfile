FROM node:20-alpine

# Sharp requires some native dependencies
RUN apk add --no-cache vips-dev

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY src ./src

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001
USER nodejs

EXPOSE 3003

CMD ["npm", "start"]
