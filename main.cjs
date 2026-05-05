const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const { pathToFileURL } = require('url');

const DESKTOP_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(DESKTOP_ROOT, '..');
const KERNEL_VENDOR_ROOT = path.join(__dirname, 'vendor', 'hare-code-kernel');
const HARE_CODE_ROOT = resolveHareCodeRoot();
const ENV_PATH = path.join(HARE_CODE_ROOT, '.env');
const TITLE_BAR_BASE_HEIGHT = 44;
const DEBUG_LOG = path.join(os.homedir(), 'AppData', 'Roaming', 'hare-desktop', 'main-debug.log');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const CLAUDE_CONFIG_HOME = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const CLAUDE_USER_SKILLS_ROOT = path.join(CLAUDE_CONFIG_HOME, 'skills');
const PERMISSION_REQUEST_TIMEOUT_MS = 120000;
const TOOL_DETAIL_MAX_LENGTH = 50000;

process.env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_HOME;
process.env.CODEX_HOME = CODEX_HOME;

let mainWindow = null;
let apiServer = null;
let apiBase = '';
let currentWorkspace = PROJECT_ROOT;
let statePath = '';
let uploadsDir = '';
let customSkillsDir = '';
const activeRuns = new Map();
const kernelConversations = new Map();
let state = null;
let kernelRuntimePromise = null;

const isForegroundRunActive = (run) => Boolean(run && !run.foregroundDone);

const userDataDirOverride = String(process.env.HARE_DESKTOP_USER_DATA_DIR || '').trim();
if (userDataDirOverride) {
  app.setPath('userData', userDataDirOverride);
}

const readJson = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};

