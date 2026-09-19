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

export interface DesktopInstanceSummary {
  id: string;
  desktopCode: string;
  desktopName: string;
  flavorName?: string;
  imageName?: string;
  useStatusText: string;
  status: string;
  lastHeartbeat?: string;
  profileId?: string;
  profileName: string;
  profileUser: string;
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

export interface PowerActionOptions {
  action:
    | 'on'
    | 'shutdown'
    | 'off'
    | 'stop'
    | 'reset'
    | 'reboot'
    | 'restart'
    | 'awake'
    | 'wake'
    | 'force_off'
    | 'force_reboot';
}
