import React, { useState, useEffect, useRef, useCallback } from 'react';
import { HashRouter, Routes, Route, Navigate, useLocation, useParams, useNavigate } from 'react-router-dom';
import { FileText, ChevronDown, Trash, Pencil, Star, Menu, Folder, ArrowLeft, ArrowRight } from 'lucide-react';
import Sidebar from './components/Sidebar';
import MainContent from './components/MainContent';
import { IconSidebarToggle } from './components/Icons';
import { buildApiUrl, updateConversation, deleteConversation, exportConversation, getConversation } from './api';
import Onboarding from './components/Onboarding';
import SettingsPage from './components/SettingsPage';
import DocumentPanel from './components/DocumentPanel';
import ArtifactsPanel from './components/ArtifactsPanel';
import ArtifactsPage from './components/ArtifactsPage';
import DraggableDivider from './components/DraggableDivider';
import { DocumentInfo } from './components/DocumentCard';
import ChatsPage from './components/ChatsPage';
import CustomizePage from './components/CustomizePage';
import ProjectsPage from './components/ProjectsPage';

const Tooltip = ({ children, text, shortcut }: { children: React.ReactNode; text: string; shortcut?: string }) => {
  const [show, setShow] = useState(false);
  return (
    <div className="relative" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1.5 z-[200] pointer-events-none">
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium whitespace-nowrap bg-[#2a2a2a] text-white dark:bg-[#e8e8e8] dark:text-[#1a1a1a] shadow-lg">
            <span>{text}</span>
            {shortcut && <span className="opacity-60 text-[11px]">{shortcut}</span>}
          </div>
        </div>
      )}
    </div>
  );
};

type TopModeKey = 'chat' | 'cowork' | 'code';

const TOP_MODE_CONFIG: Array<{ key: TopModeKey; label: string; shortcut: string }> = [
  { key: 'chat', label: 'Chat', shortcut: 'Ctrl+1' },
  { key: 'cowork', label: 'Cowork', shortcut: 'Ctrl+2' },
  { key: 'code', label: 'Code', shortcut: 'Ctrl+3' },
];

const COWORK_WORKSPACES_STORAGE_KEY = 'cowork_workspace_paths';
const ACTIVE_COWORK_WORKSPACE_STORAGE_KEY = 'active_cowork_workspace_path';

