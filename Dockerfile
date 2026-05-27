# Fragrance catalog API with Chromium for scraping
# Legitimate use: scraping fragrantica.com to build a perfume catalog database
FROM node:20-slim

# Install Chromium and required system libraries
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Use system Chromium (avoids downloading a second copy)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

# Cap Node heap to keep memory predictable under load.
# Cap scraping concurrency and pacing so shared hosts (Hostinger) don't flag CPU bursts.
ENV NODE_OPTIONS=--max-old-space-size=512
ENV SCRAPE_WORKERS=1
ENV BETWEEN_REQUESTS_MS=8000
ENV BROWSER_RESTART_AFTER_PAGES=30

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

CMD ["node", "src/index.js"]
