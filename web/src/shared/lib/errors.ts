const CODE_HINTS: Record<string, string> = {
  saas_cloudflare_sync_zone_mismatch: 'Cloudflare DNS 同步域名与主机名不匹配，请到编辑页检查同步目标',
  saas_dnspod_provider_missing: 'SaaS 未关联 DNSPod，请先在服务商设置里绑定',
  saas_dnspod_zone_not_found: 'DNSPod 中找不到匹配域名，请确认主域名已接入 DNSPod',
  preferred_apply_running: '已有优选切换任务在跑，请稍后再试',
  preferred_apply_empty: '没有匹配主机可切换（可取消“仅自动优选”）',
  dns_sync_failed: 'DNS 写回失败，请检查关联 DNS 服务商与权限',
  cloudflare_provider_not_found: 'Cloudflare 服务商不存在或已删除',
  dnspod_provider_not_found: 'DNSPod 服务商不存在或已删除',
  edgeone_cname_empty: 'EdgeOne 尚未生成 CNAME，请稍后刷新再同步',
  validation_failed: '参数不完整或格式不正确',
  unauthenticated: '登录已失效，请重新登录',
  invalid_credentials: '用户名或密码错误',
  provider_test_failed: '服务商连接测试失败',
  provider_credentials_invalid: '密钥无效或权限不足',
  provider_test_unsupported: '该服务商类型暂不支持测通',
  batch_job_running: '该站点已有批量任务在执行',
  batch_empty: '未选择任何目标',
  batch_patch_empty: '没有可修改的字段',
}

export function errorMessage(error: unknown, fallback = '请求失败'): string {
  if (typeof error === 'string' && error.trim()) return error

  const err = error as {
    message?: string
    code?: string
    status?: number
    details?: unknown
    response?: { data?: { message?: string; code?: string; details?: unknown }; status?: number }
  }

  const code = String(err?.code || err?.response?.data?.code || '').trim()
  const serverMessage = String(err?.response?.data?.message || err?.message || '').trim()
  const status = Number(err?.status || err?.response?.status || 0)

  if (serverMessage && (code === 'auth_rate_limited' || status === 429)) return serverMessage
  if (code && CODE_HINTS[code]) return CODE_HINTS[code]
  if (serverMessage) {
    if (/sync zone/i.test(serverMessage) || /does not match hostname/i.test(serverMessage)) {
      return 'DNS 同步域名与主机名不匹配，请检查同步目标（通常应为 example.com 这类主域名，而不是 SaaS 区）'
    }
    if (/permission|unauthorized|forbidden|invalid.*(token|key|secret)|auth/i.test(serverMessage)) {
      return `${serverMessage}（请检查 API Token / 密钥权限）`
    }
    if (/rate|too many|throttl/i.test(serverMessage)) {
      return `${serverMessage}（请求过快，请稍后重试）`
    }
    if (/timeout|timed out|gateway/i.test(serverMessage)) {
      return `${serverMessage}（上游超时，请稍后重试）`
    }
    // Prefer Chinese-looking server messages as-is
    if (/[\u4e00-\u9fff]/.test(serverMessage)) return serverMessage
    if (status === 401 || status === 403) return `${serverMessage}（认证/权限失败）`
    return serverMessage
  }

  if (status === 401) return '登录已失效，请重新登录'
  if (status === 403) return '没有权限执行该操作'
  if (status === 404) return '资源不存在'
  if (status >= 500) return '服务暂时异常，请稍后重试'

  return fallback
}
