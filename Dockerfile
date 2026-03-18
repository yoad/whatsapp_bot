# /addons/whatsapp_bot/Dockerfile
FROM node:18-slim

# No Chromium needed — WhatsApp connection is handled by whatsapp_client addon

# Set working directory
WORKDIR /usr/src/app

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy the bot script
COPY . .

# Expose port for reminder editor UI
EXPOSE 3000

# Set the command to run the bot
CMD [ "node", "bot.js" ]
