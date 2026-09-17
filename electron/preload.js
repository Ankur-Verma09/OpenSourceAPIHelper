'use strict';
// Preload: a tiny, safe bridge. Exposes the resolved service base URL so the
// renderer can reach the loopback service. No key material ever crosses here.

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('osah', {
  // mirror the service default (127.0.0.1:8787) or overrides
  servicePort: () => Number(process.env.OSAH_PORT || 8787),
  serviceHost: () => process.env.OSAH_HOST || '127.0.0.1',
});