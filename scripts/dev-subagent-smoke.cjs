const fs = require('fs');
const path = require('path');

const workspaceRoot = path.resolve(__dirname, '..', '..');
const desktopRoot = path.resolve(__dirname, '..');
const siblingKernelEntry = path.resolve(workspaceRoot, 'claude-code', 'dist', 'kernel.js');
const vendorKernelEntry = path.resolve(
  desktopRoot,
  'electron',
  'vendor',
  'hare-code-kernel',
  'dist',
  'kernel.js',
);
const workerEntry = path.resolve(desktopRoot, 'electron', 'worker.cjs');
const expectedOutput = 'SUBAGENT_TASK_OK';

function readArg(name, fallback = '') {
  const match = process.argv.find((value) => value.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

function resolveKernelEntry() {
  const mode = readArg('entry', 'sibling');
  if (mode === 'vendor') {
    return vendorKernelEntry;
  }
  return siblingKernelEntry;
}

async function main() {
  const kernelEntry = resolveKernelEntry();
  if (!fs.existsSync(kernelEntry)) {
    throw new Error(`Kernel entry not found: ${kernelEntry}`);
  }

  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  const baseUrl = String(process.env.OPENAI_BASE_URL || '').trim();
  const model = String(process.env.OPENAI_MODEL || '').trim();
  if (!apiKey || !baseUrl || !model) {
    throw new Error(
      'OPENAI_API_KEY, OPENAI_BASE_URL, and OPENAI_MODEL are required for dev subagent smoke',
    );
  }

  const kernel = await import(pathToFileUrl(kernelEntry));
  const runtime = await kernel.createKernelRuntime({
    transportConfig: {
      kind: 'stdio',
      command: process.execPath,
      args: [workerEntry],
      env: {
        ...process.env,
        HARE_DESKTOP_KERNEL_ENTRY: kernelEntry,
      },
      stderr: () => {},
    },
  });

  const events = [];
  const unsubscribe = runtime.onEvent((envelope) => {
    events.push({
      type: envelope.payload?.type,
      payload: envelope.payload?.payload,
    });
  });

  try {
    const spawn = await runtime.agents.spawn({
      agentType: 'general-purpose',
      prompt: `Read ${path.resolve(desktopRoot, 'package.json')} and reply with exactly ${expectedOutput} and nothing else.`,
      description: 'desktop dev subagent smoke',
      runInBackground: true,
      cwd: workspaceRoot,
    });

    if (!spawn.runId) {
      throw new Error(`Spawn returned no runId: ${JSON.stringify(spawn)}`);
    }

    const deadline = Date.now() + 120000;
    let status = null;
    while (Date.now() < deadline) {
      status = await runtime.agents.status(spawn.runId);
      if (status && ['completed', 'failed', 'cancelled'].includes(status.status)) {
        break;
      }
      await sleep(1000);
    }

    if (!status) {
      throw new Error(`Subagent run ${spawn.runId} did not report status`);
    }
    if (status.status !== 'completed') {
      throw new Error(`Subagent run ended with status ${status.status}`);
    }

    const output = await runtime.agents.output(spawn.runId, { tailBytes: 4000 });
    const result = await runtime.agents.result(spawn.runId);
    if (String(result || '').trim() !== expectedOutput) {
      throw new Error(`Unexpected subagent result: ${JSON.stringify(result)}`);
    }
    if (String(output?.output || '').trim() !== expectedOutput) {
      throw new Error(`Unexpected subagent output: ${JSON.stringify(output)}`);
    }

    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        kernelEntry,
        runId: spawn.runId,
        outputFile: output?.outputFile || status.outputFile || null,
        eventTypes: events.map((event) => event.type),
      }, null, 2)}\n`,
    );
  } finally {
    unsubscribe();
    await runtime.dispose().catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pathToFileUrl(filePath) {
  return require('url').pathToFileURL(filePath).href;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
