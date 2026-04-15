const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const TITLE_BAR_BASE_HEIGHT = 44;
const DEBUG_LOG = path.join(os.homedir(), 'AppData', 'Roaming', 'ccmini-desktop', 'main-debug.log');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CODEX_SKILLS_ROOT = path.join(CODEX_HOME, 'skills');
const HARE_CODE_RELEASE_REPO = 'go-hare/hare-code';
const HARE_CODE_RELEASE_VERSION = process.env.HARE_CODE_RELEASE_VERSION || '1.0.0';

let mainWindow = null;
let apiServer = null;
let apiBase = '';
let currentWorkspace = PROJECT_ROOT;
let statePath = '';
let uploadsDir = '';
let customSkillsDir = '';
let hareCodeRuntimeDir = '';
const activeRuns = new Map();
let state = null;
let installingHareCodePromise = null;
let npmGlobalPrefixCache = null;

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

const debugLog = (message) => {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {}
};

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
};

const isWindowsBatch = (command = '') => process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command));
const uniqueValues = (values) => [...new Set((values || []).filter(Boolean))];
const withPrependedPath = (env, entry) => {
  if (!entry) return env;
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return { ...env, PATH: `${entry}${delimiter}${env.PATH || ''}` };
};
const expandWindowsEnvVars = (value = '') => String(value).replace(/%([^%]+)%/g, (_match, name) => process.env[name] || `%${name}%`);

function runCommandCapture(command, args = [], options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
    shell: isWindowsBatch(command),
    ...options,
  });
}

function spawnCommand(command, args = [], options = {}) {
  return spawn(command, args, {
    windowsHide: true,
    shell: isWindowsBatch(command),
    ...options,
  });
}

function registryPathDirectories() {
  if (process.platform !== 'win32') return [];
  const powershellPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = runCommandCapture(powershellPath, ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','User'); [Environment]::GetEnvironmentVariable('Path','Machine')"]);
  if (result.status !== 0) return [];
  return uniqueValues(
    String(result.stdout || '')
      .split(/\r?\n/)
      .flatMap((line) => line.split(';'))
      .map((item) => expandWindowsEnvVars(item.trim()))
      .filter(Boolean),
  );
}

function windowsPathDirectories() {
  if (process.platform !== 'win32') return [];
  return uniqueValues(
    [...String(process.env.PATH || '').split(';'), ...registryPathDirectories()]
      .map((item) => expandWindowsEnvVars(String(item).trim()))
      .filter(Boolean),
  );
}

function findCommandsInDirectories(names, directories) {
  const results = [];
  directories.forEach((dir) => {
    names.forEach((name) => {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        results.push(candidate);
      }
    });
  });
  return uniqueValues(results);
}

function findCommandsOnPath(command) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = runCommandCapture(locator, [command]);
  if (result.status !== 0) return [];
  return uniqueValues(String(result.stdout || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean));
}

function canRunCommand(command, args = ['--version']) {
  if (!command) return false;
  if (path.isAbsolute(command) && !fs.existsSync(command)) return false;
  const result = runCommandCapture(command, args, { cwd: currentWorkspace || PROJECT_ROOT });
  return result.status === 0;
}

function preferWindowsExecutables(candidates = []) {
  return [...candidates].sort((left, right) => {
    const score = (value) => {
      const normalized = String(value || '').toLowerCase();
      if (normalized.endsWith('.exe')) return 0;
      if (normalized.endsWith('.cmd')) return 1;
      if (normalized.endsWith('.bat')) return 2;
      return 3;
    };
    return score(left) - score(right);
  });
}

function existingCommand(candidates = []) {
  const ordered = process.platform === 'win32' ? preferWindowsExecutables(uniqueValues(candidates)) : uniqueValues(candidates);
  return ordered.find((item) => {
    if (!item) return false;
    if (path.isAbsolute(item)) return fs.existsSync(item);
    return true;
  }) || null;
}

function detectBunBinary() {
  const candidates = uniqueValues([
    process.env.BUN_BINARY,
    ...findCommandsOnPath('bun'),
    ...findCommandsOnPath('bun.exe'),
    ...findCommandsInDirectories(['bun.exe', 'bun.cmd'], windowsPathDirectories()),
    path.join(os.homedir(), '.bun', 'bin', 'bun.exe'),
  ]);
  const command = existingCommand(candidates);
  return { found: Boolean(command), path: command };
}

function detectNpmGlobalPrefix(npmPath) {
  if (!npmPath) return null;
  if (npmGlobalPrefixCache?.npmPath === npmPath) return npmGlobalPrefixCache.prefix;
  const result = runCommandCapture(npmPath, ['prefix', '-g']);
  const prefix = result.status === 0 ? String(result.stdout || '').trim() || null : null;
  npmGlobalPrefixCache = { npmPath, prefix };
  return prefix;
}

function detectNpmBinary() {
  const candidates = uniqueValues([
    ...findCommandsOnPath('npm.cmd'),
    ...findCommandsOnPath('npm.exe'),
    ...findCommandsOnPath('npm'),
    ...findCommandsInDirectories(['npm.cmd', 'npm.exe'], windowsPathDirectories()),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'npm.cmd'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs', 'npm.cmd'),
  ]);
  const command = existingCommand(candidates);
  return { found: Boolean(command), path: command };
}

function getHareCodeBinaryAssetName() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'hare-code-windows-x64.exe';
  if (process.platform === 'linux' && process.arch === 'x64') return 'hare-code-linux-x64-baseline';
  if (process.platform === 'linux' && process.arch === 'arm64') return 'hare-code-linux-arm64';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'hare-code-darwin-x64';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'hare-code-darwin-arm64';
  return null;
}

function getHareCodeReleaseBinaryUrl() {
  const assetName = getHareCodeBinaryAssetName();
  if (!assetName) return null;
  return `https://github.com/${HARE_CODE_RELEASE_REPO}/releases/download/v${HARE_CODE_RELEASE_VERSION}/${assetName}`;
}

function managedHareCodeCandidates() {
  const assetName = getHareCodeBinaryAssetName();
  if (!hareCodeRuntimeDir || !assetName) return [];
  return [path.join(hareCodeRuntimeDir, assetName)];
}

function readFilePreview(filePath, maxBytes = 4096) {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      const size = fs.readSync(fd, buffer, 0, maxBytes, 0);
      return buffer.toString('utf8', 0, size);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function commandNeedsBunRuntime(command) {
  if (!command) return false;
  const normalized = String(command).toLowerCase();
  if (/\.(cmd|bat|ps1)$/i.test(normalized)) {
    return true;
  }
  if (!path.isAbsolute(command)) {
    return false;
  }
  try {
    const resolvedPath = fs.realpathSync(command);
    const preview = readFilePreview(resolvedPath);
    if (!preview) return false;
    return preview.includes('/usr/bin/env bun')
      || preview.includes('spawn(bunBinary')
      || preview.includes('hare-code 需要 Bun 运行时');
  } catch {
    return false;
  }
}

function detectHareCodeBinary() {
  const roamingNpmDir = path.join(os.homedir(), 'AppData', 'Roaming', 'npm');
  const npm = detectNpmBinary();
  const npmPrefix = detectNpmGlobalPrefix(npm.path);
  const npmGlobalCandidates = npmPrefix
    ? (process.platform === 'win32'
      ? [
          path.join(npmPrefix, 'hare-code.cmd'),
          path.join(npmPrefix, 'hare-code.exe'),
        ]
      : [path.join(npmPrefix, 'bin', 'hare-code')])
    : [];
  const candidates = uniqueValues([
    process.env.HARE_CODE_BIN,
    ...managedHareCodeCandidates(),
    path.join(roamingNpmDir, 'hare-code.cmd'),
    path.join(roamingNpmDir, 'hare-code.exe'),
    path.join(roamingNpmDir, 'hare-code'),
    ...findCommandsOnPath('hare-code'),
    ...findCommandsOnPath('hare-code.exe'),
    ...findCommandsOnPath('hare-code.cmd'),
    ...npmGlobalCandidates,
  ]);
  const command = existingCommand(candidates);
  return {
    found: Boolean(command),
    path: command,
    managed: Boolean(command && (
      (hareCodeRuntimeDir && command.startsWith(hareCodeRuntimeDir))
      || (npmPrefix && command.startsWith(npmPrefix))
    )),
  };
}

function systemStatusPayload() {
  const hareCode = detectHareCodeBinary();
  const bun = detectBunBinary();
  const hareCodeNeedsBun = commandNeedsBunRuntime(hareCode.path);
  return {
    platform: process.platform,
    bun: {
      required: hareCodeNeedsBun,
      found: bun.found,
      path: bun.path,
    },
    hareCode: {
      required: true,
      found: hareCode.found,
      path: hareCode.path,
      managed: hareCode.managed,
      install_url: getHareCodeReleaseBinaryUrl(),
    },
  };
}

async function installManagedHareCode() {
  if (installingHareCodePromise) return installingHareCodePromise;
  installingHareCodePromise = (async () => {
    const downloadUrl = getHareCodeReleaseBinaryUrl();
    const assetName = getHareCodeBinaryAssetName();
    if (!downloadUrl || !assetName) {
      throw new Error(`当前平台暂不支持自动安装 hare-code 二进制：${process.platform}/${process.arch}`);
    }
    ensureDir(hareCodeRuntimeDir);
    const targetPath = path.join(hareCodeRuntimeDir, assetName);
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`下载 hare-code 二进制失败：HTTP ${response.status}`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(targetPath, buffer);
    if (process.platform !== 'win32') {
      fs.chmodSync(targetPath, 0o755);
    }

    const hareCode = detectHareCodeBinary();
    if (!hareCode.found) {
      throw new Error('hare-code 安装完成，但未检测到可执行命令。');
    }
    return hareCode;
  })().finally(() => {
    installingHareCodePromise = null;
  });
  return installingHareCodePromise;
}

const nowIso = () => new Date().toISOString();
const stripThinking = (model = '') => `${model}`.replace(/-thinking$/, '');
const roughTokens = (text = '') => Math.max(1, Math.round(`${text}`.length / 4));
const inferFormat = (baseUrl = '', model = '') => (/gpt|glm|deepseek|qwen|gemini/i.test(model) || /openai|compatible|v1/i.test(baseUrl)) ? 'openai' : 'anthropic';

function readEnvSettings() {
  const data = {};
  if (!fs.existsSync(ENV_PATH)) return data;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx > 0) data[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return data;
}

function seedProviders(env) {
  const providers = [];
  if (env.ANTHROPIC_BASE_URL && (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_MODEL)) {
    providers.push({
      id: 'provider-anthropic',
      name: 'Anthropic Compatible',
      baseUrl: env.ANTHROPIC_BASE_URL,
      apiKey: env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || '',
      format: 'anthropic',
      enabled: true,
      supportsWebSearch: false,
      models: [{ id: env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', name: env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', enabled: true }],
    });
  }
  if (env.OPENAI_BASE_URL && (env.OPENAI_API_KEY || env.OPENAI_MODEL)) {
    providers.push({
      id: 'provider-openai',
      name: 'OpenAI Compatible',
      baseUrl: env.OPENAI_BASE_URL,
      apiKey: env.OPENAI_API_KEY || '',
      format: 'openai',
      enabled: true,
      supportsWebSearch: false,
      models: [{ id: env.OPENAI_MODEL || 'gpt-4o', name: env.OPENAI_MODEL || 'gpt-4o', enabled: true }],
    });
  }
  if (env.OLLAMA_BASE_URL && env.OLLAMA_MODEL) {
    providers.push({
      id: 'provider-ollama',
      name: 'Ollama',
      baseUrl: env.OLLAMA_BASE_URL,
      apiKey: 'ollama-local',
      format: 'anthropic',
      enabled: true,
      supportsWebSearch: false,
      models: [{ id: env.OLLAMA_MODEL, name: env.OLLAMA_MODEL, enabled: true }],
    });
  }
  return providers;
}

function defaultUser() {
  const username = os.userInfo().username || 'Local User';
  const emailName = String(username).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '') || 'local-user';
  return {
    id: 'local-user',
    email: `${emailName}@local.desktop`,
    nickname: username,
    full_name: username,
    display_name: username,
    role: 'superadmin',
    banned: 0,
    theme: 'light',
    chat_font: 'default',
    created_at: nowIso(),
    token_quota: 99999999,
    token_used: 0,
    storage_quota: 1073741824,
    storage_used: 0,
    subscription_name: 'Local Desktop',
    sub_status: 'active',
    sub_expires: null,
    sub_token_quota: null,
    sub_tokens_used: 0,
    sub_storage_quota: null,
    plan_id: 1,
  };
}

