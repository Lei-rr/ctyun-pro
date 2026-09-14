export interface AccountCredentials {
  accountName: string;
  user: string;
  deviceCode: string;
  passwordEncrypted?: string;
  loginInfo?: any;
}

export class AccountService {
  /**
   * 账号凭据清洗与安全性校验
   */
  public static sanitizeAccountName(raw: string): string {
    return (raw || '').trim();
  }

  /**
   * 校验手机号/账号格式
   */
  public static isValidAccountIdentifier(identifier: string): boolean {
    if (!identifier) return false;
    const trimmed = identifier.trim();
    return trimmed.length >= 4 && trimmed.length <= 64;
  }

  /**
   * 账号对外脱敏只读视图 (完全深拷贝隔离内部引用，杜绝污染与凭证泄露)
   */
  public static sanitizeAccount(accountOrState: any): any {
    if (!accountOrState) return accountOrState;
    let clone: any;
    try {
      clone = structuredClone(accountOrState);
    } catch {
      clone = JSON.parse(JSON.stringify(accountOrState));
    }
    if (clone.password) delete clone.password;
    if (clone.rawPassword) delete clone.rawPassword;
    if (clone.loginInfo) {
      delete clone.loginInfo.secretKey;
      delete clone.loginInfo.clientKey;
      delete clone.loginInfo.caCert;
      delete clone.loginInfo.clientCert;
      if (clone.loginInfo.password) delete clone.loginInfo.password;
      if (clone.loginInfo.rawPassword) delete clone.loginInfo.rawPassword;
    }
    return clone;
  }
}
