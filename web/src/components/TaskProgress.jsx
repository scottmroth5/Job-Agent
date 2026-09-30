// Shows the steps of a background action as they happen.
export default function TaskProgress({ task }) {
  if (!task) return null;
  return (
    <div className={`task ${task.status}`} aria-live="polite">
      {task.steps.map((s, i) => (
        <div key={i} className="task-step">
          {i === task.steps.length - 1 && task.status === 'running' ? '⏳' : '✓'} {s.message}
        </div>
      ))}
      {task.status === 'running' && task.steps.length === 0 && <div className="task-step">⏳ Starting…</div>}
      {task.status === 'failed' && <div className="task-step error">✗ {task.error}</div>}
    </div>
  );
}
