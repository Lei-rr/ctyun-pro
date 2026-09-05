import { ref } from 'vue'
import type { ConfirmOptions } from './types'

export type { ConfirmOptions }

const open = ref(false)
const options = ref<ConfirmOptions>({
  title: '确认操作',
  description: '此操作不可撤销，确定继续吗？',
  confirmText: '确认',
  cancelText: '取消',
  destructive: true,
})

let resolver: ((value: boolean) => void) | null = null

export function confirmDialog(opts: ConfirmOptions = {}): Promise<boolean> {
  // 若上一次弹窗异常未 settle，先以 false 收尾，避免永久挂起
  if (resolver) {
    const prev = resolver
    resolver = null
    prev(false)
  }
  options.value = {
    title: opts.title || '确认操作',
    description: opts.description || '此操作不可撤销，确定继续吗？',
    confirmText: opts.confirmText || '确认',
    cancelText: opts.cancelText || '取消',
    destructive: opts.destructive ?? true,
  }
  open.value = true
  return new Promise<boolean>((resolve) => {
    resolver = resolve
  })
}

export function confirmDelete(name: string, extra = ''): Promise<boolean> {
  return confirmDialog({
    title: '确认删除',
    description: `确认删除 ${name}？${extra ? `\n${extra}` : ''}`,
    confirmText: '删除',
    cancelText: '取消',
    destructive: true,
  })
}

export function settleConfirm(value: boolean) {
  open.value = false
  if (!resolver) return
  const r = resolver
  resolver = null
  r(value)
}

export function hasPendingConfirm() {
  return resolver != null
}

export const confirmState = {
  open,
  options,
  hasPending: hasPendingConfirm,
}
