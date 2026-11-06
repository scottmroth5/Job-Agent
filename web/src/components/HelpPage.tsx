import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api.ts';
import type { ApiResponse } from '../api.ts';
import { useDemo } from '../demo.tsx';
import { renderMarkdown } from '../../../tools/markdown.ts';

/** Help: the guides (help/*.md, through the app's one safe Markdown renderer) and Ask, answered from them by AI. */
export default function HelpPage() {
  const demo = useDemo();
  const [guides, setGuides] = useState<ApiResponse<'GET /api/help'> | null>(null);
  const [open, setOpen] = useState('getting-started');
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.help().then(setGuides, (err: Error) => setError((err as Error).message));
  }, []);

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    setAsking(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer((await api.askHelp(question.trim())).answer);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="help-page">
        <section className="home-card">
          <h2>Ask</h2>
          <form onSubmit={ask}>
            <textarea className="profile-text" rows={2} maxLength={500} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="How do I…" />
            <div className="row">
              <button className="primary" type="submit" disabled={!question.trim() || asking}>
                {asking ? 'Thinking…' : 'Ask'}
              </button>
              <span className="muted small">Answered from the guides below, using your AI.</span>
            </div>
          </form>
          {answer && <p className="help-answer">{answer}</p>}
          {error && <div className="error">{error}</div>}
        </section>
      {(guides ?? []).map((g) => (
        <section key={g.id} className="home-card help-guide">
          <button type="button" className="link help-title" aria-expanded={open === g.id} onClick={() => setOpen(open === g.id ? null : g.id)}>
            {g.title}
          </button>
          {open === g.id && <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(g.markdown.replace(/^#\s+.+\n+/, '')) }} />}
        </section>
      ))}
    </div>
  );
}
