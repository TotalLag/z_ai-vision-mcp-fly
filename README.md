# Generic MCP Server Proxy

A flexible, production-ready proxy server that wraps any stdio-based MCP (Model Context Protocol) server with bearer token authentication and SSE streaming support.

## Overview

This scaffold provides a robust infrastructure for deploying MCP servers with:
- **Bearer token authentication** for secure access
- **SSE streaming** for real-time MCP protocol communication  
- **Health monitoring** and graceful startup handling
- **Structured logging** for debugging and monitoring
- **Production-ready** error handling and graceful shutdown

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Required Environment Variables

**Required:**
- `MCP_COMMAND` - Command to start your MCP server

**Optional (for production):**
- `BEARER_TOKEN` - Authentication token for API access
- `DEBUG_LOGGING` - Enable verbose logging (`true` or `1`)
- `PORT` - External port (default: 8080)

### 3. Configure Your MCP Server

Set the `MCP_COMMAND` environment variable to the command that starts your MCP server:

```bash
# GitHub MCP Server
export MCP_COMMAND="npx -y @modelcontextprotocol/server-github"

# Linear MCP Server  
export MCP_COMMAND="npx -y @linear-mcp/server"

# Custom MCP Server
export MCP_COMMAND="node /path/to/your/mcp-server.js"
```

### 4. Add Tool-Specific Environment Variables

Pass through any credentials your MCP server needs:

```bash
export GITHUB_TOKEN="ghp_..."
export LINEAR_API_KEY="lin_api_..."
export OPENAI_API_KEY="sk-..."
```

### 5. Start the Proxy

```bash
node server.js
```

The proxy will start on port 8080 and spawn your MCP server via supergateway.

## Architecture

```
Client → Generic MCP Proxy (8080) → Supergateway (8000) → MCP Server (stdio)
```

### Component Details

- **Generic MCP Proxy**: HTTP server with bearer auth, request routing, and SSE streaming
- **Supergateway**: Bridges HTTP/SSE to stdio for MCP protocol communication
- **MCP Server**: Your specific MCP tool server (any stdio-based implementation)

## Configuration

| Environment Variable | Required | Purpose | Example |
|---------------------|----------|---------|---------|
| `MCP_COMMAND` | ✅ Yes | Command to start MCP server | `npx -y @modelcontextprotocol/server-github` |
| `BEARER_TOKEN` | ⚠️ Production | Authentication for API | `$(openssl rand -base64 32)` |
| `DEBUG_LOGGING` | ❌ No | Enable verbose logging | `true` or `1` |
| `PORT` | ❌ No | External port | `8080` |
| Tool-specific vars | Varies | Credentials for MCP server | `GITHUB_TOKEN`, `OPENAI_API_KEY` |

## API Endpoints

### `GET /sse`
SSE endpoint for MCP protocol communication (requires bearer token in production)

### `POST /sse` 
HTTP endpoint for MCP requests (requires bearer token in production)

### `GET /health`
Health check endpoint - returns gateway status

## Authentication

### Development Mode
Authentication is optional when:
- `NODE_ENV` is not `"production"`
- `FLY_APP_NAME` is not set

### Production Mode
Authentication is required when:
- `NODE_ENV` is `"production"`
- `FLY_APP_NAME` is set (Fly.io deployment)

Generate a secure token:
```bash
TOKEN=$(openssl rand -base64 32)
echo $TOKEN
```

Set the token:
```bash
export BEARER_TOKEN="$TOKEN"
```

## Deployment Examples

### Fly.io Deployment

1. **Create `fly.toml`:**
```toml
[build]
  dockerfile = "Dockerfile"

[env]
  PORT = "8080"

[env.production]
  BEARER_TOKEN = { required = true }

[processes]
  web = "node server.js"

[[services]]
  internal_port = 8080
  protocol = "tcp"
```

2. **Deploy:**
```bash
flyctl deploy --remote-only
```

3. **Set secrets:**
```bash
flyctl secrets set BEARER_TOKEN="$TOKEN"
flyctl secrets set MCP_COMMAND="npx -y @modelcontextprotocol/server-github"
flyctl secrets set GITHUB_TOKEN="ghp_..."
```

### Docker Deployment

1. **Create `Dockerfile`:**
```dockerfile
FROM node:18-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 8080
CMD ["node", "server.js"]
```

2. **Build and run:**
```bash
docker build -t mcp-proxy .
docker run -p 8080:8080 \
  -e MCP_COMMAND="npx -y @modelcontextprotocol/server-github" \
  -e BEARER_TOKEN="$TOKEN" \
  -e GITHUB_TOKEN="ghp_..." \
  mcp-proxy
```

## MCP Server Compatibility

This proxy works with any MCP server that:
- Communicates via stdio
- Follows the MCP protocol specification
- Can be started with a command-line interface

### Tested MCP Servers
- `@modelcontextprotocol/server-github`
- `@linear-mcp/server`
- Custom stdio-based MCP servers

## Monitoring and Debugging

### Structured Logging

All events are logged as JSON with the following structure:
```json
{
  "timestamp": "2025-01-01T00:00:00.000Z",
  "level": "info",
  "category": "mcp-call",
  "phase": "runtime",
  "message": "MCP method: tools/call",
  "data": { "requestId": "abc123", "method": "tools/call" }
}
```

### Debug Mode

Enable verbose logging:
```bash
export DEBUG_LOGGING=true
node server.js
```

### Health Monitoring

Monitor gateway health:
```bash
curl http://localhost:8080/health
```

Response:
```json
{
  "status": "healthy",
  "gatewayReady": true,
  "gatewayExited": false,
  "uptimeMs": 12345
}
```

## Troubleshooting

### Common Issues

**"MCP_COMMAND environment variable is required"**
- Set the `MCP_COMMAND` environment variable to your MCP server startup command

**"BEARER_TOKEN is required in production"**
- Generate and set a secure bearer token for production deployments

**"Gateway startup timeout"**
- Check that your MCP command is valid and the server can start
- Verify all required environment variables are set for your MCP server

**"Service Unavailable: MCP gateway has exited"**
- Check the logs for startup errors
- Ensure your MCP server is compatible and properly configured

### Debug Steps

1. **Verify MCP command manually:**
```bash
eval $MCP_COMMAND --help
```

2. **Check environment variables:**
```bash
env | grep -E "(MCP_COMMAND|BEARER_TOKEN)"
```

3. **Enable debug logging:**
```bash
export DEBUG_LOGGING=true
node server.js
```

4. **Test health endpoint:**
```bash
curl -v http://localhost:8080/health
```

## Security Considerations

- **Always use bearer tokens in production** - the endpoint is otherwise publicly accessible
- **Rotate tokens regularly** - implement token rotation in your deployment pipeline
- **Limit token scope** - use tokens with minimal required permissions
- **Monitor access logs** - watch for unauthorized access attempts
- **Use HTTPS in production** - terminate TLS at your load balancer or reverse proxy

## Performance

- **Cold start handling** - proxy waits for MCP server startup before accepting requests
- **SSE streaming** - long-lived connections are properly managed with no timeout
- **Request buffering** - HTTP requests are buffered; SSE responses are streamed
- **Resource limits** - gateway process has 50MB buffer limit to prevent memory issues

## License

MIT License - feel free to use this scaffold for your MCP server deployments.
