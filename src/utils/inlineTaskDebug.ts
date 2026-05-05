export const INLINE_TASK_EXPAND_DEBUG_FLAG = '__hare_debug_expand_inline_tasks';

function hasRuntimeMessageValue(value: any) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value != null && value !== '';
}

export function isInlineTaskDebugExpandEnabled(value?: string | null): boolean {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function getInlineTaskDebugExpandFlag(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return isInlineTaskDebugExpandEnabled(window.localStorage.getItem(INLINE_TASK_EXPAND_DEBUG_FLAG));
  } catch {
    return false;
  }
}

export function toolCallHasInlineTaskDetails(toolCall: any): boolean {
  if (Array.isArray(toolCall?.childToolCalls) && toolCall.childToolCalls.length > 0) return true;
  return hasRuntimeMessageValue(toolCall?.subagent);
}

export function messageHasInlineTaskDetails(toolCalls: any[]): boolean {
  return (toolCalls || []).some((toolCall) => toolCallHasInlineTaskDetails(toolCall));
}