const safeStat = (file) => {
  try { return fs.statSync(file); } catch { return null; }
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

const nowIso = () => new Date().toISOString();
const stripThinking = (model = '') => `${model}`.replace(/-thinking$/, '');
const roughTokens = (text = '') => Math.max(1, Math.round(`${text}`.length / 4));
const inferFormat = (baseUrl = '', model = '') => (/gpt|glm|deepseek|qwen|gemini/i.test(model) || /openai|compatible|v1/i.test(baseUrl)) ? 'openai' : 'anthropic';
const normalizeSessionKind = (value) => String(value || '').trim() === 'cowork' ? 'cowork' : 'chat';

function resolveHareCodeRoot() {
  const envRoot = String(process.env.HARE_CODE_ROOT || process.env.HARE_DESKTOP_KERNEL_ROOT || '').trim();
  const candidates = [
    envRoot,
    path.join(PROJECT_ROOT, 'claude-code'),
    path.join(PROJECT_ROOT, 'hare-code'),
    PROJECT_ROOT,
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return PROJECT_ROOT;
}

function resolveKernelModuleEntry() {
  const envEntry = String(process.env.HARE_DESKTOP_KERNEL_ENTRY || '').trim();
  const candidates = [
    envEntry,
    path.join(HARE_CODE_ROOT, 'dist', 'kernel.js'),
    path.join(KERNEL_VENDOR_ROOT, 'dist', 'kernel.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return resolveExternalProcessPath(candidate);
  }
  throw new Error(`Unable to resolve hare-code kernel.js. Build ../claude-code or run kernel sync for ${KERNEL_VENDOR_ROOT}`);
}

function loadHareKernelModule() {
  if (!global.__hareKernelModulePromise) {
    global.__hareKernelModulePromise = import(pathToFileURL(resolveKernelModuleEntry()).href);
  }
  return global.__hareKernelModulePromise;
}

function getBunBinary() {
  return process.env.BUN_BINARY || (process.platform === 'win32' ? 'bun.exe' : 'bun');
}

function resolveElectronNodeCommand() {
  if (!process.versions?.electron) return getBunBinary();
  if (process.platform !== 'darwin') return process.execPath;
  try {
    const executableName = path.basename(process.execPath);
    const contentsDir = path.dirname(path.dirname(process.execPath));
    const helperCommand = path.join(
      contentsDir,
      'Frameworks',
      `${executableName} Helper.app`,
      'Contents',
      'MacOS',
      `${executableName} Helper`,
    );
    if (fs.existsSync(helperCommand)) return helperCommand;
  } catch {}
  return process.execPath;
}

function getKernelWorkerCommandConfig() {
  const explicitCommand = String(process.env.HARE_DESKTOP_KERNEL_WORKER_COMMAND || '').trim();
  if (explicitCommand) {
    return { command: explicitCommand, env: {} };
  }

  if (process.versions?.electron && process.env.HARE_DESKTOP_KERNEL_WORKER_USE_BUN !== '1') {
    return {
      command: resolveElectronNodeCommand(),
      env: { ELECTRON_RUN_AS_NODE: '1' },
    };
  }

  return { command: getBunBinary(), env: {} };
}

function resolveExternalProcessPath(filePath) {
  return String(filePath || '').replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
}

function toRuntimeProviderSelection(provider, modelId, conversationId) {
  const normalizedModel = String(modelId || provider?.model || '').trim();
  const baseUrl = String(provider?.baseUrl || '').trim();
  const format = provider?.format || inferFormat(baseUrl, normalizedModel);
  const providerId = String(provider?.id || '').trim() || `desktop-inline-${conversationId}`;
  return {
    providerId,
    kind: format === 'openai' ? 'openai-compatible' : 'anthropic',
    model: normalizedModel || undefined,
    baseURL: baseUrl || undefined,
    authRef: { type: 'desktop', id: providerId },
    metadata: {
      desktopProviderName: provider?.name || providerId,
      desktopFormat: format,
      supportsWebSearch: Boolean(provider?.supportsWebSearch),
      webSearchStrategy: provider?.webSearchStrategy || null,
    },
  };
}

function buildKernelCapabilityIntent(providerSelection) {
  return {
    provider: providerSelection,
    tools: true,
    mcp: true,
    hooks: true,
    skills: true,
    plugins: true,
    agents: true,
    tasks: true,
    companion: true,
    kairos: true,
    memory: true,
    sessions: true,
  };
}

function buildKernelProviderSecret(provider, providerSelection) {
  const baseUrl = String(provider?.baseUrl || '').trim();
  const apiKey = String(provider?.apiKey || '').trim();
  const model = String(provider?.model || providerSelection?.model || '').trim();
  const format = provider?.format || inferFormat(baseUrl, model);
  if (!baseUrl && !apiKey && !model) return undefined;
  return {
    providerId: providerSelection.providerId,
    format,
    model: model || undefined,
    baseUrl: baseUrl || undefined,
    apiKey: apiKey || undefined,
  };
}

function buildKernelTurnMetadata({ conversation, provider, providerSelection, sessionId, isResuming }) {
  const metadata = {
    source: 'hare-code-desktop',
    providerId: providerSelection.providerId,
    providerFormat: provider?.format || inferFormat(provider?.baseUrl, provider?.model),
    desktopSession: {
      sessionId,
      isResuming,
      conversationId: conversation.id,
    },
  };
  const secret = buildKernelProviderSecret(provider, providerSelection);
  if (secret) {
    metadata.desktopProviderSecret = secret;
  }
  return metadata;
}

function buildKernelConversationMetadata({ conversation, provider, providerSelection, sessionId }) {
  return {
    source: 'hare-code-desktop',
    sessionKind: normalizeSessionKind(conversation.session_kind),
    providerId: providerSelection.providerId,
    providerFormat: provider?.format || inferFormat(provider?.baseUrl, provider?.model),
    desktopSession: {
      sessionId,
      isResuming: Boolean(sessionId),
      conversationId: conversation.id,
    },
  };
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function resolveWorkspacePath(...values) {
  for (const value of values) {
    const candidate = String(value || '').trim();
    if (!candidate) continue;
    const stat = safeStat(candidate);
    if (stat?.isDirectory()) return candidate;
    const parent = path.dirname(candidate);
    if (parent && parent !== candidate && parent !== path.parse(parent).root) {
      const parentStat = safeStat(parent);
      if (parentStat?.isDirectory()) return parent;
    }
  }
  return PROJECT_ROOT;
}

function isPackagedProjectRootPath(value) {
  try {
    return Boolean(app.isPackaged && value && path.resolve(String(value)) === path.resolve(PROJECT_ROOT));
  } catch {
    return false;
  }
}

function toAttachmentDisplayPath(filePath, workspacePath) {
  const absolutePath = String(filePath || '').trim();
  const basePath = String(workspacePath || '').trim();
  if (!absolutePath) return '';
  if (basePath) {
    try {
      const relativePath = path.relative(basePath, absolutePath);
      if (relativePath && !relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
        return relativePath.replace(/\\/g, '/');
      }
    } catch {}
  }
  return path.basename(absolutePath);
}

function resolveUploadAttachment(rawAttachment, workspacePath) {
  const attachmentId = firstNonEmptyString(rawAttachment?.fileId, rawAttachment?.id);
  if (!attachmentId) return null;
  const upload = state.uploads.find((item) => item.id === attachmentId);
  if (!upload?.path || !fs.existsSync(upload.path)) return null;
  return {
    type: 'file',
    source: 'desktop_upload',
    attachmentId: upload.id,
    path: upload.path,
    localPath: upload.path,
    filename: upload.file_name || path.basename(upload.path),
    displayPath: toAttachmentDisplayPath(upload.path, workspacePath),
    mimeType: upload.mime_type || '',
    fileType: upload.file_type || 'document',
    size: Number(upload.size || 0),
  };
}

function resolveGithubAttachment(rawAttachment, conversation, workspacePath) {
  const source = firstNonEmptyString(rawAttachment?.source, rawAttachment?.fileType, rawAttachment?.file_type);
  const attachmentId = firstNonEmptyString(rawAttachment?.fileId, rawAttachment?.id);
  if (source !== 'github' && !attachmentId.startsWith('github:')) return null;
  const repoFullName = firstNonEmptyString(
    rawAttachment?.ghRepo,
    rawAttachment?.gh_repo,
    rawAttachment?.fileName,
    rawAttachment?.file_name,
    attachmentId.replace(/^github:/, ''),
  );
  if (!repoFullName) return null;
  const ref = firstNonEmptyString(rawAttachment?.ghRef, rawAttachment?.gh_ref, 'main');
  const targetRoot = githubTargetRoot(conversation, repoFullName, ref);
  if (!fs.existsSync(targetRoot)) return null;
  return {
    type: 'directory',
    source: 'github',
    attachmentId: attachmentId || `github:${repoFullName}`,
    path: targetRoot,
    localPath: targetRoot,
    displayPath: toAttachmentDisplayPath(targetRoot, workspacePath),
    filename: repoFullName,
    repoFullName,
    ref,
  };
}

function resolveRuntimeAttachment(rawAttachment, conversation, workspacePath) {
  if (!rawAttachment || typeof rawAttachment !== 'object') return null;
  const githubAttachment = resolveGithubAttachment(rawAttachment, conversation, workspacePath);
  if (githubAttachment) return githubAttachment;
  const uploadAttachment = resolveUploadAttachment(rawAttachment, workspacePath);
  if (uploadAttachment) return uploadAttachment;

  const explicitPath = firstNonEmptyString(
    rawAttachment.path,
    rawAttachment.localPath,
    rawAttachment.filePath,
    rawAttachment.file_path,
  );
  if (!explicitPath || !fs.existsSync(explicitPath)) return null;
  const stats = safeStat(explicitPath);
  return {
    type: stats?.isDirectory?.() ? 'directory' : 'file',
    source: rawAttachment.source || 'explicit_path',
    attachmentId: firstNonEmptyString(rawAttachment.fileId, rawAttachment.id) || undefined,
    path: explicitPath,
    localPath: explicitPath,
    filename: firstNonEmptyString(rawAttachment.fileName, rawAttachment.file_name, path.basename(explicitPath)),
    displayPath: toAttachmentDisplayPath(explicitPath, workspacePath),
    mimeType: firstNonEmptyString(rawAttachment.mimeType, rawAttachment.mime_type),
    fileType: firstNonEmptyString(rawAttachment.fileType, rawAttachment.file_type),
    size: Number(rawAttachment.size || rawAttachment.file_size || 0),
  };
}

function resolveRuntimeAttachments(rawAttachments, conversation, workspacePath) {
  if (!Array.isArray(rawAttachments) || !rawAttachments.length) return [];
  return rawAttachments
    .map((attachment) => resolveRuntimeAttachment(attachment, conversation, workspacePath))
    .filter(Boolean);
}

function isKernelRuntimeTransportError(error) {
  const message = String(error?.message || error || '');
  return /EPIPE|write after end|closed|disposed|EOF|broken pipe|transport|spawn|exited/i.test(message);
}

function isGenericKernelTurnFailureMessage(message) {
  return /^(ask_result_error|error_during_execution|Headless runtime turn failed)$/i.test(String(message || '').trim());
}

function isKernelTurnErrorStopReason(stopReason) {
  return /^(ask_result_error|error_during_execution)$/i.test(String(stopReason || '').trim());
}

function normalizePermissionDecision(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['allow', 'allow_once', 'allow_session', 'deny', 'abort'].includes(normalized)) {
    return normalized;
  }
  return 'deny';
}

function normalizePermissionDecisionSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['host', 'policy', 'timeout', 'runtime'].includes(normalized)) {
    return normalized;
  }
  return 'host';
}

function serializePermissionRequest(request) {
  return {
    permission_request_id: String(request?.permissionRequestId || '').trim(),
    tool_name: String(request?.toolName || '').trim(),
    action: String(request?.action || '').trim(),
    risk: String(request?.risk || '').trim().toLowerCase(),
    arguments_preview: request?.argumentsPreview,
    policy_snapshot: request?.policySnapshot,
    metadata: request?.metadata || null,
    timeout_ms: Number(request?.timeoutMs || 0) || PERMISSION_REQUEST_TIMEOUT_MS,
  };
}

function serializePermissionResolved(payload) {
  return {
    permission_request_id: String(payload?.permissionRequestId || '').trim(),
    decision: normalizePermissionDecision(payload?.decision),
    decided_by: normalizePermissionDecisionSource(payload?.decidedBy),
    reason: String(payload?.reason || '').trim(),
    metadata: payload?.metadata || null,
  };
}

async function resetKernelRuntime(reason = 'desktop_runtime_reset') {
  const current = kernelRuntimePromise;
  kernelRuntimePromise = null;
  kernelConversations.clear();
  if (!current) return;
  try {
    const runtime = await current;
    await runtime.dispose(reason).catch(() => {});
  } catch {}
}

async function getKernelRuntime() {
  if (kernelRuntimePromise) return kernelRuntimePromise;
  kernelRuntimePromise = (async () => {
    const kernel = await loadHareKernelModule();
    const workerEntry = resolveExternalProcessPath(path.join(__dirname, 'worker.cjs'));
    const kernelEntry = resolveExternalProcessPath(resolveKernelModuleEntry());
    const workerCommand = getKernelWorkerCommandConfig();
    return kernel.createKernelRuntime({
      transportConfig: {
        kind: 'stdio',
        command: workerCommand.command,
        args: [workerEntry],
        env: {
          ...process.env,
          ...workerCommand.env,
          CODEX_HOME,
          CLAUDE_CONFIG_DIR: CLAUDE_CONFIG_HOME,
          HARE_DESKTOP_KERNEL_ENTRY: kernelEntry,
          CLAUDE_CODE_AGENT_WORKTREE_FALLBACK: process.env.CLAUDE_CODE_AGENT_WORKTREE_FALLBACK || '1',
        },
        stderr: (chunk) => {
          const text = String(chunk || '').trimEnd();
          if (text) debugLog(`[kernel-worker] ${text}`);
        },
      },
      autoStart: true,
    });
  })();
  try {
    return await kernelRuntimePromise;
  } catch (error) {
    kernelRuntimePromise = null;
    kernelConversations.clear();
    throw error;
  }
}

async function getKernelConversation(conversation, providerSelection, runtime) {
  const existing = kernelConversations.get(conversation.id);
  if (existing) return existing;
  const activeRuntime = runtime || await getKernelRuntime();
  const provider = state.providers.find((item) => String(item.id || '').trim() === providerSelection.providerId)
    || state.providers.find((item) => item.enabled !== false && (item.models || []).some((model) => model.id === providerSelection.model))
    || null;
  const kernelConversation = await activeRuntime.createConversation({
    id: conversation.id,
    workspacePath: conversation.workspace_path || currentWorkspace || PROJECT_ROOT,
    sessionId: conversation.backend_session_id || undefined,
    provider: providerSelection,
    capabilityIntent: buildKernelCapabilityIntent(providerSelection),
    metadata: buildKernelConversationMetadata({
      conversation,
      provider,
      providerSelection,
      sessionId: conversation.backend_session_id || undefined,
    }),
  });
  kernelConversations.set(conversation.id, kernelConversation);
  if (kernelConversation.sessionId) {
    conversation.backend_session_id = kernelConversation.sessionId;
  }
  return kernelConversation;
}

async function disposeKernelConversation(conversationId, reason = 'desktop_conversation_deleted') {
  const kernelConversation = kernelConversations.get(conversationId);
  kernelConversations.delete(conversationId);
  if (!kernelConversation) return;
  await kernelConversation.dispose(reason).catch(() => {});
}

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
  next.conversations = Array.isArray(next.conversations)
    ? next.conversations.map((conversation) => ({
        ...conversation,
        session_kind: normalizeSessionKind(conversation?.session_kind),
      }))
    : [];
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
  const stateWorkspace = isPackagedProjectRootPath(next.workspacePath) ? '' : next.workspacePath;
  currentWorkspace = resolveWorkspacePath(
    stateWorkspace,
    ...(next.projects || []).map((project) => project?.workspace_path),
    ...(next.conversations || []).map((conversation) => conversation?.workspace_path),
    next.workspacePath,
    PROJECT_ROOT,
  );
  next.workspacePath = currentWorkspace;
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
  const match = text.match(/^---\s*\n([\s\S]*?)---\s*\n?/);
  if (!match) return { meta: {}, body: text };
  const meta = {};
  match[1].split(/\r?\n/).forEach((line) => {
    const entry = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (entry) meta[entry[1]] = parseFrontmatterScalar(entry[2]);
  });
  return { meta, body: text.slice(match[0].length) };
}