function readCoworkWorkspacePaths(): string[] {
  try {
    const raw = localStorage.getItem(COWORK_WORKSPACES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeCoworkWorkspacePaths(paths: string[]) {
  localStorage.setItem(COWORK_WORKSPACES_STORAGE_KEY, JSON.stringify(Array.from(new Set(paths.filter(Boolean)))));
}

function readActiveCoworkWorkspacePath(): string {
  return String(localStorage.getItem(ACTIVE_COWORK_WORKSPACE_STORAGE_KEY) || '').trim();
}

function writeActiveCoworkWorkspacePath(path: string) {
  if (path) {
    localStorage.setItem(ACTIVE_COWORK_WORKSPACE_STORAGE_KEY, path);
  } else {
    localStorage.removeItem(ACTIVE_COWORK_WORKSPACE_STORAGE_KEY);
  }
}

function readDefaultWorkspacePath(): string {
  return String(localStorage.getItem('workspace_path') || '').trim();
}

const ChatHeader = ({
  title,
  showArtifacts,
  documentPanelDoc,
  onOpenArtifacts,
  hasArtifacts,
  onTitleRename
}: {
  title: string;
  showArtifacts: boolean;
  documentPanelDoc: any;
  onOpenArtifacts: () => void;
  hasArtifacts: boolean;
  onTitleRename?: (newTitle: string) => void;
}) => {
  const { id } = useParams();
  const navigate = useNavigate();
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [showMenu, setShowMenu] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(event.target as Node)) {
        setShowMenu(false);
      }
    };
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMenu]);

  const startEditing = () => {
    setEditTitle(title || 'New Chat');
    setIsEditing(true);
    setShowMenu(false);
  };

  const handleDelete = async () => {
    if (!id) return;
    try {
      await deleteConversation(id);
      navigate('/');
      // Trigger sidebar refresh
      window.dispatchEvent(new CustomEvent('conversationTitleUpdated'));
    } catch (err) {
      console.error('Failed to delete chat:', err);
    }
    setShowMenu(false);
  };

  const handleRenameSubmit = async () => {
    if (!id || !editTitle.trim()) {
      setIsEditing(false);
      return;
    }

    try {
      await updateConversation(id, { title: editTitle });
      onTitleRename?.(editTitle);
      window.dispatchEvent(new CustomEvent('conversationTitleUpdated'));
    } catch (err) {
      console.error('Failed to rename chat:', err);
    } finally {
      setIsEditing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
    }
  };

  return (
    <div
      className="relative flex items-center justify-between px-3 py-2 bg-claude-bg flex-shrink-0 h-[44px] border-b border-claude-border z-40"
    >
      {isEditing ? (
        <input
          type="text"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onBlur={handleRenameSubmit}
          onKeyDown={handleKeyDown}
          autoFocus
          className="max-w-[60%] px-2 py-1 text-[14px] font-medium text-claude-text bg-claude-input border border-blue-500 rounded-md outline-none shadow-sm"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        />
      ) : (
        <div className="relative flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button
            onClick={startEditing}
            className="flex items-center px-2 py-1.5 hover:bg-claude-btn-hover rounded-md transition-colors text-[14px] font-medium text-claude-text max-w-[200px] truncate group"
          >
            {title || 'New Chat'}
          </button>

          <button
            ref={buttonRef}
            onClick={() => setShowMenu(!showMenu)}
            className={`p-1 hover:bg-claude-btn-hover rounded-md transition-colors text-claude-textSecondary hover:text-claude-text ${showMenu ? 'bg-claude-btn-hover text-claude-text' : ''}`}
          >
            <ChevronDown size={14} />
          </button>

          {showMenu && (
            <div
              ref={menuRef}
              className="absolute top-full left-0 mt-1 z-50 bg-claude-input border border-claude-border rounded-xl shadow-[0_4px_12px_rgba(0,0,0,0.08)] py-1.5 flex flex-col w-[200px]"
            >
              <button className="flex items-center gap-3 px-3 py-2 hover:bg-claude-hover text-left w-full transition-colors group">
                <Star size={16} className="text-claude-textSecondary group-hover:text-claude-text" />
                <span className="text-[13px] text-claude-text">Star</span>
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  startEditing();
                }}
                className="flex items-center gap-3 px-3 py-2 hover:bg-claude-hover text-left w-full transition-colors group"
              >
                <Pencil size={16} className="text-claude-textSecondary group-hover:text-claude-text" />
                <span className="text-[13px] text-claude-text">Rename</span>
              </button>
              <div className="h-[1px] bg-claude-border my-1 mx-3" />
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete();
                }}
                className="flex items-center gap-3 px-3 py-2 hover:bg-claude-hover text-left w-full transition-colors group"
              >
                <Trash size={16} className="text-[#B9382C]" />
                <span className="text-[13px] text-[#B9382C]">Delete</span>
              </button>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-1">
        {hasArtifacts && (
          <button
            onClick={onOpenArtifacts}
            className={`w-8 h-8 flex items-center justify-center text-claude-textSecondary hover:bg-claude-btn-hover rounded-md transition-colors ${showArtifacts ? 'bg-claude-btn-hover text-claude-text' : ''}`}
            title="View Artifacts"
          >
            <FileText size={18} strokeWidth={1.5} />
          </button>
        )}
        <button
          className="px-2 h-8 flex items-center justify-center text-claude-textSecondary hover:text-claude-text transition-colors"
          title="Open Workspace Folder"
          onClick={async () => {
            if (!id) return;
            try {
              const data = await getConversation(id);
              if (data.workspace_path && (window as any).electronAPI?.openFolder) {
                (window as any).electronAPI.openFolder(data.workspace_path);
              }
            } catch (e) { console.error('Open folder failed:', e); }
          }}
        >
          <Folder size={17} strokeWidth={1.5} />
        </button>
        <button
          onClick={async () => {
            if (!id || isExporting) return;
            setIsExporting(true);
            try {
              await exportConversation(id);
            } catch (err) {
              console.error('导出失败', err);
              window.alert(err instanceof Error ? err.message : '导出失败');
            } finally {
              setIsExporting(false);
            }
          }}
          disabled={isExporting}
          className="px-3 py-1.5 text-[13px] font-medium text-claude-textSecondary hover:bg-claude-btn-hover rounded-md transition-colors border border-transparent hover:border-claude-border disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isExporting ? '导出中…' : 'Export'}
        </button>
      </div>
      <div className="absolute top-full left-0 right-0 h-6 bg-gradient-to-b from-claude-bg to-transparent pointer-events-none z-30" />
    </div>
  );
};

