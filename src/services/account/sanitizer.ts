import type { ManagedAccount } from '../../types.js';
import type { AccountConfig } from '../../config.js';
import type { LoginInfo } from '../../ctyun/client.js';

export class AccountSanitizer {
  /**
   * 凭证对外脱敏处理 (剔除 secretKey, password, clientKey 等高敏字段)
   */
  public static sanitizeLoginInfo(info?: LoginInfo): LoginInfo | undefined {
    if (!info) return undefined;
    const clone = { ...info } as Record<string, unknown>;
    delete clone.secretKey;
    delete clone.clientKey;
    delete clone.caCert;
    delete clone.clientCert;
    delete clone.password;
    delete clone.rawPassword;
    return clone as unknown as LoginInfo;
  }

  /**
   * 账号对外脱敏只读视图 (完全深拷贝隔离内部引用，杜绝污染与凭证泄露)
   */
  public static sanitizeAccount(accountOrState: ManagedAccount | AccountConfig): ManagedAccount;
  public static sanitizeAccount(accountOrState?: ManagedAccount | AccountConfig): ManagedAccount | undefined;
  public static sanitizeAccount(accountOrState?: ManagedAccount | AccountConfig): ManagedAccount | undefined {
    if (!accountOrState) return undefined;
    let clone: Record<string, unknown>;
    try {
      clone = structuredClone(accountOrState) as unknown as Record<string, unknown>;
    } catch {
      clone = JSON.parse(JSON.stringify(accountOrState)) as unknown as Record<string, unknown>;
    }
    if ('password' in clone) delete clone.password;
    if ('rawPassword' in clone) delete clone.rawPassword;
    if (clone.loginInfo && typeof clone.loginInfo === 'object') {
      const li = clone.loginInfo as Record<string, unknown>;
      delete li.secretKey;
      delete li.clientKey;
      delete li.caCert;
      delete li.clientCert;
      if ('password' in li) delete li.password;
      if ('rawPassword' in li) delete li.rawPassword;
    }
    return clone as unknown as ManagedAccount;
  }
}