function defaultAdminPlan() {
  return {
    id: 1,
    name: 'Local Desktop',
    price: 0,
    duration_days: 30,
    token_quota: 99999999,
    storage_quota: 1073741824,
    description: '本地桌面版默认套餐',
    is_active: 1,
    created_at: nowIso(),
    window_budget: 0,
    weekly_budget: 0,
  };
}

function defaultUpstreamRoutes() {
  return {
    opus: { model_group: 'opus', base_url: '', preferred_key_id: null, updated_at: null },
    sonnet: { model_group: 'sonnet', base_url: '', preferred_key_id: null, updated_at: null },
    haiku: { model_group: 'haiku', base_url: '', preferred_key_id: null, updated_at: null },
    gpt: { model_group: 'gpt', base_url: '', preferred_key_id: null, updated_at: null },
  };
}

function buildAdminModels(providers, existing = []) {
  const existingMap = new Map((existing || []).filter((item) => item && item.id).map((item) => [item.id, item]));
  const ids = new Set((existing || []).map((item) => item?.id).filter(Boolean));
  (providers || []).forEach((provider) => {
    (provider.models || []).forEach((model) => {
      if (model?.id) ids.add(model.id);
    });
  });
  return [...ids].map((id) => {
    const previous = existingMap.get(id) || {};
    return {
      id,
      name: previous.name || id,
      model_multiplier: previous.model_multiplier ?? 1.0,
      output_multiplier: previous.output_multiplier ?? 5.0,
      cache_read_multiplier: previous.cache_read_multiplier ?? 0.1,
      cache_creation_multiplier: previous.cache_creation_multiplier ?? 2.0,
      enabled: previous.enabled ?? 1,
      common_order: previous.common_order ?? null,
      created_at: previous.created_at || nowIso(),
    };
  });
}

function defaultState() {
  const env = readEnvSettings();
  const providers = seedProviders(env);
  const modelEntries = providers.flatMap((provider) => (provider.models || []).map((model) => ({
    ...model,
    providerId: provider.id,
    providerName: provider.name,
  })));
  return {
    workspacePath: PROJECT_ROOT,
    user: defaultUser(),
    providers,
    skills: [],
    uploads: [],
    announcements: [],
    projects: [],
    conversations: [],
    currentSessionId: `session-${randomUUID()}`,
    chatModels: modelEntries,
    adminKeys: [],
    adminPlans: [defaultAdminPlan()],
    adminModels: buildAdminModels(providers, []),
    adminRecharges: [],
    adminRedemptionCodes: [],
    adminUpstreamRoutes: defaultUpstreamRoutes(),
    paymentOrders: [],
    userAnnouncementReads: {},
    skillPreferences: {},
    githubBrowsingEnabled: true,
    githubRecentRepos: [],
  };
}

function loadState() {
  const next = readJson(statePath, defaultState());
  next.user = { ...defaultUser(), ...(next.user || {}) };
  next.providers = Array.isArray(next.providers) ? next.providers : [];
  next.projects = Array.isArray(next.projects) ? next.projects : [];
  next.conversations = Array.isArray(next.conversations) ? next.conversations : [];
  next.uploads = Array.isArray(next.uploads) ? next.uploads : [];
  next.skills = Array.isArray(next.skills) ? next.skills : [];
  next.announcements = Array.isArray(next.announcements) ? next.announcements : [];
  next.chatModels = Array.isArray(next.chatModels) ? next.chatModels : [];
  next.adminKeys = Array.isArray(next.adminKeys) ? next.adminKeys : [];
  next.adminPlans = Array.isArray(next.adminPlans) && next.adminPlans.length ? next.adminPlans : [defaultAdminPlan()];
  next.adminRecharges = Array.isArray(next.adminRecharges) ? next.adminRecharges : [];
  next.adminRedemptionCodes = Array.isArray(next.adminRedemptionCodes) ? next.adminRedemptionCodes : [];
  next.adminUpstreamRoutes = next.adminUpstreamRoutes && typeof next.adminUpstreamRoutes === 'object'
    ? { ...defaultUpstreamRoutes(), ...next.adminUpstreamRoutes }
    : defaultUpstreamRoutes();
  next.paymentOrders = Array.isArray(next.paymentOrders) ? next.paymentOrders : [];
  next.userAnnouncementReads = next.userAnnouncementReads && typeof next.userAnnouncementReads === 'object' ? next.userAnnouncementReads : {};
  next.skillPreferences = next.skillPreferences && typeof next.skillPreferences === 'object' ? next.skillPreferences : {};
  next.githubBrowsingEnabled = next.githubBrowsingEnabled !== false;
  next.githubRecentRepos = Array.isArray(next.githubRecentRepos) ? next.githubRecentRepos : [];
  next.adminModels = buildAdminModels(next.providers, Array.isArray(next.adminModels) ? next.adminModels : []);
  currentWorkspace = next.workspacePath || PROJECT_ROOT;
  return next;
}

function syncChatModelsFromProviders() {
  state.chatModels = state.providers.flatMap((provider) =>
    (provider.models || [])
      .filter((model) => model && model.enabled !== false)
      .map((model) => ({
        id: model.id,
        name: model.name || model.id,
        enabled: true,
        providerId: provider.id,
        providerName: provider.name,
      })),
  );
  state.adminModels = buildAdminModels(state.providers, state.adminModels);
}

function saveState() {
  state.workspacePath = currentWorkspace;
  writeJson(statePath, state);
}

function touchConversation(conversation) {
  if (conversation) conversation.updated_at = nowIso();
}

function localUserPayload() {
  return { ...state.user, user: state.user };
}

