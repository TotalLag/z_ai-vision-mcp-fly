/**
 * Generic MCP Server Proxy with Bearer Token Authentication
 *
 * This server:
 * 1. Spawns supergateway which wraps any stdio-based MCP server
 * 2. Proxies requests with bearer token authentication
 * 3. Works with any MCP server via configurable MCP_COMMAND
 * 4. Provides structured logging for debugging MCP tool calls
 * 5. Properly streams SSE responses (critical for MCP protocol)
 * 6. Accepts image file uploads via POST /upload endpoint
 *
 * Architecture:
 *   Client → Auth Proxy (8080) → [/upload → Base64 Conversion]
 *                               → [other paths → Supergateway (8000) → MCP Server (stdio)]
 *
 * SSE Streaming:
 *   The proxy MUST stream SSE responses immediately as they arrive.
 *   Buffering SSE responses breaks the MCP protocol because:
 *   - SSE connections are long-lived and never "end" normally
 *   - Clients expect real-time events through the SSE stream
 *   - Session IDs are sent via SSE and needed for subsequent messages
 *
 * File Upload:
 *   The /upload endpoint handles multipart/form-data image uploads directly,
 *   bypassing the supergateway proxy to support remote MCP server scenarios
 *   where local file paths are not accessible.
 */

const http = require('http');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Busboy = require('busboy');

// Gateway lifecycle state
const gatewayState = {
  isReady: false,
  hasExited: false,
  exitCode: null,
  startupError: null,
  startTime: Date.now()
};

// Configuration constants
const PROXY_TIMEOUT_MS = 60000; // 60 second timeout for proxy requests (increased for cold starts)
const STARTUP_TIMEOUT_MS = 120000; // 120 seconds to wait for gateway startup
const HEALTH_CHECK_INTERVAL_MS = 500; // Check gateway health every 500ms during startup
const STARTUP_WAIT_TIMEOUT_MS = 30000; // Max time to wait for gateway during startup (30 seconds)

const PORT = process.env.PORT || 8080;
const INTERNAL_PORT = 8000;
const BEARER_TOKEN = process.env.BEARER_TOKEN;
const MCP_COMMAND = process.env.MCP_COMMAND;
const DEBUG_LOGGING = process.env.DEBUG_LOGGING === 'true' || process.env.DEBUG_LOGGING === '1';

// Environment detection for security enforcement
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const IS_FLY = !!process.env.FLY_APP_NAME;
const REQUIRE_AUTH = IS_PRODUCTION || IS_FLY;

// Security check: BEARER_TOKEN is required in production/Fly environments
if (REQUIRE_AUTH && !BEARER_TOKEN) {
  console.error('');
  console.error('❌ FATAL: BEARER_TOKEN is required in production environments!');
  console.error('');
  console.error('   Running on Fly.io or with NODE_ENV=production requires authentication.');
  console.error('   Without BEARER_TOKEN, your MCP endpoint would be publicly accessible.');
  console.error('');
  console.error('   To fix:');
  console.error('   1. Generate a secure token: TOKEN=$(openssl rand -base64 32)');
  console.error('   2. Set it on Fly.io: flyctl secrets set BEARER_TOKEN="$TOKEN"');
  console.error('');
  console.error('   For local development only, you can run without BEARER_TOKEN');
  console.error('   by ensuring NODE_ENV is not "production" and FLY_APP_NAME is not set.');
  console.error('');
  process.exit(1);
}

// Validate that MCP_COMMAND is set
if (!MCP_COMMAND) {
  console.error('❌ FATAL: MCP_COMMAND environment variable is required!');
  console.error('   Set it to the command that starts your MCP server.');
  console.error('   Examples:');
  console.error('     MCP_COMMAND="npx -y @modelcontextprotocol/server-github"');
  console.error('     MCP_COMMAND="npx -y @linear-mcp/server"');
  console.error('');
  process.exit(1);
}

// Structured logging helper with startup/runtime differentiation
function logMCP(level, category, message, data = null) {
  const timestamp = new Date().toISOString();
  const phase = gatewayState.isReady ? 'runtime' : 'startup';
  const logEntry = {
    timestamp,
    level,
    category,
    phase,
    message,
    ...(data && { data })
  };
  
  if (level === 'error') {
    console.error(JSON.stringify(logEntry));
  } else if (DEBUG_LOGGING || level === 'warn') {
    console.log(JSON.stringify(logEntry));
  }
}

// Log startup-specific events
function logStartup(level, message, data = null) {
  logMCP(level, 'startup', message, { ...data, phase: 'startup' });
}

// Log runtime-specific events
function logRuntime(level, category, message, data = null) {
  logMCP(level, category, message, { ...data, phase: 'runtime' });
}

// Parse and validate JSON safely, returning detailed error info
function safeJSONParse(str, context = 'unknown') {
  try {
    return { success: true, data: JSON.parse(str) };
  } catch (e) {
    // Find the position of the invalid character
    const match = e.message.match(/position (\d+)/);
    const position = match ? parseInt(match[1], 10) : null;
    
    let errorDetail = {
      error: e.message,
      context,
      inputLength: str?.length || 0,
      inputPreview: str?.substring(0, 200) || '<empty>',
    };
    
    if (position !== null && str) {
      // Show context around the error position
      const start = Math.max(0, position - 20);
      const end = Math.min(str.length, position + 20);
      errorDetail.errorPosition = position;
      errorDetail.errorContext = str.substring(start, end);
      errorDetail.charAtPosition = str.charCodeAt(position);
      errorDetail.charAtPositionHex = '0x' + str.charCodeAt(position).toString(16);
    }
    
    return { success: false, error: errorDetail };
  }
}

