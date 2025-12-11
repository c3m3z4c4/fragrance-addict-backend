FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --only=production
COPY . .
EXPOSE 3000
CMD ["node", "src/index.js"]
# This Dockerfile sets up a Node.js application using the official Node.js 20 Alpine image. It installs production dependencies and starts the application on port 3000.