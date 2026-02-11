/**
 * DXX-Redux Gamelog Uploader
 * 
 * This script monitors a local gamelog.txt file and streams new entries
 * to a central tracking server for multi-perspective game analysis.
 * 
 * Usage:
 *   node gamelog-uploader.js [options]
 * 
 * Options:
 *   --server URL     Server URL (default: http://localhost:9999)
 *   --gamelog PATH   Path to gamelog.txt (auto-detected if not specified)
 *   --interval MS    Check interval in milliseconds (default: 1000)
 *   --help           Show this help message
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const os = require('os');

// Configuration
const CONFIG = {
  serverUrl: 'http://192.210.140.94:9998',
  gamelogPath: null,
  checkInterval: 1000,
  uploadEndpoint: '/api/gamelog/append',
  statusEndpoint: '/api/status',
  playerName: null
};

// State tracking
let lastPosition = 0;
let currentGameId = null;
let uploadQueue = [];
let isUploading = false;

/**
 * Parse command line arguments
 */
function parseArguments() {
  const args = process.argv.slice(2);
  
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--server':
        CONFIG.serverUrl = args[++i];
        break;
      case '--gamelog':
        CONFIG.gamelogPath = args[++i];
        break;
      case '--interval':
        CONFIG.checkInterval = parseInt(args[++i], 10);
        break;
      case '--player':
        CONFIG.playerName = args[++i];
        break;
      case '--help':
        console.log('DXX-Redux Gamelog Uploader');
        console.log('');
        console.log('Usage: node gamelog-uploader.js [options]');
        console.log('');
        console.log('Options:');
        console.log('  --server URL     Server URL (default: http://192.210.140.94:9998)');
        console.log('  --gamelog PATH   Path to gamelog.txt (auto-detected if not specified)');
        console.log('  --player NAME    Your player name (auto-detected if not specified)');
        console.log('  --interval MS    Check interval in milliseconds (default: 1000)');
        console.log('  --help           Show this help message');
        process.exit(0);
        break;
    }
  }
}

/**
 * Attempt to auto-detect gamelog.txt location based on OS
 */
function detectGamelogPath() {
  const platform = os.platform();
  const home = os.homedir();
  
  const possiblePaths = [];
  
  if (platform === 'win32') {
    // Windows paths
    possiblePaths.push(
      path.join(home, 'Documents', 'Descent', 'gamelog.txt'),
      path.join(home, 'Descent', 'gamelog.txt'),
      path.join('C:', 'Descent', 'gamelog.txt'),
      path.join('C:', 'Games', 'Descent', 'gamelog.txt')
    );
  } else if (platform === 'darwin') {
    // macOS paths
    possiblePaths.push(
      path.join(home, 'Library', 'Application Support', 'D2X-Rebirth', 'gamelog.txt'),
      path.join(home, '.d2x-rebirth', 'gamelog.txt')
    );
  } else {
    // Linux/Unix paths
    possiblePaths.push(
      path.join(home, '.d2x-rebirth', 'gamelog.txt'),
      path.join(home, '.local', 'share', 'd2x-rebirth', 'gamelog.txt')
    );
  }
  
  // Check current directory
  possiblePaths.push(path.join(process.cwd(), 'gamelog.txt'));
  
  for (const testPath of possiblePaths) {
    if (fs.existsSync(testPath)) {
      return testPath;
    }
  }
  
  return null;
}

/**
 * Verify server is reachable
 */
function checkServerConnection() {
  return new Promise((resolve, reject) => {
    const url = new URL(CONFIG.statusEndpoint, CONFIG.serverUrl);
    const client = url.protocol === 'https:' ? https : http;
    
    const req = client.get(url.toString(), (res) => {
      if (res.statusCode === 200 || res.statusCode === 404) {
        // 404 is okay - endpoint might not exist but server is up
        resolve(true);
      } else {
        reject(new Error(`Server returned status ${res.statusCode}`));
      }
    });
    
    req.on('error', (err) => {
      reject(err);
    });
    
    req.setTimeout(5000, () => {
      req.destroy();
      reject(new Error('Connection timeout'));
    });
  });
}

/**
 * Send gamelog data to server
 */
function uploadGamelogData(playerName, content) {
  return new Promise((resolve, reject) => {
    const url = new URL(CONFIG.uploadEndpoint, CONFIG.serverUrl);
    const client = url.protocol === 'https:' ? https : http;
    
    const payload = JSON.stringify({
      playerName: playerName,
      content: content
    });
    
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    
    const req = client.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`Upload failed with status ${res.statusCode}: ${data}`));
        }
      });
    });
    
    req.on('error', (err) => {
      reject(err);
    });
    
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Upload timeout'));
    });
    
    req.write(payload);
    req.end();
  });
}

/**
 * Process upload queue
 */
