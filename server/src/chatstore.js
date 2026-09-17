'use strict';
// Chat + memory domain. Sessions (multi-chat, per Req 4), history persistence
// (Req 7), and FTS reference search over all past messages (Req 3).

const crypto = require('crypto');
const db = require('./db');

const uid = () => crypto.randomUUID();
const now = () => Date.now();

function listChats() {
  const rows = db.all(
    `SELECT c.*, (SELECT count(*) FROM messages m WHERE m.chat_id = c.id) msg_count
       FROM chats c
      ORDER BY c.updated_at DESC`,
  );
  return rows.map((r) => ({
    id: r.id, title: r.title, model: r.model,
    created_at: r.created_at, updated_at: r.updated_at, msg_count: Number(r.msg_count ?? 0),
  }));
}

function createChat({ title, model } = {}) {
  const id = uid();
  const t = now();
  db.run('INSERT INTO chats (id, title, model, created_at, updated_at) VALUES (?,?,?,?,?)',
    id, title || `Chat ${String(t).slice(-4)}`, model || '', t, t);
  const c = db.one('SELECT * FROM chats WHERE id = ?', id);
  return { id: c.id, title: c.title, model: c.model, created_at: c.created_at, updated_at: c.updated_at, msg_count: 0 };
}

function renameChat(id, title) {
  db.run('UPDATE chats SET title=?, updated_at=? WHERE id=?', title || 'Untitled', now(), id);
}

function setChatModel(id, model) {
  db.run('UPDATE chats SET model=?, updated_at=? WHERE id=?', model || '', now(), id);
}

function getMessages(id) {
  return db.all(
    'SELECT id, chat_id, role, content, model, created_at FROM messages WHERE chat_id=? ORDER BY created_at ASC',
    id,
  );
}

function addMessage({ chatId, role, content, model }) {
  const id = uid();
  const t = now();
  db.run(
    'INSERT INTO messages (id, chat_id, role, content, model, created_at) VALUES (?,?,?,?,?,?)',
    id, chatId, role, content, model, t,
  );
  db.run('UPDATE chats SET updated_at=? WHERE id=?', t, chatId);
  return id;
}

function deleteChat(id) {
  db.run('DELETE FROM chats WHERE id=?', id); // cascade removes messages + fts via triggers
}

// Full-text reference search (Req 3). Returns snippets ranking by BM25.
function searchMemory(query, opts = {}) {
  const limit = Math.min(opts.limit ?? 10, 50);
  if (!query || !query.trim()) return [];
  const q = String(query).trim();
  return db.all(
    `SELECT f.msg_id, f.chat_id, f.content, bm25(messages_fts, 0, 8.0, 1.0) AS rank,
            c.title chat_title
       FROM messages_fts f
       JOIN messages m ON m.id = f.msg_id
       JOIN chats c ON c.id = f.chat_id
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?`,
    q.replace(/"/g, '""').replace(/[\s]+/g, ' ').trim(),
    limit,
  ).map((r) => ({
    msg_id: r.msg_id,
    chat_id: r.chat_id,
    chat_title: r.chat_title,
    content: r.content,
    snippet: makeSnippet(r.content, q),
    rank: Math.round((r.rank || 0) * -100) / 100,
  }));
}

function makeSnippet(content, query, width = 140) {
  const c = content || '';
  const i = c.toLowerCase().indexOf(query.toLowerCase());
  const start = i > width ? i - 40 : 0;
  const slice = c.slice(start, start + width * 2);
  return (start > 0 ? '…' : '') + slice + (c.length > start + slice.length ? '…' : '');
}

// Load the most recent N messages of a chat flattened to OpenAI history format.
function historyForChat(chatId, limit = 40) {
  const msgs = db.all(
    'SELECT role, content FROM messages WHERE chat_id=? ORDER BY id DESC LIMIT ?',
    chatId, limit,
  );
  return msgs.reverse().map((m) => ({ role: m.role, content: m.content }));
}

module.exports = {
  listChats, createChat, renameChat, setChatModel, getMessages,
  addMessage, deleteChat, searchMemory, historyForChat,
};