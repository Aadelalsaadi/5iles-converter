FROM node:20-slim

RUN apt-get update && apt-get install -y \
  ffmpeg \
  poppler-utils \
  zip \
  --no-install-recommends \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN mkdir -p /tmp/uploads /tmp/outputs

COPY package*.json ./

RUN npm install --production

COPY server.js .

EXPOSE 3000

CMD ["node", "server.js"]
