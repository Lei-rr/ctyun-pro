/**
 * App toast facade — same call sites as before:
 *   toast.success / error / warning / message
 * Implementation: official vue-sonner (shadcn-vue sonner block).
 */
import { toast as sonner } from 'vue-sonner'

type Options = {
  description?: string
  duration?: number
}

function opts(options: Options = {}) {
  return {
    description: options.description,
    duration: options.duration ?? 3200,
  }
}

export const toast = {
  message: (title: string, description?: string) => sonner(title, opts({ description })),
  success: (title: string, description?: string) => sonner.success(title, opts({ description })),
  error: (title: string, description?: string) => sonner.error(title, opts({ description })),
  warning: (title: string, description?: string) => sonner.warning(title, opts({ description })),
  info: (title: string, description?: string) => sonner.info(title, opts({ description })),
  loading: (title: string, description?: string) => sonner.loading(title, opts({ description })),
  dismiss: (id?: string | number) => sonner.dismiss(id),
}

export type ToastItem = {
  id: number | string
  title: string
  description?: string
  variant?: 'default' | 'destructive' | 'success'
}
