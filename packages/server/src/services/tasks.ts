import {
  AgentMeshError,
  ErrorCode,
  LifecycleEventType,
  type Actor,
  type CreateTaskRequest,
  type Task,
  type TaskListQuery,
  type UpdateTaskRequest,
} from '@agentmesh/protocol';
import { jsonb, type Db } from '../db/client.js';
import type { SessionAccess } from '../auth/principal.js';
import { IdPrefix, newId } from '../ids.js';
import { toTask } from '../mappers.js';
import { escapeLike } from './messages.js';
import type { EventLog } from './eventLog.js';

/**
 * A deliberately small task system: enough to say who is doing what and what it
 * touches, and no more. Anything resembling workflows, sprints or custom fields
 * belongs in the tracker the team already uses.
 */
export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
  ) {}

  async list(sessionId: string, filter: TaskListQuery = {}): Promise<Task[]> {
    let query = this.db.selectFrom('tasks').selectAll().where('session_id', '=', sessionId);
    if (filter.status) query = query.where('status', '=', filter.status);
    if (filter.assigneeId) query = query.where('assignee_id', '=', filter.assigneeId);
    const rows = await query.orderBy('created_at', 'desc').execute();
    return rows.map(toTask);
  }

  async listOpen(sessionId: string): Promise<Task[]> {
    const rows = await this.db
      .selectFrom('tasks')
      .selectAll()
      .where('session_id', '=', sessionId)
      .where('status', '!=', 'done')
      .orderBy('created_at', 'desc')
      .limit(100)
      .execute();
    return rows.map(toTask);
  }

  async get(sessionId: string, taskId: string): Promise<Task> {
    const row = await this.db
      .selectFrom('tasks')
      .selectAll()
      .where('id', '=', taskId)
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    if (!row) throw new AgentMeshError(ErrorCode.NotFound, 'Task not found.');
    return toTask(row);
  }

  async create(access: SessionAccess, input: CreateTaskRequest): Promise<Task> {
    const assignee = input.assignee ? await this.resolveAssignee(access.sessionId, input.assignee) : null;

    return this.log.write(access.sessionId, async (ctx) => {
      let created: Task | undefined;
      await ctx.append(LifecycleEventType.TaskCreated, access.actor, async () => {
        const row = await ctx.trx
          .insertInto('tasks')
          .values({
            id: newId(IdPrefix.Task),
            session_id: access.sessionId,
            title: input.title,
            description: input.description ?? null,
            status: input.status ?? 'todo',
            creator_type: access.actor.type,
            creator_id: access.actor.id,
            creator_name: access.actor.name,
            assignee_type: assignee?.type ?? null,
            assignee_id: assignee?.id ?? null,
            assignee_name: assignee?.name ?? null,
            related_files: jsonb(input.relatedFiles ?? []),
            related_commits: jsonb(input.relatedCommits ?? []),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        created = toTask(row);
        return { task: created };
      });
      return created as Task;
    });
  }

  async update(access: SessionAccess, taskId: string, input: UpdateTaskRequest): Promise<Task> {
    const existing = await this.get(access.sessionId, taskId);

    const patch: Record<string, unknown> = { updated_at: new Date() };
    const changed: string[] = [];

    if (input.title !== undefined && input.title !== existing.title) {
      patch.title = input.title;
      changed.push('title');
    }
    if (input.description !== undefined && input.description !== existing.description) {
      patch.description = input.description;
      changed.push('description');
    }
    if (input.status !== undefined && input.status !== existing.status) {
      patch.status = input.status;
      changed.push('status');
    }
    if (input.assignee !== undefined) {
      const assignee = input.assignee ? await this.resolveAssignee(access.sessionId, input.assignee) : null;
      patch.assignee_type = assignee?.type ?? null;
      patch.assignee_id = assignee?.id ?? null;
      patch.assignee_name = assignee?.name ?? null;
      changed.push('assignee');
    }
    if (input.relatedFiles !== undefined) {
      patch.related_files = jsonb(input.relatedFiles);
      changed.push('relatedFiles');
    }
    if (input.relatedCommits !== undefined) {
      patch.related_commits = jsonb(input.relatedCommits);
      changed.push('relatedCommits');
    }

    if (changed.length === 0) return existing;

    return this.log.write(access.sessionId, async (ctx) => {
      let updated: Task | undefined;
      await ctx.append(LifecycleEventType.TaskUpdated, access.actor, async () => {
        const row = await ctx.trx
          .updateTable('tasks')
          .set(patch as never)
          .where('id', '=', taskId)
          .where('session_id', '=', access.sessionId)
          .returningAll()
          .executeTakeFirstOrThrow();
        updated = toTask(row);
        return { task: updated, changed };
      });
      return updated as Task;
    });
  }

  async remove(access: SessionAccess, taskId: string): Promise<void> {
    await this.get(access.sessionId, taskId);
    await this.log.write(access.sessionId, async (ctx) => {
      await ctx.append(LifecycleEventType.TaskDeleted, access.actor, async () => {
        await ctx.trx
          .deleteFrom('tasks')
          .where('id', '=', taskId)
          .where('session_id', '=', access.sessionId)
          .execute();
        return { taskId };
      });
    });
  }

  async search(sessionId: string, query: string, limit: number): Promise<Task[]> {
    const pattern = `%${escapeLike(query)}%`;
    const rows = await this.db
      .selectFrom('tasks')
      .selectAll()
      .where('session_id', '=', sessionId)
      .where((eb) => eb.or([eb('title', 'ilike', pattern), eb('description', 'ilike', pattern)]))
      .orderBy('updated_at', 'desc')
      .limit(limit)
      .execute();
    return rows.map(toTask);
  }

  /** Assignees are stored denormalized, so the reference must exist right now. */
  private async resolveAssignee(sessionId: string, assignee: { type: 'user' | 'agent'; id: string }): Promise<Actor> {
    if (assignee.type === 'agent') {
      const row = await this.db
        .selectFrom('agents')
        .select(['id', 'name'])
        .where('id', '=', assignee.id)
        .where('session_id', '=', sessionId)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      if (!row) throw new AgentMeshError(ErrorCode.ValidationFailed, 'Assignee agent is not in this session.');
      return { type: 'agent', id: row.id, name: row.name };
    }

    const row = await this.db
      .selectFrom('session_members')
      .innerJoin('users', 'users.id', 'session_members.user_id')
      .select(['users.id', 'users.display_name'])
      .where('session_members.session_id', '=', sessionId)
      .where('session_members.user_id', '=', assignee.id)
      .executeTakeFirst();
    if (!row) throw new AgentMeshError(ErrorCode.ValidationFailed, 'Assignee user is not in this session.');
    return { type: 'user', id: row.id, name: row.display_name };
  }
}
