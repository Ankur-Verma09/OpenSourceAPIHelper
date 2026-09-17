'use strict';
// Windows Service registration (Req 10). Standalone, no extra deps: generates a
// launch .cmd (sets the runtime env, runs the server) then registers/removes it
// with `sc` (LocalSystem). Run from an ADMIN shell:
//
//   node scripts\service\windows-service.js install
//   node scripts\service\windows-service.js uninstall
//
// The service binds to 127.0.0.1 only. No secrets live in these env vars (the
// vault/materkey stay in OSAH_DATA_DIR).
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'server', 'src', 'index.js');
const DATA_DIR = process.env.OSAH_DATA_DIR || path.join(ROOT, 'data');
const PORT = process.env.OSAH_PORT || '8787';
const SVC = 'OSAH';
const LAUNCH = path.join(DATA_DIR, 'osah-service.cmd');

function nodeExe() {
  // Prefer a pinned copy if provided, else the node that runs this script.
  return process.env.OSAH_NODE_EXE || process.execPath;
}

function writeLaunch() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // NoYFgu gzip -- the .cmd must not print secrets; it only redirects logs.
  const body = [
    '@echo off',
    'setlocal',
    `set NODE="${nodeExe()}"`,
    `set OSAH_DATA_DIR=${DATA_DIR}`,
    `set OSAH_PORT=${PORT}`,
    `set OSAH_HOST=127.0.0.1`,
    `"%NODE%" "${SERVER}" >> "${path.join(DATA_DIR, 'osah.log')}" 2>&1`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');
  fs.writeFileSync(LAUNCH, body);
  console.log('wrote', LAUNCH);
}

function cmd(args) {
  const r = spawnSync('sc.exe', args, { encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function install() {
  writeLaunch();
  // sc requires the binPath to be quoted; use cmd.exe as the restrter so the
  // service survives the node child being killed (failsafe restart).
  const bin = `cmd.exe /c ""${LAUNCH}""`;
  const r1 = cmd(['create', SVC, 'binPath=', bin, 'start=', 'auto', 'type=', 'own', 'obj=', 'LocalSystem']);
  if (r1.code !== 0 && /already exists/i.test(r1.out)) {
    cmd(['stop', SVC]);
    cmd(['config', SVC, 'binPath=', bin]);
  }
  const r2 = cmd(['config', SVC, 'start=', 'auto']);
  const r3 = cmd(['description', SVC, 'OpenSourceAPIHelper loopback service']);
  console.log(r1.out.trim());
  if (r1.code === 0) console.log('Service installed:', SVC);
  else console.error('sc create returned', r1.code, r1.out, r2.out);
}

function uninstall() {
  cmd(['stop', SVC]);
  const r = cmd(['delete', SVC]);
  console.log(r.out.trim());
  if (r.code === 0) console.log('Service removed. Logs remain in', DATA_DIR);
}

const action = process.argv[2];
if (action === 'install') install();
else if (action === 'uninstall') uninstall();
else console.log('usage: node windows-service.js <install|uninstall>');