function parseFrontmatterScalar(value = '') {
  const text = String(value || '').trim();
  const quoted = text.match(/^(['"])([\s\S]*)\1$/);
  return quoted ? quoted[2].trim() : text;
}

function parseFrontmatterBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function parseFrontmatterList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const text = String(value || '').trim();
  if (!text) return [];
  if (text.startsWith('[') && text.endsWith(']')) {
    try {
      const parsed = JSON.parse(text.replace(/'/g, '"'));
      if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
    } catch {}
    return text.slice(1, -1).split(',').map((item) => parseFrontmatterScalar(item)).filter(Boolean);
  }
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

function normalizeSkillPaths(value) {
  const patterns = parseFrontmatterList(value)
    .map((pattern) => pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern)
    .filter(Boolean);
  if (!patterns.length || patterns.every((pattern) => pattern === '**')) return undefined;
  return patterns;
}

function skillRuntimeMetadata(parsed, entry, source) {
  const meta = parsed.meta || {};
  return {
    command_name: entry.sourceDir,
    display_name: meta.name || entry.sourceDir,
    source,
    loadedFrom: 'skills',
    userInvocable: meta['user-invocable'] == null ? true : parseFrontmatterBoolean(meta['user-invocable'], true),
    modelInvocable: !parseFrontmatterBoolean(meta['disable-model-invocation'], false),
    whenToUse: meta.when_to_use || undefined,
    version: meta.version || undefined,
    context: meta.context === 'fork' ? 'fork' : undefined,
    agent: meta.agent || undefined,
    allowedTools: parseFrontmatterList(meta['allowed-tools']),
    paths: normalizeSkillPaths(meta.paths),
    contentLength: parsed.body.length,
  };
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

function skillDirsFromRoot(rootPath, source) {
  if (!fs.existsSync(rootPath)) return { examples: [], skills: [] };
  const examples = [];
  const skills = [];
  safeReadDir(rootPath).forEach((entry) => {
    if (!entry.isDirectory()) return;
    const fullPath = path.join(rootPath, entry.name);
    if (entry.name === '.system') {
      safeReadDir(fullPath).forEach((child) => {
        if (!child.isDirectory()) return;
        const childPath = path.join(fullPath, child.name);
        if (fs.existsSync(path.join(childPath, 'SKILL.md'))) {
          examples.push({ fullPath: childPath, relPath: `${entry.name}/${child.name}`, sourceDir: child.name, source });
        }
      });
      return;
    }
    if (fs.existsSync(path.join(fullPath, 'SKILL.md'))) {
      skills.push({ fullPath, relPath: entry.name, sourceDir: entry.name, source });
    }
  });
  return { examples, skills };
}

function findGitRoot(startPath) {
  let current = path.resolve(startPath || PROJECT_ROOT);
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function projectSkillRoots(cwd) {
  const roots = [];
  const home = path.resolve(os.homedir());
  const gitRoot = findGitRoot(cwd);
  let current = path.resolve(cwd || PROJECT_ROOT);
  while (true) {
    if (current === home) break;
    const candidate = path.join(current, '.claude', 'skills');
    if (safeStat(candidate)?.isDirectory()) roots.push(candidate);
    if (gitRoot && current === gitRoot) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

function realPathOrOriginal(filePath) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(filePath) : fs.realpathSync(filePath);
  } catch {
    return filePath;
  }
}

function projectSkillRecords() {
  const userRoot = path.resolve(CLAUDE_USER_SKILLS_ROOT);
  const records = [];
  const seen = new Set();
  projectSkillRoots(currentWorkspace).forEach((projectRoot) => {
    if (path.resolve(projectRoot) === userRoot) return;
    const { skills } = skillDirsFromRoot(projectRoot, 'projectSettings');
    skills.forEach((entry) => {
      const key = realPathOrOriginal(path.join(entry.fullPath, 'SKILL.md'));
      if (seen.has(key)) return;
      seen.add(key);
      records.push(projectSkillRecord(entry));
    });
  });
  return records;
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
      const runtimeMeta = skillRuntimeMetadata(parsed, { sourceDir: entry.name }, 'userSettings');
      return {
        id: record?.id || `local:${entry.name}`,
        dir_name: entry.name,
        dir_path: dirPath,
        name: parsed.meta.name || record?.name || entry.name,
        description: parsed.meta.description || record?.description || '',
        content: parsed.body || record?.content || '',
        enabled: record?.enabled !== false,
        is_example: false,
        ...runtimeMeta,
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
  const id = `example:${entry.relPath.replace(/\\/g, '/')}`;
  const runtimeMeta = skillRuntimeMetadata(parsed, entry, entry.source || 'userSettings');
  return {
    id,
    name: parsed.meta.name || entry.sourceDir,
    description: parsed.meta.description || '',
    content: parsed.body || '',
    enabled: state.skillPreferences[id] !== false,
    is_example: true,
    ...runtimeMeta,
    source_dir: entry.sourceDir,
    rel_path: entry.relPath.replace(/\\/g, '/'),
    dir_path: entry.fullPath,
    files: buildFileTree(entry.fullPath),
  };
}

function projectSkillRecord(entry) {
  const skillFile = path.join(entry.fullPath, 'SKILL.md');
  const parsed = readSkillMarkdown(skillFile);
  const relPath = entry.relPath.replace(/\\/g, '/');
  const id = `project:${relPath}`;
  const runtimeMeta = skillRuntimeMetadata(parsed, entry, 'projectSettings');
  return {
    id,
    dir_name: entry.sourceDir,
    dir_path: entry.fullPath,
    name: parsed.meta.name || entry.sourceDir,
    description: parsed.meta.description || '',
    content: parsed.body || '',
    enabled: state.skillPreferences[id] !== false,
    is_example: false,
    ...runtimeMeta,
    source_dir: entry.sourceDir,
    rel_path: relPath,
    files: buildFileTree(entry.fullPath),
  };
}

function allSkillRecords() {
  const userSkills = skillDirsFromRoot(CLAUDE_USER_SKILLS_ROOT, 'user');
  return {
    examples: userSkills.examples.map((entry) => builtinSkillRecord(entry)),
    custom: [
      ...projectSkillRecords(),
      ...customSkillRecords(),
    ],
  };
}

function findSkillRecord(id) {
  const { examples, custom } = allSkillRecords();
  return [...examples, ...custom].find((item) => item.id === id) || null;
}

function runtimeSkillRecordId(skill) {
  const source = String(skill?.source || 'unknown').replace(/[^a-zA-Z0-9_.:-]+/g, '-');
  const loadedFrom = String(skill?.loadedFrom || 'skills').replace(/[^a-zA-Z0-9_.:-]+/g, '-');
  const name = String(skill?.name || 'unknown').replace(/[^a-zA-Z0-9_.:-]+/g, '-');
  return `runtime:${source}:${loadedFrom}:${name}`;
}

function fileSkillRecordKey(record) {
  return String(record?.command_name || record?.source_dir || record?.name || '').trim();
}

function fileSkillRecordMap(records) {
  const map = new Map();
  records.forEach((record) => {
    const key = fileSkillRecordKey(record);
    if (key && !map.has(key)) map.set(key, record);
  });
  return map;
}

function isRuntimeExampleSkill(record) {
  return record?.is_example === true || ['builtin', 'bundled'].includes(String(record?.source || ''));
}

function applySkillPreference(record) {
  const preference = state.skillPreferences[record.id];
  const enabled = preference == null ? record.enabled !== false : preference !== false;
  return { ...record, enabled };
}

function runtimeSkillRecord(skill, fileRecord = null) {
  const commandName = String(skill?.name || fileSkillRecordKey(fileRecord) || '').trim();
  const id = fileRecord?.id || runtimeSkillRecordId(skill);
  const displayName = fileRecord?.display_name || fileRecord?.name || commandName;
  return applySkillPreference({
    ...(fileRecord || {}),
    id,
    name: displayName,
    command_name: commandName,
    display_name: displayName,
    description: String(skill?.description ?? fileRecord?.description ?? ''),
    content: fileRecord?.content || '',
    enabled: fileRecord?.enabled !== false,
    is_example: fileRecord?.is_example === true || ['builtin', 'bundled'].includes(String(skill?.source || '')),
    source_dir: fileRecord?.source_dir || commandName,
    source: skill?.source || fileRecord?.source || 'unknown',
    loadedFrom: skill?.loadedFrom || fileRecord?.loadedFrom || 'skills',
    userInvocable: skill?.userInvocable,
    modelInvocable: skill?.modelInvocable !== false,
    aliases: Array.isArray(skill?.aliases) ? skill.aliases : undefined,
    whenToUse: skill?.whenToUse,
    version: skill?.version,
    context: skill?.context,
    agent: skill?.agent,
    allowedTools: Array.isArray(skill?.allowedTools) ? skill.allowedTools : [],
    paths: Array.isArray(skill?.paths) ? skill.paths : undefined,
    contentLength: Number.isFinite(skill?.contentLength) ? skill.contentLength : fileRecord?.contentLength,
    plugin: skill?.plugin,
    runtime_only: !fileRecord,
  });
}

async function kernelSkillDescriptors() {
  const kernel = await loadHareKernelModule();
  if (typeof kernel.createKernelRuntime !== 'function') {
    throw new Error('kernel package missing createKernelRuntime');
  }
  const runtime = await kernel.createKernelRuntime({
    workspacePath: currentWorkspace || PROJECT_ROOT,
    transportConfig: { kind: 'in-process' },
    autoStart: true,
  });
  try {
    const skills = await runtime.skills.reload();
    return Array.isArray(skills) ? skills : [];
  } finally {
    await runtime.dispose('desktop_skill_catalog_list').catch(() => {});
  }
}

async function allRuntimeBackedSkillRecords() {
  const fileRecords = allSkillRecords();
  const fileFlat = [...fileRecords.examples, ...fileRecords.custom];
  const byCommand = fileSkillRecordMap(fileFlat);
  const descriptors = await kernelSkillDescriptors();
  const records = descriptors.map((skill) => runtimeSkillRecord(skill, byCommand.get(String(skill?.name || '').trim()) || null));
  return {
    examples: records.filter(isRuntimeExampleSkill),
    custom: records.filter((record) => !isRuntimeExampleSkill(record)),
  };
}

async function safeAllSkillRecords() {
  try {
    return await allRuntimeBackedSkillRecords();
  } catch (error) {
    debugLog(`kernel skill catalog unavailable, falling back to file scan: ${error?.message || error}`);
    return allSkillRecords();
  }
}

async function findRuntimeBackedSkillRecord(id) {
  const { examples, custom } = await safeAllSkillRecords();
  return [...examples, ...custom].find((item) => item.id === id) || null;
}

function pathInside(childPath, parentPath) {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function userWritableSkillRecord(record) {
  return record && record.source === 'userSettings' && pathInside(record.dir_path, customSkillsDir);
}

function skillFilePath(record, requestedPath = '') {
  const relative = String(requestedPath || '').replace(/^[/\\]+/, '');
  return path.join(record.dir_path, relative);
}

function githubHeaders(extra = {}) {
  return {
      'User-Agent': 'hare-desktop',
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
    session_kind: normalizeSessionKind(conversation.session_kind),
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

function extractAssistantText(message) {
  if (!message || !Array.isArray(message.content)) return '';
  return message.content.filter((block) => block && block.type === 'text').map((block) => block.text || '').join('');
}

function truncateToolDetail(value, maxLength = TOOL_DETAIL_MAX_LENGTH) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n[desktop truncated ${text.length - maxLength} chars]`;
}

function stringifyToolValue(value) {
  if (value == null) return '';
  if (typeof value === 'string') return truncateToolDetail(value);
  if (Array.isArray(value)) {
    return truncateToolDetail(value.map((item) => stringifyToolValue(item)).filter(Boolean).join('\n'));
  }
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return truncateToolDetail(value.text);
    if (typeof value.content === 'string' || Array.isArray(value.content)) return stringifyToolValue(value.content);
    try {
      return truncateToolDetail(JSON.stringify(value, null, 2));
    } catch {
      return truncateToolDetail(String(value));
    }
  }
  return truncateToolDetail(String(value));
}

function normalizeToolInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  return input;
}

function hasObjectEntries(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0);
}

function hasRuntimeMessageValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value != null && value !== '';
}

function findPersistedToolCallById(toolCalls, id) {
  if (!id) return null;
  for (const toolCall of toolCalls || []) {
    if (toolCall?.id === id) return toolCall;
    const child = findPersistedToolCallById(toolCall?.childToolCalls || [], id);
    if (child) return child;
  }
  return null;
}

function isEmptyToolPayload(payload) {
  return !String(payload?.parent_tool_use_id || '').trim()
    && !String(payload?.tool_name || '').trim()
    && !hasObjectEntries(payload?.tool_input)
    && !hasRuntimeMessageValue(payload?.content)
    && !hasRuntimeMessageValue(payload?.textBefore);
}

function applyPersistedToolPayloadToList(toolCalls, payload, fallbackName = '') {
  const toolUseId = String(payload?.tool_use_id || '').trim();
  if (!toolUseId) return;
  if (payload.type === 'tool_use_start') {
    let existing = toolCalls.find((item) => item.id === toolUseId);
    if (existing) {
      existing.name = payload.tool_name || existing.name;
      if (hasObjectEntries(payload.tool_input)) existing.input = payload.tool_input;
      if (payload.textBefore) existing.textBefore = payload.textBefore;
    } else {
      if (isEmptyToolPayload(payload)) return;
      toolCalls.push({
        id: toolUseId,
        name: payload.tool_name || fallbackName || 'unknown',
        input: hasObjectEntries(payload.tool_input) ? payload.tool_input : {},
        status: 'running',
        textBefore: payload.textBefore || '',
      });
    }
    return;
  }

  if (payload.type === 'tool_use_input') {
    const existing = toolCalls.find((item) => item.id === toolUseId);
    if (existing) {
      existing.name = payload.tool_name || existing.name;
      existing.input = hasObjectEntries(payload.tool_input) ? payload.tool_input : existing.input || {};
    }
    return;
  }

  if (payload.type === 'tool_use_done') {
    let existing = toolCalls.find((item) => item.id === toolUseId);
    if (!existing) {
      if (isEmptyToolPayload(payload)) return;
      existing = {
        id: toolUseId,
        name: payload.tool_name || fallbackName || 'unknown',
        input: {},
        status: payload.is_error ? 'error' : 'done',
        result: payload.content,
      };
      toolCalls.push(existing);
      return;
    }
    existing.name = payload.tool_name || existing.name;
    existing.status = payload.is_error ? 'error' : 'done';
    existing.result = payload.content;
  }
}

function recordPersistedToolPayload(toolCalls, payload) {
  const parentToolUseId = String(payload?.parent_tool_use_id || '').trim();
  if (parentToolUseId) {
    const parent = findPersistedToolCallById(toolCalls, parentToolUseId);
    if (!parent) return;
    parent.childToolCalls = parent.childToolCalls || [];
    applyPersistedToolPayloadToList(parent.childToolCalls, payload, parent.subagent?.last_tool_name);
    pruneSyntheticAgentChildren(parent.childToolCalls, payload.tool_name || parent.subagent?.last_tool_name);
    return;
  }
  applyPersistedToolPayloadToList(toolCalls, payload);
}

function pruneSyntheticAgentChildren(childToolCalls, toolName) {
  const name = String(toolName || '').trim();
  if (!name) return;
  const hasRealChild = (childToolCalls || []).some((item) => (
    item?.name === name && !String(item?.id || '').startsWith('agent-child:')
  ));
  if (!hasRealChild) return;
  for (let index = childToolCalls.length - 1; index >= 0; index -= 1) {
    const child = childToolCalls[index];
    if (child?.name === name && String(child?.id || '').startsWith('agent-child:')) {
      childToolCalls.splice(index, 1);
    }
  }
}

function syntheticAgentChildId(taskId, toolName) {
  return `agent-child:${String(taskId || 'task')}:${String(toolName || 'tool')}`;
}

function inputFromAgentTaskProgress(toolName, description) {
  const text = String(description || '').trim();
  if (!text) return {};
  if (toolName === 'Read') {
    const match = text.match(/^(?:reading|read)\s+(.+)$/i);
    return { path: match?.[1]?.trim() || text };
  }
  if (toolName === 'Bash' || toolName === 'PowerShell') {
    return { command: text };
  }
  if (toolName === 'Grep' || toolName === 'Search') {
    return { pattern: text };
  }
  if (toolName === 'Glob') {
    return { pattern: text };
  }
  return { description: text };
}

function syncSyntheticAgentChildFromTaskEvent(parent, payload, description) {
  parent.childToolCalls = parent.childToolCalls || [];
  const lastToolName = String(payload?.last_tool_name || parent.subagent?.last_tool_name || '').trim();
  const taskId = String(payload?.task_id || parent.subagent?.task_id || parent.id || '').trim();
  if (lastToolName) {
    const hasRealChild = parent.childToolCalls.some((item) => (
      item?.name === lastToolName && !String(item?.id || '').startsWith('agent-child:')
    ));
    if (hasRealChild) return;
    const childId = syntheticAgentChildId(taskId, lastToolName);
    let child = parent.childToolCalls.find((item) => item.id === childId);
    if (!child) {
      child = {
        id: childId,
        name: lastToolName,
        input: inputFromAgentTaskProgress(lastToolName, description),
        status: payload?.subtype === 'task_notification' ? 'done' : 'running',
      };
      parent.childToolCalls.push(child);
    }
    child.name = lastToolName;
    if (!hasObjectEntries(child.input)) {
      child.input = inputFromAgentTaskProgress(lastToolName, description);
    }
    child.status = payload?.subtype === 'task_notification' || payload?.status === 'completed'
      ? 'done'
      : 'running';
    if (payload?.summary) child.result = stringifyToolValue(payload.summary);
    return;
  }

  if (payload?.subtype === 'task_notification' || payload?.status === 'completed') {
    for (const child of parent.childToolCalls) {
      if (child.status === 'running') {
        child.status = 'done';
        if (!child.result && payload?.summary) child.result = stringifyToolValue(payload.summary);
      }
    }
  }
}

function recordPersistedTaskEvent(toolCalls, payload) {
  const parentToolUseId = String(payload?.tool_use_id || '').trim();
  if (!parentToolUseId) return;
  const parent = findPersistedToolCallById(toolCalls, parentToolUseId);
  if (!parent) return;

  const previous = parent.subagent || {};
  const incomingDescription = String(payload.description || '').trim();
  const description = incomingDescription && !incomingDescription.startsWith('Kernel ')
    ? incomingDescription
    : previous.description || incomingDescription;
  const previousEvents = Array.isArray(previous.events) ? previous.events : [];
  const event = {
    subtype: payload.subtype || '',
    status: payload.status || '',
    description,
    last_tool_name: payload.last_tool_name || '',
  };
  const eventKey = `${event.subtype}|${event.status}|${event.last_tool_name}|${event.description}`;
  const lastEvent = previousEvents[previousEvents.length - 1];
  const lastEventKey = lastEvent ? `${lastEvent.subtype || ''}|${lastEvent.status || ''}|${lastEvent.last_tool_name || ''}|${lastEvent.description || ''}` : '';
  parent.subagent = {
    ...previous,
    task_id: payload.task_id || previous.task_id,
    description,
    status: payload.status || (payload.subtype === 'task_notification' ? 'completed' : 'running'),
    last_tool_name: payload.last_tool_name || previous.last_tool_name,
    summary: payload.summary || previous.summary,
    usage: payload.usage || previous.usage,
    subtype: payload.subtype || previous.subtype,
	    events: eventKey && eventKey !== lastEventKey
	      ? [...previousEvents.slice(-29), event]
	      : previousEvents,
	  };
  syncSyntheticAgentChildFromTaskEvent(parent, payload, description);
}

function runViaKernel({ conversation, provider, prompt, attachments, workspacePath, onText, onDone, onError, onStart, onPermissionRequest, onPermissionResolved, onToolUse, onSystemEvent, onForegroundDone }) {
  const requestedWorkspace = workspacePath || currentWorkspace || PROJECT_ROOT;
  const workspace = resolveWorkspacePath(requestedWorkspace, currentWorkspace, PROJECT_ROOT);
  if (workspace !== requestedWorkspace) {
    debugLog(`workspace path unavailable for ${conversation.id}: requested=${requestedWorkspace} fallback=${workspace}`);
  }
  const previousSessionId = String(conversation.backend_session_id || '').trim();
  const sessionId = previousSessionId || undefined;
  const turnId = `turn-${randomUUID()}`;
  const providerSelection = toRuntimeProviderSelection(
    provider,
    stripThinking(conversation.model) || conversation.model,
    conversation.id,
  );

  let runtime = null;
  let kernelConversation = null;
  let unsubscribe = null;
  let stopRequested = false;
  let terminal = false;
  let streamedText = '';
  let lastAssistantText = '';
  let lastResultText = '';
  let lastErrorText = '';
  let runtimeSessionId = previousSessionId;
  let foregroundDoneEmitted = false;
  let backgroundFinishTimer = null;
  const toolUseInputsById = new Map();
  const toolNamesById = new Map();
  const emittedToolResults = new Set();
  const pendingBackgroundTaskIds = new Set();
  const pendingPermissionRequestIds = new Set();
  let lastToolTextSnapshot = '';

  const cleanup = () => {
    if (backgroundFinishTimer) {
      clearTimeout(backgroundFinishTimer);
      backgroundFinishTimer = null;
    }
    if (unsubscribe) {
      try { unsubscribe(); } catch {}
      unsubscribe = null;
    }
  };

  const finish = (kind, value) => {
    if (terminal) return;
    terminal = true;
    const finalText = (lastAssistantText || lastResultText || streamedText || '').trim();
    if (kind === 'error') {
      onError(value || lastErrorText || 'Kernel runtime request failed');
    } else {
      onDone(value || finalText || '[模型未返回文本]');
    }
    cleanup();
  };

  const stop = (options = {}) => {
    if (terminal || stopRequested) return;
    stopRequested = true;
    if (kernelConversation) {
      void kernelConversation.abortTurn(turnId, { reason: 'desktop_stop_generation' }).catch(() => {});
    }
    if (options?.mode === 'finish') {
      const finalText = (lastAssistantText || streamedText || lastResultText || '').trim();
      finish('done', finalText || '[模型未返回文本]');
      return;
    }
    finish('error', 'Task stopped.');
  };

  const emitText = (text) => {
    if (!text || terminal) return;
    streamedText += text;
    onText(text);
  };

  const emitToolUse = (payload) => {
    if (terminal || typeof onToolUse !== 'function') return;
    onToolUse(payload);
  };

  const emitSystemEvent = (payload) => {
    if (terminal || typeof onSystemEvent !== 'function') return;
    onSystemEvent(payload);
  };

  const maybeEmitForegroundDone = () => {
    if (foregroundDoneEmitted || pendingBackgroundTaskIds.size === 0) return;
    const finalText = (lastAssistantText || streamedText || '').trim();
    if (!finalText) return;
    foregroundDoneEmitted = true;
    if (typeof onForegroundDone === 'function') {
      onForegroundDone(finalText);
    }
  };

  const maybeFinishBackgroundRun = () => {
    if (!foregroundDoneEmitted || pendingBackgroundTaskIds.size > 0 || terminal) return;
    if (backgroundFinishTimer) clearTimeout(backgroundFinishTimer);
    backgroundFinishTimer = setTimeout(() => {
      backgroundFinishTimer = null;
      if (!foregroundDoneEmitted || pendingBackgroundTaskIds.size > 0 || terminal) return;
      const finalText = (lastAssistantText || streamedText || lastResultText || '').trim();
      finish('done', finalText || '[模型未返回文本]');
    }, 100);
  };

  const emitToolUseBlock = (block, parentToolUseId = '') => {
    const toolUseId = String(block?.id || '').trim();
    if (!toolUseId) return;
    const toolName = String(block?.name || toolNamesById.get(toolUseId) || 'unknown').trim() || 'unknown';
    const toolInput = normalizeToolInput(block?.input);
    const inputKey = JSON.stringify(toolInput);
    const previousInputKey = toolUseInputsById.get(toolUseId);
    const isFirstEmission = previousInputKey == null;
    toolNamesById.set(toolUseId, toolName);
    if (isFirstEmission) {
      const textBefore = streamedText.startsWith(lastToolTextSnapshot)
        ? streamedText.slice(lastToolTextSnapshot.length)
        : streamedText;
      if (!parentToolUseId) lastToolTextSnapshot = streamedText;
      emitToolUse({
        type: 'tool_use_start',
        tool_use_id: toolUseId,
        parent_tool_use_id: parentToolUseId || undefined,
        tool_name: toolName,
        tool_input: toolInput,
        textBefore: parentToolUseId ? '' : textBefore,
      });
    }
    if (isFirstEmission || previousInputKey !== inputKey) {
      toolUseInputsById.set(toolUseId, inputKey);
      emitToolUse({
        type: 'tool_use_input',
        tool_use_id: toolUseId,
        parent_tool_use_id: parentToolUseId || undefined,
        tool_name: toolName,
        tool_input: toolInput,
      });
    }
  };

  const emitToolResultBlock = (block, parentToolUseId = '') => {
    const toolUseId = String(block?.tool_use_id || block?.toolUseId || '').trim();
    if (!toolUseId || emittedToolResults.has(toolUseId)) return;
    emittedToolResults.add(toolUseId);
    emitToolUse({
      type: 'tool_use_done',
      tool_use_id: toolUseId,
      parent_tool_use_id: parentToolUseId || undefined,
      tool_name: toolNamesById.get(toolUseId) || undefined,
      content: stringifyToolValue(block?.content),
      is_error: Boolean(block?.is_error || block?.isError),
    });
  };

  const handleNestedToolMessage = (nestedMessage, parentToolUseId = '') => {
    if (!nestedMessage || typeof nestedMessage !== 'object') return;
    const content = nestedMessage.message?.content;
    if (!Array.isArray(content)) return;
    if (nestedMessage.type === 'assistant') {
      for (const block of content) {
        if (block?.type === 'tool_use') emitToolUseBlock(block, parentToolUseId);
      }
      return;
    }
    if (nestedMessage.type === 'user') {
      for (const block of content) {
        if (block?.type === 'tool_result') emitToolResultBlock(block, parentToolUseId);
      }
    }
  };

  const decidePermission = async ({ permissionRequestId, decision, decidedBy = 'host', reason = '' }) => {
    const normalizedRequestId = String(permissionRequestId || '').trim();
    if (!runtime || !normalizedRequestId) {
      throw new Error('Kernel runtime permission broker unavailable');
    }
    return runtime.decidePermission({
      permissionRequestId: normalizedRequestId,
      decision: normalizePermissionDecision(decision),
      decidedBy: normalizePermissionDecisionSource(decidedBy),
      reason: String(reason || '').trim(),
    });
  };

  const failTurn = (message) => {
    debugLog(`kernel turn failed for ${conversation.id}: ${message || 'Kernel runtime turn failed'}`);
    conversation.backend_runtime = 'kernel';
    conversation.backend_started = false;
    conversation.backend_session_id = undefined;
    void disposeKernelConversation(conversation.id, 'desktop_turn_failed');
    finish('error', message || 'Kernel runtime turn failed');
  };

  const completeTurn = (stopReason) => {
    debugLog(`kernel turn completed for ${conversation.id}: stopReason=${stopReason || 'end_turn'}`);
    conversation.backend_runtime = 'kernel';
    conversation.backend_session_id = runtimeSessionId || conversation.backend_session_id || kernelConversation?.sessionId;
    conversation.backend_started = false;
    if (stopReason === 'foreground_done') {
      conversation.backend_started = true;
      conversation.updated_at = nowIso();
      saveState();
      return;
    }
    if (stopRequested || stopReason === 'aborted') {
      finish('error', 'Task stopped.');
      return;
    }
    if (lastErrorText && isKernelTurnErrorStopReason(stopReason)) {
      conversation.backend_session_id = undefined;
      void disposeKernelConversation(conversation.id, 'desktop_turn_failed');
      finish('error', lastErrorText);
      return;
    }
    if (!(lastAssistantText || lastResultText || streamedText || '').trim()) {
      conversation.backend_session_id = undefined;
      void disposeKernelConversation(conversation.id, 'desktop_turn_empty_output');
      void resetKernelRuntime('desktop_turn_empty_output');
      finish('error', 'Kernel runtime returned no text. Session was reset; please retry.');
      return;
    }
    conversation.backend_started = true;
    finish('done');
  };

  const handleSdkMessage = (message) => {
    if (!message || typeof message !== 'object') return;
    if (typeof message.session_id === 'string' && message.session_id) {
      runtimeSessionId = message.session_id;
      conversation.backend_session_id = runtimeSessionId;
    }

    if (message.type === 'stream_event') {
      if (
        message.event?.type === 'content_block_delta'
        && message.event?.delta?.type === 'text_delta'
        && typeof message.event?.delta?.text === 'string'
      ) {
        emitText(message.event.delta.text);
        return;
      }
      if (message.event?.type === 'content_block_start' && message.event?.content_block?.type === 'tool_use') {
        emitToolUseBlock(message.event.content_block, String(message.parent_tool_use_id || '').trim());
        return;
      }
    }

    if (message.type === 'assistant') {
      const parentToolUseId = String(message.parent_tool_use_id || '').trim();
      if (!parentToolUseId) {
        lastAssistantText = extractAssistantText(message.message) || lastAssistantText;
        maybeEmitForegroundDone();
      }
      if (Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block?.type === 'tool_use') emitToolUseBlock(block, parentToolUseId);
        }
      }
      return;
    }

    if (message.type === 'user' && Array.isArray(message.message?.content)) {
      const parentToolUseId = String(message.parent_tool_use_id || '').trim();
      for (const block of message.message.content) {
        if (block?.type === 'tool_result') emitToolResultBlock(block, parentToolUseId);
      }
      return;
    }

    if (message.type === 'progress') {
      const progressData = message.data || {};
      const progressType = progressData.type || '';
      if (progressType === 'agent_progress' || progressType === 'skill_progress') {
        const parentToolUseId = String(
          message.parentToolUseID
            || message.parent_tool_use_id
            || progressData.parentToolUseID
            || progressData.parent_tool_use_id
            || '',
        ).trim();
        if (!parentToolUseId) return;
        handleNestedToolMessage(progressData.message, parentToolUseId);
      }
      return;
    }

    if (message.type === 'system') {
      const subtype = message.subtype || 'system';
      const taskId = String(message.task_id || message.session_id || turnId);
      const taskType = String(message.task_type || '').trim();
      const shouldTrackBackgroundTask = taskType === 'local_agent' || taskType === 'local_bash';
      if (subtype === 'task_started') {
        if (shouldTrackBackgroundTask) {
          pendingBackgroundTaskIds.add(taskId);
          maybeEmitForegroundDone();
        }
      } else if (subtype === 'task_notification') {
        pendingBackgroundTaskIds.delete(taskId);
        maybeFinishBackgroundRun();
      }
      emitSystemEvent({
        type: 'task_event',
        subtype,
        task_id: taskId,
        tool_use_id: message.tool_use_id || undefined,
        description: message.description || (subtype ? `Kernel ${subtype}` : 'Kernel system event'),
        summary: message.summary || stringifyToolValue(message),
        status: message.status || undefined,
        last_tool_name: message.last_tool_name || undefined,
        usage: message.usage || undefined,
        task_type: message.task_type || undefined,
        prompt: message.prompt || undefined,
      });
      return;
    }

    if (message.type === 'result') {
      if (typeof message.result === 'string') {
        lastResultText = message.result;
      }
      if (message.is_error) {
        lastErrorText = (Array.isArray(message.errors) ? message.errors.filter(Boolean).join('\n') : '')
          || lastResultText
          || 'Kernel runtime returned an error result';
      }
      maybeFinishBackgroundRun();
    }
  };

  const handlePermissionRequest = (request) => {
    const permissionRequestId = String(request?.permissionRequestId || '').trim();
    if (!permissionRequestId) return;
    pendingPermissionRequestIds.add(permissionRequestId);
    const serialized = serializePermissionRequest(request);
    debugLog(`permission requested for ${conversation.id}: tool=${serialized.tool_name || ''} risk=${serialized.risk || ''}`);
    if (typeof onPermissionRequest === 'function') {
      onPermissionRequest(serialized);
      return;
    }
    void decidePermission({
      permissionRequestId,
      decision: 'abort',
      decidedBy: 'host',
      reason: 'Desktop permission UI not connected yet',
    }).catch((error) => {
      debugLog(`failed to resolve permission request ${permissionRequestId}: ${error?.message || error}`);
    });
  };

  const handleKernelEnvelope = (envelope) => {
    if (!envelope || terminal) return;
    if (envelope.kind === 'error') {
      if (isKernelRuntimeTransportError(envelope.error)) {
        void resetKernelRuntime('desktop_runtime_worker_error');
      }
      finish('error', envelope.error?.message || 'Kernel runtime request failed');
      return;
    }

    const eventType = envelope.payload?.type;
    const eventPayload = envelope.payload?.payload;
    if (eventType === 'permission.requested') {
      handlePermissionRequest(eventPayload);
      return;
    }

    if (eventType === 'permission.resolved') {
      const permissionRequestId = String(eventPayload?.permissionRequestId || eventPayload?.permission_request_id || '').trim();
      if (permissionRequestId) pendingPermissionRequestIds.delete(permissionRequestId);
      if (typeof onPermissionResolved === 'function') {
        onPermissionResolved(serializePermissionResolved(eventPayload));
      }
      return;
    }

    if (eventType === 'headless.sdk_message') {
      handleSdkMessage(eventPayload);
      return;
    }

    if (eventType === 'turn.output_delta') {
      const text = typeof eventPayload?.text === 'string' ? eventPayload.text : '';
      if (text && !streamedText) emitText(text);
      return;
    }

    if (eventType === 'turn.failed') {
      const eventMessage = typeof eventPayload?.error?.message === 'string'
        ? eventPayload.error.message
        : '';
      const message = !isGenericKernelTurnFailureMessage(eventMessage)
        ? eventMessage
        : lastErrorText;
      failTurn(message);
      return;
    }

    if (eventType === 'turn.abort_requested') {
      conversation.backend_runtime = 'kernel';
      conversation.backend_started = false;
      finish('error', 'Task stopped.');
      return;
    }

    if (eventType === 'turn.completed') {
      completeTurn(eventPayload?.stopReason);
    }
  };

  onStart({
    stop,
    sessionId,
    decidePermission,
  });

  void (async () => {
    try {
      debugLog(`runViaKernel start ${conversation.id}: session=${sessionId || ''} workspace=${workspace}`);
      runtime = await getKernelRuntime();
      debugLog(`runViaKernel runtime ready ${conversation.id}`);
      kernelConversation = await getKernelConversation({
        ...conversation,
        workspace_path: workspace,
        backend_session_id: previousSessionId || undefined,
      }, providerSelection, runtime);
      debugLog(`runViaKernel conversation ready ${conversation.id}: runtimeSession=${kernelConversation.sessionId || ''}`);
      runtimeSessionId = conversation.backend_session_id || kernelConversation.sessionId || runtimeSessionId;
      conversation.backend_session_id = runtimeSessionId;
      unsubscribe = kernelConversation.onEvent(handleKernelEnvelope);

      if (stopRequested) {
        finish('error', 'Task stopped.');
        return;
      }

      debugLog(`runViaKernel runTurn ${conversation.id}: turn=${turnId}`);
      const turnSnapshot = await kernelConversation.runTurn(prompt, {
        turnId,
        attachments: attachments || undefined,
        providerOverride: providerSelection,
        metadata: {
          ...buildKernelTurnMetadata({
            conversation,
            provider,
            providerSelection,
            sessionId,
            isResuming: Boolean(previousSessionId),
          }),
        },
      });
      debugLog(`runViaKernel runTurn returned ${conversation.id}: state=${turnSnapshot?.state || 'unknown'} stopReason=${turnSnapshot?.stopReason || ''}`);
      if (terminal) {
        return;
      }
      if (turnSnapshot?.state === 'completed') {
        completeTurn(turnSnapshot.stopReason);
        return;
      }
      if (turnSnapshot?.state === 'failed') {
        const snapshotMessage = typeof turnSnapshot?.error?.message === 'string'
          ? turnSnapshot.error.message
          : '';
        failTurn(snapshotMessage || lastErrorText);
        return;
      }
      return;
    } catch (error) {
      if (isKernelRuntimeTransportError(error)) {
        await resetKernelRuntime('desktop_runtime_failed');
      }
      conversation.backend_runtime = 'kernel';
      conversation.backend_started = false;
      finish('error', error?.message || 'Kernel runtime request failed');
    }
  })();
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

  api.route('/api/workspace-config').get((_req, res) => res.json({ defaultDir: currentWorkspace })).post((req, res) => {
    const requested = req.body?.dir || currentWorkspace;
    const resolved = resolveWorkspacePath(requested, currentWorkspace, PROJECT_ROOT);
    if (resolved !== requested) {
      debugLog(`workspace config path unavailable: requested=${requested} fallback=${resolved}`);
    }
    currentWorkspace = resolved;
    saveState();
    res.json({ ok: true, defaultDir: currentWorkspace });
  });
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
  api.get('/api/skills', async (_req, res) => {
    const records = await safeAllSkillRecords();
    res.json({ examples: records.examples, my_skills: records.custom });
  });
  api.get('/api/skills/:id', async (req, res) => {
    const record = await findRuntimeBackedSkillRecord(req.params.id);
    if (!record) return res.status(404).json({ error: 'Skill not found' });
    res.json(record);
  });
  api.get('/api/skills/:id/file', async (req, res) => {
    const record = await findRuntimeBackedSkillRecord(req.params.id);
    if (!record) return res.status(404).json({ error: 'Skill not found' });
    if (!record.dir_path) return res.status(404).json({ error: 'Skill file is not available for this runtime skill' });
    const filePath = skillFilePath(record, req.query?.path || '');
    if (!pathInside(filePath, record.dir_path) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
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
    const parsed = readSkillMarkdown(path.join(dirPath, 'SKILL.md'));
    res.json({
      ...skill,
      ...skillRuntimeMetadata(parsed, { sourceDir: dirName }, 'userSettings'),
      is_example: false,
      source_dir: dirName,
      files: buildFileTree(dirPath),
    });
  });
  api.patch('/api/skills/:id', async (req, res) => {
    let skill = state.skills.find((item) => item.id === req.params.id);
    const existingRecord = await findRuntimeBackedSkillRecord(req.params.id);
    if (!skill) {
      if (!userWritableSkillRecord(existingRecord)) return res.status(404).json({ error: 'Skill not found' });
      skill = {
        id: existingRecord.id,
        dir_name: existingRecord.dir_name,
        enabled: existingRecord.enabled !== false,
        name: existingRecord.name,
        description: existingRecord.description || '',
        content: existingRecord.content || '',
        created_at: existingRecord.created_at || nowIso(),
      };
      state.skills.unshift(skill);
    }
    Object.assign(skill, req.body || {});
    const dirPath = path.join(customSkillsDir, skill.dir_name);
    if (!pathInside(dirPath, customSkillsDir)) return res.status(400).json({ error: 'Invalid skill path' });
    ensureDir(dirPath);
    writeSkillMarkdown(path.join(dirPath, 'SKILL.md'), skill.name, skill.description || '', skill.content || '');
    saveState();
    const parsed = readSkillMarkdown(path.join(dirPath, 'SKILL.md'));
    res.json({
      ...skill,
      ...skillRuntimeMetadata(parsed, { sourceDir: skill.dir_name }, 'userSettings'),
      is_example: false,
      source_dir: skill.dir_name,
      files: buildFileTree(dirPath),
    });
  });
  api.delete('/api/skills/:id', async (req, res) => {
    const skill = state.skills.find((item) => item.id === req.params.id);
    const existingRecord = await findRuntimeBackedSkillRecord(req.params.id);
    if (!skill && !userWritableSkillRecord(existingRecord)) return res.status(404).json({ error: 'Skill not found' });
    const dirName = skill?.dir_name || existingRecord.dir_name;
    const dirPath = path.join(customSkillsDir, dirName);
    if (!pathInside(dirPath, customSkillsDir)) return res.status(400).json({ error: 'Invalid skill path' });
    if (fs.existsSync(dirPath)) fs.rmSync(dirPath, { recursive: true, force: true });
    state.skills = state.skills.filter((item) => item.id !== req.params.id && item.dir_name !== dirName);
    saveState();
    res.json({ ok: true });
  });
  api.patch('/api/skills/:id/toggle', async (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    const customSkill = state.skills.find((item) => item.id === req.params.id);
    if (customSkill) {
      customSkill.enabled = enabled;
      saveState();
      return res.json(customSkill);
    }
    const record = await findRuntimeBackedSkillRecord(req.params.id);
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
  api.get('/api/projects/:id/conversations', (req, res) => {
    const project = state.projects.find((item) => item.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const sessionKind = normalizeSessionKind(req.query?.session_kind);
    res.json(
      (project.conversations || [])
        .map((id) => state.conversations.find((item) => item.id === id))
        .filter(Boolean)
        .filter((conversation) => normalizeSessionKind(conversation.session_kind) === sessionKind)
        .map((conversation) => conversationView(conversation)),
    );
  });
  api.post('/api/projects/:id/conversations', (req, res) => {
    const project = state.projects.find((item) => item.id === req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const conversation = {
      id: `conv-${randomUUID()}`,
      title: req.body?.title || 'New Chat',
      model: req.body?.model || state.chatModels?.[0]?.id || 'claude-sonnet-4-6',
      session_kind: normalizeSessionKind(req.body?.session_kind),
      workspace_path: resolveWorkspacePath(project.workspace_path, currentWorkspace, PROJECT_ROOT),
      project_id: project.id,
      messages: [],
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    state.conversations.unshift(conversation);
    project.conversations.unshift(conversation.id);
    saveState();
    res.json(conversationView(conversation));
  });
  api.get('/api/conversations', (req, res) => {
    const sessionKind = normalizeSessionKind(req.query?.session_kind);
    res.json(
      state.conversations
        .filter((item) => normalizeSessionKind(item.session_kind) === sessionKind)
        .map((item) => ({
          id: item.id,
          title: item.title,
          model: item.model,
          session_kind: normalizeSessionKind(item.session_kind),
          workspace_path: item.workspace_path || '',
          updated_at: item.updated_at,
          created_at: item.created_at,
          project_id: item.project_id || null,
        })),
    );
  });
  api.post('/api/conversations', (req, res) => {
    const conversation = {
      id: `conv-${randomUUID()}`,
      title: req.body?.title || 'New Chat',
      model: req.body?.model || state.chatModels?.[0]?.id || 'claude-sonnet-4-6',
      session_kind: normalizeSessionKind(req.body?.session_kind),
      workspace_path: resolveWorkspacePath(req.body?.workspace_path, currentWorkspace, PROJECT_ROOT),
      project_id: null,
      messages: [],
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    state.conversations.unshift(conversation);
    saveState();
    res.json(conversationView(conversation));
  });
  api.get('/api/conversations/:id', (req, res) => { const conversation = state.conversations.find((item) => item.id === req.params.id); conversation ? res.json(conversationView(conversation)) : res.status(404).json({ error: 'Conversation not found' }); });
  api.patch('/api/conversations/:id', (req, res) => { const conversation = state.conversations.find((item) => item.id === req.params.id); if (!conversation) return res.status(404).json({ error: 'Conversation not found' }); Object.assign(conversation, req.body || {}, { updated_at: nowIso() }); saveState(); res.json(conversationView(conversation)); });
  api.delete('/api/conversations/:id', async (req, res) => {
    activeRuns.get(req.params.id)?.stop?.();
    activeRuns.delete(req.params.id);
    await disposeKernelConversation(req.params.id, 'desktop_conversation_deleted');
    state.conversations = state.conversations.filter((item) => item.id !== req.params.id);
    state.projects.forEach((project) => { project.conversations = (project.conversations || []).filter((id) => id !== req.params.id); });
    saveState();
    res.json({ ok: true });
  });
  api.delete('/api/conversations/:id/messages/:messageId', (req, res) => { const conversation = state.conversations.find((item) => item.id === req.params.id); if (!conversation) return res.status(404).json({ error: 'Conversation not found' }); const index = (conversation.messages || []).findIndex((item) => item.id === req.params.messageId); if (index >= 0) conversation.messages = conversation.messages.slice(0, index); conversation.updated_at = nowIso(); saveState(); res.json(conversationView(conversation)); });
  api.delete('/api/conversations/:id/messages-tail/:count', (req, res) => { const conversation = state.conversations.find((item) => item.id === req.params.id); if (!conversation) return res.status(404).json({ error: 'Conversation not found' }); conversation.messages = conversation.messages.slice(0, Math.max(0, conversation.messages.length - Number(req.params.count || 0))); conversation.updated_at = nowIso(); saveState(); res.json(conversationView(conversation)); });
  api.get('/api/conversations/:id/generation-status', (req, res) => {
    const active = isForegroundRunActive(activeRuns.get(req.params.id));
    res.json({ active, status: active ? 'generating' : 'idle', crossProcess: false });
  });
  api.post('/api/conversations/:id/stop-generation', (req, res) => { activeRuns.get(req.params.id)?.stop(); res.json({ ok: true }); });
  api.get('/api/conversations/:id/context-size', (req, res) => { const conversation = state.conversations.find((item) => item.id === req.params.id); const tokens = (conversation?.messages || []).reduce((sum, item) => sum + roughTokens(item.content), 0); res.json({ tokens, limit: 200000 }); });
  api.post('/api/conversations/:id/compact', (_req, res) => res.json({ summary: 'Local desktop backend does not compact yet.', tokensSaved: 0, messagesCompacted: 0 }));
  api.post('/api/conversations/:id/answer', (_req, res) => res.json({ ok: true }));
  api.post('/api/conversations/:id/permissions/:permissionRequestId', async (req, res) => {
    const run = activeRuns.get(req.params.id);
    if (!run) return res.status(404).json({ error: 'No active run for this conversation' });
    if (typeof run.resolvePermission !== 'function') {
      return res.status(409).json({ error: 'Permission broker unavailable' });
    }
    try {
      debugLog(`permission decision api start ${req.params.id}: request=${req.params.permissionRequestId} decision=${req.body?.decision || ''}`);
      await run.resolvePermission({
        permissionRequestId: req.params.permissionRequestId,
        decision: req.body?.decision,
        reason: req.body?.reason,
      });
      debugLog(`permission decision api done ${req.params.id}: request=${req.params.permissionRequestId}`);
      res.json({ ok: true });
    } catch (error) {
      debugLog(`permission decision api failed ${req.params.id}: request=${req.params.permissionRequestId} message=${error?.message || error}`);
      const statusCode = Number(error?.statusCode || 0) || 500;
      res.status(statusCode).json({ error: error?.message || 'Failed to resolve permission request' });
    }
  });
  api.post('/api/conversations/:id/warm', (_req, res) => res.json({ ok: true }));
  api.get('/api/conversations/:id/stream-status', (req, res) => {
    const run = activeRuns.get(req.params.id);
    res.json({
      active: Boolean(run),
      foregroundActive: isForegroundRunActive(run),
      eventCount: run?.buffer.length || 0,
    });
  });
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
    debugLog(`api chat start ${req.body?.conversation_id || ''}: model=${conversation.model || ''}`);
    const provider = resolveProvider(conversation, req.body || {});
    if (!provider) return res.status(400).json({ error: 'No provider configured for this model' });
    const runWorkspace = resolveWorkspacePath(conversation.workspace_path, currentWorkspace, PROJECT_ROOT);
    if (runWorkspace !== (conversation.workspace_path || currentWorkspace)) {
      debugLog(`chat workspace path unavailable ${conversation.id}: requested=${conversation.workspace_path || currentWorkspace} fallback=${runWorkspace}`);
    }
    const runtimeAttachments = resolveRuntimeAttachments(
      req.body?.attachments || [],
      conversation,
      runWorkspace,
    );
    const previousRun = activeRuns.get(conversation.id);
    if (previousRun) {
      debugLog(`api chat interrupt previous run ${conversation.id}: foregroundDone=${previousRun.foregroundDone ? 'true' : 'false'}`);
      previousRun.stop?.({ mode: previousRun.foregroundDone ? 'finish' : 'abort' });
      activeRuns.delete(conversation.id);
    }
    res.setHeader('Content-Type', 'text/event-stream');
    const userMessage = { id: `msg-${randomUUID()}`, role: 'user', content: req.body.message || '', created_at: nowIso(), attachments: req.body.attachments || [] };
    conversation.messages.push(userMessage);
    if ((!conversation.title || conversation.title === 'New Chat') && userMessage.content) conversation.title = userMessage.content.slice(0, 50);
    conversation.updated_at = nowIso();
    saveState();
    const runId = `run-${randomUUID()}`;
    const run = {
      id: runId,
      buffer: [],
      emitter: new EventEmitter(),
      stop: () => {},
      fullText: '',
      foregroundDone: false,
      assistantMessage: null,
      decidePermission: null,
      pendingPermissions: new Map(),
      resolvePermission: null,
      toolCalls: [],
    };
    const write = (payload) => { const line = `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`; run.buffer.push(line); run.emitter.emit('line', line); res.write(line); };
    const clearPendingPermission = (permissionRequestId) => {
      const normalizedRequestId = String(permissionRequestId || '').trim();
      if (!normalizedRequestId) return null;
      const entry = run.pendingPermissions.get(normalizedRequestId);
      if (entry?.timeout) clearTimeout(entry.timeout);
      run.pendingPermissions.delete(normalizedRequestId);
      return entry || null;
    };
    const closePendingPermissions = (decision, reason, decidedBy = 'host') => {
      Array.from(run.pendingPermissions.values()).forEach((entry) => {
        clearPendingPermission(entry.request.permission_request_id);
        write({
          type: 'permission_resolved',
          conversation_id: conversation.id,
          permission_request_id: entry.request.permission_request_id,
          decision: normalizePermissionDecision(decision),
          decided_by: decidedBy,
          reason: String(reason || '').trim(),
          metadata: entry.request.metadata || null,
        });
      });
    };
    const finalizeRun = () => {
      if (activeRuns.get(conversation.id)?.id === runId) activeRuns.delete(conversation.id);
    };
    const schedulePermissionTimeout = (requestPayload) => setTimeout(() => {
      void run.resolvePermission?.({
        permissionRequestId: requestPayload.permission_request_id,
        decision: 'abort',
        reason: 'Desktop permission request timed out.',
        decidedBy: 'host',
      }).catch((error) => {
        debugLog(`permission timeout resolve failed for ${requestPayload.permission_request_id}: ${error?.message || error}`);
      });
    }, Math.max(1000, Number(requestPayload.timeout_ms || 0) || PERMISSION_REQUEST_TIMEOUT_MS));
    activeRuns.set(conversation.id, run);
    const emitVisibleText = (text) => {
      if (!text) return;
      run.fullText += text;
      write({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
    };
    const ensureFinalTextVisible = (fullText) => {
      const text = String(fullText || '').trim();
      if (!text) return '';
      const current = String(run.fullText || '').trim();
      if (!current) {
        run.fullText = text;
        write({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
      } else if (current !== text) {
        write({ type: 'final_text', text });
      }
      return text;
    };
    const onText = emitVisibleText;
    const buildAssistantMessage = (fullText) => ({
      id: `msg-${randomUUID()}`,
      role: 'assistant',
      content: fullText || run.fullText || '[模型未返回文本]',
      created_at: nowIso(),
      attachments: [],
      toolCalls: run.toolCalls || [],
    });
    const persistAssistantMessage = (fullText) => {
      if (run.assistantMessage) {
        run.assistantMessage.content = fullText || run.fullText || run.assistantMessage.content || '[模型未返回文本]';
        run.assistantMessage.toolCalls = run.toolCalls || [];
        conversation.updated_at = nowIso();
        saveState();
        return run.assistantMessage;
      }
      const assistantMessage = buildAssistantMessage(fullText);
      run.assistantMessage = assistantMessage;
      conversation.messages.push(assistantMessage);
      conversation.updated_at = nowIso();
      saveState();
      return assistantMessage;
    };
    const onDone = (fullText) => {
      const finalText = ensureFinalTextVisible(fullText) || fullText || run.fullText || '';
      persistAssistantMessage(finalText);
      conversation.updated_at = nowIso();
      saveState();
      write({ type: 'message_stop', text: finalText || run.fullText || '' });
      write('[DONE]');
      res.end();
      if (activeRuns.get(conversation.id)?.id === runId) activeRuns.delete(conversation.id);
    };
    const onError = (error) => { write({ type: 'error', error: error || 'Request failed' }); write('[DONE]'); res.end(); if (activeRuns.get(conversation.id)?.id === runId) activeRuns.delete(conversation.id); };
    const onStart = (controller) => { run.stop = controller.stop; if (controller.sessionId) conversation.backend_session_id = controller.sessionId; };
    const finishRun = (fullText) => {
      closePendingPermissions('abort', 'Turn finished before permission request was resolved.');
      const finalText = ensureFinalTextVisible(fullText) || fullText || run.fullText || '';
      persistAssistantMessage(finalText);
      conversation.updated_at = nowIso();
      saveState();
      write({ type: 'message_stop', text: finalText || run.fullText || '' });
      write('[DONE]');
      res.end();
      finalizeRun();
    };
    const finishForegroundRun = (fullText) => {
      if (run.foregroundDone) return;
      run.foregroundDone = true;
      const finalText = ensureFinalTextVisible(fullText) || fullText || run.fullText || '';
      persistAssistantMessage(finalText);
      write({
        type: 'foreground_done',
        conversation_id: conversation.id,
        text: finalText || run.fullText || '',
      });
    };
	    const failRun = (error) => {
	      const errorMessage = String(error || 'Request failed');
	      closePendingPermissions('abort', 'Run ended before permission request was resolved.');
	      persistAssistantMessage(`Error: ${errorMessage}`);
	      write({ type: 'error', error: errorMessage });
	      write('[DONE]');
	      res.end();
	      finalizeRun();
	    };
    run.resolvePermission = async ({ permissionRequestId, decision, reason = '', decidedBy = 'host' }) => {
      const normalizedRequestId = String(permissionRequestId || '').trim();
      if (!normalizedRequestId) {
        const error = new Error('Permission request id is required');
        error.statusCode = 400;
        throw error;
      }
      if (typeof run.decidePermission !== 'function') {
        const error = new Error('Permission broker unavailable');
        error.statusCode = 409;
        throw error;
      }
      const entry = run.pendingPermissions.get(normalizedRequestId) || null;
      if (entry?.timeout) {
        clearTimeout(entry.timeout);
      } else {
        debugLog(`resolvePermission proceeding without local pending entry ${conversation.id}: request=${normalizedRequestId}`);
      }
      debugLog(`resolvePermission start ${conversation.id}: request=${normalizedRequestId} decision=${decision}`);
      void Promise.resolve(run.decidePermission({
        permissionRequestId: normalizedRequestId,
        decision: normalizePermissionDecision(decision),
        reason,
        decidedBy: normalizePermissionDecisionSource(decidedBy),
      })).then(() => {
        debugLog(`resolvePermission done ${conversation.id}: request=${normalizedRequestId}`);
      }).catch((error) => {
        if (entry) {
          entry.timeout = schedulePermissionTimeout(entry.request);
        }
        if (isKernelRuntimeTransportError(error)) {
          void resetKernelRuntime('desktop_permission_resolution_failed');
        }
        debugLog(`resolvePermission failed ${conversation.id}: request=${normalizedRequestId} message=${error?.message || error}`);
      });
    };
    const startRun = (controller) => {
      run.stop = controller.stop;
      run.decidePermission = controller.decidePermission || null;
      if (controller.sessionId) conversation.backend_session_id = controller.sessionId;
    };
    const forwardPermissionRequest = (payload) => {
      if (!payload?.permission_request_id) return;
      clearPendingPermission(payload.permission_request_id);
      run.pendingPermissions.set(payload.permission_request_id, {
        request: payload,
        timeout: schedulePermissionTimeout(payload),
      });
      write({ type: 'permission_request', conversation_id: conversation.id, ...payload });
    };
    const forwardPermissionResolved = (payload) => {
      if (!payload?.permission_request_id) return;
      clearPendingPermission(payload.permission_request_id);
      write({ type: 'permission_resolved', conversation_id: conversation.id, ...payload });
    };
    const forwardToolUse = (payload) => {
      if (!payload?.type || !String(payload.type).startsWith('tool_use_')) return;
      recordPersistedToolPayload(run.toolCalls, payload);
      write({ conversation_id: conversation.id, ...payload });
    };
    const forwardSystemEvent = (payload) => {
      if (!payload?.type) return;
      if (payload.type === 'task_event') {
        recordPersistedTaskEvent(run.toolCalls, payload);
      }
      write({ conversation_id: conversation.id, ...payload });
    };
    runViaKernel({
      conversation,
      provider,
      prompt: req.body.message || '',
      attachments: runtimeAttachments,
      workspacePath: runWorkspace,
      onText,
      onDone: finishRun,
      onError: failRun,
      onStart: startRun,
      onPermissionRequest: forwardPermissionRequest,
      onPermissionResolved: forwardPermissionResolved,
      onToolUse: forwardToolUse,
      onSystemEvent: forwardSystemEvent,
      onForegroundDone: finishForegroundRun,
    });
    req.on('aborted', () => {
      if (!res.writableEnded) run.stop();
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
  statePath = path.join(app.getPath('userData'), 'hare-state.json');
  uploadsDir = path.join(app.getPath('userData'), 'uploads');
  customSkillsDir = CLAUDE_USER_SKILLS_ROOT;
  state = loadState();
  syncChatModelsFromProviders();
  apiBase = await startApiServer();
  state.apiBase = apiBase;
  saveState();
  debugLog(`state saved with apiBase ${apiBase}`);
  process.env.HARE_API_BASE = apiBase;
  createWindow();
  debugLog('window created');
});

app.on('before-quit', () => {
  void resetKernelRuntime('desktop_app_quit');
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
