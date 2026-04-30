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

(async () => {
  const kernel = await import(pathToFileURL(kernelEntry).href);
  if (typeof kernel.createKernelRuntimeInProcessTurnExecutor !== 'function') {
    throw new Error('kernel package missing createKernelRuntimeInProcessTurnExecutor');
  }

  await kernel.runKernelRuntimeWireProtocol({
    runTurnExecutor: kernel.createKernelRuntimeInProcessTurnExecutor(),
    eventJournalPath: false,
    conversationJournalPath: false,
  });
})().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