// File path detection and conversion utilities

/**
 * Check if a value is a local file path
 * @param {string} value - The value to check
 * @returns {boolean} True if it's a local file path
 */
function isLocalFilePath(value) {
  if (typeof value !== 'string') return false;
  
  // Check for absolute paths (Unix/Linux)
  if (value.startsWith('/')) return true;
  
  // Check for relative paths
  if (value.startsWith('./') || value.startsWith('../')) return true;
  
  // Check for Windows absolute paths
  if (/^[A-Za-z]:\\/.test(value)) return true;
  
  // Check for Windows relative paths
  if (value.includes('\\') && (value.startsWith('.\\') || value.startsWith('..\\'))) return true;
  
  return false;
}

/**
 * Check if a value is a URL
 * @param {string} value - The value to check
 * @returns {boolean} True if it's a URL
 */
function isURL(value) {
  if (typeof value !== 'string') return false;
  
  return value.startsWith('http://') || 
         value.startsWith('https://') || 
         value.startsWith('file://');
}

/**
 * Check if a value is base64 or a data URI
 * @param {string} value - The value to check
 * @returns {boolean} True if it's base64 or data URI
 */
function isBase64OrDataURI(value) {
  if (typeof value !== 'string') return false;
  
  // Check for data URI
  if (value.startsWith('data:')) return true;
  
  // Check for pure base64 (letters, numbers, +, /, =)
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  return base64Regex.test(value) && value.length > 10;
}

/**
 * Check if a file path has an image extension
 * @param {string} filePath - The file path to check
 * @returns {boolean} True if it's an image file
 */
function isImageFile(filePath) {
  if (typeof filePath !== 'string') return false;
  
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];
  const lowerPath = filePath.toLowerCase();
  
  return imageExtensions.some(ext => lowerPath.endsWith(ext));
}

/**
 * Convert a local file to base64 data URI
 * @param {string} filePath - Path to the local file
 * @returns {Promise<string>} Data URI with base64 content
 */
