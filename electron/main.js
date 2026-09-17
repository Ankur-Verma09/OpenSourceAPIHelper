'use strict';
// Electron main process. Thin shell:
//   1) probe / spawns the loopback service (server/src/index.js) as a child
//   2) creates a frameless dark window
//   3) loads the built client (../client/dist) or the Vite dev server when OSAH_DEV=1
//   4) kills the spawned service when the app quits (unless it was already running)
//
// The service is the single owner of secrets/DB; this wrapper only talks to it
// over loopback HTTP. Never print or transmit any key material.

const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const HOST = process.env.OSAH_HOST || '127.0.0.1';
const PORT = Number(process.env.OSAH_PORT || 8787);
const DEV = process.env.OSAH_DEV === '1';
const SERVER_ENTRY = path.join(__dirname, '..', 'server', 'src', 'index.js');
const DIST = path.join(__dirname, '..', 'client', 'dist', 'index.html');

let serviceProc = null;
let servicePreExisted = false;

// ---- health probe ----------------------------------------------------------
function probe() {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, HOST);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    sock.setTimeout(1500);
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
  });
}

// ---- spawn the service if it isn't already up ------------------------------
async function ensureService() {
  if (await probe()) { servicePreExisted = true; return; }
  const node = process.execPath; // reuse the Electron-bundled Node for the server
  serviceProc = spawn(node, [SERVER_ENTRY], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  serviceProc.stdout.on('data', strip);
  serviceProc.stderr.on('data', strip);
  serviceProc.on('exit', (code) => {
    if (!app.isQuitting) console.log('[osah-desktop] service exited', code);
    serviceProc = null;
  });

  // wait for it to accept connections
  for (let i = 0; i < 60; i++) {
    if (await probe()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error('[osah-desktop] service did not come up on', `${HOST}:${PORT}`);
}

function strip(chunk) {
  const line = chunk.toString().trim();
  if (line) console.log('[service]', line);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#07070d',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // Content Security Policy — restrict to local service + self
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' http://127.0.0.1:8787 ws://127.0.0.1:8787",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
    const headers = { ...details.responseHeaders };
    headers['Content-Security-Policy'] = [csp];
    callback({ responseHeaders: headers });
  });

  // Open external links in the OS browser, never a new Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV) {
    win.loadURL(`http://localhost:5173`).catch((e) => console.error('[osah-desktop] dev load failed', e));
  } else {
    win.loadFile(DIST).catch((e) => console.error('[osah-desktop] load failed — run `npm run build` first', e));
  }
}

app.whenReady().then(async () => {
  await ensureService();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { app.isQuitting = true; });
app.on('window-all-closed', () => {
  if (!servicePreExisted && serviceProc) {
    serviceProc.kill();
    serviceProc = null;
  }
  app.quit();
});