async function processUploadQueue() {
  if (isUploading || uploadQueue.length === 0) {
    return;
  }
  
  isUploading = true;
  
  try {
    const batch = uploadQueue.shift();
    await uploadGamelogData(batch.playerName, batch.content);
    console.log(`[${new Date().toISOString()}] Uploaded ${batch.lineCount} lines as ${batch.playerName}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Upload failed: ${err.message}`);
    // Don't retry - just log and continue
  }
  
  isUploading = false;
  
  // Process next item if available
  if (uploadQueue.length > 0) {
    setImmediate(processUploadQueue);
  }
}

/**
 * Detect player name from gamelog or config
 */
function detectPlayerName(content) {
  // Try to extract from gamelog lines like:
  // "You were killed by PlayerName"
  // "You killed PlayerName"
  // "PlayerName [You]"
  const lines = content.split('\n');
  
  for (const line of lines) {
    const youMatch = line.match(/\[You\].*?playerName=([^\s,\]]+)/);
    if (youMatch) {
      return youMatch[1];
    }
  }
  
  // Default to hostname if can't detect
  return os.hostname().replace(/[^a-zA-Z0-9-]/g, '');
}

/**
 * Read new lines from gamelog file
 */
function readNewLines() {
  try {
    const stats = fs.statSync(CONFIG.gamelogPath);
    
    // File was truncated (new game started)
    if (stats.size < lastPosition) {
      console.log(`[${new Date().toISOString()}] Gamelog reset detected - new game starting`);
      lastPosition = 0;
      currentGameId = null;
    }
    
    // No new data
    if (stats.size === lastPosition) {
      return;
    }
    
    // Read new content
    const fd = fs.openSync(CONFIG.gamelogPath, 'r');
    const buffer = Buffer.alloc(stats.size - lastPosition);
    fs.readSync(fd, buffer, 0, buffer.length, lastPosition);
    fs.closeSync(fd);
    
    lastPosition = stats.size;
    
    // Parse content
    const content = buffer.toString('utf8');
    const lines = content.split('\n').filter(line => line.trim().length > 0);
    
    if (lines.length === 0) {
      return;
    }
    
    // Detect player name if not set
    if (!CONFIG.playerName) {
      CONFIG.playerName = detectPlayerName(content);
      console.log(`[${new Date().toISOString()}] Detected player name: ${CONFIG.playerName}`);
    }
    
    // Queue for upload (send raw content, server will parse)
    uploadQueue.push({
      playerName: CONFIG.playerName,
      content: content,
      lineCount: lines.length
    });
    
    // Trigger processing
    processUploadQueue();
    
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`[${new Date().toISOString()}] Gamelog file not found - waiting for it to be created...`);
      lastPosition = 0;
      currentGameId = null;
    } else {
      console.error(`[${new Date().toISOString()}] Error reading gamelog: ${err.message}`);
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  console.log('DXX-Redux Gamelog Uploader');
  console.log('');
  
  parseArguments();
  
  // Determine gamelog path
  if (!CONFIG.gamelogPath) {
    CONFIG.gamelogPath = detectGamelogPath();
    
    if (!CONFIG.gamelogPath) {
      console.error('ERROR: Could not auto-detect gamelog.txt location.');
      console.error('Please specify the path manually with --gamelog option.');
      console.error('');
      console.error('Example:');
      console.error('  node gamelog-uploader.js --gamelog /path/to/gamelog.txt');
      process.exit(1);
    }
  }
  
  console.log(`Configuration:`);
  console.log(`  Server URL: ${CONFIG.serverUrl}`);
  console.log(`  Gamelog Path: ${CONFIG.gamelogPath}`);
  console.log(`  Player Name: ${CONFIG.playerName || '(auto-detect)'}`);
  console.log(`  Check Interval: ${CONFIG.checkInterval}ms`);
  console.log('');
  
  // Verify gamelog exists
  if (!fs.existsSync(CONFIG.gamelogPath)) {
    console.log(`WARNING: Gamelog file does not exist yet: ${CONFIG.gamelogPath}`);
    console.log(`Waiting for file to be created...`);
    console.log('');
  }
  
  // Check server connection
  try {
    await checkServerConnection();
    console.log(`Connected to server: ${CONFIG.serverUrl}`);
  } catch (err) {
    console.error(`WARNING: Could not connect to server: ${err.message}`);
    console.error(`Will continue attempting to upload...`);
  }
  
  console.log('');
  console.log(`Monitoring gamelog file...`);
  console.log(`Press Ctrl+C to stop`);
  console.log('');
  
  // Start monitoring
  setInterval(readNewLines, CONFIG.checkInterval);
  
  // Initial read to catch up with existing content
  readNewLines();
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('');
  console.log(`Shutting down...`);
  
  if (uploadQueue.length > 0) {
    console.log(`WARNING: ${uploadQueue.length} batches still in upload queue`);
  }
  
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

// Start the uploader
main().catch(err => {
  console.error('FATAL ERROR:', err.message);
  process.exit(1);
});
