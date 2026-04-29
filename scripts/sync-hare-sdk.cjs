const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createWriteStream } = require('fs');

const desktopRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(desktopRoot, '..');
const hareCodeRoot = resolveHareCodeRoot();
const vendorDir = path.resolve(desktopRoot, 'electron', 'vendor');
const targetKernelRoot = path.resolve(vendorDir, 'hare-code-kernel');
const targetKernelDist = path.resolve(targetKernelRoot, 'dist');
const desktopPackagePath = path.resolve(desktopRoot, 'package.json');
const defaultReleaseRepo = process.env.HARE_CODE_RELEASE_REPO || 'go-hare/hare-code';

const bunBinary = process.platform === 'win32' ? 'bun.exe' : 'bun';
const npmBinary = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tarBinary = 'tar';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function resolveHareCodeRoot() {
  const envRoot = process.env.HARE_CODE_ROOT || process.env.HARE_DESKTOP_KERNEL_ROOT || '';
  const candidates = [
    envRoot,
    path.resolve(workspaceRoot, 'claude-code'),
    path.resolve(workspaceRoot, 'hare-code'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.resolve(candidate, 'package.json'))) {
      return candidate;
    }
  }
  return path.resolve(workspaceRoot, 'claude-code');
}

function parseArgs(argv) {
  const options = {
    source: 'auto',
    packageSpec: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') {
      options.source = argv[index + 1] || options.source;
      index += 1;
      continue;
    }
    if (arg.startsWith('--source=')) {
      options.source = arg.slice('--source='.length);
      continue;
    }
    if (arg === '--package-spec') {
      options.packageSpec = argv[index + 1] || options.packageSpec;
      index += 1;
      continue;
    }
    if (arg.startsWith('--package-spec=')) {
      options.packageSpec = arg.slice('--package-spec='.length);
    }
  }

  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    stdio: options.captureOutput ? 'pipe' : 'inherit',
    encoding: options.captureOutput ? 'utf8' : undefined,
    shell:
      options.shell ??
      (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)),
  });

  if (result.status !== 0) {
    if (options.captureOutput) {
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
    }
    process.exit(result.status ?? 1);
  }

  return result;
}

function syncKernelDist(sourceDist, label) {
  const kernelEntry = path.resolve(sourceDist, 'kernel.js');
  if (!fs.existsSync(kernelEntry)) {
    console.error(`Missing hare-code kernel bundle: ${kernelEntry}`);
    process.exit(1);
  }

  fs.rmSync(targetKernelDist, { recursive: true, force: true });
  fs.mkdirSync(targetKernelRoot, { recursive: true });
  fs.cpSync(sourceDist, targetKernelDist, { recursive: true });
  fs.writeFileSync(
    path.resolve(targetKernelRoot, 'package.json'),
    `${JSON.stringify({ type: 'module' }, null, 2)}\n`,
    'utf8',
  );
  console.log(`Synced hare-code kernel dist from ${label} -> ${targetKernelDist}`);
}

