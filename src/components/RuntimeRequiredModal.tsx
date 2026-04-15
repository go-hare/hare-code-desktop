import React, { useMemo, useState } from 'react';
import { getSystemStatus, installHareCode, SystemStatus } from '../api';

interface Props {
  initialStatus: SystemStatus;
  onResolved: (status: SystemStatus) => void;
}

const BUN_DOWNLOAD_URL = 'https://bun.sh/';
const HARE_CODE_REPO_URL = 'https://github.com/go-hare/hare-code';
const HARE_CODE_RELEASES_URL = `${HARE_CODE_REPO_URL}/releases`;

const RuntimeRequiredModal: React.FC<Props> = ({ initialStatus, onResolved }) => {
  const [status, setStatus] = useState<SystemStatus>(initialStatus);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missing = useMemo(() => ({
    bun: status.bun.required && !status.bun.found,
    hareCode: status.hareCode.required && !status.hareCode.found,
  }), [status]);

  const api = (window as any).electronAPI;

  const openExternal = (url: string) => {
    if (api?.openExternal) {
      api.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  };

  const refreshStatus = async () => {
    const next = await getSystemStatus();
    setStatus(next);
    if ((!next.hareCode.required || next.hareCode.found) && (!next.bun.required || next.bun.found)) {
      onResolved(next);
    }
    return next;
  };

  const recheck = async () => {
    setChecking(true);
    setError(null);
    try {
      const next = await refreshStatus();
      if ((next.bun.required && !next.bun.found) || (next.hareCode.required && !next.hareCode.found)) {
        setError('仍有运行时依赖未就绪。请完成安装后再试。');
      }
    } catch (err: any) {
      setError(err?.message || '检测失败');
    } finally {
      setChecking(false);
    }
  };

  const handleInstallHareCode = async () => {
    setInstalling(true);
    setError(null);
    try {
      await installHareCode();
      await refreshStatus();
    } catch (err: any) {
      setError(err?.message || '下载 hare-code 二进制失败');
    } finally {
      setInstalling(false);
    }
  };

  const title = missing.bun ? '需要安装 Bun' : '需要安装 hare-code';

  const description = missing.bun
    ? '当前检测到的 hare-code 是基于 Bun 的包装命令。请先安装 Bun，或改用 release 二进制。'
    : '未检测到本机 hare-code。桌面端会直接下载当前平台对应的 release 二进制。';

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="max-w-md w-full mx-4 rounded-2xl bg-claude-bg border border-claude-border shadow-2xl p-7">
        <div className="flex items-start gap-3 mb-4">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-amber-600 dark:text-amber-400">
              <path d="M12 9v4" />
              <path d="M12 17h.01" />
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
            </svg>
          </div>
          <div className="flex-1">
            <h2 className="text-[17px] font-semibold text-claude-text">{title}</h2>
            <p className="text-[13px] text-claude-textSecondary mt-1">{description}</p>
          </div>
        </div>

        <div className="rounded-lg bg-claude-hover/50 p-3.5 mb-4 space-y-1.5">
          <p className="text-[12.5px] text-claude-text leading-relaxed">
            Bun: <span className={missing.bun ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}>{missing.bun ? '未就绪' : '已就绪'}</span>
          </p>
          <p className="text-[12.5px] text-claude-text leading-relaxed">
            hare-code: <span className={missing.hareCode ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}>{missing.hareCode ? '未就绪' : '已就绪'}</span>
          </p>
          {status.hareCode.path && !missing.hareCode ? (
            <p className="text-[11.5px] text-claude-textSecondary break-all">当前命令: {status.hareCode.path}</p>
          ) : null}
        </div>

        {error && (
          <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 mb-4">
            <p className="text-[12.5px] text-red-700 dark:text-red-300">{error}</p>
          </div>
        )}

        <div className="flex flex-col gap-2">
          {missing.bun ? (
            <button
              onClick={() => openExternal(BUN_DOWNLOAD_URL)}
              className="w-full px-4 py-2.5 rounded-lg bg-claude-text text-claude-bg text-[14px] font-medium hover:opacity-90 transition-opacity"
            >
              打开 Bun 安装页
            </button>
          ) : null}

          {missing.hareCode ? (
            <>
              <button
                onClick={handleInstallHareCode}
                disabled={installing}
                className="w-full px-4 py-2.5 rounded-lg bg-claude-text text-claude-bg text-[14px] font-medium hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {installing ? '下载中...' : '下载 hare-code 二进制'}
              </button>
              <button
                onClick={() => openExternal(HARE_CODE_RELEASES_URL)}
                className="w-full px-4 py-2.5 rounded-lg border border-claude-border text-claude-text text-[14px] font-medium hover:bg-claude-hover transition-colors"
              >
                打开 hare-code 发布页
              </button>
            </>
          ) : null}

          <button
            onClick={recheck}
            disabled={checking || installing}
            className="w-full px-4 py-2.5 rounded-lg border border-claude-border text-claude-text text-[14px] font-medium hover:bg-claude-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {checking ? '检测中...' : '重新检测'}
          </button>
        </div>

        <p className="text-[11px] text-claude-textSecondary text-center mt-4">
          安装完成后重新检测即可继续进入桌面端。
        </p>
      </div>
    </div>
  );
};

export default RuntimeRequiredModal;
