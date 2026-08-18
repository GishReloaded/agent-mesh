import type { ContextEntry, Event as MeshEvent, Task } from '@agentmesh/sdk';
import { useState } from 'react';

type Tab = 'tasks' | 'context' | 'activity';

export function ContextPanel({
  tasks,
  context,
  events,
  onCreateTask,
  onUpdateTaskStatus,
}: {
  tasks: Task[];
  context: ContextEntry[];
  events: MeshEvent[];
  onCreateTask: (title: string) => Promise<void>;
  onUpdateTaskStatus: (taskId: string, status: Task['status']) => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>('tasks');

  return (
    <div className="panel panel-right">
      <div className="tabs">
        {(['tasks', 'context', 'activity'] as Tab[]).map((name) => (
          <button key={name} className={tab === name ? 'active' : ''} onClick={() => setTab(name)}>
            {name === 'tasks' ? `Tasks (${tasks.filter((t) => t.status !== 'done').length})` : null}
            {name === 'context' ? `Context (${context.length})` : null}
            {name === 'activity' ? 'Activity' : null}
          </button>
        ))}
      </div>

      <div className="panel-scroll">
        {tab === 'tasks' && <TaskTab tasks={tasks} onCreate={onCreateTask} onUpdateStatus={onUpdateTaskStatus} />}
        {tab === 'context' && <ContextTab entries={context} />}
        {tab === 'activity' && <ActivityTab events={events} />}
      </div>
    </div>
  );
}

const NEXT_STATUS: Record<Task['status'], Task['status']> = {
  todo: 'in_progress',
  in_progress: 'review',
  review: 'done',
  blocked: 'in_progress',
  done: 'todo',
};

function TaskTab({
  tasks,
  onCreate,
  onUpdateStatus,
}: {
  tasks: Task[];
  onCreate: (title: string) => Promise<void>;
  onUpdateStatus: (taskId: string, status: Task['status']) => Promise<void>;
}) {
  const [title, setTitle] = useState('');

  return (
    <>
      <form
        className="row"
        style={{ marginBottom: 12 }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!title.trim()) return;
          void onCreate(title.trim()).then(() => setTitle(''));
        }}
      >
        <input value={title} placeholder="New task" onChange={(event) => setTitle(event.target.value)} />
        <button type="submit" disabled={!title.trim()}>
          Add
        </button>
      </form>

      {tasks.length === 0 && <div className="sub">No tasks yet.</div>}
      {tasks.map((task) => (
        <div key={task.id} className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="title">{task.title}</span>
            <button
              className={`status-chip status-${task.status}`}
              title="Advance status"
              onClick={() => void onUpdateStatus(task.id, NEXT_STATUS[task.status])}
            >
              {task.status.replace('_', ' ')}
            </button>
          </div>
          {task.description && <div className="sub">{task.description}</div>}
          <div className="sub">
            {task.assignee ? `assigned to ${task.assignee.name}` : 'unassigned'}
            {task.relatedFiles.length > 0 && ` - ${task.relatedFiles.length} file(s)`}
          </div>
        </div>
      ))}
    </>
  );
}

function ContextTab({ entries }: { entries: ContextEntry[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const grouped = entries.reduce<Record<string, ContextEntry[]>>((acc, entry) => {
    (acc[entry.kind] ??= []).push(entry);
    return acc;
  }, {});

  if (entries.length === 0) {
    return (
      <div className="sub">
        Nothing published yet. Agents publish contracts, decisions and project state here so they do not have to
        re-read the chat.
      </div>
    );
  }

  return (
    <>
      {Object.entries(grouped).map(([kind, items]) => (
        <div key={kind}>
          <div className="panel-title">{kind.replace('_', ' ')}</div>
          {items.map((entry) => (
            <div key={entry.id} className="card">
              <button
                className="ghost"
                style={{ padding: 0, textAlign: 'left', width: '100%' }}
                onClick={() => setOpen(open === entry.id ? null : entry.id)}
              >
                <span className="title">{entry.title}</span>
              </button>
              <div className="sub">
                {entry.key} - v{entry.version} - {entry.updatedBy.name ?? 'unknown'}
              </div>
              {open === entry.id && (
                <div style={{ marginTop: 8 }}>
                  {entry.body && <div style={{ whiteSpace: 'pre-wrap' }}>{entry.body}</div>}
                  {Object.keys(entry.data).length > 0 && (
                    <pre style={{ overflowX: 'auto', background: 'var(--bg-input)', padding: 8, borderRadius: 6 }}>
                      {JSON.stringify(entry.data, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function ActivityTab({ events }: { events: MeshEvent[] }) {
  if (events.length === 0) return <div className="sub">No development events yet.</div>;
  return (
    <>
      {[...events].reverse().map((event) => (
        <div key={event.id} className="card">
          <div className="title" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
            {event.type}
          </div>
          <div className="sub">
            {event.actor.name ?? 'system'} - {new Date(event.createdAt).toLocaleString()}
          </div>
          <pre style={{ overflowX: 'auto', marginTop: 6 }}>{JSON.stringify(event.payload, null, 2)}</pre>
        </div>
      ))}
    </>
  );
}
