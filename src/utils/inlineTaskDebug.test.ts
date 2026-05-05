import { describe, expect, test } from 'bun:test';
import {
  isInlineTaskDebugExpandEnabled,
  messageHasInlineTaskDetails,
  toolCallHasInlineTaskDetails,
} from './inlineTaskDebug';

describe('inlineTaskDebug', () => {
  test('parses explicit debug flag values', () => {
    expect(isInlineTaskDebugExpandEnabled('1')).toBe(true);
    expect(isInlineTaskDebugExpandEnabled('true')).toBe(true);
    expect(isInlineTaskDebugExpandEnabled('on')).toBe(true);
    expect(isInlineTaskDebugExpandEnabled('0')).toBe(false);
    expect(isInlineTaskDebugExpandEnabled('')).toBe(false);
  });

  test('detects task detail payloads from subagent and child tools', () => {
    expect(toolCallHasInlineTaskDetails({ subagent: { task_type: 'local_workflow' } })).toBe(true);
    expect(toolCallHasInlineTaskDetails({ childToolCalls: [{ id: 'child-1', name: 'Read' }] })).toBe(true);
    expect(toolCallHasInlineTaskDetails({ name: 'Agent', input: {} })).toBe(false);
    expect(messageHasInlineTaskDetails([
      { name: 'Read', input: { path: '/tmp/x' } },
      { name: 'Agent', subagent: { status: 'running' } },
    ])).toBe(true);
  });
});
