'use strict';
// Electron main process. Thin shell:
//   1) probe / spawns the loopback service (server/src/index.js) as a child
//   2) validates license (email + machine binding) before showing main window
//   3) creates a frameless dark window
//   4) loads the built client (../client/dist) or the Vite dev server when OSAH_DEV=1
//   5) kills the spawned service when the app quits (unless it was already running)
//
// The service is the single owner of secrets/DB; this wrapper only talks to it
// over loopback HTTP. Never print or transmit any key material.

const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

// Disable GPU acceleration on Windows to prevent crashes — must be before app.whenReady()
if (process.platform === 'win32') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
}

const HOST = process.env.OSAH_HOST || '127.0.0.1';
const PORT = Number(process.env.OSAH_PORT || 8787);
const DEV = process.env.OSAH_DEV === '1';
const SERVER_ENTRY = path.join(__dirname, '..', 'server', 'src', 'index.js');
const DIST = path.join(__dirname, '..', 'client', 'dist', 'index.html');

// In production, client/dist is inside app.asar; in dev, it's on disk
const isPackaged = app.isPackaged;
const LOGIN_HTML = isPackaged
  ? path.join(__dirname, '..', 'client', 'dist', 'login.html')  // Inside app.asar
  : path.join(__dirname, '..', 'client', 'dist', 'login.html'); // On disk

let serviceProc = null;
let servicePreExisted = false;
let mainWindow = null;
let loginWindow = null;

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

// ---- License checking ------------------------------------------------------
async function checkLicense(email) {
  const base = `http://${HOST}:${PORT}`;
  try {
    const res = await fetch(`${base}/api/license/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OSAH-CSRF': '1' },
      body: JSON.stringify({ email: email.trim().toLowerCase() }),
    });
    const data = await res.json();
    return { ok: res.ok, data, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getMachineInfo() {
  const base = `http://${HOST}:${PORT}`;
  try {
    const res = await fetch(`${base}/api/license/machine`, {
      headers: { 'X-OSAH-CSRF': '1' },
    });
    return await res.json();
  } catch (e) {
    return { error: e.message };
  }
}

// ---- Window creation -------------------------------------------------------
function createLoginWindow() {
  if (loginWindow) {
    loginWindow.focus();
    return;
  }
  loginWindow = new BrowserWindow({
    width: 480,
    height: 600,
    minWidth: 440,
    minHeight: 550,
    backgroundColor: '#07070d',
    titleBarStyle: 'hiddenInset',
    resizable: false,
    maximizable: false,
    fullscreenable: false,
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

  loginWindow.setMenuBarVisibility(false);
  loginWindow.loadFile(LOGIN_HTML).catch((e) => console.error('[osah-desktop] login load failed', e));

  loginWindow.on('closed', () => { loginWindow = null; });
}

function createMainWindow() {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }
  mainWindow = new BrowserWindow({
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
      offscreen: false,
      enableRemoteModule: false,
    },
  });

  // Content Security Policy — restrict to local service + self
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self' http://${HOST}:${PORT} ws://${HOST}:${PORT}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ');
    const headers = { ...details.responseHeaders };
    headers['Content-Security-Policy'] = [csp];
    callback({ responseHeaders: headers });
  });

  // Open external links in the OS browser, never a new Electron window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  if (DEV) {
    mainWindow.loadURL(`http://localhost:5173`).catch((e) => console.error('[osah-desktop] dev load failed', e));
  } else {
    mainWindow.loadFile(DIST).catch((e) => console.error('[osah-desktop] load failed — run `npm run build` first', e));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---- License flow ----------------------------------------------------------
async function runLicenseFlow() {
  await ensureService();

  // Give service a moment to fully initialize
  await new Promise(r => setTimeout(r, 500));

  // Get machine info first
  const machineInfo = await getMachineInfo();
  console.log('[license] Machine:', machineInfo);

  // Check if we have a saved email (from previous successful login)
  const { readFileSync, existsSync } = require('fs');
  const emailPath = path.join(app.getPath('userData'), 'license-email.json');
  let savedEmail = null;
  if (existsSync(emailPath)) {
    try {
      savedEmail = JSON.parse(readFileSync(emailPath, 'utf8')).email;
    } catch {}
  }

  // If we have a saved email, try to validate it
  if (savedEmail) {
    console.log('[license] Trying saved email:', savedEmail);
    const result = await checkLicense(savedEmail);
    if (result.ok && result.data?.ok) {
      console.log('[license] Saved email validated:', savedEmail);
      // Save machine info for client
      saveMachineInfo(machineInfo);
      createMainWindow();
      return;
    }
    console.log('[license] Saved email failed:', result.data?.message || result.error);
  }

  // No valid saved email — show login window
  createLoginWindow();
}

function saveMachineInfo(info) {
  const { writeFileSync } = require('fs');
  const infoPath = path.join(app.getPath('userData'), 'machine-info.json');
  writeFileSync(infoPath, JSON.stringify(info, null, 2));
}

// IPC handlers for login window
ipcMain.handle('license:validate', async (_, email) => {
  const result = await checkLicense(email);
  if (result.ok && result.data?.ok) {
    // Save email for next launch
    const { writeFileSync } = require('fs');
    const emailPath = path.join(app.getPath('userData'), 'license-email.json');
    writeFileSync(emailPath, JSON.stringify({ email: email.trim().toLowerCase() }));
    // Save machine info
    const machineInfo = await getMachineInfo();
    saveMachineInfo(machineInfo);
    return { ok: true, machine: result.data.machine };
  }
  return { ok: false, message: result.data?.message || result.error || 'Validation failed' };
});

ipcMain.handle('license:machine', async () => {
  return await getMachineInfo();
});

ipcMain.on('license:success', () => {
  if (loginWindow) {
    loginWindow.close();
    loginWindow = null;
  }
  createMainWindow();
});

// ---- App lifecycle ---------------------------------------------------------
app.whenReady().then(async () => {
  await runLicenseFlow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      runLicenseFlow();
    }
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