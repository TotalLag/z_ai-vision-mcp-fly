# Z.AI Vision MCP Server Proxy

A production-ready proxy server for deploying the Z.AI Vision MCP Server on Fly.io with bearer token authentication and SSE streaming support.

## Overview

This repository provides the infrastructure for deploying the Z.AI Vision MCP Server with:
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
- `MCP_COMMAND` - Command to start Z.AI Vision MCP Server (default: `npx -y @z_ai/mcp-server`)
- `Z_AI_API_KEY` - Your Z.AI API key (get from https://z.ai/manage-apikey/apikey-list)
- `Z_AI_MODE` - AI service platform (`ZAI` or `ZHIPU`)

**Optional (for production):**
- `BEARER_TOKEN` - Authentication token for API access
- `DEBUG_LOGGING` - Enable verbose logging (`true` or `1`)
- `PORT` - External port (default: 8080)

### 3. Configure Z.AI Credentials

```bash
# Z.AI Vision MCP Server command
export MCP_COMMAND="npx -y @z_ai/mcp-server"

# Z.AI API credentials
export Z_AI_API_KEY="your_api_key_here"
export Z_AI_MODE="ZAI"  # or "ZHIPU" depending on platform
```

### 4. Start the Proxy

```bash
node server.js
```

The proxy will start on port 8080 and spawn the Z.AI Vision MCP Server via supergateway.

## Architecture

```
Client → Z.AI Vision MCP Proxy (8080) → Supergateway (8000) → Z.AI MCP Server (stdio) → Z.AI API
```

### Component Details

- **Z.AI Vision MCP Proxy**: HTTP server with bearer auth, request routing, and SSE streaming
- **Supergateway**: Bridges HTTP/SSE to stdio for MCP protocol communication
- **Z.AI Vision MCP Server**: Vision AI capabilities via the Z.AI platform

## Configuration Summary

| Configuration | Value | Reason |
|--------------|-------|--------|
| **MCP_COMMAND** | `npx -y @z_ai/mcp-server` | Launches Z.AI Vision MCP Server |
| **Z_AI_API_KEY** | Secret (required) | Authenticates with Z.AI platform |
| **Z_AI_MODE** | `ZAI` or `ZHIPU` (required) | Selects AI service platform |
| **BEARER_TOKEN** | Secret (required in production) | Secures your deployed endpoint |
| **Memory** | 512MB | Adequate for MCP server workload (Z.AI handles heavy processing) |
| **CPU** | shared | Cost-optimized (Z.AI platform handles heavy vision processing) |
| **Concurrency** | 8 soft / 10 hard | Prevents resource exhaustion |

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

## Fly.io Deployment

### Deployment Instructions

1. **Copy the example configuration:**
   ```bash
   cp fly.example.toml fly.toml
   ```

2. **Edit fly.toml:**
   - Set app name: `app = "your-unique-app-name"`
   - Choose region: `primary_region = "iad"` (or nearest to you)

3. **Create the Fly.io app:**
   ```bash
   flyctl apps create your-unique-app-name
   ```

4. **Set required secrets:**
   ```bash
   # Generate secure bearer token
   flyctl secrets set BEARER_TOKEN="$(openssl rand -base64 32)"
   
   # Set Z.AI credentials (get from https://z.ai/manage-apikey/apikey-list)
   flyctl secrets set Z_AI_API_KEY="your_z_ai_api_key"
   flyctl secrets set Z_AI_MODE="ZAI"  # or "ZHIPU" depending on platform
   ```

5. **Deploy:**
   ```bash
   flyctl deploy --remote-only
   ```

6. **Check status:**
   ```bash
   flyctl status
   ```

7. **View logs:**
   ```bash
   flyctl logs
   ```

8. **Test the endpoint:**
   ```bash
   curl -H "Authorization: Bearer YOUR_BEARER_TOKEN" \
        https://your-app.fly.dev/health
   ```

### Verification Steps

After deployment:

1. **Check health endpoint:** `curl https://your-app.fly.dev/health`
2. **Verify authentication:** Request without bearer token should return 401
3. **Test SSE endpoint:** `curl -H "Authorization: Bearer YOUR_TOKEN" https://your-app.fly.dev/sse`
4. **Monitor logs:** `flyctl logs` to ensure Z.AI MCP server starts successfully
5. **Check resource usage:** `flyctl status` to verify memory/CPU allocation

### Architecture Diagram

```
sequenceDiagram
    participant Client as Roo Code/Kilo Code
    participant Proxy as Fly.io (Auth Proxy)
    participant Gateway as Supergateway
    participant ZAI as Z.AI Vision MCP Server
    participant API as Z.AI API Platform

    Client->>Proxy: Request with Bearer Token
    Proxy->>Proxy: Validate Bearer Token
    Proxy->>Gateway: Forward Request (SSE)
    Gateway->>ZAI: stdio communication
    ZAI->>API: Vision API Call (Z_AI_API_KEY)
    API-->>ZAI: Vision Analysis Result
    ZAI-->>Gateway: MCP Response
    Gateway-->>Proxy: SSE Stream
    Proxy-->>Client: Authenticated Response
```

## Docker Deployment

1. **Build and run:**
```bash
docker build -t z-ai-vision-mcp .
docker run -p 8080:8080 \
  -e MCP_COMMAND="npx -y @z_ai/mcp-server" \
  -e BEARER_TOKEN="$TOKEN" \
  -e Z_AI_API_KEY="your_api_key" \
  -e Z_AI_MODE="ZAI" \
  z-ai-vision-mcp
```

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
- Set the `MCP_COMMAND` environment variable to `npx -y @z_ai/mcp-server`

**"BEARER_TOKEN is required in production"**
- Generate and set a secure bearer token for production deployments

**"Gateway startup timeout"**
- Check that Z_AI_API_KEY and Z_AI_MODE are set correctly
- Verify your Z.AI API key is valid

**"Service Unavailable: MCP gateway has exited"**
- Check the logs for startup errors
- Ensure Z.AI credentials are properly configured

### Debug Steps

1. **Check environment variables:**
```bash
env | grep -E "(MCP_COMMAND|BEARER_TOKEN|Z_AI)"
```

2. **Enable debug logging:**
```bash
export DEBUG_LOGGING=true
node server.js
```

3. **Test health endpoint:**
```bash
curl -v http://localhost:8080/health
```

## Security Considerations

- **Always use bearer tokens in production** - the endpoint is otherwise publicly accessible
- **Rotate tokens regularly** - implement token rotation in your deployment pipeline
- **Never commit secrets** - use Fly.io secrets or environment variables
- **Monitor access logs** - watch for unauthorized access attempts
- **Use HTTPS in production** - Fly.io provides automatic TLS

## Performance

- **Cold start handling** - proxy waits for MCP server startup before accepting requests
- **SSE streaming** - long-lived connections are properly managed with no timeout
- **Request buffering** - HTTP requests are buffered; SSE responses are streamed
- **Resource limits** - gateway process has 50MB buffer limit to prevent memory issues

## License

MIT License - feel free to use this scaffold for your Z.AI Vision MCP Server deployments.