function numberValue(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function nextNumericId(items) {
  return (items || []).reduce((max, item) => Math.max(max, numberValue(item?.id, 0)), 0) + 1;
}

function dayKey(value = nowIso()) {
  return new Date(value).toISOString().slice(0, 10);
}

function dayWindow(days = 30) {
  const count = Math.max(1, numberValue(days, 30));
  return Array.from({ length: count }, (_item, index) => {
    const date = new Date();
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCDate(date.getUTCDate() - (count - index - 1));
    return dayKey(date);
  });
}

function currentPlan() {
  return state.adminPlans.find((item) => item.id === state.user.plan_id)
    || state.adminPlans.find((item) => item.is_active)
    || state.adminPlans[0]
    || defaultAdminPlan();
}

function userStorageUsed() {
  return state.uploads.reduce((sum, item) => sum + numberValue(item?.size, 0), 0);
}

function adminUserView() {
  const plan = currentPlan();
  return {
    id: state.user.id || 'local-user',
    email: state.user.email || defaultUser().email,
    nickname: state.user.nickname || state.user.full_name || 'Local User',
    role: state.user.role || 'superadmin',
    plan: plan.name,
    subscription_name: state.user.subscription_name || plan.name,
    sub_status: state.user.sub_status || 'active',
    sub_expires: state.user.sub_expires || null,
    sub_token_quota: state.user.sub_token_quota ?? plan.token_quota,
    sub_tokens_used: state.user.sub_tokens_used ?? state.user.token_used ?? 0,
    sub_storage_quota: state.user.sub_storage_quota ?? plan.storage_quota,
    banned: state.user.banned ? 1 : 0,
    token_quota: state.user.token_quota ?? plan.token_quota,
    token_used: state.user.token_used ?? 0,
    storage_quota: state.user.storage_quota ?? plan.storage_quota,
    storage_used: userStorageUsed(),
    created_at: state.user.created_at || nowIso(),
  };
}

function dailyUsage(days = 30) {
  const messages = state.conversations.flatMap((conversation) => conversation.messages || []);
  const paymentsByDay = new Map();
  const costByDay = new Map();
  state.paymentOrders.filter((item) => item.status === 'paid').forEach((item) => {
    const key = dayKey(item.created_at);
    paymentsByDay.set(key, (paymentsByDay.get(key) || 0) + numberValue(item.amount, 0));
  });
  state.adminRecharges.forEach((item) => {
    const key = dayKey(item.created_at);
    costByDay.set(key, (costByDay.get(key) || 0) + Math.round((numberValue(item.amount_cny, 0) / 7) * 10000));
  });
  return dayWindow(days).map((date) => {
    const dayMessages = messages.filter((message) => dayKey(message.created_at) === date);
    const userMessages = dayMessages.filter((message) => message.role === 'user');
    const assistantMessages = dayMessages.filter((message) => message.role === 'assistant');
    return {
      date,
      requests: userMessages.length,
      tokens_output: assistantMessages.reduce((sum, message) => sum + roughTokens(message.content), 0),
      active_users: dayMessages.length ? 1 : 0,
      new_users: dayKey(state.user.created_at) === date ? 1 : 0,
      revenue: paymentsByDay.get(date) || 0,
      total_cost: costByDay.get(date) || 0,
    };
  });
}

function dashboardPayload() {
  const today = dailyUsage(1)[0] || { requests: 0, tokens_output: 0, revenue: 0, total_cost: 0, new_users: 0 };
  const monthKey = nowIso().slice(0, 7);
  const totalRevenue = state.paymentOrders.filter((item) => item.status === 'paid').reduce((sum, item) => sum + numberValue(item.amount, 0), 0);
  const totalRecharge = state.adminRecharges.reduce((sum, item) => sum + numberValue(item.amount_cny, 0), 0);
  const monthRevenue = state.paymentOrders.filter((item) => item.status === 'paid' && String(item.created_at || '').startsWith(monthKey)).reduce((sum, item) => sum + numberValue(item.amount, 0), 0);
  const monthRecharge = state.adminRecharges.filter((item) => String(item.created_at || '').startsWith(monthKey)).reduce((sum, item) => sum + numberValue(item.amount_cny, 0), 0);
  const enabledKeys = state.adminKeys.filter((item) => item.enabled);
  const healthyKeys = enabledKeys.filter((item) => item.health_status === 'healthy');
  return {
    totalUsers: 1,
    todayNewUsers: today.new_users,
    todayMessages: today.requests,
    todayTokensInput: today.requests * 1200,
    todayTokensOutput: today.tokens_output,
    keyPool: {
      total: state.adminKeys.length,
      enabled: enabledKeys.length,
      healthy: healthyKeys.length,
      down: state.adminKeys.filter((item) => item.health_status === 'down').length,
    },
    activeSubscriptions: state.user.sub_status === 'active' ? 1 : 0,
    todayCost: today.total_cost,
    todayRevenue: today.revenue,
    profit: {
      monthRevenue,
      monthRecharge,
      totalRevenue,
      totalRecharge,
    },
  };
}

function providerSearchProbe(provider) {
  const baseUrl = String(provider?.baseUrl || '').toLowerCase();
  if (!provider) return { ok: false, reason: 'Provider not found' };
  if (provider.webSearchStrategy) return { ok: true, strategy: provider.webSearchStrategy, hitCount: 3 };
  if (provider.format === 'anthropic' || /anthropic|jiazhuang/.test(baseUrl)) return { ok: true, strategy: 'anthropic_native', hitCount: 3 };
  if (/bigmodel|glm/.test(baseUrl)) return { ok: true, strategy: 'bigmodel', hitCount: 3 };
  if (/dashscope|aliyuncs|qwen/.test(baseUrl)) return { ok: true, strategy: 'dashscope', hitCount: 3 };
  return { ok: false, reason: '当前 provider 未声明可用 web search 能力' };
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function slugify(value = '') {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || `skill-${randomUUID().slice(0, 8)}`;
}

function splitFrontmatter(raw = '') {
  const text = String(raw || '');
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { meta: {}, body: text };
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  match[1].split(/\r?\n/).forEach((line) => {
    const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (entry) meta[entry[1]] = entry[2].trim();
  });
  return { meta, body: match[2] || '' };
}

function readSkillMarkdown(filePath) {
  const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  return splitFrontmatter(raw);
}

function writeSkillMarkdown(filePath, name, description, content) {
  const body = String(content || '').trim();
  const markdown = `---\nname: ${name}\ndescription: ${description || ''}\n---\n\n${body}\n`;
  fs.writeFileSync(filePath, markdown, 'utf8');
}

function buildFileTree(dir) {
  return safeReadDir(dir)
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return { name: entry.name, type: 'folder', children: buildFileTree(fullPath) };
      }
      return { name: entry.name, type: 'file' };
    });
}

function builtinSkillDirs() {
  if (!fs.existsSync(CODEX_SKILLS_ROOT)) return [];
  const results = [];
  safeReadDir(CODEX_SKILLS_ROOT).forEach((entry) => {
    if (!entry.isDirectory()) return;
    const fullPath = path.join(CODEX_SKILLS_ROOT, entry.name);
    if (entry.name === '.system') {
      safeReadDir(fullPath).forEach((child) => {
        if (!child.isDirectory()) return;
        const childPath = path.join(fullPath, child.name);
        if (fs.existsSync(path.join(childPath, 'SKILL.md'))) {
          results.push({ fullPath: childPath, relPath: `${entry.name}/${child.name}`, sourceDir: child.name });
        }
      });
      return;
    }
    if (fs.existsSync(path.join(fullPath, 'SKILL.md'))) {
      results.push({ fullPath, relPath: entry.name, sourceDir: entry.name });
    }
  });
  return results;
}

function customSkillRecords() {
  ensureDir(customSkillsDir);
  return safeReadDir(customSkillsDir)
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dirPath = path.join(customSkillsDir, entry.name);
      const skillFile = path.join(dirPath, 'SKILL.md');
      if (!fs.existsSync(skillFile)) return null;
      const parsed = readSkillMarkdown(skillFile);
      const record = state.skills.find((item) => item.id === `local:${entry.name}` || item.dir_name === entry.name);
      return {
        id: record?.id || `local:${entry.name}`,
        dir_name: entry.name,
        dir_path: dirPath,
        name: parsed.meta.name || record?.name || entry.name,
        description: parsed.meta.description || record?.description || '',
        content: parsed.body || record?.content || '',
        enabled: record?.enabled !== false,
        is_example: false,
        source_dir: entry.name,
        files: buildFileTree(dirPath),
        created_at: record?.created_at || nowIso(),
      };
    })
    .filter(Boolean);
}

function builtinSkillRecord(entry) {
  const skillFile = path.join(entry.fullPath, 'SKILL.md');
  const parsed = readSkillMarkdown(skillFile);
  return {
    id: `example:${entry.relPath.replace(/\\/g, '/')}`,
    name: parsed.meta.name || entry.sourceDir,
    description: parsed.meta.description || '',
    content: parsed.body || '',
    enabled: state.skillPreferences[`example:${entry.relPath.replace(/\\/g, '/')}`] !== false,
    is_example: true,
    source_dir: entry.sourceDir,
    rel_path: entry.relPath.replace(/\\/g, '/'),
    dir_path: entry.fullPath,
    files: buildFileTree(entry.fullPath),
  };
}

function allSkillRecords() {
  return {
    examples: builtinSkillDirs().map((entry) => builtinSkillRecord(entry)),
    custom: customSkillRecords(),
  };
}

function findSkillRecord(id) {
  const { examples, custom } = allSkillRecords();
  return [...examples, ...custom].find((item) => item.id === id) || null;
}

function skillFilePath(record, requestedPath = '') {
  const relative = String(requestedPath || '').replace(/^[/\\]+/, '');
  return path.join(record.dir_path, relative);
}

function githubHeaders(extra = {}) {
  return {
    'User-Agent': 'ccmini-desktop',
    'Accept': 'application/vnd.github+json',
    ...extra,
  };
}

async function githubJson(url, options = {}) {
  const response = await fetch(url, { ...options, headers: githubHeaders(options.headers || {}) });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `GitHub request failed: ${response.status}`);
  }
  return response.json();
}

function touchGithubRepo(fullName, extra = {}) {
  const [owner, repo] = String(fullName || '').split('/');
  if (!owner || !repo) return;
  const current = state.githubRecentRepos.find((item) => item.full_name === fullName);
  if (current) {
    Object.assign(current, { updated_at: nowIso(), ...extra });
  } else {
    state.githubRecentRepos.unshift({
      id: nextNumericId(state.githubRecentRepos),
      name: repo,
      full_name: fullName,
      description: '',
      private: false,
      html_url: `https://github.com/${fullName}`,
      language: null,
      updated_at: nowIso(),
      ...extra,
    });
  }
  state.githubRecentRepos = state.githubRecentRepos.slice(0, 30);
  saveState();
}

function normalizeGithubEntry(item) {
  return {
    name: item.name,
    path: item.path,
    sha: item.sha || item.path,
    size: numberValue(item.size, 0),
    type: item.type === 'dir' ? 'dir' : item.type === 'tree' ? 'dir' : 'file',
    download_url: item.download_url || null,
    content: item.content,
    encoding: item.encoding,
  };
}

