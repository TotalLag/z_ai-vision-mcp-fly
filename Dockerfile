# Z.AI Vision MCP Server Proxy Dockerfile
# This Dockerfile creates a minimal, production-ready container for the Z.AI Vision MCP proxy

FROM node:18-alpine

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (production only)
RUN npm install --omit=dev && npm cache clean --force

# Add node_modules/.bin to PATH so supergateway is available
ENV PATH="/app/node_modules/.bin:$PATH"

# Copy application code
COPY . .

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Change ownership of the app directory
RUN chown -R nodejs:nodejs /app
USER nodejs

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) }).on('error', () => process.exit(1))"

# Start the proxy server
CMD ["node", "server.js"]
