const fs = require('fs');
const path = require('path');

const desktopRoot = path.resolve(__dirname, '..');
const siblingRoot = path.resolve(desktopRoot, '..', 'claude-code');
const desktopPackagePath = path.resolve(desktopRoot, 'package.json');
const siblingPackagePath = path.resolve(siblingRoot, 'package.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function requirePackage(filePath, label) {
  if (!fs.existsSync(filePath)) {
    console.error(`Missing ${label}: ${filePath}`);
    process.exit(1);
  }
  return readJson(filePath);
}

function main() {
  const mode = String(process.argv[2] || 'check').trim();
  const desktopPackage = requirePackage(desktopPackagePath, 'desktop package.json');
  const siblingPackage = requirePackage(siblingPackagePath, 'sibling claude-code package.json');
  const siblingVersion = String(siblingPackage.version || '').trim();
  const desktopVersion = String(desktopPackage.version || '').trim();

  if (!siblingVersion) {
    console.error(`Sibling claude-code version is empty: ${siblingPackagePath}`);
    process.exit(1);
  }

  if (mode === 'sync') {
    if (desktopVersion !== siblingVersion) {
      desktopPackage.version = siblingVersion;
      writeJson(desktopPackagePath, desktopPackage);
      console.log(`Synced hare-code-desktop version ${desktopVersion || '(empty)'} -> ${siblingVersion}`);
      return;
    }
    console.log(`hare-code-desktop version already matches claude-code: ${siblingVersion}`);
    return;
  }

  if (mode === 'check') {
    if (desktopVersion !== siblingVersion) {
      console.error(
        `Version mismatch: hare-code-desktop=${desktopVersion || '(empty)'} claude-code=${siblingVersion}`,
      );
      process.exit(1);
    }
    console.log(`Version OK: ${desktopVersion}`);
    return;
  }

  console.error(`Unsupported mode: ${mode}`);
  process.exit(1);
}

main();