function githubTargetRoot(conversation, repoFullName, ref) {
  const safeRepo = String(repoFullName || 'repo').replace(/[\\/:*?"<>|]+/g, '-');
  const safeRef = String(ref || 'main').replace(/[\\/:*?"<>|]+/g, '-');
  return path.join(conversation.workspace_path || currentWorkspace, 'github-imports', `${safeRepo}-${safeRef}`);
}

function walkArtifactFiles(dir, exts, limit = 100, bucket = []) {
  if (!dir || !fs.existsSync(dir) || bucket.length >= limit) return bucket;
  for (const entry of safeReadDir(dir)) {
    if (bucket.length >= limit) break;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue;
      walkArtifactFiles(fullPath, exts, limit, bucket);
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    if (exts.has(ext)) bucket.push(fullPath);
  }
  return bucket;
}

function artifactList() {
  const items = [];
  const seen = new Set();
  const addArtifact = (filePath, title, conversationTitle, createdAt) => {
    if (!filePath || seen.has(filePath) || !fs.existsSync(filePath)) return;
    seen.add(filePath);
    items.push({
      id: `artifact:${filePath}`,
      title: title || path.basename(filePath),
      file_path: filePath,
      conversation_title: conversationTitle || 'Local files',
      created_at: createdAt || nowIso(),
    });
  };
  state.uploads.forEach((upload) => {
    const ext = path.extname(upload.file_name || '').toLowerCase();
    if (upload.mime_type === 'text/html' || ['.html', '.htm', '.svg'].includes(ext)) {
      addArtifact(upload.path, path.parse(upload.file_name).name || upload.file_name, 'Uploads', upload.created_at);
    }
  });
  state.projects.forEach((project) => {
    (project.files || []).forEach((file) => {
      const ext = path.extname(file.file_name || '').toLowerCase();
      if (['.html', '.htm', '.svg', '.jsx', '.tsx', '.vue', '.svelte'].includes(ext)) {
        addArtifact(file.file_path, path.parse(file.file_name).name || file.file_name, project.name, file.created_at);
      }
    });
  });
  const workspaceArtifacts = walkArtifactFiles(path.join(currentWorkspace, 'github-imports'), new Set(['.html', '.htm', '.svg', '.jsx', '.tsx', '.vue', '.svelte']));
  workspaceArtifacts.forEach((filePath) => addArtifact(filePath, path.parse(filePath).name, 'GitHub imports', fs.statSync(filePath).mtime.toISOString()));
  return items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

function conversationView(conversation) {
  return {
    id: conversation.id,
    title: conversation.title,
    model: conversation.model,
    workspace_path: conversation.workspace_path || '',
    project_id: conversation.project_id || null,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    messages: (conversation.messages || []).map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      created_at: message.created_at,
      attachments: message.attachments || [],
      toolCalls: message.toolCalls || [],
      documents: message.documents || [],
    })),
  };
}

function projectSummary(project) {
  return {
    id: project.id,
    name: project.name,
    description: project.description || '',
    instructions: project.instructions || '',
    workspace_path: project.workspace_path || '',
    is_archived: project.is_archived || 0,
    file_count: (project.files || []).length,
    chat_count: (project.conversations || []).length,
    created_at: project.created_at,
    updated_at: project.updated_at,
  };
}

function projectView(project) {
  return {
    ...projectSummary(project),
    files: project.files || [],
    conversations: (project.conversations || []).map((id) => {
      const conversation = state.conversations.find((item) => item.id === id);
      return conversation ? { id: conversation.id, title: conversation.title, updated_at: conversation.updated_at, model: conversation.model } : null;
    }).filter(Boolean),
  };
}

function resolveProvider(conversation, body = {}) {
  const explicitBaseUrl = body.env_base_url || '';
  const explicitToken = body.env_token || '';
  if (explicitBaseUrl || explicitToken) {
    return { baseUrl: explicitBaseUrl, apiKey: explicitToken, format: inferFormat(explicitBaseUrl, conversation.model), model: stripThinking(conversation.model) || conversation.model };
  }
  const modelId = stripThinking(conversation.model);
  const provider = state.providers.find((item) => item.enabled !== false && (item.models || []).some((model) => model.id === modelId));
  if (provider) return { ...provider, model: modelId };
  const fallback = state.providers.find((item) => item.enabled !== false);
  return fallback ? { ...fallback, model: modelId || fallback.models?.[0]?.id } : null;
}

function buildCliArgs(sessionId, model, started) {
  const args = ['-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
  if (started) args.push('--resume', sessionId); else args.push('--session-id', sessionId);
  if (model) args.push('--model', model);
  return args;
}

function extractAssistantText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content.filter((block) => block && block.type === 'text').map((block) => block.text || '').join('');
}

function runViaOpenAI({ provider, prompt, onText, onDone, onError, onStart }) {
  const controller = new AbortController();
  onStart({ stop: () => controller.abort() });
  fetch(`${provider.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({ model: provider.model || 'gpt-4o', messages: [{ role: 'user', content: prompt }], stream: true, max_tokens: 8192 }),
    signal: controller.signal,
  }).then(async (response) => {
    if (!response.ok || !response.body) throw new Error((await response.text().catch(() => '')).slice(0, 300) || `HTTP ${response.status}`);
    const decoder = new TextDecoder();
    let buffer = '', full = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') return onDone(full);
        try {
          const parsed = JSON.parse(payload);
          const text = parsed?.choices?.[0]?.delta?.content;
          if (text) { full += text; onText(text); }
        } catch {}
      }
    }
    onDone(full);
  }).catch((error) => onError(error?.name === 'AbortError' ? 'Task stopped.' : (error?.message || 'OpenAI request failed')));
}

function runViaCli({ conversation, provider, prompt, workspacePath, onText, onDone, onError, onStart }) {
  const hareCode = detectHareCodeBinary();
  if (!hareCode.found || !hareCode.path) {
    onError('未检测到 hare-code 命令，请先在桌面端完成安装。');
    return;
  }
  const sessionId = conversation.backend_session_id || randomUUID();
  const bun = detectBunBinary();
  if (commandNeedsBunRuntime(hareCode.path) && (!bun.found || !bun.path)) {
    onError('当前 hare-code 仍依赖 Bun 运行时，请先安装 Bun，或改用 GitHub Release 二进制。');
    return;
  }
  let env = { ...process.env, ANTHROPIC_BASE_URL: provider.baseUrl || '', ANTHROPIC_API_KEY: provider.apiKey || '', ANTHROPIC_AUTH_TOKEN: provider.apiKey || '' };
  if (bun.found && bun.path) {
    env = withPrependedPath(env, path.dirname(bun.path));
  }
  const child = spawnCommand(hareCode.path, buildCliArgs(sessionId, provider.model || conversation.model, Boolean(conversation.backend_started)), { cwd: workspacePath || currentWorkspace || PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'], env });
  let assistant = '', stderr = '';
  onStart({ stop: () => child.kill(), sessionId });
  child.stdin.write(prompt);
  child.stdin.end();
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const parsed = JSON.parse(line.trim());
      const delta = parsed?.event?.delta?.text;
      if (parsed?.type === 'stream_event' && parsed?.event?.type === 'content_block_delta' && delta) onText(delta);
      if (parsed?.type === 'assistant') assistant = extractAssistantText(parsed.message) || assistant;
      if (parsed?.type === 'result' && typeof parsed.result === 'string') assistant = parsed.result || assistant;
    } catch {}
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('error', (error) => {
    onError(error?.message || 'hare-code 启动失败');
  });
  child.on('close', (code) => {
    conversation.backend_session_id = sessionId;
    conversation.backend_started = code === 0;
    code === 0 ? onDone(assistant.trim()) : onError((stderr || assistant || 'CLI request failed').trim());
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1150,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 12, y: 12 } } : { titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#808080', height: TITLE_BAR_BASE_HEIGHT } }),
    icon: path.join(__dirname, '..', 'public', 'favicon.png'),
    backgroundColor: '#F8F8F6',
    show: false,
  });
  mainWindow.once('ready-to-show', () => { mainWindow.webContents.setZoomFactor(1); mainWindow.show(); });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (!input.control && !input.meta) return;
    const current = mainWindow.webContents.getZoomFactor();
    if (input.key === '=' || input.key === '+') { event.preventDefault(); mainWindow.webContents.setZoomFactor(Math.min(+(current + 0.1).toFixed(1), 2)); }
    if (input.key === '-') { event.preventDefault(); mainWindow.webContents.setZoomFactor(Math.max(+(current - 0.1).toFixed(1), 0.5)); }
    if (input.key === '0') { event.preventDefault(); mainWindow.webContents.setZoomFactor(1); }
    mainWindow.webContents.send('zoom-changed', mainWindow.webContents.getZoomFactor());
  });
  process.env.NODE_ENV === 'development' ? mainWindow.loadURL('http://localhost:3000') : mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function startApiServer() {
  debugLog('startApiServer called');
  try {
    const api = express();
    const upload = multer({ dest: uploadsDir });
    api.use(express.json({ limit: '20mb' }));
    api.use('/api/uploads', express.static(uploadsDir));

  api.get('/api/system-status', (_req, res) => res.json(systemStatusPayload()));
  api.post('/api/system/install-hare-code', async (_req, res) => {
    try {
      const hareCode = await installManagedHareCode();
      res.json({ ok: true, path: hareCode.path || null });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to install hare-code' });
    }
  });
  api.route('/api/workspace-config').get((_req, res) => res.json({ defaultDir: currentWorkspace })).post((req, res) => { currentWorkspace = req.body?.dir || currentWorkspace; saveState(); res.json({ ok: true, defaultDir: currentWorkspace }); });
  api.post('/api/auth/send-code', (_req, res) => res.json({ ok: true, message: '验证码已发送（本地占位）' }));
  api.post('/api/auth/register', (req, res) => {
    state.user = { ...state.user, nickname: req.body?.nickname || state.user.nickname, full_name: req.body?.nickname || state.user.full_name, email: req.body?.email || '' };
    saveState();
    res.json({ token: `local-token-${randomUUID()}`, user: state.user });
  });
  api.post('/api/auth/login', (req, res) => {
    state.user = { ...state.user, email: req.body?.email || state.user.email || '' };
    saveState();
    res.json({ token: `local-token-${randomUUID()}`, user: state.user });
  });
  api.post('/api/auth/forgot-password', (_req, res) => res.json({ ok: true, message: '验证码已发送（本地占位）' }));
  api.post('/api/auth/reset-password', (_req, res) => res.json({ ok: true, message: '密码已重置（本地占位）' }));
  api.route('/api/user/profile').get((_req, res) => res.json(localUserPayload())).patch((req, res) => { state.user = { ...state.user, ...(req.body || {}) }; saveState(); res.json(state.user); });
  api.get('/api/user/usage', (_req, res) => {
    const plan = currentPlan();
    const tokenQuota = state.user.sub_token_quota ?? state.user.token_quota ?? plan.token_quota;
    const tokenUsed = state.user.sub_tokens_used ?? state.user.token_used ?? 0;
    const storageQuota = state.user.sub_storage_quota ?? state.user.storage_quota ?? plan.storage_quota;
    const storageUsed = userStorageUsed();
    res.json({
      plan: { id: plan.id, name: plan.name, status: state.user.sub_status || 'active', price: plan.price },
      token_quota: tokenQuota,
      token_used: tokenUsed,
      token_remaining: Math.max(0, tokenQuota - tokenUsed),
      usage_percent: tokenQuota ? Math.min(100, Math.round((tokenUsed / tokenQuota) * 100)) : 0,
      storage_quota: storageQuota,
      storage_used: storageUsed,
      storage_percent: storageQuota ? Math.min(100, Math.round((storageUsed / storageQuota) * 100)) : 0,
      messages: { count: state.conversations.reduce((sum, item) => sum + (item.messages || []).length, 0) },
      quota: {
        window: { used: 0, limit: plan.window_budget || 0, resetAt: null },
        week: { used: 0, limit: plan.weekly_budget || 0, resetAt: null },
        total: { used: tokenUsed, limit: tokenQuota },
      },
    });
  });
  api.get('/api/user/announcements', (_req, res) => res.json((state.announcements || []).filter((item) => item.is_active).map((item) => ({
    ...item,
    read: Boolean(state.userAnnouncementReads[item.id]),
  }))));
  api.post('/api/user/announcements/:id/read', (req, res) => {
    const announcement = (state.announcements || []).find((item) => String(item.id) === req.params.id);
    if (!announcement) return res.status(404).json({ error: 'Announcement not found' });
    if (!state.userAnnouncementReads[announcement.id]) {
      state.userAnnouncementReads[announcement.id] = true;
      announcement.read_count = numberValue(announcement.read_count, 0) + 1;
      saveState();
    }
    res.json({ ok: true });
  });
  api.get('/api/user/sessions', (_req, res) => res.json({ sessions: [{ id: state.currentSessionId, device_name: os.hostname(), last_active_at: nowIso(), current: true }], currentSessionId: state.currentSessionId }));
  api.delete('/api/user/sessions/:id', (_req, res) => res.json({ ok: true }));
  api.post('/api/user/sessions/logout-others', (_req, res) => res.json({ ok: true }));
  api.post('/api/user/change-password', (_req, res) => res.json({ ok: true }));
  api.post('/api/user/delete-account', (_req, res) => res.json({ ok: true }));
  api.get('/api/user/models', (_req, res) => res.json({
    all: state.adminModels.filter((item) => item.enabled).map((item) => ({ id: item.id, name: item.name, enabled: item.enabled })),
    common: state.adminModels.filter((item) => item.enabled && item.common_order != null).sort((a, b) => a.common_order - b.common_order).map((item) => ({ id: item.id, name: item.name, enabled: item.enabled })),
  }));
  api.get('/api/payment/plans', (_req, res) => res.json(state.adminPlans.filter((item) => item.is_active).map((item) => ({ id: item.id, name: item.name, price: item.price, status: 'active' }))));
  api.post('/api/payment/create', (req, res) => {
    const plan = state.adminPlans.find((item) => item.id === numberValue(req.body?.plan_id));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const order = {
      id: `order-${randomUUID()}`,
      plan_id: plan.id,
      amount: plan.price,
      payment_method: req.body?.payment_method || 'local',
      status: 'paid',
      created_at: nowIso(),
    };
    state.paymentOrders.unshift(order);
    saveState();
    res.json({ ok: true, order_id: order.id, payment_url: null, status: order.status });
  });
  api.get('/api/payment/status/:id', (req, res) => {
    const order = state.paymentOrders.find((item) => item.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ ok: true, order_id: order.id, status: order.status });
  });
  api.post('/api/redemption/redeem', (req, res) => {
    const code = String(req.body?.code || '').trim();
    const item = state.adminRedemptionCodes.find((entry) => entry.code === code);
    if (!item) return res.status(404).json({ error: '兑换码不存在' });
    if (item.status !== 'unused') return res.status(400).json({ error: '兑换码当前不可用' });
    if (item.expires_at && new Date(item.expires_at).getTime() < Date.now()) {
      item.status = 'expired';
      saveState();
      return res.status(400).json({ error: '兑换码已过期' });
    }
    item.status = 'used';
    item.used_at = nowIso();
    item.used_by = state.user.email;
    state.user.plan_id = item.plan_id;
    state.user.subscription_name = item.plan_name;
    state.user.sub_status = 'active';
    saveState();
    res.json({ ok: true, message: `已兑换 ${item.plan_name}` });
  });
  api.get('/api/providers', (_req, res) => res.json(state.providers));
  api.post('/api/providers', (req, res) => { const provider = { id: `provider-${randomUUID()}`, enabled: true, models: [], supportsWebSearch: false, ...(req.body || {}) }; state.providers.push(provider); syncChatModelsFromProviders(); saveState(); res.json(provider); });
  api.patch('/api/providers/:id', (req, res) => { const provider = state.providers.find((item) => item.id === req.params.id); if (!provider) return res.status(404).json({ error: 'Provider not found' }); Object.assign(provider, req.body || {}); syncChatModelsFromProviders(); saveState(); res.json(provider); });
  api.delete('/api/providers/:id', (req, res) => { state.providers = state.providers.filter((item) => item.id !== req.params.id); syncChatModelsFromProviders(); saveState(); res.status(204).end(); });
  api.get('/api/providers/models', (_req, res) => res.json(state.providers.flatMap((provider) => (provider.models || []).map((model) => ({ id: model.id, name: model.name || model.id, providerId: provider.id, providerName: provider.name })))));
  api.post('/api/providers/:id/test-websearch', (req, res) => {
    const provider = state.providers.find((item) => item.id === req.params.id);
    if (!provider) return res.status(404).json({ error: 'Provider not found' });
    const result = providerSearchProbe(provider);
    provider.supportsWebSearch = Boolean(result.ok);
    provider.webSearchStrategy = result.strategy || null;
    provider.webSearchTestedAt = Date.now();
    provider.webSearchTestReason = result.reason || null;
    saveState();
    res.json(result);
  });
  api.get('/api/skills', (_req, res) => {
    const records = allSkillRecords();
    res.json({ examples: records.examples, my_skills: records.custom });
  });
  api.get('/api/skills/:id', (req, res) => {
    const record = findSkillRecord(req.params.id);
    if (!record) return res.status(404).json({ error: 'Skill not found' });
    res.json(record);
  });
  api.get('/api/skills/:id/file', (req, res) => {
    const record = findSkillRecord(req.params.id);
    if (!record) return res.status(404).json({ error: 'Skill not found' });
    const filePath = skillFilePath(record, req.query?.path || '');
    if (!filePath.startsWith(record.dir_path) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.json({ path: `${req.query?.path || ''}`, content: fs.readFileSync(filePath, 'utf8') });
  });
  api.post('/api/skills', (req, res) => {
    ensureDir(customSkillsDir);
    const dirName = `${slugify(req.body?.name || 'new-skill')}-${randomUUID().slice(0, 6)}`;
    const dirPath = path.join(customSkillsDir, dirName);
    ensureDir(dirPath);
    writeSkillMarkdown(path.join(dirPath, 'SKILL.md'), req.body?.name || 'New Skill', req.body?.description || '', req.body?.content || '');
    const skill = {
      id: `local:${dirName}`,
      dir_name: dirName,
      enabled: true,
      name: req.body?.name || 'New Skill',
      description: req.body?.description || '',
      content: req.body?.content || '',
      created_at: nowIso(),
    };
    state.skills.unshift(skill);
    saveState();
    res.json({ ...skill, is_example: false, source_dir: dirName, files: buildFileTree(dirPath) });
  });
  api.patch('/api/skills/:id', (req, res) => {
    const skill = state.skills.find((item) => item.id === req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    Object.assign(skill, req.body || {});
    const dirPath = path.join(customSkillsDir, skill.dir_name);
    if (fs.existsSync(dirPath)) {
      writeSkillMarkdown(path.join(dirPath, 'SKILL.md'), skill.name, skill.description || '', skill.content || '');
    }
    saveState();
    res.json({ ...skill, is_example: false, source_dir: skill.dir_name, files: buildFileTree(dirPath) });
  });
  api.delete('/api/skills/:id', (req, res) => {
    const skill = state.skills.find((item) => item.id === req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    const dirPath = path.join(customSkillsDir, skill.dir_name);
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
    state.skills = state.skills.filter((item) => item.id !== req.params.id);
    saveState();
    res.json({ ok: true });
  });
  api.patch('/api/skills/:id/toggle', (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    const customSkill = state.skills.find((item) => item.id === req.params.id);
    if (customSkill) {
      customSkill.enabled = enabled;
      saveState();
      return res.json(customSkill);
    }
    const record = findSkillRecord(req.params.id);
    if (!record) return res.status(404).json({ error: 'Skill not found' });
    state.skillPreferences[req.params.id] = enabled;
    saveState();
    res.json({ ...record, enabled });
  });
  api.get('/api/artifacts', (_req, res) => res.json(artifactList()));
  api.get('/api/artifacts/content', (_req, res) => {
    const filePath = String(_req.query?.path || '');
    const allowedRoots = [currentWorkspace, uploadsDir];
    if (!filePath || !fs.existsSync(filePath) || !allowedRoots.some((root) => filePath.startsWith(root))) {
      return res.json({ content: '', path: filePath, exists: false });
    }
    res.json({ content: fs.readFileSync(filePath, 'utf8'), path: filePath, exists: true });
  });
  api.get('/api/github/status', (_req, res) => res.json({
    connected: state.githubBrowsingEnabled !== false,
    user: state.githubBrowsingEnabled === false ? null : {
      login: 'public',
      name: 'GitHub Public',
      avatar_url: 'https://github.githubassets.com/favicons/favicon.png',
    },
  }));
  api.get('/api/github/auth-url', (_req, res) => {
    state.githubBrowsingEnabled = true;
    saveState();
    res.json({ url: 'https://github.com/login' });
  });
  api.post('/api/github/disconnect', (_req, res) => {
    state.githubBrowsingEnabled = false;
    saveState();
    res.json({ ok: true });
  });
  api.get('/api/github/repos', (_req, res) => res.json(state.githubRecentRepos));
  api.get('/api/github/repos/:owner/:repo/tree', async (req, res) => {
    try {
      const ref = String(req.query?.ref || 'HEAD');
      const data = await githubJson(`https://api.github.com/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
      touchGithubRepo(`${req.params.owner}/${req.params.repo}`);
      res.json({ tree: (data.tree || []).map((item) => ({ path: item.path, type: item.type, size: numberValue(item.size, 0) })) });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to fetch tree' });
    }
  });
  api.get('/api/github/repos/:owner/:repo/contents', async (req, res) => {
    try {
      const params = new URLSearchParams();
      if (req.query?.ref) params.set('ref', String(req.query.ref));
      const relPath = String(req.query?.path || '').replace(/^[/\\]+/, '');
      const suffix = relPath ? `/${relPath.split('/').map(encodeURIComponent).join('/')}` : '';
      const data = await githubJson(`https://api.github.com/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/contents${suffix}${params.toString() ? `?${params}` : ''}`);
      touchGithubRepo(`${req.params.owner}/${req.params.repo}`);
      res.json(Array.isArray(data) ? data.map((item) => normalizeGithubEntry(item)) : [normalizeGithubEntry(data)]);
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Failed to fetch contents' });
    }
  });
  api.post('/api/github/materialize', async (req, res) => {
    try {
      const conversation = state.conversations.find((item) => item.id === req.body?.conversationId);
      if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
      const repoFullName = String(req.body?.repoFullName || '');
      const [owner, repo] = repoFullName.split('/');
      if (!owner || !repo) return res.status(400).json({ error: 'Invalid repoFullName' });
      const ref = String(req.body?.ref || 'main');
      const selections = Array.isArray(req.body?.selections) ? req.body.selections : [];
      if (!selections.length) return res.status(400).json({ error: 'No selections provided' });
      const treeData = await githubJson(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
      const blobs = (treeData.tree || []).filter((item) => item.type === 'blob');
      const targetRoot = githubTargetRoot(conversation, repoFullName, ref);
      ensureDir(targetRoot);
      let fileCount = 0;
      for (const selection of selections) {
        const targetPaths = selection.isFolder
          ? blobs.filter((item) => item.path.startsWith(`${selection.path}/`))
          : blobs.filter((item) => item.path === selection.path);
        for (const item of targetPaths) {
          const rawUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${item.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`;
          const response = await fetch(rawUrl, { headers: githubHeaders({ Accept: 'application/vnd.github.raw' }) });
          if (!response.ok) continue;
          const buffer = Buffer.from(await response.arrayBuffer());
          const outputPath = path.join(targetRoot, item.path);
          ensureDir(path.dirname(outputPath));
          fs.writeFileSync(outputPath, buffer);
          fileCount += 1;
        }
      }
      touchGithubRepo(repoFullName);
      res.json({ ok: true, repoFullName, ref, rootDir: targetRoot, fileCount, skipped: 0 });
    } catch (error) {
      res.status(500).json({ error: error?.message || 'Materialize failed' });
    }
  });
  api.get('/api/admin/me', (_req, res) => res.json({ role: state.user.role || 'superadmin', email: state.user.email || '', nickname: state.user.nickname || state.user.full_name || 'Local User' }));
  api.get('/api/admin/dashboard', (_req, res) => res.json(dashboardPayload()));
  api.get('/api/admin/keys', (_req, res) => res.json(state.adminKeys));
  api.post('/api/admin/keys', (req, res) => {
    const key = {
      id: nextNumericId(state.adminKeys),
      api_key: String(req.body?.api_key || '').trim() || `sk-local-${randomUUID().slice(0, 8)}`,
      base_url: String(req.body?.base_url || '').trim(),
      relay_name: req.body?.relay_name || null,
      relay_url: req.body?.relay_url || null,
      max_concurrency: numberValue(req.body?.max_concurrency, 3),
      enabled: 1,
      priority: numberValue(req.body?.priority, 0),
      weight: numberValue(req.body?.weight, 1),
      note: req.body?.note || null,
      health_status: 'healthy',
      consecutive_errors: 0,
      daily_tokens_input: 0,
      daily_tokens_output: 0,
      daily_request_count: 0,
      last_request_at: null,
      last_error: null,
      created_at: nowIso(),
      input_rate: numberValue(req.body?.input_rate, 0),
      output_rate: numberValue(req.body?.output_rate, 0),
      group_multiplier: numberValue(req.body?.group_multiplier, 1),
      charge_rate: numberValue(req.body?.charge_rate, 0),
    };
    state.adminKeys.unshift(key);
    saveState();
    res.json(key);
  });
  api.put('/api/admin/keys/:id', (req, res) => {
    const key = state.adminKeys.find((item) => item.id === numberValue(req.params.id));
    if (!key) return res.status(404).json({ error: 'Key not found' });
    Object.assign(key, {
      ...req.body,
      max_concurrency: numberValue(req.body?.max_concurrency, key.max_concurrency),
      priority: numberValue(req.body?.priority, key.priority),
      weight: numberValue(req.body?.weight, key.weight),
      input_rate: numberValue(req.body?.input_rate, key.input_rate),
      output_rate: numberValue(req.body?.output_rate, key.output_rate),
      group_multiplier: numberValue(req.body?.group_multiplier, key.group_multiplier),
      charge_rate: numberValue(req.body?.charge_rate, key.charge_rate),
    });
    saveState();
    res.json(key);
  });
  api.delete('/api/admin/keys/:id', (req, res) => {
    state.adminKeys = state.adminKeys.filter((item) => item.id !== numberValue(req.params.id));
    Object.keys(state.adminUpstreamRoutes).forEach((group) => {
      const route = state.adminUpstreamRoutes[group];
      if (route.preferred_key_id === numberValue(req.params.id)) route.preferred_key_id = null;
    });
    saveState();
    res.json({ ok: true });
  });
  api.post('/api/admin/keys/:id/toggle', (req, res) => {
    const key = state.adminKeys.find((item) => item.id === numberValue(req.params.id));
    if (!key) return res.status(404).json({ error: 'Key not found' });
    key.enabled = key.enabled ? 0 : 1;
    key.health_status = key.enabled ? 'healthy' : 'down';
    saveState();
    res.json(key);
  });
  api.get('/api/admin/keys/pool-status', (_req, res) => res.json(state.adminKeys.map((item) => ({
    id: item.id,
    current_concurrency: activeRuns.size ? Math.min(numberValue(item.max_concurrency, 0), activeRuns.size) : 0,
    health_status: item.health_status,
  }))));
  api.get('/api/admin/upstream-routes', (_req, res) => res.json({ routes: state.adminUpstreamRoutes }));
  api.put('/api/admin/upstream-routes', (req, res) => {
    const incoming = req.body?.routes || {};
    Object.keys(defaultUpstreamRoutes()).forEach((group) => {
      const route = incoming[group] || {};
      state.adminUpstreamRoutes[group] = {
        model_group: group,
        base_url: String(route.base_url || ''),
        preferred_key_id: route.preferred_key_id == null ? null : numberValue(route.preferred_key_id, null),
        updated_at: nowIso(),
      };
    });
    saveState();
    res.json({ ok: true, routes: state.adminUpstreamRoutes });
  });
  api.get('/api/admin/users', (req, res) => {
    const search = String(req.query?.search || '').trim().toLowerCase();
    const page = Math.max(1, numberValue(req.query?.page, 1));
    const limit = Math.max(1, numberValue(req.query?.limit, 20));
    const all = [adminUserView()].filter((item) => !search || [item.id, item.email, item.nickname].some((field) => String(field || '').toLowerCase().includes(search)));
    const start = (page - 1) * limit;
    res.json({ users: all.slice(start, start + limit), pagination: { page, limit, total: all.length } });
  });
  api.post('/api/admin/users/:id/ban', (req, res) => {
    if (req.params.id !== state.user.id) return res.status(404).json({ error: 'User not found' });
    state.user.banned = 1;
    saveState();
    res.json({ ok: true });
  });
  api.post('/api/admin/users/:id/unban', (req, res) => {
    if (req.params.id !== state.user.id) return res.status(404).json({ error: 'User not found' });
    state.user.banned = 0;
    saveState();
    res.json({ ok: true });
  });
  api.post('/api/admin/users/:id/reset-password', (req, res) => {
    if (req.params.id !== state.user.id) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, passwordUpdated: Boolean(req.body?.password) });
  });
  api.post('/api/admin/users/:id/adjust-quota', (req, res) => {
    if (req.params.id !== state.user.id) return res.status(404).json({ error: 'User not found' });
    state.user.token_quota = numberValue(req.body?.token_quota, state.user.token_quota);
    state.user.sub_token_quota = state.user.token_quota;
    saveState();
    res.json(adminUserView());
  });
  api.post('/api/admin/users/:id/role', (req, res) => {
    if (req.params.id !== state.user.id) return res.status(404).json({ error: 'User not found' });
    state.user.role = req.body?.role || state.user.role;
    saveState();
    res.json(adminUserView());
  });
  api.get('/api/admin/plans', (_req, res) => res.json(state.adminPlans));
  api.post('/api/admin/plans', (req, res) => {
    const plan = {
      id: nextNumericId(state.adminPlans),
      name: req.body?.name || '新套餐',
      price: numberValue(req.body?.price, 0),
      duration_days: numberValue(req.body?.duration_days, 30),
      token_quota: numberValue(req.body?.token_quota, 0),
      storage_quota: numberValue(req.body?.storage_quota, 104857600),
      description: req.body?.description || null,
      is_active: 1,
      created_at: nowIso(),
      window_budget: numberValue(req.body?.window_budget, 0),
      weekly_budget: numberValue(req.body?.weekly_budget, 0),
    };
    state.adminPlans.unshift(plan);
    saveState();
    res.json(plan);
  });
  api.put('/api/admin/plans/:id', (req, res) => {
    const plan = state.adminPlans.find((item) => item.id === numberValue(req.params.id));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    Object.assign(plan, {
      ...req.body,
      price: numberValue(req.body?.price, plan.price),
      duration_days: numberValue(req.body?.duration_days, plan.duration_days),
      token_quota: numberValue(req.body?.token_quota, plan.token_quota),
      storage_quota: numberValue(req.body?.storage_quota, plan.storage_quota),
      window_budget: numberValue(req.body?.window_budget, plan.window_budget),
      weekly_budget: numberValue(req.body?.weekly_budget, plan.weekly_budget),
    });
    saveState();
    res.json(plan);
  });
  api.delete('/api/admin/plans/:id', (req, res) => {
    state.adminPlans = state.adminPlans.filter((item) => item.id !== numberValue(req.params.id));
    if (!state.adminPlans.length) state.adminPlans = [defaultAdminPlan()];
    if (!state.adminPlans.some((item) => item.id === state.user.plan_id)) state.user.plan_id = state.adminPlans[0].id;
    saveState();
    res.json({ ok: true });
  });
  api.post('/api/admin/plans/:id/toggle', (req, res) => {
    const plan = state.adminPlans.find((item) => item.id === numberValue(req.params.id));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    plan.is_active = plan.is_active ? 0 : 1;
    saveState();
    res.json(plan);
  });
  api.get('/api/admin/announcements', (_req, res) => res.json(state.announcements));
  api.post('/api/admin/announcements', (req, res) => {
    const announcement = {
      id: nextNumericId(state.announcements),
      title: String(req.body?.title || '').trim() || '新公告',
      content: String(req.body?.content || ''),
      is_active: numberValue(req.body?.is_active, 1) ? 1 : 0,
      read_count: 0,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    state.announcements.unshift(announcement);
    saveState();
    res.json(announcement);
  });
  api.put('/api/admin/announcements/:id', (req, res) => {
    const announcement = state.announcements.find((item) => item.id === numberValue(req.params.id));
    if (!announcement) return res.status(404).json({ error: 'Announcement not found' });
    Object.assign(announcement, {
      title: req.body?.title ?? announcement.title,
      content: req.body?.content ?? announcement.content,
      is_active: req.body?.is_active == null ? announcement.is_active : (numberValue(req.body?.is_active, 0) ? 1 : 0),
      updated_at: nowIso(),
    });
    saveState();
    res.json(announcement);
  });
  api.delete('/api/admin/announcements/:id', (req, res) => {
    state.announcements = state.announcements.filter((item) => item.id !== numberValue(req.params.id));
    delete state.userAnnouncementReads[req.params.id];
    saveState();
    res.json({ ok: true });
  });
  api.post('/api/admin/announcements/:id/toggle', (req, res) => {
    const announcement = state.announcements.find((item) => item.id === numberValue(req.params.id));
    if (!announcement) return res.status(404).json({ error: 'Announcement not found' });
    announcement.is_active = announcement.is_active ? 0 : 1;
    announcement.updated_at = nowIso();
    saveState();
    res.json(announcement);
  });
  api.post('/api/admin/redemption/generate', (req, res) => {
    const plan = state.adminPlans.find((item) => item.id === numberValue(req.body?.plan_id));
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    const count = Math.min(100, Math.max(1, numberValue(req.body?.count, 1)));
    const expiresDays = Math.max(1, numberValue(req.body?.expires_days, 90));
    const batchId = `batch-${randomUUID().slice(0, 8)}`;
    const codes = [];
    for (let index = 0; index < count; index += 1) {
      const code = `CP-${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
      codes.push(code);
      state.adminRedemptionCodes.unshift({
        id: nextNumericId(state.adminRedemptionCodes),
        code,
        plan_id: plan.id,
        plan_name: plan.name,
        status: 'unused',
        batch_id: batchId,
        note: req.body?.note || null,
        created_at: nowIso(),
        used_at: null,
        used_by: null,
        expires_at: new Date(Date.now() + expiresDays * 86400000).toISOString(),
      });
    }
    saveState();
    res.json({ codes, batch_id: batchId });
  });
  api.get('/api/admin/redemption/list', (req, res) => {
    const page = Math.max(1, numberValue(req.query?.page, 1));
    const limit = Math.max(1, numberValue(req.query?.limit, 20));
    const status = String(req.query?.status || '').trim();
    const batchId = String(req.query?.batch_id || '').trim();
    const all = state.adminRedemptionCodes.filter((item) => (!status || item.status === status) && (!batchId || item.batch_id.includes(batchId)));
    const start = (page - 1) * limit;
    res.json({
      codes: all.slice(start, start + limit),
      stats: {
        total: state.adminRedemptionCodes.length,
        unused: state.adminRedemptionCodes.filter((item) => item.status === 'unused').length,
        used: state.adminRedemptionCodes.filter((item) => item.status === 'used').length,
        expired: state.adminRedemptionCodes.filter((item) => item.status === 'expired').length,
        disabled: state.adminRedemptionCodes.filter((item) => item.status === 'disabled').length,
      },
      pagination: { page, limit, total: all.length },
    });
  });
  api.post('/api/admin/redemption/disable', (req, res) => {
    const codeSet = new Set((req.body?.codes || []).map((item) => String(item)));
    state.adminRedemptionCodes.forEach((item) => {
      if (codeSet.has(item.code) && item.status === 'unused') item.status = 'disabled';
    });
    saveState();
    res.json({ ok: true });
  });
  api.get('/api/admin/stats/trends', (req, res) => res.json(dailyUsage(req.query?.days)));
  api.get('/api/admin/stats/cost', (req, res) => res.json({ dailyCost: dailyUsage(req.query?.days).map((item) => ({ date: item.date, total_cost: item.total_cost })) }));
  api.get('/api/admin/recharges', (_req, res) => res.json(state.adminRecharges));
  api.post('/api/admin/recharges', (req, res) => {
    const recharge = {
      id: nextNumericId(state.adminRecharges),
      amount_cny: numberValue(req.body?.amount_cny, 0),
      key_ids: JSON.stringify((req.body?.key_ids || []).map((item) => numberValue(item)).filter(Boolean)),
      remark: req.body?.remark || null,
      created_at: nowIso(),
    };
    state.adminRecharges.unshift(recharge);
    saveState();
    res.json(recharge);
  });
  api.delete('/api/admin/recharges/:id', (req, res) => {
    state.adminRecharges = state.adminRecharges.filter((item) => item.id !== numberValue(req.params.id));
    saveState();
    res.json({ ok: true });
  });
  api.get('/api/admin/models', (_req, res) => res.json(state.adminModels));
  api.post('/api/admin/models', (req, res) => {
    const id = String(req.body?.id || '').trim();
    if (!id) return res.status(400).json({ error: 'Model id is required' });
    if (state.adminModels.some((item) => item.id === id)) return res.status(400).json({ error: 'Model already exists' });
    const model = {
      id,
      name: req.body?.name || id,
      model_multiplier: numberValue(req.body?.model_multiplier, 1),
      output_multiplier: numberValue(req.body?.output_multiplier, 5),
      cache_read_multiplier: numberValue(req.body?.cache_read_multiplier, 0.1),
      cache_creation_multiplier: numberValue(req.body?.cache_creation_multiplier, 2),
      enabled: 1,
      common_order: null,
      created_at: nowIso(),
    };
    state.adminModels.unshift(model);
    saveState();
    res.json(model);
  });
  api.get('/api/admin/models/common', (_req, res) => res.json({
    model_ids: state.adminModels.filter((item) => item.common_order != null).sort((a, b) => a.common_order - b.common_order).map((item) => item.id),
  }));
  api.put('/api/admin/models/common', (req, res) => {
    const ids = Array.isArray(req.body?.model_ids) ? req.body.model_ids.map((item) => String(item)) : [];
    state.adminModels.forEach((item) => { item.common_order = null; });
    ids.slice(0, 3).forEach((id, index) => {
      const model = state.adminModels.find((item) => item.id === id);
      if (model) model.common_order = index + 1;
    });
    saveState();
    res.json({ ok: true, model_ids: ids.slice(0, 3) });
  });
  api.put('/api/admin/models/:id', (req, res) => {
    const model = state.adminModels.find((item) => item.id === req.params.id);
    if (!model) return res.status(404).json({ error: 'Model not found' });
    Object.assign(model, {
      name: req.body?.name ?? model.name,
      model_multiplier: req.body?.model_multiplier == null ? model.model_multiplier : numberValue(req.body?.model_multiplier, model.model_multiplier),
      output_multiplier: req.body?.output_multiplier == null ? model.output_multiplier : numberValue(req.body?.output_multiplier, model.output_multiplier),
      cache_read_multiplier: req.body?.cache_read_multiplier == null ? model.cache_read_multiplier : numberValue(req.body?.cache_read_multiplier, model.cache_read_multiplier),
      cache_creation_multiplier: req.body?.cache_creation_multiplier == null ? model.cache_creation_multiplier : numberValue(req.body?.cache_creation_multiplier, model.cache_creation_multiplier),
      enabled: req.body?.enabled == null ? model.enabled : (numberValue(req.body?.enabled, 0) ? 1 : 0),
    });
    saveState();
    res.json(model);
  });
  api.delete('/api/admin/models/:id', (req, res) => {
    state.adminModels = state.adminModels.filter((item) => item.id !== req.params.id);
    saveState();
    res.json({ ok: true });
  });
  api.get('/api/projects', (_req, res) => res.json(state.projects.map(projectSummary)));
  api.post('/api/projects', (req, res) => { const project = { id: `project-${randomUUID()}`, name: req.body?.name || 'Untitled Project', description: req.body?.description || '', instructions: '', workspace_path: currentWorkspace, is_archived: 0, files: [], conversations: [], created_at: nowIso(), updated_at: nowIso() }; state.projects.unshift(project); saveState(); res.json(projectSummary(project)); });
  api.get('/api/projects/:id', (req, res) => { const project = state.projects.find((item) => item.id === req.params.id); project ? res.json(projectView(project)) : res.status(404).json({ error: 'Project not found' }); });
  api.patch('/api/projects/:id', (req, res) => { const project = state.projects.find((item) => item.id === req.params.id); if (!project) return res.status(404).json({ error: 'Project not found' }); Object.assign(project, req.body || {}, { updated_at: nowIso() }); saveState(); res.json(projectView(project)); });
  api.delete('/api/projects/:id', (req, res) => { state.projects = state.projects.filter((item) => item.id !== req.params.id); saveState(); res.json({ ok: true }); });
  api.post('/api/projects/:id/files', upload.single('file'), (req, res) => { const project = state.projects.find((item) => item.id === req.params.id); if (!project || !req.file) return res.status(400).json({ error: 'Upload failed' }); const file = { id: `project-file-${randomUUID()}`, project_id: project.id, file_name: req.file.originalname, file_path: req.file.path, file_size: req.file.size, mime_type: req.file.mimetype, created_at: nowIso() }; project.files.push(file); project.updated_at = nowIso(); saveState(); res.json(file); });
  api.delete('/api/projects/:id/files/:fileId', (req, res) => { const project = state.projects.find((item) => item.id === req.params.id); if (!project) return res.status(404).json({ error: 'Project not found' }); project.files = (project.files || []).filter((item) => item.id !== req.params.fileId); project.updated_at = nowIso(); saveState(); res.json({ ok: true }); });
  api.get('/api/projects/:id/conversations', (req, res) => { const project = state.projects.find((item) => item.id === req.params.id); if (!project) return res.status(404).json({ error: 'Project not found' }); res.json((project.conversations || []).map((id) => conversationView(state.conversations.find((item) => item.id === id))).filter(Boolean)); });
  api.post('/api/projects/:id/conversations', (req, res) => { const project = state.projects.find((item) => item.id === req.params.id); if (!project) return res.status(404).json({ error: 'Project not found' }); const conversation = { id: `conv-${randomUUID()}`, title: req.body?.title || 'New Chat', model: req.body?.model || state.chatModels?.[0]?.id || 'claude-sonnet-4-6', workspace_path: project.workspace_path || currentWorkspace, project_id: project.id, messages: [], created_at: nowIso(), updated_at: nowIso() }; state.conversations.unshift(conversation); project.conversations.unshift(conversation.id); saveState(); res.json(conversationView(conversation)); });
  api.get('/api/conversations', (_req, res) => res.json(state.conversations.map((item) => ({ id: item.id, title: item.title, model: item.model, workspace_path: item.workspace_path || '', updated_at: item.updated_at, created_at: item.created_at, project_id: item.project_id || null }))));
  api.post('/api/conversations', (req, res) => { const conversation = { id: `conv-${randomUUID()}`, title: req.body?.title || 'New Chat', model: req.body?.model || state.chatModels?.[0]?.id || 'claude-sonnet-4-6', workspace_path: req.body?.workspace_path || currentWorkspace, project_id: null, messages: [], created_at: nowIso(), updated_at: nowIso() }; state.conversations.unshift(conversation); saveState(); res.json(conversationView(conversation)); });
  api.get('/api/conversations/:id', (req, res) => { const conversation = state.conversations.find((item) => item.id === req.params.id); conversation ? res.json(conversationView(conversation)) : res.status(404).json({ error: 'Conversation not found' }); });
  api.patch('/api/conversations/:id', (req, res) => { const conversation = state.conversations.find((item) => item.id === req.params.id); if (!conversation) return res.status(404).json({ error: 'Conversation not found' }); Object.assign(conversation, req.body || {}, { updated_at: nowIso() }); saveState(); res.json(conversationView(conversation)); });
  api.delete('/api/conversations/:id', (req, res) => { state.conversations = state.conversations.filter((item) => item.id !== req.params.id); state.projects.forEach((project) => { project.conversations = (project.conversations || []).filter((id) => id !== req.params.id); }); saveState(); res.json({ ok: true }); });
  api.delete('/api/conversations/:id/messages/:messageId', (req, res) => { const conversation = state.conversations.find((item) => item.id === req.params.id); if (!conversation) return res.status(404).json({ error: 'Conversation not found' }); const index = (conversation.messages || []).findIndex((item) => item.id === req.params.messageId); if (index >= 0) conversation.messages = conversation.messages.slice(0, index); conversation.updated_at = nowIso(); saveState(); res.json(conversationView(conversation)); });
  api.delete('/api/conversations/:id/messages-tail/:count', (req, res) => { const conversation = state.conversations.find((item) => item.id === req.params.id); if (!conversation) return res.status(404).json({ error: 'Conversation not found' }); conversation.messages = conversation.messages.slice(0, Math.max(0, conversation.messages.length - Number(req.params.count || 0))); conversation.updated_at = nowIso(); saveState(); res.json(conversationView(conversation)); });
  api.get('/api/conversations/:id/generation-status', (req, res) => res.json({ active: activeRuns.has(req.params.id), status: activeRuns.has(req.params.id) ? 'generating' : 'idle', crossProcess: false }));
  api.post('/api/conversations/:id/stop-generation', (req, res) => { activeRuns.get(req.params.id)?.stop(); activeRuns.delete(req.params.id); res.json({ ok: true }); });
  api.get('/api/conversations/:id/context-size', (req, res) => { const conversation = state.conversations.find((item) => item.id === req.params.id); const tokens = (conversation?.messages || []).reduce((sum, item) => sum + roughTokens(item.content), 0); res.json({ tokens, limit: 200000 }); });
  api.post('/api/conversations/:id/compact', (_req, res) => res.json({ summary: 'Local desktop backend does not compact yet.', tokensSaved: 0, messagesCompacted: 0 }));
  api.post('/api/conversations/:id/answer', (_req, res) => res.json({ ok: true }));
  api.post('/api/conversations/:id/warm', (_req, res) => res.json({ ok: true }));
  api.get('/api/conversations/:id/stream-status', (req, res) => { const run = activeRuns.get(req.params.id); res.json({ active: Boolean(run), eventCount: run?.buffer.length || 0 }); });
  api.get('/api/conversations/:id/reconnect', (req, res) => {
    const run = activeRuns.get(req.params.id);
    if (!run) return res.status(404).end();
    res.setHeader('Content-Type', 'text/event-stream');
    run.buffer.forEach((line) => res.write(line));
    const forward = (line) => res.write(line);
    run.emitter.on('line', forward);
    req.on('close', () => run.emitter.off('line', forward));
  });
  api.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const fileType = req.file.mimetype.startsWith('image/') ? 'image' : (/pdf|word|officedocument|text|json|xml|yaml|csv/i.test(req.file.mimetype) ? 'document' : 'text');
    const file = { id: `upload-${randomUUID()}`, path: req.file.path, folder: path.dirname(req.file.path), file_name: req.file.originalname, mime_type: req.file.mimetype, size: req.file.size, file_type: fileType, created_at: nowIso() };
    state.uploads.push(file);
    saveState();
    res.json({ fileId: file.id, fileName: file.file_name, fileType: file.file_type, mimeType: file.mime_type, size: file.size });
  });
  api.get('/api/uploads/:id/raw', (req, res) => { const file = state.uploads.find((item) => item.id === req.params.id); file ? res.sendFile(file.path) : res.status(404).end(); });
  api.get('/api/uploads/:id/path', (req, res) => { const file = state.uploads.find((item) => item.id === req.params.id); file ? res.json({ localPath: file.path, folder: file.folder }) : res.status(404).json({ error: 'File not found' }); });
  api.delete('/api/uploads/:id', (req, res) => { const file = state.uploads.find((item) => item.id === req.params.id); if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path); state.uploads = state.uploads.filter((item) => item.id !== req.params.id); saveState(); res.json({ ok: true }); });
  api.get('/api/documents/:id/raw', (_req, res) => {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.send('# Document Unavailable\n\nThis local desktop backend does not persist generated documents yet.');
  });
  api.get('/api/conversations/:id/export', (req, res) => {
    const conversation = state.conversations.find((item) => item.id === req.params.id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="conversation-${conversation.id.slice(0, 8)}.zip"`);
    res.send(Buffer.from(`# ${conversation.title}\n\n${(conversation.messages || []).map((item) => `## ${item.role}\n\n${item.content}`).join('\n\n')}`, 'utf8'));
  });
  api.get('/api/code/sso', (_req, res) => res.json({ ok: true, url: null }));
  api.get('/api/code/quota', (_req, res) => res.json({ ok: true, remaining: 999999 }));
  api.get('/api/code/plans', (_req, res) => res.json([{ id: 'local', name: 'Local Desktop Code', price: 0 }]));
  api.post('/api/code-result', (_req, res) => res.json({ ok: true }));
  api.post('/api/chat', (req, res) => {
    const conversation = state.conversations.find((item) => item.id === req.body?.conversation_id);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });
    const provider = resolveProvider(conversation, req.body || {});
    if (!provider) return res.status(400).json({ error: 'No provider configured for this model' });
    const write = (payload) => { const line = `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`; activeRuns.get(conversation.id)?.buffer.push(line); activeRuns.get(conversation.id)?.emitter.emit('line', line); res.write(line); };
    res.setHeader('Content-Type', 'text/event-stream');
    const userMessage = { id: `msg-${randomUUID()}`, role: 'user', content: req.body.message || '', created_at: nowIso(), attachments: req.body.attachments || [] };
    conversation.messages.push(userMessage);
    if ((!conversation.title || conversation.title === 'New Chat') && userMessage.content) conversation.title = userMessage.content.slice(0, 50);
    conversation.updated_at = nowIso();
    saveState();
    const run = { buffer: [], emitter: new EventEmitter(), stop: () => {}, fullText: '' };
    activeRuns.set(conversation.id, run);
    const onText = (text) => { run.fullText += text; write({ type: 'content_block_delta', delta: { type: 'text_delta', text } }); };
    const onDone = (fullText) => { conversation.messages.push({ id: `msg-${randomUUID()}`, role: 'assistant', content: fullText || run.fullText || '[模型未返回文本]', created_at: nowIso(), attachments: [] }); conversation.updated_at = nowIso(); saveState(); write({ type: 'message_stop' }); write('[DONE]'); res.end(); activeRuns.delete(conversation.id); };
    const onError = (error) => { write({ type: 'error', error: error || 'Request failed' }); write('[DONE]'); res.end(); activeRuns.delete(conversation.id); };
    const onStart = (controller) => { run.stop = controller.stop; if (controller.sessionId) conversation.backend_session_id = controller.sessionId; };
    provider.format === 'openai' ? runViaOpenAI({ provider, prompt: req.body.message || '', onText, onDone, onError, onStart }) : runViaCli({ conversation, provider, prompt: req.body.message || '', workspacePath: conversation.workspace_path || currentWorkspace, onText, onDone, onError, onStart });
    req.on('aborted', () => {
      if (!res.writableEnded) activeRuns.get(conversation.id)?.stop();
    });
  });

    return new Promise((resolve, reject) => {
      apiServer = api.listen(0, '127.0.0.1', () => {
        const nextApiBase = `http://127.0.0.1:${apiServer.address().port}/api`;
        debugLog(`api server listening at ${nextApiBase}`);
        resolve(nextApiBase);
      });
      apiServer.on('error', (error) => {
        debugLog(`api server error: ${error?.message || error}`);
        reject(error);
      });
    });
  } catch (error) {
    debugLog(`startApiServer failed: ${error?.message || error}`);
    throw error;
  }
}