async function convertFileToBase64(filePath) {
  try {
    // Check if file exists and get stats
    const stats = await fs.promises.stat(filePath);
    
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${filePath}`);
    }
    
    // Check file size (max 10MB)
    const maxSize = 10 * 1024 * 1024; // 10MB
    if (stats.size > maxSize) {
      throw new Error(`File too large: ${stats.size} bytes (max ${maxSize} bytes)`);
    }
    
    // Read file content
    const fileBuffer = await fs.promises.readFile(filePath);
    
    // Detect MIME type based on file extension
    const lowerPath = filePath.toLowerCase();
    let mimeType = 'application/octet-stream'; // default
    
    if (lowerPath.endsWith('.png')) mimeType = 'image/png';
    else if (lowerPath.endsWith('.jpg') || lowerPath.endsWith('.jpeg')) mimeType = 'image/jpeg';
    else if (lowerPath.endsWith('.gif')) mimeType = 'image/gif';
    else if (lowerPath.endsWith('.webp')) mimeType = 'image/webp';
    else if (lowerPath.endsWith('.bmp')) mimeType = 'image/bmp';
    
    // Convert to base64
    const base64Data = fileBuffer.toString('base64');
    
    // Return data URI
    return `data:${mimeType};base64,${base64Data}`;
    
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`File not found: ${filePath}`);
    } else if (error.code === 'EACCES') {
      throw new Error(`Permission denied: ${filePath}`);
    } else {
      throw new Error(`Failed to read file ${filePath}: ${error.message}`);
    }
  }
}

/**
 * Recursively transform tool arguments, converting local file paths to base64 data URIs
 * @param {Object|Array} args - The arguments object or array to transform
 * @param {string} toolName - The name of the tool being called
 * @returns {Promise<Object|Array>} The transformed arguments
 */
async function transformToolArguments(args, toolName) {
  if (args === null || args === undefined) {
    return args;
  }
  
  // Known image parameter names for Z.ai Vision tools
  const imageParamNames = [
    'image_path', 'image', 'images', 'screenshot_path', 'file_path', 'path',
    'image_source', 'image_files', 'input_image', 'input_images'
  ];
  
  // Explicit allowlist of Z.ai Vision MCP server tool names
  // Only these specific tools should trigger file path transformation
  const visionToolAllowlist = [
    'ui_to_artifact',
    'extract_text_from_screenshot',
    'diagnose_error_screenshot',
    'understand_technical_diagram',
    'analyze_data_visualization',
    'ui_diff_check',
    'analyze_image',
    'analyze_video'
  ];
  
  // Check if tool name is in the explicit allowlist
  const isVisionTool = toolName && visionToolAllowlist.includes(toolName);
  
  if (!isVisionTool) {
    return args; // Not a vision tool, skip transformation
  }
  
  // Handle arrays
  if (Array.isArray(args)) {
    const transformedArray = [];
    for (let i = 0; i < args.length; i++) {
      transformedArray[i] = await transformToolArguments(args[i], toolName);
    }
    return transformedArray;
  }
  
  // Handle objects
  if (typeof args === 'object') {
    const transformed = {};
    
    for (const [key, value] of Object.entries(args)) {
      let transformedValue = value;
      
      // Check if this is an image parameter
      if (imageParamNames.some(paramName => key.toLowerCase().includes(paramName.toLowerCase()))) {
        if (typeof value === 'string') {
          // Skip if already URL, base64, or data URI
          if (!isURL(value) && !isBase64OrDataURI(value)) {
            // Check if it looks like a local file path
            if (isLocalFilePath(value) && isImageFile(value)) {
              try {
                const startTime = Date.now();
                const dataUri = await convertFileToBase64(value);
                const endTime = Date.now();
                
                logMCP('info', 'file-transform', 'File converted to data URI', {
                  originalPath: value,
                  dataUriLength: dataUri.length,
                  conversionTimeMs: endTime - startTime,
                  toolName,
                  parameterName: key
                });
                
                transformedValue = dataUri;
              } catch (error) {
                logMCP('warn', 'file-transform', 'Failed to convert file to base64', {
                  originalPath: value,
                  error: error.message,
                  toolName,
                  parameterName: key
                });
                
                // Keep original value if conversion fails
                transformedValue = value;
              }
            }
          }
        } else if (Array.isArray(value)) {
          // Handle arrays of file paths or image objects
          const transformedArray = [];
          for (let i = 0; i < value.length; i++) {
            const item = value[i];
            if (typeof item === 'string' && isLocalFilePath(item) && isImageFile(item)) {
              try {
                const startTime = Date.now();
                const dataUri = await convertFileToBase64(item);
                const endTime = Date.now();
                
                logMCP('info', 'file-transform', 'File in array converted to data URI', {
                  originalPath: item,
                  arrayIndex: i,
                  dataUriLength: dataUri.length,
                  conversionTimeMs: endTime - startTime,
                  toolName,
                  parameterName: key
                });
                
                transformedArray.push(dataUri);
              } catch (error) {
                logMCP('warn', 'file-transform', 'Failed to convert file in array', {
                  originalPath: item,
                  arrayIndex: i,
                  error: error.message,
                  toolName,
                  parameterName: key
                });
                
                // Keep original value if conversion fails
                transformedArray.push(item);
              }
            } else if (typeof item === 'object' && item !== null) {
              // Recursively transform nested objects/arrays in array items
              transformedArray.push(await transformToolArguments(item, toolName));
            } else {
              transformedArray.push(item);
            }
          }
          transformedValue = transformedArray;
        }
      } else {
        // Recursively transform nested objects/arrays
        transformedValue = await transformToolArguments(value, toolName);
      }
      
      transformed[key] = transformedValue;
    }
    
    return transformed;
  }
  
  // Return primitive values unchanged
  return args;
}

// Start supergateway in background using shell command
console.log('Starting supergateway...');

// Build supergateway command directly
let fullCommand = `supergateway --stdio "${MCP_COMMAND}" --port ${INTERNAL_PORT} --healthEndpoint /healthz --cors`;

console.log(`Full command: ${fullCommand}`);

// Set up environment for the MCP server (pass through all environment variables)
const gatewayEnv = {
  ...process.env
};

const gateway = exec(
  fullCommand,
  {
    maxBuffer: 50 * 1024 * 1024,
    env: gatewayEnv,
    shell: '/bin/sh'
  }
);

// Proactively check supergateway health endpoint to detect readiness
// This is more reliable than parsing stdout since MCP servers may not output expected strings
function checkGatewayHealth() {
  if (gatewayState.isReady || gatewayState.hasExited) {
    return; // Stop checking once ready or exited
  }
  
  const healthReq = http.request({
    hostname: 'localhost',
    port: INTERNAL_PORT,
    path: '/healthz',
    method: 'GET',
    timeout: 2000
  }, (res) => {
    if (res.statusCode === 200) {
      if (!gatewayState.isReady) {
        gatewayState.isReady = true;
        const startupDuration = Date.now() - gatewayState.startTime;
        logStartup('info', '✅ MCP server is ready (health check passed)', {
          startupDurationMs: startupDuration,
          detectionMethod: 'health-check'
        });
      }
    } else {
      // Not ready yet, schedule another check
      setTimeout(checkGatewayHealth, HEALTH_CHECK_INTERVAL_MS);
    }
  });
  
  healthReq.on('error', () => {
    // Connection failed, gateway not ready yet - schedule another check
    setTimeout(checkGatewayHealth, HEALTH_CHECK_INTERVAL_MS);
  });
  
  healthReq.on('timeout', () => {
    healthReq.destroy();
    setTimeout(checkGatewayHealth, HEALTH_CHECK_INTERVAL_MS);
  });
  
  healthReq.end();
}

// Start health checking after a brief delay to let supergateway initialize
setTimeout(checkGatewayHealth, 500);

gateway.stdout.on('data', (data) => {
  const output = data.toString().trim();
  
  if (!gatewayState.isReady) {
    logStartup('info', `supergateway stdout: ${output}`);
  } else {
    logRuntime('info', 'gateway-stdout', output);
  }
  
  // Check for general readiness indicators
  if (output.includes('listening') ||
      output.includes('ready') ||
      output.includes('Server running') ||
      output.includes('MCP server') ||
      output.includes('Connected to') ||
      output.includes('Authenticated')) {
    if (!gatewayState.isReady) {
      gatewayState.isReady = true;
      const startupDuration = Date.now() - gatewayState.startTime;
      logStartup('info', '✅ MCP server is ready for connections', {
        startupDurationMs: startupDuration,
        triggerMessage: output.substring(0, 100)
      });
    }
  }
});

gateway.stderr.on('data', (data) => {
  const output = data.toString().trim();
  
  if (!gatewayState.isReady) {
    logStartup('error', `supergateway stderr: ${output}`, {
      hint: 'This error occurred during startup - the gateway may not be properly configured'
    });
    // Track startup errors
    if (!gatewayState.startupError) {
      gatewayState.startupError = output;
    }
  } else {
    logRuntime('error', 'gateway-stderr', output);
  }
});

gateway.on('error', (err) => {
  gatewayState.hasExited = true;
  gatewayState.startupError = err.message;
  logStartup('error', 'Failed to start supergateway', {
    error: err.message,
    code: err.code,
    hint: 'Check that supergateway is installed and the MCP command is valid'
  });
});

gateway.on('exit', (code, signal) => {
  gatewayState.hasExited = true;
  gatewayState.exitCode = code;
  
  const phase = gatewayState.isReady ? 'runtime' : 'startup';
  const logFn = gatewayState.isReady ? logRuntime : logStartup;
  
  logFn(code === 0 ? 'info' : 'error', phase === 'startup' ? 'gateway-exit' : 'gateway-exit',
    `supergateway exited with code ${code}`, {
      exitCode: code,
      signal,
      phase,
      wasReady: gatewayState.isReady,
      startupError: gatewayState.startupError
    });
  
  // Only exit the process if we're in startup phase and it failed
  // During runtime, we want to keep the server running to return proper errors
  if (!gatewayState.isReady && code !== 0) {
    console.error('Gateway failed during startup - exiting');
    process.exit(1);
  }
});

// Start auth proxy immediately
console.log(`Auth proxy starting on port ${PORT}...`);

// Log authentication status with clear security context
if (BEARER_TOKEN) {
  console.log(`🔒 Bearer token auth: ENABLED (${REQUIRE_AUTH ? 'required' : 'optional'} in this environment)`);
} else {
  console.log(`⚠️  Bearer token auth: DISABLED - endpoint is UNAUTHENTICATED`);
  console.log(`   This is only safe for local development.`);
  if (!REQUIRE_AUTH) {
    console.log(`   (Allowed because NODE_ENV=${process.env.NODE_ENV || 'undefined'}, FLY_APP_NAME=${process.env.FLY_APP_NAME || 'undefined'})`);
  }
}

console.log(`MCP command: ${MCP_COMMAND}`);

const server = http.createServer((req, res) => {
  // Add CORS headers to all responses
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  // Handle CORS preflight - no auth required
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check - returns gateway status
  if (req.url === '/health' || req.url === '/healthz') {
    const status = {
      status: gatewayState.hasExited ? 'unhealthy' : (gatewayState.isReady ? 'healthy' : 'starting'),
      gatewayReady: gatewayState.isReady,
      gatewayExited: gatewayState.hasExited,
      uptimeMs: Date.now() - gatewayState.startTime,
      uploadEndpoint: '/upload',
      supportedImageTypes: ['png', 'jpeg', 'jpg', 'gif', 'webp', 'bmp'],
      maxUploadSize: '10MB',
      fileTransformation: {
        enabled: true,
        description: 'Automatic conversion of local file paths to base64 data URIs for Z.ai Vision tools',
        supportedTools: ['ui_to_artifact', 'extract_text_from_screenshot', 'diagnose_error_screenshot', 'understand_technical_diagram', 'analyze_data_visualization', 'ui_diff_check', 'analyze_image', 'analyze_video'],
        supportedParameters: ['image_path', 'image', 'images', 'screenshot_path', 'file_path', 'path', 'image_source', 'image_files', 'input_image', 'input_images'],
        maxFileSize: '10MB'
      }
    };
    
    if (gatewayState.hasExited) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...status, exitCode: gatewayState.exitCode }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    }
    return;
  }

  // Guard: Reject requests if gateway has exited
  if (gatewayState.hasExited) {
    logRuntime('error', 'gateway-down', 'Rejecting request - gateway has exited', {
      exitCode: gatewayState.exitCode,
      url: req.url,
      method: req.method
    });
    
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: {
        code: -32603,
        message: 'Service Unavailable: MCP gateway has exited',
        data: {
          exitCode: gatewayState.exitCode,
          startupError: gatewayState.startupError,
          hint: 'The supergateway process has terminated. The service needs to be restarted.'
        }
      },
      id: null
    }));
    return;
  }

  // Guard: Wait for gateway to be ready before processing request
  // This handles the cold-start case where Fly.io wakes the machine on request
  if (!gatewayState.isReady) {
    const startupDurationMs = Date.now() - gatewayState.startTime;
    logStartup('info', 'Request received before gateway ready - waiting for startup', {
      url: req.url,
      method: req.method,
      startupDurationMs
    });
    
    // Wait for gateway to become ready with timeout
    const waitStart = Date.now();
    const waitForReady = () => {
      return new Promise((resolve, reject) => {
        const checkReady = () => {
          if (gatewayState.isReady) {
            const waitDuration = Date.now() - waitStart;
            logStartup('info', 'Gateway became ready while waiting', {
              url: req.url,
              waitDurationMs: waitDuration
            });
            resolve();
            return;
          }
          
          if (gatewayState.hasExited) {
            reject(new Error('Gateway exited during startup'));
            return;
          }
          
          const elapsed = Date.now() - waitStart;
          if (elapsed >= STARTUP_WAIT_TIMEOUT_MS) {
            reject(new Error(`Gateway startup timeout after ${elapsed}ms`));
            return;
          }
          
          // Check again in 100ms
          setTimeout(checkReady, 100);
        };
        
        checkReady();
      });
    };
    
    waitForReady()
      .then(() => {
        // Gateway is ready, continue processing the request
        processRequest(req, res);
      })
      .catch((err) => {
        logStartup('error', 'Failed waiting for gateway startup', {
          url: req.url,
          error: err.message,
          startupDurationMs: Date.now() - gatewayState.startTime
        });
        
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'Retry-After': '5'
        });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Service Unavailable: MCP server is starting up',
            data: {
              startupDurationMs: Date.now() - gatewayState.startTime,
              hint: 'The server is still starting. Please retry in a few seconds.',
              retryAfter: 5
            }
          },
          id: null
        }));
      });
    
    return; // Don't continue - the promise will handle the request
  }
  
  // Gateway is ready, process the request immediately
  processRequest(req, res);
});

// Extracted request processing logic
function processRequest(req, res) {

  // Check bearer token if configured
  if (BEARER_TOKEN) {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${BEARER_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized: Invalid or missing bearer token');
      return;
    }
  }

  // Handle file upload endpoint
  if (req.url === '/upload' && req.method === 'POST') {
    /**
     * File Upload Endpoint
     * 
     * Accepts multipart/form-data image uploads, validates them,
     * converts to base64, and returns JSON with encoded data.
     * 
     * This endpoint does NOT proxy to supergateway - it handles
     * uploads directly to support remote MCP server scenarios
     * where local file paths are not accessible.
     * 
     * @route POST /upload
     * @param {File} file - Image file (png, jpeg, gif, webp, bmp)
     * @returns {Object} JSON with base64 encoded image data
     */
    
    // Check for multipart content type
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.startsWith('multipart/form-data')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: 'Content-Type must be multipart/form-data'
      }));
      return;
    }

    // Upload validation constants
    const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
    const ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/bmp'];

    // Set request timeout
    req.setTimeout(30000); // 30 seconds

    // Track upload state
    let fileReceived = false;
    let fileBuffer = [];
    let fileSize = 0;
    let mimeType = null;
    let filename = null;
    let fileCount = 0;
    let responded = false;

    // Helper function to send response safely with double-response guard
    const sendResponse = (statusCode, body) => {
      if (responded) return;
      responded = true;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    // Helper function to halt processing after early errors
    const haltProcessing = (errorMessage = 'Early validation failed') => {
      try {
        busboy.destroy(new Error(errorMessage));
        req.unpipe(busboy);
      } catch (e) {
        // Ignore errors from cleanup
      }
    };

    // Log upload start
    logMCP('info', 'upload-start', 'File upload started', {
      contentType: contentType,
      contentLength: req.headers['content-length']
    });

    // Initialize busboy
    const busboy = Busboy({ headers: req.headers });

    // Handle file upload
    busboy.on('file', (fieldname, file, info) => {
      fileCount++;
      
      // Check if multiple files uploaded
      if (fileCount > 1) {
        logMCP('error', 'upload-validation', 'Multiple files uploaded - only one allowed', {
          fileCount
        });
        file.destroy();
        sendResponse(400, {
          success: false,
          error: 'Only one file allowed per upload'
        });
        haltProcessing('Multiple files uploaded');
        return;
      }

      filename = info.filename;
      mimeType = info.mimeType;

      // Validate MIME type
      if (!ALLOWED_MIME_TYPES.includes(mimeType)) {
        logMCP('error', 'upload-validation', 'Invalid MIME type uploaded', {
          filename,
          mimeType,
          allowedTypes: ALLOWED_MIME_TYPES
        });
        file.destroy();
        sendResponse(400, {
          success: false,
          error: `Invalid file type. Allowed types: ${ALLOWED_MIME_TYPES.join(', ')}`
        });
        haltProcessing('Invalid MIME type');
        return;
      }

      fileReceived = true;

      // Log file start
      logMCP('info', 'upload-file', 'File upload in progress', {
        filename,
        mimeType
      });

      // Stream file chunks
      file.on('data', (data) => {
        fileSize += data.length;
        
        // Check file size limit
        if (fileSize > MAX_FILE_SIZE) {
          logMCP('error', 'upload-validation', 'File size exceeded limit', {
            filename,
            fileSize,
            maxSize: MAX_FILE_SIZE
          });
          file.destroy();
          sendResponse(413, {
            success: false,
            error: `File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`
          });
          haltProcessing('File size exceeded');
          return;
        }

        fileBuffer.push(data);
      });

      file.on('end', () => {
        logMCP('info', 'upload-chunk', 'File chunk received', {
          filename,
          chunkSize: fileBuffer[fileBuffer.length - 1]?.length || 0
        });
      });
    });

    // Handle busboy errors
    busboy.on('error', (err) => {
      if (responded) return; // Guard against double response
      logMCP('error', 'upload-parse', 'Busboy parsing error', {
        error: err.message
      });
      sendResponse(400, {
        success: false,
        error: 'Failed to parse multipart data'
      });
    });

    // Handle upload completion
    busboy.on('finish', () => {
      // Guard against double response (e.g., if early error already sent response)
      if (responded) return;

      // Check if file was uploaded
      if (!fileReceived) {
        logMCP('error', 'upload-validation', 'No file uploaded', {});
        sendResponse(400, {
          success: false,
          error: 'No file uploaded'
        });
        return;
      }

      try {
        // Concatenate file buffer
        const completeBuffer = Buffer.concat(fileBuffer);
        
        // Convert to base64
        const base64Data = completeBuffer.toString('base64');
        const dataUri = `data:${mimeType};base64,${base64Data}`;

        // Log successful upload
        logMCP('info', 'upload-success', 'File upload completed successfully', {
          filename,
          mimeType,
          fileSize,
          dataSize: base64Data.length
        });

        // Return success response
        sendResponse(200, {
          success: true,
          filename,
          mimeType,
          size: fileSize,
          base64: base64Data,
          dataUri: dataUri
        });

      } catch (error) {
        logMCP('error', 'upload-process', 'Error processing uploaded file', {
          filename,
          error: error.message
        });
        sendResponse(500, {
          success: false,
          error: 'Failed to process uploaded file'
        });
      }
    });

    // Handle request timeout
    req.on('timeout', () => {
      if (responded) return; // Guard against double response
      logMCP('error', 'upload-timeout', 'Upload request timed out', {
        filename,
        fileSize
      });
      haltProcessing('Request timeout');
      sendResponse(408, {
        success: false,
        error: 'Request timeout'
      });
    });

    // Pipe request to busboy
    req.pipe(busboy);
    return; // Don't continue to proxy logic
  }

  // Collect request body for logging and validation
  let requestBody = '';
  
  req.on('data', (chunk) => {
    requestBody += chunk.toString();
  });
  
  req.on('end', async () => {
    // Log incoming request
    const requestId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    
    // Declare variables at outer scope to avoid ReferenceError for non-POST requests
    let jsonBody = null;
    let originalMethod = null;
    
    logMCP('info', 'request', 'Incoming MCP request', {
      requestId,
      method: req.method,
      url: req.url,
      contentType: req.headers['content-type'],
      bodyLength: requestBody.length
    });
    
    // Check if this is an SSE request (GET /sse)
    const isSSE = req.method === 'GET' && (req.url === '/sse' || req.url.startsWith('/sse?'));
    
    // For POST requests with JSON body, validate and log
    if (req.method === 'POST' && requestBody) {
      const parseResult = safeJSONParse(requestBody, 'incoming-request');
      
      if (!parseResult.success) {
        logMCP('error', 'json-parse', 'Failed to parse incoming request body', {
          requestId,
          ...parseResult.error
        });
        
        // Return detailed error to client
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32700,
            message: 'Parse error: Invalid JSON in request body',
            data: {
              parseError: parseResult.error.error,
              position: parseResult.error.errorPosition,
              context: parseResult.error.errorContext,
              hint: 'Check for invalid characters, double-encoding, or truncated JSON'
            }
          },
          id: null
        }));
        return;
      }
      
      // Assign to outer-scope variable
      jsonBody = parseResult.data;
      originalMethod = jsonBody.method || null;
      
      // File path transformation for Z.ai Vision tools
      if (jsonBody.method === 'tools/call' && jsonBody.params) {
        const toolName = jsonBody.params.name;
        
        try {
          // Transform arguments if this is a vision tool with local file paths
          const transformedArgs = await transformToolArguments(jsonBody.params.arguments, toolName);
          
          // Check if transformation occurred
          if (transformedArgs !== jsonBody.params.arguments) {
            jsonBody.params.arguments = transformedArgs;
            
            // Re-serialize the modified JSON body
            requestBody = JSON.stringify(jsonBody);
            
            logMCP('info', 'file-transform', 'Request body transformed for Z.ai Vision tool', {
              requestId,
              toolName,
              originalBodyLength: requestBody.length,
              transformed: true
            });
          } else {
            logMCP('debug', 'file-transform', 'No file transformations needed', {
              requestId,
              toolName,
              transformed: false
            });
          }
        } catch (error) {
          logMCP('warn', 'file-transform', 'Error during file transformation', {
            requestId,
            toolName,
            error: error.message
          });
          // Continue with original request if transformation fails
        }
      }
      
      // Log MCP method calls
      if (jsonBody.method) {
        logMCP('info', 'mcp-call', `MCP method: ${jsonBody.method}`, {
          requestId,
          method: jsonBody.method,
          id: jsonBody.id,
          hasParams: !!jsonBody.params
        });
        
        // Handle MCP Resource Discovery
        if (jsonBody.method === 'resources/list') {
          // Return upload endpoint metadata directly without proxying
          logMCP('info', 'resource-list', 'Handling resources/list request', {
            requestId,
            method: jsonBody.method,
            id: jsonBody.id
          });
          
          const response = {
            jsonrpc: '2.0',
            id: jsonBody.id,
            result: {
              resources: [
                {
                  uri: 'upload://images',
                  name: 'Image Upload Endpoint',
                  description: 'Upload local images to POST /upload endpoint for use with Z.ai Vision tools. Supports PNG, JPEG, GIF, WebP, BMP formats (max 10MB). Returns base64 encoded data for direct use in tool calls.',
                  mimeType: 'application/json'
                }
              ]
            }
          };
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(response));
          return;
        }
        
        if (jsonBody.method === 'resources/read') {
          // Return detailed upload instructions
          const requestedUri = jsonBody.params?.uri;
          
          logMCP('info', 'resource-read', 'Handling resources/read request', {
            requestId,
            method: jsonBody.method,
            id: jsonBody.id,
            requestedUri
          });
          
          if (requestedUri === 'upload://images') {
            const response = {
              jsonrpc: '2.0',
              id: jsonBody.id,
              result: {
                uri: 'upload://images',
                name: 'Image Upload Endpoint',
                description: 'Upload local images for Z.ai Vision tool usage',
                mimeType: 'application/json',
                data: {
                  endpoint: 'POST /upload',
                  contentType: 'multipart/form-data',
                  fieldName: 'file',
                  supportedFormats: ['png', 'jpeg', 'jpg', 'gif', 'webp', 'bmp'],
                  maxSize: '10MB',
                  responseFormat: {
                    base64: 'base64 encoded image data',
                    dataUri: 'data URI format for direct use'
                  },
                  usage: {
                    curl: 'curl -X POST http://localhost:8080/upload -H "Authorization: Bearer $TOKEN" -F "file=@image.jpg"',
                    response: {
                      success: true,
                      base64: 'base64_data_here',
                      dataUri: 'data:image/jpeg;base64,base64_data_here'
                    }
                  }
                }
              }
            };
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
            return;
          } else {
            // Unknown resource URI
            const errorResponse = {
              jsonrpc: '2.0',
              id: jsonBody.id,
              error: {
                code: -32602,
                message: 'Invalid params: Unknown resource URI',
                data: {
                  requestedUri,
                  availableResources: ['upload://images']
                }
              }
            };
            
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(errorResponse));
            return;
          }
        }
        
        // Special logging for tool calls
        if (jsonBody.method === 'tools/call' && jsonBody.params) {
          const toolName = jsonBody.params.name;
          let toolArgs = jsonBody.params.arguments;
          
          logMCP('info', 'tool-call', `Tool call: ${toolName}`, {
            requestId,
            toolName,
            argumentKeys: toolArgs ? Object.keys(toolArgs) : [],
            argumentTypes: toolArgs ? Object.fromEntries(
              Object.entries(toolArgs).map(([k, v]) => [k, typeof v])
            ) : {}
          });
          
          // Log full arguments in debug mode
          if (DEBUG_LOGGING) {
            logMCP('debug', 'tool-args', 'Full tool arguments', {
              requestId,
              toolName,
              arguments: toolArgs
            });
          }
        }
      }
    }
    
    // Proxy to supergateway
    // SSE requests should NOT have a timeout - they're long-lived connections
    const proxyReq = http.request({
      hostname: 'localhost',
      port: INTERNAL_PORT,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: `localhost:${INTERNAL_PORT}`,
        'content-length': Buffer.byteLength(requestBody) // Updated after potential file transformation
      },
      // No timeout for SSE requests - they're meant to stay open indefinitely
      timeout: isSSE ? 0 : PROXY_TIMEOUT_MS
    }, (proxyRes) => {
      // For SSE requests, stream the response directly without buffering
      if (isSSE) {
        logMCP('info', 'sse-stream', 'Starting SSE stream proxy', {
          requestId,
          statusCode: proxyRes.statusCode,
          contentType: proxyRes.headers['content-type']
        });
        
        // Forward headers immediately
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        
        // Stream data directly to client as it arrives
        proxyRes.on('data', (chunk) => {
          res.write(chunk);
        });
        
        proxyRes.on('end', () => {
          logMCP('info', 'sse-end', 'SSE stream ended', { requestId });
          res.end();
        });
        
        proxyRes.on('error', (err) => {
          logMCP('error', 'sse-error', 'SSE stream error', {
            requestId,
            error: err.message
          });
          res.end();
        });
        
        return;
      }
      
      // For non-SSE requests, collect response for logging
      let responseBody = '';
      
      proxyRes.on('data', (chunk) => {
        responseBody += chunk.toString();
      });
      
      proxyRes.on('end', () => {
        // Log response
        logMCP('info', 'response', 'MCP response', {
          requestId,
          statusCode: proxyRes.statusCode,
          contentType: proxyRes.headers['content-type'],
          bodyLength: responseBody.length
        });
        
        // Store original method for response enhancement (already set in POST parse block)
        
        // Check for error responses
        if (proxyRes.headers['content-type']?.includes('application/json') && responseBody) {
          const responseParseResult = safeJSONParse(responseBody, 'proxy-response');
          
          if (responseParseResult.success) {
            const responseJson = responseParseResult.data;
            
            // Enhance tools/list responses with upload capability hints
            if (originalMethod === 'tools/list' && responseJson.result?.tools) {
              logMCP('info', 'tools-enhance', 'Enhancing tools/list response with upload hints', {
                requestId,
                toolCount: responseJson.result.tools.length
              });
              
              // Check if this response contains Z.ai Vision tools
              const visionToolNames = [
                'ui_to_artifact', 'extract_text_from_screenshot', 'analyze_image',
                'diagnose_error_screenshot', 'analyze_data_visualization', 'understand_technical_diagram',
                'ui_diff_check', 'analyze_video'
              ];
              
              const hasVisionTools = responseJson.result.tools.some(tool => 
                visionToolNames.includes(tool.name)
              );
              
              if (hasVisionTools) {
                // Enhance tool descriptions for vision tools
                responseJson.result.tools.forEach(tool => {
                  if (visionToolNames.includes(tool.name)) {
                    // Add upload capability hint to description
                    if (tool.description) {
                      tool.description += '\n\n**Note for remote servers**: Local image files are automatically converted to base64. You can also upload files to POST /upload endpoint first.';
                    }
                    
                    // Update inputSchema descriptions for image path parameters
                    if (tool.inputSchema && tool.inputSchema.properties) {
                      Object.keys(tool.inputSchema.properties).forEach(paramName => {
                        const param = tool.inputSchema.properties[paramName];
                        if (param.description && (
                            param.description.toLowerCase().includes('image') ||
                            param.description.toLowerCase().includes('file') ||
                            param.description.toLowerCase().includes('path') ||
                            param.type === 'string'
                          )) {
                          param.description += ' (Local file paths are automatically converted to base64 for Z.ai Vision tools)';
                        }
                      });
                    }
                  }
                });
                
                // Re-serialize the enhanced response
                responseBody = JSON.stringify(responseJson);
                
                logMCP('info', 'tools-enhanced', 'Successfully enhanced tools/list response', {
                  requestId,
                  enhancedTools: responseJson.result.tools.filter(tool => 
                    visionToolNames.includes(tool.name)
                  ).length
                });
              } else {
                logMCP('debug', 'tools-enhance', 'No Z.ai Vision tools found in tools/list response', {
                  requestId,
                  toolNames: responseJson.result.tools.map(tool => tool.name)
                });
              }
            }
            
            // Log MCP errors
            if (responseJson.error) {
              logMCP('error', 'mcp-error', 'MCP returned error', {
                requestId,
                errorCode: responseJson.error.code,
                errorMessage: responseJson.error.message,
                errorData: responseJson.error.data
              });
            }
          } else {
            logMCP('warn', 'response-parse', 'Could not parse response JSON for logging', {
              requestId,
              parseError: responseParseResult.error
            });
          }
        }
        
        // Send response to client
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(responseBody);
      });
    });

    // Handle proxy request timeout
    proxyReq.on('timeout', () => {
      logRuntime('error', 'proxy-timeout', 'Proxy request timed out', {
        requestId,
        timeoutMs: PROXY_TIMEOUT_MS,
        url: req.url,
        method: req.method
      });
      
      proxyReq.destroy();
      
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Gateway Timeout: MCP server did not respond in time',
            data: {
              timeoutMs: PROXY_TIMEOUT_MS,
              hint: 'The request to the MCP server timed out. The server may be overloaded or unresponsive.'
            }
          },
          id: null
        }));
      }
    });

    proxyReq.on('error', (err) => {
      const isStartupPhase = !gatewayState.isReady;
      const logFn = isStartupPhase ? logStartup : logRuntime;
      
      logFn('error', isStartupPhase ? 'Proxy request failed during startup' : 'proxy-error', {
        requestId,
        error: err.message,
        code: err.code,
        phase: isStartupPhase ? 'startup' : 'runtime',
        gatewayReady: gatewayState.isReady,
        gatewayExited: gatewayState.hasExited
      });
      
      if (!res.headersSent) {
        const statusCode = gatewayState.hasExited ? 503 : 502;
        const message = gatewayState.hasExited
          ? 'Service Unavailable: MCP gateway has exited'
          : (isStartupPhase
              ? 'Bad Gateway: MCP server still starting'
              : 'Bad Gateway: MCP server connection failed');
        
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message,
            data: {
              proxyError: err.message,
              errorCode: err.code,
              phase: isStartupPhase ? 'startup' : 'runtime',
              gatewayExited: gatewayState.hasExited,
              hint: gatewayState.hasExited
                ? 'The gateway process has terminated. The service needs to be restarted.'
                : (isStartupPhase
                    ? 'The supergateway/MCP server is still starting. Please retry in a few seconds.'
                    : 'The connection to the MCP server failed. Please retry.')
            }
          },
          id: null
        }));
      }
    });

    // Write the collected body to the proxy request
    proxyReq.write(requestBody);
    proxyReq.end();
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Generic MCP proxy ready at http://0.0.0.0:${PORT}`);
  console.log(`SSE endpoint: http://0.0.0.0:${PORT}/sse`);
  console.log(`Upload endpoint: http://0.0.0.0:${PORT}/upload`);
  console.log(`Debug logging: ${DEBUG_LOGGING ? 'ENABLED' : 'DISABLED (set DEBUG_LOGGING=true to enable)'}`);
});

