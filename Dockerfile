# Use the latest Node 22 slim image
FROM node:22-slim

# Install system dependencies
# - ffmpeg: Required for audio processing [cite: 1582]
# - build-essential & python3: Required for building native modules like @discordjs/opus [cite: 1582, 1610]
RUN apt-get update && apt-get install -y \
    ffmpeg \
    build-essential \
    python3 \
    espeak-ng \
    && rm -rf /var/lib/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files first to leverage Docker layer caching
COPY package*.json ./

# Install dependencies
# This will install @discordjs/voice (v0.19.1) and discord.js (v14.25.1)
# as specified in the package.json
RUN npm install

# Copy the rest of the application code
COPY . .

# Expose the status server port (default 3000)
EXPOSE 3000

# Start the application
CMD ["npm", "start"]