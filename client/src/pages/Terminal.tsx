import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { ExecCommandResult } from '../api/types';

interface HistoryItem {
  id: string;
  timestamp: number;
  result: ExecCommandResult;
}

export function Terminal() {
  const [command, setCommand] = useState('');
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);

  const runCmd = async (cmdToRun?: string) => {
    const targetCmd = (cmdToRun || command).trim();
    if (!targetCmd || busy) return;

    setBusy(true);
    setError(null);
    try {
      const res = await api.execCommand({
        command: targetCmd,
        cwd: cwd.trim() || undefined,
      });
      setHistory((prev) => [
        ...prev,
        {
          id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          timestamp: Date.now(),
          result: res,
        },
      ]);
      setCommand('');
      if (!cwd && res.cwd) {
        setCwd(res.cwd);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: 'smooth' });
  }, [history]);

  const presets = [
    { label: 'npm install', cmd: 'npm install' },
    { label: 'pip install', cmd: 'pip install ' },
    { label: 'node -v', cmd: 'node -v' },
    { label: 'python --version', cmd: 'python --version' },
    { label: 'git status', cmd: 'git status' },
  ];

  return (
    <div className="pane" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Header */}
      <div className="pane-head" style={{ gap: 8, flexWrap: 'wrap' }}>
        <strong>Terminal & Command Runner</strong>
        <div className="spacer" />
        {error && <div className="error-banner" style={{ maxWidth: 400 }}>{error}</div>}
        <button
          className="btn outline"
          onClick={() => setHistory([])}
          style={{ fontSize: 12, padding: '4px 10px' }}
        >
          Clear Output
        </button>
      </div>

      {/* CWD Bar & Quick Presets */}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 260 }}>
          <span style={{ fontSize: 12, color: 'var(--text-4)', whiteSpace: 'nowrap' }}>Working Dir (CWD):</span>
          <input
            type="text"
            className="input"
            style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12 }}
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="Default: system CWD / project root..."
          />
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {presets.map((p) => (
            <button
              key={p.label}
              className="btn outline"
              style={{ fontSize: 11, padding: '3px 8px' }}
              onClick={() => {
                setCommand(p.cmd);
                if (!p.cmd.endsWith(' ')) runCmd(p.cmd);
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Terminal Display Console */}
      <div
        ref={outputRef}
        className="glass"
        style={{
          flex: 1,
          background: 'var(--bg-0)',
          borderRadius: 'var(--radius)',
          border: '1px solid var(--glass-border)',
          padding: 14,
          overflowY: 'auto',
          fontFamily: 'var(--font-mono)',
          fontSize: 13,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          minHeight: 300,
        }}
      >
        {history.length === 0 && (
          <div style={{ color: 'var(--text-5)', padding: 12, textAlign: 'center' }}>
            Terminal ready. Type a command below or select a quick preset.
          </div>
        )}

        {history.map((item) => {
          const r = item.result;
          return (
            <div
              key={item.id}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
                padding: 10,
                background: 'rgba(255, 255, 255, 0.02)',
                borderRadius: 'var(--radius-sm)',
                borderLeft: `3px solid ${r.ok ? 'var(--success)' : 'var(--danger)'}`,
              }}
            >
              {/* Command Meta Line */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--cyan)', fontWeight: 600 }}>$ {r.command}</span>
                <div className="spacer" />
                <span
                  style={{
                    fontSize: 11,
                    padding: '1px 6px',
                    borderRadius: 4,
                    background: r.ok ? 'rgba(52, 211, 153, 0.15)' : 'rgba(248, 113, 113, 0.15)',
                    color: r.ok ? 'var(--success)' : 'var(--danger)',
                  }}
                >
                  {r.ok ? `exit 0` : `exit ${r.exitCode ?? 1}`}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-4)' }}>{r.durationMs}ms</span>
              </div>

              <div style={{ fontSize: 11, color: 'var(--text-5)' }}>{r.cwd}</div>

              {/* Stdout Output */}
              {r.stdout && (
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: 'var(--text-2)',
                    lineHeight: 1.45,
                  }}
                >
                  {r.stdout}
                </pre>
              )}

              {/* Stderr Output */}
              {r.stderr && (
                <pre
                  style={{
                    margin: 0,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    color: 'var(--danger)',
                    lineHeight: 1.45,
                  }}
                >
                  {r.stderr}
                </pre>
              )}
            </div>
          );
        })}
      </div>

      {/* Terminal Input Bar */}
      <div className="row" style={{ gap: 8 }}>
        <span style={{ fontSize: 16, color: 'var(--violet)', fontFamily: 'var(--font-mono)' }}>$</span>
        <input
          type="text"
          className="input"
          style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 13 }}
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="Enter command (e.g. npm install axios, python script.py, node index.js)..."
          onKeyDown={(e) => {
            if (e.key === 'Enter') runCmd();
          }}
        />
        <button
          className="btn primary"
          disabled={busy || !command.trim()}
          onClick={() => runCmd()}
          style={{ padding: '6px 16px' }}
        >
          {busy ? <span className="spinner" /> : 'Run Command'}
        </button>
      </div>
    </div>
  );
}