async function downloadFile(url, outputPath) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': 'hare-desktop-sdk-sync/1.0',
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} while downloading ${url}`);
  }

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  const fileStream = createWriteStream(outputPath);

  await new Promise((resolve, reject) => {
    response.body.pipe(fileStream);
    response.body.on('error', reject);
    fileStream.on('finish', resolve);
    fileStream.on('error', reject);
  });
}

function resolveLocalTgz(desktopVersion) {
  const localTarball = path.resolve(hareCodeRoot, `hare-code-${desktopVersion}.tgz`);
  return fs.existsSync(localTarball) ? localTarball : '';
}

function refreshSiblingTarball(desktopVersion) {
  const siblingPackagePath = path.resolve(hareCodeRoot, 'package.json');
  if (!fs.existsSync(siblingPackagePath)) {
    return resolveLocalTgz(desktopVersion);
  }

  console.log(`Refreshing local hare-code tarball for version ${desktopVersion}...`);
  run(bunBinary, ['run', 'build'], { cwd: hareCodeRoot });
  const packResult = run(
    npmBinary,
    ['pack', '--silent'],
    {
      cwd: hareCodeRoot,
      captureOutput: true,
    },
  );

  const tarballName = packResult.stdout
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .pop();

  if (!tarballName) {
    console.error(`Unable to refresh local hare-code tarball for version ${desktopVersion}`);
    process.exit(1);
  }

  return path.resolve(hareCodeRoot, tarballName);
}

async function resolveTarballSource(packageSpec) {
  const desktopVersion = readJson(desktopPackagePath).version;

  if (packageSpec) {
    const resolvedPackageSpec =
      packageSpec.startsWith('.') || packageSpec.startsWith('..') || path.isAbsolute(packageSpec)
        ? path.resolve(desktopRoot, packageSpec)
        : packageSpec;
    return {
      mode: 'npm-pack',
      value: resolvedPackageSpec,
      desktopVersion,
    };
  }

  const localTarball = resolveLocalTgz(desktopVersion);
  if (localTarball) {
    const refreshedTarball = refreshSiblingTarball(desktopVersion);
    return {
      mode: 'local-tgz',
      value: refreshedTarball,
      desktopVersion,
    };
  }

  const versionTag = desktopVersion.startsWith('v') ? desktopVersion : `v${desktopVersion}`;
  const assetName = `hare-code-${desktopVersion}.tgz`;
  const downloadUrl = `https://github.com/${defaultReleaseRepo}/releases/download/${versionTag}/${assetName}`;
  const downloadTarget = path.resolve(
    desktopRoot,
    '.cache',
    'hare-sdk-package',
    assetName,
  );

  console.log(`Downloading hare-code SDK package from release: ${downloadUrl}`);
  await downloadFile(downloadUrl, downloadTarget);

  return {
    mode: 'downloaded-tgz',
    value: downloadTarget,
    desktopVersion,
  };
}

function syncFromSibling() {
  const sourceDist = path.resolve(hareCodeRoot, 'dist');
  run(bunBinary, ['run', 'build'], { cwd: hareCodeRoot });
  syncKernelDist(sourceDist, 'sibling source');
}

async function syncFromPackage(packageSpec) {
  const tempDir = path.resolve(desktopRoot, '.cache', 'hare-sdk-package');

  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });

  const tarballSource = await resolveTarballSource(packageSpec);
  let tarballName = '';

  if (tarballSource.mode === 'npm-pack') {
    const packResult = run(
      npmBinary,
      ['pack', tarballSource.value, '--silent'],
      {
        cwd: tempDir,
        captureOutput: true,
      },
    );

    tarballName = packResult.stdout
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .pop();

    if (!tarballName) {
      console.error(`Unable to resolve packed hare-code artifact for ${tarballSource.value}`);
      process.exit(1);
    }
  } else {
    tarballName = path.basename(tarballSource.value);
    fs.copyFileSync(tarballSource.value, path.resolve(tempDir, tarballName));
  }

  run(tarBinary, ['-xf', tarballName], { cwd: tempDir });

  const packedDist = path.resolve(
    tempDir,
    'package',
    'dist',
  );
  if (!fs.existsSync(path.resolve(packedDist, 'kernel.js'))) {
    console.error(`Missing packed hare-code kernel bundle: ${path.resolve(packedDist, 'kernel.js')}`);
    process.exit(1);
  }

  syncKernelDist(packedDist, tarballSource.mode === 'npm-pack' ? `package spec "${tarballSource.value}"` : `${tarballSource.mode} "${tarballSource.value}"`);
  if (tarballSource.mode === 'npm-pack') {
    console.log(`Resolved hare-code package spec "${tarballSource.value}"`);
  } else {
    console.log(`Resolved hare-code package from ${tarballSource.mode} "${tarballSource.value}"`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const siblingPackagePath = path.resolve(hareCodeRoot, 'package.json');
  const canUseSibling = fs.existsSync(siblingPackagePath);
  const sourceMode =
    options.source === 'auto'
      ? canUseSibling
        ? 'sibling'
        : 'package'
      : options.source;

  if (sourceMode === 'sibling') {
    if (!canUseSibling) {
      console.error(`Sibling hare-code package not found: ${siblingPackagePath}`);
      process.exit(1);
    }
    syncFromSibling();
    return;
  }

  if (sourceMode === 'package') {
    await syncFromPackage(options.packageSpec);
    return;
  }

  console.error(`Unsupported SDK source mode: ${sourceMode}`);
  process.exit(1);
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exit(1);
});
