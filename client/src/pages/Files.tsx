import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { DirectoryListResult, FileContentResult, FileItem } from '../api/types';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDate(mtime: number): string {
  if (!mtime) return '—';
  return new Date(mtime).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function Files() {
  const [currentPath, setCurrentPath] = useState<string>('');
  const [parentPath, setParentPath] = useState<string>('');
  const [items, setItems] = useState<FileItem[]>([]);
  const [pathInput, setPathInput] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Active Editor State
  const [activeFile, setActiveFile] = useState<FileContentResult | null>(null);
  const [editorContent, setEditorContent] = useState<string>('');
  const [isDirty, setIsDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [busySave, setBusySave] = useState(false);

  // New File Modal State
  const [showNewModal, setShowNewModal] = useState(false);
  const [newFilePath, setNewFilePath] = useState('');
  const [newFileContent, setNewFileContent] = useState('');

  const loadDir = useCallback(async (targetPath?: string) => {
    setLoading(true);
    setError(null);
    try {
      const res: DirectoryListResult = await api.listFiles(targetPath);
      setCurrentPath(res.currentPath);
      setParentPath(res.parentPath);
      setItems(res.items);
      setPathInput(res.currentPath);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDir();
  }, [loadDir]);

  const openFile = async (filePath: string) => {
    setError(null);
    setSaveStatus(null);
    try {
      const res = await api.readFile(filePath);
      setActiveFile(res);
      setEditorContent(res.content);
      setIsDirty(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const saveFile = async () => {
    if (!activeFile) return;
    setBusySave(true);
    setSaveStatus(null);
    try {
      const res = await api.writeFile({
        path: activeFile.path,
        content: editorContent,
        overwrite: true,
      });
      setActiveFile((prev) => (prev ? { ...prev, size: res.size, mtime: res.mtime } : prev));
      setIsDirty(false);
      setSaveStatus('File saved successfully!');
      // refresh dir list
      loadDir(currentPath);
      setTimeout(() => setSaveStatus(null), 3000);
    } catch (e) {
      setSaveStatus(`Save failed: ${(e as Error).message}`);
    } finally {
      setBusySave(false);
    }
  };

  const createNewFile = async () => {
    if (!newFilePath.trim()) return;
    setBusySave(true);
    try {
      await api.writeFile({
        path: newFilePath.trim(),
        content: newFileContent,
        overwrite: true,
      });
      setShowNewModal(false);
      setNewFilePath('');
      setNewFileContent('');
      await loadDir(currentPath);
      await openFile(newFilePath.trim());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusySave(false);
    }
  };

  const deleteItem = async (e: React.MouseEvent, item: FileItem) => {
    e.stopPropagation();
    const typeStr = item.isDirectory ? 'directory' : 'file';
    if (!confirm(`Are you sure you want to delete ${typeStr}:\n${item.path}?`)) return;
    try {
      await api.deleteFile(item.path);
      if (activeFile?.path === item.path) {
        setActiveFile(null);
      }
      loadDir(currentPath);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const sendToChat = (content: string, filename: string) => {
    const formattedPrompt = `[Local File: ${filename}]\n\`\`\`\n${content}\n\`\`\`\n`;
    window.dispatchEvent(new CustomEvent('osah:send-to-chat', { detail: formattedPrompt }));
  };

  return (
    <div className="pane" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Top Controls & Navigation Bar */}
      <div className="pane-head" style={{ gap: 8, flexWrap: 'wrap' }}>
        <strong>Local Files</strong>
        <div className="spacer" />
        {error && <div className="error-banner" style={{ maxWidth: 400 }}>{error}</div>}
      </div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button className="btn outline" onClick={() => loadDir(parentPath)} title="Go up one folder">
          ⬆ Up
        </button>
        <button className="btn outline" onClick={() => loadDir('')} title="Home Directory">
          🏠 Home
        </button>
        <button className="btn outline" onClick={() => loadDir(currentPath)} title="Refresh">
          🔄 Refresh
        </button>
        <div style={{ flex: 1, display: 'flex', gap: 6, minWidth: 240 }}>
          <input
            type="text"
            className="input"
            style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 13 }}
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') loadDir(pathInput);
            }}
            placeholder="Enter directory path..."
          />
          <button className="btn outline" onClick={() => loadDir(pathInput)}>
            Go
          </button>
        </div>
        <button
          className="btn primary"
          onClick={() => {
            setNewFilePath(currentPath ? `${currentPath}/new_file.txt` : 'new_file.txt');
            setNewFileContent('');
            setShowNewModal(true);
          }}
        >
          + New File
        </button>
      </div>

      {/* Main Split Layout: Left File Explorer, Right Editor */}
      <div style={{ display: 'flex', gap: 16, flex: 1, minHeight: 400 }}>
        {/* Left: Directory File List */}
        <div
          className="glass"
          style={{
            flex: activeFile ? '0 0 340px' : '1',
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 'var(--radius)',
            overflow: 'hidden',
            border: '1px solid var(--glass-border)',
          }}
        >
          <div
            style={{
              padding: '10px 14px',
              borderBottom: '1px solid var(--glass-border)',
              background: 'var(--glass-strong)',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>
              {items.length} items in folder
            </span>
            {loading && <span className="spinner" style={{ marginLeft: 10 }} />}
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: 6 }}>
            {items.length === 0 && !loading && (
              <div className="note" style={{ padding: 16, textAlign: 'center' }}>
                Empty directory
              </div>
            )}
            {items.map((item) => {
              const isSelected = activeFile?.path === item.path;
              return (
                <div
                  key={item.path}
                  className={`chat-item ${isSelected ? 'active' : ''}`}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 'var(--radius-sm)',
                    marginBottom: 3,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                  onClick={() => {
                    if (item.isDirectory) loadDir(item.path);
                    else openFile(item.path);
                  }}
                >
                  <span style={{ fontSize: 16 }}>{item.isDirectory ? '📁' : '📄'}</span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div
                      style={{
                        fontWeight: item.isDirectory ? 600 : 400,
                        fontSize: 13,
                        color: item.isDirectory ? 'var(--cyan)' : 'var(--text-1)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={item.name}
                    >
                      {item.name}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-4)', display: 'flex', gap: 10 }}>
                      {!item.isDirectory && <span>{formatBytes(item.size)}</span>}
                      <span>{formatDate(item.mtime)}</span>
                    </div>
                  </div>
                  {!item.isDirectory && (
                    <button
                      className="btn ghost"
                      style={{ padding: '2px 6px', fontSize: 11 }}
                      title="Send file context to Chat"
                      onClick={(e) => {
                        e.stopPropagation();
                        api.readFile(item.path).then((f) => sendToChat(f.content, f.name));
                      }}
                    >
                      💬 Chat
                    </button>
                  )}
                  <button
                    className="del ghost-danger"
                    style={{ padding: '2px 6px', fontSize: 11 }}
                    title="Delete item"
                    onClick={(e) => deleteItem(e, item)}
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: File Editor / Reader View */}
        {activeFile ? (
          <div
            className="glass"
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              borderRadius: 'var(--radius)',
              overflow: 'hidden',
              border: '1px solid var(--glass-border)',
            }}
          >
            {/* Editor Header */}
            <div
              style={{
                padding: '8px 14px',
                background: 'var(--glass-strong)',
                borderBottom: '1px solid var(--glass-border)',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
            >
              <span style={{ fontSize: 16 }}>📄</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 13,
                    color: 'var(--text-1)',
                    fontFamily: 'var(--font-mono)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={activeFile.path}
                >
                  {activeFile.name} {isDirty && <span style={{ color: 'var(--warn)' }}>●</span>}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-4)' }}>
                  {formatBytes(activeFile.size)} · {activeFile.lines ?? 0} lines
                </div>
              </div>

              {saveStatus && (
                <span
                  style={{
                    fontSize: 12,
                    color: saveStatus.includes('failed') ? 'var(--danger)' : 'var(--success)',
                  }}
                >
                  {saveStatus}
                </span>
              )}

              <button
                className="btn primary"
                disabled={busySave || !isDirty}
                onClick={saveFile}
                style={{ fontSize: 12, padding: '4px 12px' }}
              >
                {busySave ? <span className="spinner" /> : '💾 Save'}
              </button>
              <button
                className="btn outline"
                onClick={async () => {
                  const ext = activeFile.name.split('.').pop()?.toLowerCase();
                  let cmd = `node "${activeFile.path}"`;
                  if (ext === 'py') cmd = `python "${activeFile.path}"`;
                  else if (ext === 'sh' || ext === 'bash') cmd = `bash "${activeFile.path}"`;
                  else if (ext === 'bat' || ext === 'cmd') cmd = `"${activeFile.path}"`;
                  
                  try {
                    const res = await api.execCommand({ command: cmd, cwd: currentPath });
                    const outputMsg = `[Execution Output of ${activeFile.name}]\nExit code: ${res.exitCode}\nSTDOUT:\n${res.stdout || '(none)'}\n${res.stderr ? `STDERR:\n${res.stderr}` : ''}`;
                    alert(outputMsg);
                  } catch (err) {
                    alert(`Execution failed: ${(err as Error).message}`);
                  }
                }}
                style={{ fontSize: 12, padding: '4px 10px' }}
                title="Run script using Node/Python/Shell"
              >
                ▶ Run File
              </button>
              <button
                className="btn outline"
                onClick={() => sendToChat(editorContent, activeFile.name)}
                style={{ fontSize: 12, padding: '4px 10px' }}
                title="Send file content to Chat prompt"
              >
                💬 Send to Chat
              </button>
              <button
                className="btn ghost"
                onClick={() => setActiveFile(null)}
                style={{ fontSize: 14, padding: '4px 8px' }}
                title="Close Editor"
              >
                ✕
              </button>
            </div>

            {/* Code / Text Area */}
            <textarea
              value={editorContent}
              onChange={(e) => {
                setEditorContent(e.target.value);
                setIsDirty(true);
              }}
              style={{
                flex: 1,
                width: '100%',
                padding: 14,
                background: 'var(--bg-0)',
                color: 'var(--text-1)',
                fontFamily: 'var(--font-mono)',
                fontSize: 13,
                lineHeight: 1.5,
                border: 'none',
                outline: 'none',
                resize: 'none',
                tabSize: 2,
              }}
              placeholder="File content..."
              spellCheck={false}
            />
          </div>
        ) : (
          <div
            className="glass"
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              color: 'var(--text-4)',
              borderRadius: 'var(--radius)',
              border: '1px dashed var(--glass-border)',
              padding: 24,
            }}
          >
            <span style={{ fontSize: 36, marginBottom: 12 }}>📂</span>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Select a file to view or edit its contents</div>
            <div style={{ fontSize: 12, color: 'var(--text-5)', marginTop: 4 }}>
              Click any text file on the left, or create a new file.
            </div>
          </div>
        )}
      </div>

      {/* New File Modal */}
      {showNewModal && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
          }}
        >
          <div
            className="glass"
            style={{
              width: 500,
              maxWidth: '90vw',
              padding: 20,
              borderRadius: 'var(--radius-lg)',
              border: '1px solid var(--glass-border-strong)',
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
            }}
          >
            <h3 style={{ margin: 0 }}>Create & Write Local File</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: 'var(--text-3)' }}>File Path:</label>
              <input
                type="text"
                className="input"
                style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
                value={newFilePath}
                onChange={(e) => setNewFilePath(e.target.value)}
                placeholder="e.g. C:\path\to\file.txt"
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12, color: 'var(--text-3)' }}>Initial Content:</label>
              <textarea
                className="input"
                style={{
                  height: 120,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 13,
                  resize: 'vertical',
                }}
                value={newFileContent}
                onChange={(e) => setNewFileContent(e.target.value)}
                placeholder="Type file content here..."
              />
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 6 }}>
              <button className="btn outline" onClick={() => setShowNewModal(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busySave} onClick={createNewFile}>
                {busySave ? <span className="spinner" /> : 'Write File'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
