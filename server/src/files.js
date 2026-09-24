'use strict';
// Local File System Operations Module.
// Provides safe reading, writing, listing, and deletion of local files.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { audit } = require('./util');
const { AppError, ERROR_CODES } = require('./errors');

const MAX_READ_TEXT_SIZE = 10 * 1024 * 1024; // 10MB limit for text read

function normalizePath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string' || !targetPath.trim()) {
    return os.homedir();
  }
  let p = targetPath.trim();
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

/**
 * List directory contents with item metadata.
 */
function listDirectory(dirPath) {
  const resolved = normalizePath(dirPath);
  if (!fs.existsSync(resolved)) {
    throw new AppError(
      ERROR_CODES.NOT_FOUND,
      `Directory does not exist: ${resolved}`,
      404,
      { path: resolved }
    );
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      `Path is a file, not a directory: ${resolved}`,
      400,
      { path: resolved }
    );
  }

  const entries = fs.readdirSync(resolved, { withFileTypes: true });
  const items = [];

  for (const entry of entries) {
    const fullPath = path.join(resolved, entry.name);
    try {
      const entryStat = fs.statSync(fullPath);
      items.push({
        name: entry.name,
        path: fullPath,
        isDirectory: entryStat.isDirectory(),
        size: entryStat.size,
        mtime: entryStat.mtimeMs,
      });
    } catch {
      // Ignore broken symlinks or unreadable items
      items.push({
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        size: 0,
        mtime: 0,
      });
    }
  }

  // Sort directories first, then alphabetically by name
  items.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });
  });

  return {
    currentPath: resolved,
    parentPath: path.dirname(resolved) !== resolved ? path.dirname(resolved) : resolved,
    items,
  };
}

/**
 * Read local file contents (text utf8 or base64).
 */
function readFileContent(filePath, encoding = 'utf8') {
  const resolved = normalizePath(filePath);
  if (!fs.existsSync(resolved)) {
    throw new AppError(
      ERROR_CODES.NOT_FOUND,
      `File does not exist: ${resolved}`,
      404,
      { path: resolved }
    );
  }

  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      `Cannot read directory as file: ${resolved}`,
      400,
      { path: resolved }
    );
  }

  const enc = encoding === 'base64' ? 'base64' : 'utf8';

  if (enc === 'utf8' && stat.size > MAX_READ_TEXT_SIZE) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      `File size (${(stat.size / 1024 / 1024).toFixed(2)} MB) exceeds text read limit (10 MB).`,
      400,
      { path: resolved, size: stat.size }
    );
  }

  const raw = fs.readFileSync(resolved, enc);
  const content = String(raw);
  const lines = enc === 'utf8' ? content.split('\n').length : undefined;

  return {
    path: resolved,
    name: path.basename(resolved),
    content,
    encoding: enc,
    size: stat.size,
    mtime: stat.mtimeMs,
    lines,
  };
}

/**
 * Write content to a local file. Automatically creates parent directories.
 */
function writeFileContent(filePath, content, encoding = 'utf8', overwrite = true) {
  if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'Target file path is required',
      400
    );
  }

  const resolved = normalizePath(filePath);
  const parentDir = path.dirname(resolved);

  if (fs.existsSync(resolved)) {
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        `Cannot overwrite directory with file: ${resolved}`,
        400,
        { path: resolved }
      );
    }
    if (!overwrite) {
      throw new AppError(
        ERROR_CODES.VALIDATION_FAILED,
        `File already exists: ${resolved}`,
        409,
        { path: resolved }
      );
    }
  }

  // Ensure parent directory exists recursively
  fs.mkdirSync(parentDir, { recursive: true });

  const dataContent = content !== undefined && content !== null ? String(content) : '';
  const enc = encoding === 'base64' ? 'base64' : 'utf8';

  fs.writeFileSync(resolved, dataContent, enc);
  const stat = fs.statSync(resolved);

  audit('file_write', { path: resolved, size: stat.size, encoding: enc });

  return {
    ok: true,
    path: resolved,
    name: path.basename(resolved),
    size: stat.size,
    mtime: stat.mtimeMs,
  };
}

/**
 * Delete a local file or directory.
 */
function deleteFile(filePath) {
  if (!filePath || typeof filePath !== 'string' || !filePath.trim()) {
    throw new AppError(
      ERROR_CODES.VALIDATION_FAILED,
      'Target path is required for deletion',
      400
    );
  }

  const resolved = normalizePath(filePath);
  if (!fs.existsSync(resolved)) {
    throw new AppError(
      ERROR_CODES.NOT_FOUND,
      `Path does not exist: ${resolved}`,
      404,
      { path: resolved }
    );
  }

  fs.rmSync(resolved, { recursive: true, force: true });
  audit('file_delete', { path: resolved });

  return { ok: true, path: resolved };
}

/**
 * Get file or directory stat metadata.
 */
function getFileMetadata(filePath) {
  const resolved = normalizePath(filePath);
  if (!fs.existsSync(resolved)) {
    throw new AppError(
      ERROR_CODES.NOT_FOUND,
      `Path does not exist: ${resolved}`,
      404,
      { path: resolved }
    );
  }

  const stat = fs.statSync(resolved);
  return {
    path: resolved,
    name: path.basename(resolved),
    isDirectory: stat.isDirectory(),
    size: stat.size,
    mtime: stat.mtimeMs,
  };
}

module.exports = {
  listDirectory,
  readFileContent,
  writeFileContent,
  deleteFile,
  getFileMetadata,
  normalizePath,
};