// Graceful shutdown handler
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log('Shutdown already in progress...');
    return;
  }
  
  isShuttingDown = true;
  console.log(`\nReceived ${signal}, starting graceful shutdown...`);
  
  // Stop accepting new connections
  server.close((err) => {
    if (err) {
      console.error('Error closing HTTP server:', err);
    } else {
      console.log('HTTP server closed');
    }
  });
  
  // Set a timeout for forceful shutdown
  const forceShutdownTimeout = setTimeout(() => {
    console.error('Forceful shutdown after timeout');
    process.exit(1);
  }, 10000); // 10 second timeout
  
  // Kill the gateway process
  if (gateway && !gatewayState.hasExited) {
    console.log('Sending SIGTERM to supergateway...');
    gateway.kill('SIGTERM');
    
    // Wait for gateway to exit
    const gatewayExitPromise = new Promise((resolve) => {
      if (gatewayState.hasExited) {
        resolve();
        return;
      }
      
      const checkInterval = setInterval(() => {
        if (gatewayState.hasExited) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
      
      // Force kill after 5 seconds if still running
      setTimeout(() => {
        if (!gatewayState.hasExited) {
          console.log('Gateway did not exit gracefully, sending SIGKILL...');
          gateway.kill('SIGKILL');
        }
        clearInterval(checkInterval);
        resolve();
      }, 5000);
    });
    
    gatewayExitPromise.then(() => {
      console.log('Gateway process terminated');
      clearTimeout(forceShutdownTimeout);
      process.exit(0);
    });
  } else {
    console.log('Gateway already exited or not started');
    clearTimeout(forceShutdownTimeout);
    process.exit(0);
  }
}

// Handle various shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});