const Layout = () => {
  const { id: routeConversationId } = useParams();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [newChatKey, setNewChatKey] = useState(0);
  const [authChecked, setAuthChecked] = useState(true);
  const [authValid, setAuthValid] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [showUpgrade] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  // Document panel state
  const [documentPanelDoc, setDocumentPanelDoc] = useState<DocumentInfo | null>(null);
  const [showArtifacts, setShowArtifacts] = useState(false);
  const [artifacts, setArtifacts] = useState<DocumentInfo[]>([]);
  const [documentPanelWidth, setDocumentPanelWidth] = useState(50); // percent of remaining space (1:1 default)
  const [isChatMode, setIsChatMode] = useState(false);
  const [currentChatTitle, setCurrentChatTitle] = useState('');
  const sidebarWasCollapsedRef = useRef(false);
  const contentContainerRef = useRef<HTMLDivElement>(null);

  // Detect macOS for traffic light padding
  const [isMac, setIsMac] = useState(false);
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (api?.getPlatform) {
      api.getPlatform().then((p: string) => setIsMac(p === 'darwin'));
    }
  }, []);

  // Title bar height adjusts inversely to zoom so it stays visually constant
  const [titleBarHeight, setTitleBarHeight] = useState(44);
  useEffect(() => {
    const api = (window as any).electronAPI;
    if (api?.onZoomChanged) {
      api.onZoomChanged((factor: number) => {
        setTitleBarHeight(Math.round(44 / factor));
      });
    }
  }, []);

  useEffect(() => {
    if (!localStorage.getItem('user_mode')) {
      localStorage.setItem('user_mode', 'selfhosted');
    }
  }, []);

  const [coworkWorkspacePaths, setCoworkWorkspacePaths] = useState<string[]>(() => readCoworkWorkspacePaths());
  const [activeCoworkWorkspacePath, setActiveCoworkWorkspacePath] = useState<string>(() => readActiveCoworkWorkspacePath() || readDefaultWorkspacePath());

  const location = useLocation();
  const navigate = useNavigate();

  const getActiveTopMode = useCallback((pathname: string): TopModeKey => {
    if (pathname === '/cowork' || pathname.startsWith('/cowork/')) {
      return 'cowork';
    }
    return 'chat';
  }, []);

  const activeTopMode = getActiveTopMode(location.pathname);

  useEffect(() => {
    writeCoworkWorkspacePaths(coworkWorkspacePaths);
  }, [coworkWorkspacePaths]);

  useEffect(() => {
    writeActiveCoworkWorkspacePath(activeCoworkWorkspacePath);
  }, [activeCoworkWorkspacePath]);

  useEffect(() => {
    if (activeCoworkWorkspacePath) {
      return;
    }
    if (coworkWorkspacePaths.length > 0) {
      setActiveCoworkWorkspacePath(coworkWorkspacePaths[0]);
    }
  }, [activeCoworkWorkspacePath, coworkWorkspacePaths]);

  const rememberCoworkWorkspace = useCallback((path: string) => {
    const normalized = String(path || '').trim();
    if (!normalized) return;
    setCoworkWorkspacePaths((prev) => {
      const next = prev.filter((item) => item !== normalized);
      return [normalized, ...next];
    });
    setActiveCoworkWorkspacePath(normalized);
  }, []);

  useEffect(() => {
    if (activeCoworkWorkspacePath || coworkWorkspacePaths.length > 0) {
      return;
    }
    const localWorkspace = readDefaultWorkspacePath();
    if (localWorkspace) {
      rememberCoworkWorkspace(localWorkspace);
      return;
    }
    let cancelled = false;
    fetch(buildApiUrl('/workspace-config'))
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const dir = String(data?.defaultDir || '').trim();
        if (dir) {
          rememberCoworkWorkspace(dir);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeCoworkWorkspacePath, coworkWorkspacePaths, rememberCoworkWorkspace]);

  const promptForCoworkWorkspace = useCallback(async () => {
    const api = (window as any).electronAPI;
    if (!api?.selectDirectory) {
      return '';
    }
    const dir = String((await api.selectDirectory()) || '').trim();
    if (!dir) return '';
    rememberCoworkWorkspace(dir);
    return dir;
  }, [rememberCoworkWorkspace]);

  const handleTopModeChange = useCallback(async (mode: TopModeKey) => {
    if (mode === 'code') {
      return;
    }
    if (mode === 'cowork') {
      let workspacePath = activeCoworkWorkspacePath.trim();
      if (!workspacePath) {
        workspacePath = readDefaultWorkspacePath();
      }
      if (workspacePath) {
        rememberCoworkWorkspace(workspacePath);
      }
      if (routeConversationId && workspacePath) {
        try {
          await updateConversation(routeConversationId, { workspace_path: workspacePath });
        } catch (err) {
          console.error('Failed to attach conversation to cowork workspace:', err);
        }
        navigate(`/cowork/${routeConversationId}`);
      } else if (location.pathname !== '/cowork') {
        navigate('/cowork');
      }
      return;
    }
    if (routeConversationId) {
      navigate(`/chat/${routeConversationId}`);
    } else if (location.pathname !== '/') {
      navigate('/');
    }
  }, [activeCoworkWorkspacePath, location.pathname, navigate, rememberCoworkWorkspace, routeConversationId]);

  // Navigation history for back/forward buttons
  const [navHistory, setNavHistory] = useState<string[]>([location.pathname + location.search + location.hash]);
  const [navIndex, setNavIndex] = useState(0);
  const isNavAction = useRef(false);

  useEffect(() => {
    const fullPath = location.pathname + location.search;
    if (isNavAction.current) {
      isNavAction.current = false;
      return;
    }
    setNavHistory(prev => {
      const trimmed = prev.slice(0, navIndex + 1);
      if (trimmed[trimmed.length - 1] === fullPath) return trimmed;
      return [...trimmed, fullPath];
    });
    setNavIndex(prev => {
      const trimmed = navHistory.slice(0, prev + 1);
      if (trimmed[trimmed.length - 1] === fullPath) return prev;
      return trimmed.length;
    });
  }, [location.pathname, location.search]);

  const canGoBack = navIndex > 0;
  const canGoForward = navIndex < navHistory.length - 1;

  const handleNavBack = () => {
    if (!canGoBack) return;
    isNavAction.current = true;
    const newIndex = navIndex - 1;
    setNavIndex(newIndex);
    navigate(navHistory[newIndex]);
  };

  const handleNavForward = () => {
    if (!canGoForward) return;
    isNavAction.current = true;
    const newIndex = navIndex + 1;
    setNavIndex(newIndex);
    navigate(navHistory[newIndex]);
  };

  useEffect(() => {
    setShowSettings(false);
    setDocumentPanelDoc(null);
    setShowArtifacts(false);
  }, [location.pathname]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
        return;
      }
      if (event.target instanceof HTMLElement) {
        const tag = event.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target.isContentEditable) {
          return;
        }
      }

      if (event.key === '1') {
        event.preventDefault();
        void handleTopModeChange('chat');
      } else if (event.key === '2') {
        event.preventDefault();
        void handleTopModeChange('cowork');
      } else if (event.key === '3') {
        event.preventDefault();
        void handleTopModeChange('code');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleTopModeChange]);

  // Collapse sidebar on Customize page (Removed per user request)
  useEffect(() => {
    // Intentionally empty: do not collapse left sidebar automatically
  }, [location.pathname]);

  const isElectron = !!(window as any).electronAPI?.isElectron;
  // Electron users can always enter the main UI regardless of auth state. The
  // clawparrot login gate is now deferred to the first send attempt (see
  // MainContent.tsx handleSend) — users can explore the app freely and only
  // get prompted to login when they actually try to use a model.
  useEffect(() => {
    if (isElectron) setAuthValid(true);
  }, [isElectron]);

  const refreshSidebar = () => {
    setRefreshTrigger(prev => prev + 1);
  };

  const handleNewChat = () => {
    setNewChatKey(prev => prev + 1);
    setRefreshTrigger(prev => prev + 1);
    setShowSettings(false);
    setDocumentPanelDoc(null);
    setShowArtifacts(false);
  };

  const handleOpenDocument = useCallback((doc: DocumentInfo) => {
    if (!documentPanelDoc && !showArtifacts) {
      sidebarWasCollapsedRef.current = isSidebarCollapsed;
    }
    setShowArtifacts(false);
    setIsSidebarCollapsed(true);
    setDocumentPanelDoc(doc);
  }, [isSidebarCollapsed, documentPanelDoc, showArtifacts]);

  const handleCloseDocument = useCallback(() => {
    setDocumentPanelDoc(null);
    if (!showArtifacts) {
      setIsSidebarCollapsed(sidebarWasCollapsedRef.current);
    }
  }, [showArtifacts]);

  const handleArtifactsUpdate = useCallback((docs: DocumentInfo[]) => {
    setArtifacts(docs);
  }, []);

  const handleOpenArtifacts = useCallback(() => {
    if (showArtifacts) {
      setShowArtifacts(false);
      // Restore sidebar state if it was collapsed by us?
      // For now, simple toggle close.
      if (!documentPanelDoc) {
        setIsSidebarCollapsed(sidebarWasCollapsedRef.current);
      }
      return;
    }

    if (!documentPanelDoc) {
      sidebarWasCollapsedRef.current = isSidebarCollapsed;
    }
    setIsSidebarCollapsed(true);
    setShowArtifacts(true);
    setDocumentPanelDoc(null);
  }, [isSidebarCollapsed, documentPanelDoc, showArtifacts]);

  const handleCloseArtifacts = useCallback(() => {
    setShowArtifacts(false);
    setIsSidebarCollapsed(sidebarWasCollapsedRef.current);
  }, []);

  const handleChatModeChange = useCallback((isChat: boolean) => {
    setIsChatMode(isChat);
  }, []);

  const handleTitleChange = useCallback((title: string) => {
    setCurrentChatTitle(title);
  }, []);

  // Layout Tuner State
  const [tunerConfig, setTunerConfig] = useState({
    sidebarWidth: 288, // tuned value
    recentsMt: 24,
    profilePy: 10,
    profilePx: 12,
    mainContentWidth: 773, // tuned value
    mainContentMt: -100,
    inputRadius: 24,
    welcomeSize: 46,
    welcomeMb: 34,

    recentsFontSize: 14,
    recentsItemPy: 7,
    recentsPl: 6,
    userAvatarSize: 36,
    userNameSize: 15,
    headerPy: 0,

    // Toggle Button (Independent Position)
    toggleSize: 28,
    toggleAbsRight: 10,
    toggleAbsTop: 11,
    toggleAbsLeft: 8, // Collapsed State Left Position
  });

  // Onboarding: show on first launch
  if (showOnboarding) {
    return <Onboarding onComplete={() => {
      setShowOnboarding(false);
      // Both modes enter the main UI directly — clawparrot users will be
      // prompted to login on first send, not forced into a login page.
      if (isElectron) setAuthValid(true);
    }} />;
  }

  // Guard: check if logged in
  if (!authChecked) {
    return null; // 验证中，不渲染
  }
  if (!authValid) {
    return <Navigate to="/" replace />;
  }

  return (
    <>
      <div className="relative flex w-full h-screen overflow-hidden bg-claude-bg font-sans antialiased">
        {/* Custom Solid Title Bar (Unified Full Width) */}
        <div
          className="absolute top-0 left-0 w-full z-50 flex items-center select-none pointer-events-none bg-claude-bg border-b border-claude-border transition-all duration-300"
          style={{ WebkitAppRegion: 'drag', height: `${titleBarHeight}px` } as React.CSSProperties}
        >
          {/* Left Controls inside Title Bar — extra padding on Mac for traffic lights */}
          <div
            className="h-full flex items-center pr-2 gap-0.5"
            style={{ pointerEvents: 'auto', WebkitAppRegion: 'no-drag', paddingLeft: isMac ? '78px' : '4px' } as React.CSSProperties}
          >
            <Tooltip text="Menu">
              <button
                onClick={() => { }}
                className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-claude-textSecondary hover:text-claude-text transition-colors"
              >
                <Menu size={18} className="opacity-80" />
              </button>
            </Tooltip>
            <Tooltip text={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}>
              <button
                onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
                className="p-1.5 hover:bg-black/5 dark:hover:bg-white/5 rounded-md text-claude-textSecondary hover:text-claude-text transition-colors"
              >
                <IconSidebarToggle size={26} className="dark:invert transition-[filter] duration-200" />
              </button>
            </Tooltip>
            {canGoBack ? (
              <Tooltip text="Back">
                <button
                  onClick={handleNavBack}
                  className="p-1.5 rounded-md transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                  style={{ color: '#73726C' }}
                >
                  <ArrowLeft size={16} strokeWidth={1.5} />
                </button>
              </Tooltip>
            ) : (
              <span className="p-1.5" style={{ color: '#B7B5B0' }}>
                <ArrowLeft size={16} strokeWidth={1.5} />
              </span>
            )}
            {canGoForward ? (
              <Tooltip text="Forward">
                <button
                  onClick={handleNavForward}
                  className="p-1.5 rounded-md transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                  style={{ color: '#73726C' }}
                >
                  <ArrowRight size={16} strokeWidth={1.5} />
                </button>
              </Tooltip>
            ) : (
              <span className="p-1.5" style={{ color: '#B7B5B0' }}>
                <ArrowRight size={16} strokeWidth={1.5} />
              </span>
            )}
          </div>

          {/* Center Mode Tabs */}
          <div
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center rounded-xl p-0.5"
            style={{ pointerEvents: 'auto', WebkitAppRegion: 'no-drag', backgroundColor: 'var(--bg-mode-tabs)' } as React.CSSProperties}
          >
            {TOP_MODE_CONFIG.map((item) => {
              const isActive = activeTopMode === item.key;
              return (
                <Tooltip key={item.key} text={item.label} shortcut={item.shortcut}>
                  <button
                    onClick={() => { void handleTopModeChange(item.key); }}
                    className={`px-3.5 py-1 text-[13px] font-medium rounded-[10px] transition-colors ${isActive ? 'text-claude-text shadow-sm' : 'text-claude-textSecondary hover:text-claude-text'}`}
                    style={{
                      backgroundColor: isActive ? 'var(--bg-mode-tab-active)' : 'transparent',
                      fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
                      letterSpacing: '0.01em'
                    }}
                  >
                    {item.label}
                  </button>
                </Tooltip>
              );
            })}
          </div>
        </div>

        <Sidebar
          mode={activeTopMode}
          isCollapsed={isSidebarCollapsed}
          toggleSidebar={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
          refreshTrigger={refreshTrigger}
          onNewChatClick={handleNewChat}
          onOpenSettings={() => { setShowSettings(true); }}
          onOpenUpgrade={() => {}}
          onCloseOverlays={() => { setShowSettings(false); }}
          coworkWorkspacePaths={coworkWorkspacePaths}
          activeCoworkWorkspacePath={activeCoworkWorkspacePath}
          onCoworkSelectWorkspace={rememberCoworkWorkspace}
          onCoworkAddWorkspace={() => { void promptForCoworkWorkspace(); }}
          tunerConfig={tunerConfig}
          setTunerConfig={setTunerConfig}
        />

        {/* Unified Content Wrapper - takes remaining space after sidebar */}
        <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden relative" style={{ paddingTop: `${titleBarHeight}px` }}>
          {/* Header - moved to allow conditional placement (Full Width Mode) */}
          {isChatMode && (showArtifacts && !documentPanelDoc) && !showSettings && !showUpgrade && (
            <ChatHeader
              title={currentChatTitle}
              showArtifacts={showArtifacts}
              documentPanelDoc={documentPanelDoc}
              onOpenArtifacts={handleOpenArtifacts}
              hasArtifacts={artifacts.length > 0}
              onTitleRename={handleTitleChange}
            />
          )}

          <div className="flex-1 flex overflow-hidden relative" ref={contentContainerRef}>

            {/* Main Content Area - takes remaining width after panel */}
            <div className="flex-1 flex flex-col h-full min-w-0">
              {/* Header - Only render here if NOT in Artifacts-only mode */}
              {isChatMode && (!showArtifacts || documentPanelDoc) && !showSettings && !showUpgrade && location.pathname !== '/chats' && location.pathname !== '/customize' && location.pathname !== '/projects' && location.pathname !== '/artifacts' && location.pathname !== '/cowork' && (
                <ChatHeader
                  title={currentChatTitle}
                  showArtifacts={showArtifacts}
                  documentPanelDoc={documentPanelDoc}
                  onOpenArtifacts={handleOpenArtifacts}
                  hasArtifacts={artifacts.length > 0}
                  onTitleRename={handleTitleChange}
                />
              )}

              {showSettings ? (
                <SettingsPage onClose={() => setShowSettings(false)} />
              ) : location.pathname === '/chats' ? (
                <ChatsPage />
              ) : location.pathname === '/customize' ? (
                <CustomizePage onCreateWithClaude={() => {
                  sessionStorage.setItem('prefill_input', '让我们一起使用你的 skill-creator skill 来创建一个 skill 吧。请先问我这个 skill 应该做什么。');
                  handleNewChat();
                  window.location.hash = '#/';
                }} />
              ) : location.pathname === '/projects' ? (
                <ProjectsPage />
              ) : location.pathname === '/artifacts' ? (
                <ArtifactsPage onTryPrompt={(prompt) => {
                  if (prompt === '__remix__') {
                    // Remix mode: artifact data already in sessionStorage
                    sessionStorage.setItem('artifact_prompt', '__remix__');
                  } else {
                    sessionStorage.setItem('artifact_prompt', prompt);
                  }
                  handleNewChat();
                  window.location.hash = '#/';
                }} />
              ) : (
                <MainContent
                  currentMode={activeTopMode}
                  coworkWorkspacePath={activeCoworkWorkspacePath}
                  onNewChat={refreshSidebar}
                  resetKey={newChatKey}
                  tunerConfig={tunerConfig}
                  onOpenDocument={handleOpenDocument}
                  onArtifactsUpdate={handleArtifactsUpdate}
                  onOpenArtifacts={handleOpenArtifacts}
                  onTitleChange={handleTitleChange}
                  onChatModeChange={handleChatModeChange}
                />
              )}
            </div>

            {/* Animated Document Panel Container */}
            <div
              className={`h-full bg-claude-bg transition-all duration-300 ease-out flex z-20 relative ${(documentPanelDoc || showArtifacts) ? 'border-l border-claude-border' : ''}`}
              style={{
                width: documentPanelDoc ? `${documentPanelWidth}%` : showArtifacts ? '360px' : '0px',
                opacity: (documentPanelDoc || showArtifacts) ? 1 : 0,
                overflow: 'hidden'
              }}
            >
              {documentPanelDoc && (
                <div className="absolute left-0 top-0 bottom-0 h-full z-50">
                  <DraggableDivider onResize={setDocumentPanelWidth} containerRef={contentContainerRef} />
                </div>
              )}
              <div className={`w-full h-full flex relative min-w-0 overflow-hidden`}>
                {(documentPanelDoc || showArtifacts) && (
                  <>
                    {documentPanelDoc ? (
                      <DocumentPanel document={documentPanelDoc} onClose={handleCloseDocument} />
                    ) : (
                      <ArtifactsPanel
                        documents={artifacts}
                        onClose={handleCloseArtifacts}
                        onOpenDocument={handleOpenDocument}
                      />
                    )}
                  </>
                )}
              </div>
            </div>

          </div>
        </div>
      </div>
    </>
  );
};

const App = () => {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Layout />} />
        <Route path="/chats" element={<Layout />} />
        <Route path="/customize" element={<Layout />} />
        <Route path="/projects" element={<Layout />} />
        <Route path="/artifacts" element={<Layout />} />
        <Route path="/chat/:id" element={<Layout />} />
        <Route path="/cowork" element={<Layout />} />
        <Route path="/cowork/:id" element={<Layout />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </HashRouter>
  );
};

export default App;
