import type { ManagedDesktopState } from '../types.js';

export interface DesktopMatch {
  accountName: string;
  desktop: ManagedDesktopState;
}

/** desktopCode 与数字 desktopId 双寻址匹配 */
export function matchesDesktop(d: { desktopCode?: string; desktopId?: string }, key: string): boolean {
  return String(d.desktopCode) === key || String(d.desktopId) === key;
}

export interface DesktopResolverHost {
  /** 遍历已托管的账号桌面状态 */
  iterateStates(): IterableIterator<[string, { name: string; desktops: ManagedDesktopState[] }]>;
  /** 遍历持久化配置中的桌面快照 (兜底) */
  iterateConfiguredDesktops(): IterableIterator<[string, Array<{ desktopCode?: string; desktopId?: string }>]>;
  reloadDesktops(accountName: string): Promise<void>;
  getAccountNames(): string[];
  getState(accountName: string): { desktops: ManagedDesktopState[] } | undefined;
}

/**
 * 云电脑反查器：统一 desktopCode/desktopId 双寻址与"内存未命中则刷新"兜底逻辑
 */
export class DesktopResolver {
  constructor(private host: DesktopResolverHost) {}

  /** 仅内存反查 (同步，不触发网络刷新) */
  public find(desktopCode: string): DesktopMatch | undefined {
    if (!desktopCode) return undefined;
    const key = String(desktopCode).trim();

    for (const [name, state] of this.host.iterateStates()) {
      const d = state.desktops.find((item) => matchesDesktop(item, key));
      if (d) return { accountName: name, desktop: d };
    }
    for (const [name, desktops] of this.host.iterateConfiguredDesktops()) {
      const d = desktops.find((item) => matchesDesktop(item, key));
      if (d) return { accountName: name, desktop: d as ManagedDesktopState };
    }
    return undefined;
  }

  /**
   * 精准反查：账号提示 -> 内存遍历 -> 全量刷新重载兜底
   */
  public async resolve(desktopCode: string, accountHint?: string): Promise<DesktopMatch> {
    if (!desktopCode) throw new Error('缺少全局唯一 desktopCode');
    const key = String(desktopCode).trim();

    if (accountHint) {
      const state = this.host.getState(accountHint);
      const d = state?.desktops.find((item) => matchesDesktop(item, key));
      if (d && state) return { accountName: accountHint, desktop: d };
    }

    const matched = this.find(key);
    if (matched) return matched;

    for (const name of this.host.getAccountNames()) {
      try {
        await this.host.reloadDesktops(name);
        const state = this.host.getState(name);
        const d = state?.desktops.find((item) => matchesDesktop(item, key));
        if (d) return { accountName: name, desktop: d };
      } catch {}
    }

    throw new Error(`未找到设备编码为 [${desktopCode}] 的云电脑实例`);
  }
}
