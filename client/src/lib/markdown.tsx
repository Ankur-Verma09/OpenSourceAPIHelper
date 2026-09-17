import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * GitHub-flavored markdown renderer used for assistant messages.
 * GFM enables tables, strikethrough, autolinks and task lists.
 */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source ?? ''}</ReactMarkdown>
    </div>
  );
}

/** Mask a key-like value to its display form (never show plaintext keys). */
export function maskExternal(input: string): string {
  const s = (input || '').trim();
  if (!s) return '• not set';
  if (s.length <= 8) return '••••••';
  const lead = s.slice(0, 3);
  const tail = s.slice(-4);
  return `${lead}••••••${tail}`;
}