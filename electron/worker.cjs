const { pathToFileURL } = require('url');

const kernelEntry = process.env.HARE_DESKTOP_KERNEL_ENTRY;
if (!kernelEntry) {
  throw new Error('HARE_DESKTOP_KERNEL_ENTRY is required');
}

if (typeof process.env.FEATURE_KAIROS === 'undefined') {
  process.env.FEATURE_KAIROS = '1';
}

if (typeof process.env.CLAUDE_CODE_ENABLE_KAIROS === 'undefined') {
  process.env.CLAUDE_CODE_ENABLE_KAIROS = '1';
}

if (typeof process.env.CLAUDE_CODE_AGENT_WORKTREE_FALLBACK === 'undefined') {
  process.env.CLAUDE_CODE_AGENT_WORKTREE_FALLBACK = '1';
}

if (typeof process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS === 'undefined') {
  process.env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS = '1';
}

if (typeof process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS_DISABLED === 'undefined') {
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS_DISABLED = '1';
}

(async () => {
  const kernel = await import(pathToFileURL(kernelEntry).href);
  if (typeof kernel.runKernelRuntimeWireProtocol !== 'function') {
    throw new Error('kernel package missing runKernelRuntimeWireProtocol');
  }

  await kernel.runKernelRuntimeWireProtocol({
    eventJournalPath: false,
    conversationJournalPath: false,
    headlessExecutor: {
      mode: process.env.HARE_KERNEL_RUNTIME_HEADLESS_MODE || 'persistent',
      command: process.env.HARE_KERNEL_RUNTIME_HEADLESS_COMMAND,
      args: parseHeadlessArgs(process.env.HARE_KERNEL_RUNTIME_HEADLESS_ARGS_JSON),
      cwd: process.env.HARE_KERNEL_RUNTIME_HEADLESS_CWD,
    },
  });
})().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});

function parseHeadlessArgs(value) {
  if (!value) return undefined;
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('HARE_KERNEL_RUNTIME_HEADLESS_ARGS_JSON must be a JSON string array');
  }
  return parsed;
}
