'use strict';
// Command Execution Module.
// Safely executes shell commands locally and captures stdout, stderr, exit code, and duration.

const { exec } = require('child_process');
const path = require('path');
const os = require('os');
const { audit } = require('./util');
const { AppError, ERROR_CODES } = require('./errors');

const MAX_BUFFER = 2 * 1024 * 1024; // 2MB output buffer limit
const DEFAULT_TIMEOUT = 30000; // 30 seconds default timeout

function normalizeCwd(dir) {
  if (!dir || typeof dir !== 'string' || !dir.trim()) {
    return process.cwd();
  }
  let p = dir.trim();
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

/**
 * Execute a local shell command.
 * @param {Object} opts
 * @param {string} opts.command - Command line string to execute
 * @param {string} [opts.cwd] - Working directory
 * @param {number} [opts.timeout=30000] - Timeout in milliseconds
 * @returns {Promise<Object>} Execution result object
 */
function runCommand({ command, cwd, timeout = DEFAULT_TIMEOUT }) {
  return new Promise((resolve, reject) => {
    if (!command || typeof command !== 'string' || !command.trim()) {
      return reject(
        new AppError(
          ERROR_CODES.VALIDATION_FAILED,
          'Command string is required',
          400
        )
      );
    }

    const trimmedCmd = command.trim();
    const targetCwd = normalizeCwd(cwd);
    const startTime = Date.now();

    const options = {
      cwd: targetCwd,
      timeout: Math.min(Math.max(Number(timeout) || DEFAULT_TIMEOUT, 1000), 300000), // 1s to 5m
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
      env: { ...process.env },
    };

    exec(trimmedCmd, options, (err, stdout, stderr) => {
      const durationMs = Date.now() - startTime;
      const stdoutStr = stdout ? stdout.toString('utf8') : '';
      const stderrStr = stderr ? stderr.toString('utf8') : '';

      let exitCode = 0;
      let ok = true;

      if (err) {
        ok = false;
        exitCode = typeof err.code === 'number' ? err.code : 1;
        if (err.killed) {
          exitCode = -1; // timed out
        }
      }

      audit('exec_command', {
        command: trimmedCmd,
        cwd: targetCwd,
        exitCode,
        durationMs,
        ok,
      });

      resolve({
        ok,
        exitCode,
        stdout: stdoutStr,
        stderr: err && !stderrStr ? err.message : stderrStr,
        durationMs,
        cwd: targetCwd,
        command: trimmedCmd,
      });
    });
  });
}

module.exports = {
  runCommand,
  normalizeCwd,
};
