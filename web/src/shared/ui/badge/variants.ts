import { cva, type VariantProps } from 'class-variance-authority'

export const badgeVariants = cva(
  'inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 [&>svg]:size-3 gap-1 [&>svg]:pointer-events-none transition-[color,box-shadow] overflow-hidden',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary: 'border-transparent bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        destructive:
          'border-transparent bg-destructive text-white [a&]:hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40',
        outline: 'text-foreground border-border/80 [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        success:
          'border-emerald-500/20 bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 [a&]:hover:bg-emerald-500/25',
        warning: 'border-amber-500/20 bg-amber-500/15 text-amber-800 dark:text-amber-300 [a&]:hover:bg-amber-500/25',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

export type BadgeVariants = VariantProps<typeof badgeVariants>
