const { contextBridge, ipcRenderer } = require('electron');

const KERNEL_CHAT_EVENT_CHANNEL = 'kernel-chat:event';

// Expose safe APIs to the renderer process 
contextBridge.exposeInMainWorld('electronAPI', {
    apiBase: process.env.HARE_API_BASE || '',
    // Zoom change listener
    onZoomChanged: (callback) => ipcRenderer.on('zoom-changed', (_, factor) => callback(factor)),
    // Platform info
    getPlatform: () => ipcRenderer.invoke('get-platform'),
    getAppPath: () => ipcRenderer.invoke('get-app-path'),

    // File system
    selectDirectory: () => ipcRenderer.invoke('select-directory'),

    // Check if running in Electron
    isElectron: true,

    // Core Functions
    exportWorkspace: (workspaceId, contextMarkdown, defaultFilename) => ipcRenderer.invoke('export-workspace', workspaceId, contextMarkdown, defaultFilename),

    // File explorer: open folder containing a file, or open a folder directly
    showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),
    openFolder: (folderPath) => ipcRenderer.invoke('open-folder', folderPath),

    // Window resize
    resizeWindow: (width, height) => ipcRenderer.invoke('resize-window', width, height),

    // Open external URL in system browser (for OAuth flows etc.)
    openExternal: (url) => ipcRenderer.invoke('open-external', url),

    // Auto-update events
    onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_, status) => callback(status)),
    installUpdate: () => ipcRenderer.invoke('install-update'),

    // Kernel chat runtime: renderer <-> main via IPC, main <-> worker via kernel stdio.
    kernelChat: {
        start: (payload) => ipcRenderer.invoke('kernel-chat:start', payload),
        status: (conversationId) => ipcRenderer.invoke('kernel-chat:status', conversationId),
        stop: (conversationId, options) => ipcRenderer.invoke('kernel-chat:stop', conversationId, options),
        replay: (conversationId, runId) => ipcRenderer.invoke('kernel-chat:replay', conversationId, runId),
        decidePermission: (conversationId, permissionRequestId, payload) => ipcRenderer.invoke('kernel-chat:permission', conversationId, permissionRequestId, payload),
        answer: (conversationId, payload) => ipcRenderer.invoke('kernel-chat:answer', conversationId, payload),
        onEvent: (filter, callback) => {
            const normalizedFilter = typeof filter === 'string'
                ? { runId: filter }
                : (filter || {});
            const handler = (_event, message) => {
                if (normalizedFilter.runId && message?.runId !== normalizedFilter.runId) return;
                if (normalizedFilter.conversationId && message?.conversationId !== normalizedFilter.conversationId) return;
                callback(message);
            };
            ipcRenderer.on(KERNEL_CHAT_EVENT_CHANNEL, handler);
            return () => ipcRenderer.removeListener(KERNEL_CHAT_EVENT_CHANNEL, handler);
        },
    },
});
