import { describe, expect, test } from 'bun:test';
import {
  formatInlineTaskEventText,
  getInlineTaskDetail,
  getInlineTaskLabel,
  getInlineTaskStatusLabel,
  getInlineWorkflowProgressLines,
  selectVisibleAssistantText,
} from './inlineTaskPresentation';

describe('inlineTaskPresentation', () => {
  test('formats workflow labels and progress lines for inline task cards', () => {
    const task = {
      task_type: 'local_workflow',
      workflow_name: 'build-release',
      status: 'running',
      workflow_progress: [
        { phaseIndex: 0, label: 'prepare', status: 'done' },
        { phaseIndex: 1, label: 'compile', status: 'running', detail: 'worker-2' },
      ],
    };

    expect(getInlineTaskLabel(task, 'Agent')).toBe('Workflow build-release');
    expect(getInlineTaskDetail(task).statusLabel).toBe('Running...');
    expect(getInlineWorkflowProgressLines(task.workflow_progress)).toEqual([
      'Phase 1 · prepare · done',
      'Phase 2 · compile · running · worker-2',
    ]);
  });

  test('falls back to task-type specific labels for remote and teammate tasks', () => {
    expect(getInlineTaskLabel({
      task_type: 'remote_agent',
      summary: 'review auth flow',
    }, 'Agent')).toBe('Remote agent review auth flow');

    expect(getInlineTaskLabel({
      task_type: 'in_process_teammate',
      description: 'sync package versions',
    }, 'Agent')).toBe('Teammate sync package versions');
  });

  test('normalizes status and generic task event copy', () => {
    expect(getInlineTaskStatusLabel('failed')).toBe('Failed');
    expect(getInlineTaskStatusLabel('completed')).toBe('Done');
    expect(formatInlineTaskEventText({ description: 'waiting for monitor sample' })).toBe('waiting for monitor sample');
    expect(formatInlineTaskEventText({})).toBe('Task event');
  });

  test('promotes a completed agent summary when assistant text is still starter copy', () => {
    const text = selectVisibleAssistantText(
      '我先快速梳理这个仓库的结构和当前改动，再给你一个项目分析摘要。',
      [{
        name: 'Agent',
        status: 'done',
        subagent: {
          task_type: 'local_agent',
          description: 'Scan project architecture',
          status: 'completed',
          summary: '以下是项目结构速览。',
        },
      }],
    );

    expect(text).toBe('以下是项目结构速览。');
  });

  test('keeps failed agent cards out of visible assistant text when completed summaries exist', () => {
    const text = selectVisibleAssistantText(
      '我先并行梳理项目结构和当前改动，再给你一个总结。',
      [
        {
          name: 'Agent',
          status: 'done',
          subagent: {
            task_type: 'local_agent',
            description: 'Map project architecture',
            status: 'completed',
            summary: '项目主入口在 electron/main.cjs。',
          },
        },
        {
          name: 'Agent',
          status: 'error',
          subagent: {
            task_type: 'local_agent',
            description: 'Inspect current changes',
            status: 'error',
            is_error: true,
          },
          result: 'Failed to create worktree: could not lock config file .git/config',
        },
      ],
    );

    expect(text).toContain('项目主入口在 electron/main.cjs。');
    expect(text).not.toContain('### 未完成任务');
    expect(text).not.toContain('Agent Inspect current changes: Failed to create worktree');
  });

  test('keeps normal assistant text when it is already substantive', () => {
    const text = selectVisibleAssistantText(
      '这是最终结论，不需要再从工具结果里回填。',
      [{
        name: 'Agent',
        status: 'done',
        subagent: {
          task_type: 'local_agent',
          description: 'Scan project architecture',
          status: 'completed',
          summary: '不应覆盖这段正文。',
        },
      }],
    );

    expect(text).toBe('这是最终结论，不需要再从工具结果里回填。');
  });

  test('treats completed agent cards with task details as expandable', () => {
    expect(getInlineTaskLabel({
      task_type: 'local_agent',
      description: 'Scan project architecture',
      status: 'completed',
      summary: '已完成项目结构梳理。',
      events: [{ subtype: 'task_started', description: 'Kernel task started' }],
    }, 'Agent')).toBe('Agent Scan project architecture');
  });

  test('treats parallel analysis starter copy as replaceable starter text', () => {
    const text = selectVisibleAssistantText(
      '我先从两个方向并行看一下这个仓库：一边梳理整体架构和主要模块，一边检查当前分支上的改动在做什么。',
      [
        {
          name: 'Agent',
          status: 'done',
          subagent: {
            task_type: 'local_agent',
            description: 'Map repo architecture',
            status: 'completed',
            summary: '已按要求做就地只读分析，结论如下。',
          },
        },
        {
          name: 'Agent',
          status: 'done',
          subagent: {
            task_type: 'local_agent',
            description: 'Inspect current changes',
            status: 'completed',
            summary: '当前在 main 分支，工作区改动集中在桌面聊天运行时重构。',
          },
        },
      ],
    );

    expect(text).toContain('### Agent Map repo architecture');
    expect(text).toContain('### Agent Inspect current changes');
    expect(text).not.toContain('我先从两个方向并行看一下这个仓库');
  });
});
