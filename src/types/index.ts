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

export interface LoginInfo {
  token?: string;
  authToken?: string;
  userToken?: string;
  userId?: string;
  userName?: string;
  userAccount?: string;
  userEid?: string;
  mobilephone?: string;
  tenantId?: string;
  secretKey?: string;
  commonLoginReqHeader?: string;
  bondedDevice?: boolean;
  [key: string]: unknown;
}

export interface ChallengeData {
  challengeId: string;
  challengeCode: string;
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
