/**
 * 天翼云业务核心类型契约定义
 */

export interface DesktopModel {
  desktopId: string;
  desktopCode: string;
  desktopName?: string;
  nickName?: string;
  name?: string;
  computerName?: string;
  imageName?: string;
  flavorName?: string;
  status?: string;
  useStatusText?: string;
  ip?: string;
  osType?: string;
  expiredTime?: string;
  poolId?: string;
  sessionStatus?: string;
  objType?: number;
  objId?: string;
  isPool?: boolean;
  lastHeartbeat?: string;
  [key: string]: unknown;
}

export interface ManagedDesktopState extends DesktopModel {
  status: 'running' | 'stopped' | 'paused' | 'idle' | 'connecting' | 'connected' | 'reconnecting';
  desktopId: string;
  desktopCode: string;
  desktopName: string;
  useStatusText: string;
  watchdog?: {
    active: boolean;
    currentIntervalSec: number;
    nextProbeSec: number;
    failRounds: number;
  };
  yieldStatus?: {
    active?: boolean;
    yielding?: boolean;
    reason?: string;
    remainingSeconds?: number;
    durationMs?: number;
    remainingMs?: number;
    startTime?: number;
    endTime?: number;
  };
}

import type { LoginInfo } from './ctyun/client.js';

export interface ManagedAccount {
  id: string;
  name: string;
  user: string;
  deviceCode: string;
  status: 'idle' | 'login_needed' | 'need_sms' | 'online' | 'error';
  lastError?: string;
  loginInfo?: LoginInfo;
  autoStart?: boolean;
  taskConfig?: import('./config.js').TaskConfig;
  redeemConfig?: import('./config.js').RedeemConfig;
  todayPoints?: number;
  desktops: ManagedDesktopState[];
}

/**
 * 云电脑电源动作 (对齐官方 jb 枚举: ON=1, SHUTDOWN=2, RESET=3, RESTORE=6, AWAKE=18)
 * 官方协议不存在强制关机(4)/强制重启(5)，故仅保留受支持动作
 */
export interface PowerActionOptions {
  action: 'on' | 'shutdown' | 'off' | 'stop' | 'reset' | 'reboot' | 'restart' | 'awake' | 'wake';
}
