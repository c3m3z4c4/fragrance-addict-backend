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

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 3000

# Run as non-root user for better security posture
RUN groupadd -r appuser && useradd -r -g appuser -G audio,video appuser \
    && chown -R appuser:appuser /app
USER appuser

CMD ["node", "src/index.js"]
