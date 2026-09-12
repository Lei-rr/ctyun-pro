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
}
