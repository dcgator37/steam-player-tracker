FROM node:24-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY src ./src

COPY sql ./sql

EXPOSE 3000

CMD ["npm", "start"]