app.whenReady().then(async () => {
  debugLog('app.whenReady entered');
  statePath = path.join(app.getPath('userData'), 'ccmini-state.json');
  uploadsDir = path.join(app.getPath('userData'), 'uploads');
  customSkillsDir = path.join(app.getPath('userData'), 'skills');
  hareCodeRuntimeDir = path.join(app.getPath('userData'), 'hare-code-runtime');
  state = loadState();
  syncChatModelsFromProviders();
  apiBase = await startApiServer();
  state.apiBase = apiBase;
  saveState();
  debugLog(`state saved with apiBase ${apiBase}`);
  process.env.CCMINI_API_BASE = apiBase;
  createWindow();
  debugLog('window created');
});

app.on('window-all-closed', () => { if (apiServer) apiServer.close(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

ipcMain.handle('get-app-path', () => app.getPath('userData'));
ipcMain.handle('get-platform', () => process.platform);
ipcMain.handle('install-update', () => false);
ipcMain.handle('open-external', (_event, url) => shell.openExternal(url));
ipcMain.handle('resize-window', (_event, width, height) => { if (mainWindow) { mainWindow.setSize(width, height); mainWindow.center(); } return true; });
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'], defaultPath: currentWorkspace });
  if (result.canceled || !result.filePaths?.length) return null;
  currentWorkspace = result.filePaths[0];
  saveState();
  return currentWorkspace;
});
ipcMain.handle('show-item-in-folder', (_event, filePath) => filePath && fs.existsSync(filePath) ? (shell.showItemInFolder(filePath), true) : false);
ipcMain.handle('open-folder', (_event, folderPath) => folderPath && fs.existsSync(folderPath) ? (shell.openPath(folderPath), true) : false);
ipcMain.handle('export-workspace', async (_event, workspaceId, contextMarkdown, defaultFilename) => {
  const result = await dialog.showSaveDialog(mainWindow, { title: '导出对话', defaultPath: defaultFilename || `conversation-${workspaceId}.md`, filters: [{ name: 'Markdown Files', extensions: ['md'] }, { name: 'All Files', extensions: ['*'] }] });
  if (result.canceled || !result.filePath) return { success: false, reason: 'canceled' };
  fs.writeFileSync(result.filePath, contextMarkdown || '', 'utf8');
  return { success: true, path: result.filePath, size: Buffer.byteLength(contextMarkdown || '', 'utf8') };
});
