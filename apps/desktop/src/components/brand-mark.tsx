import { cn } from '@/lib/utils'

// A simple app mark that follows the active light/dark Jarvis palette.
export function BrandMark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'inline-flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-primary text-primary-foreground',
        className
      )}
      {...props}
    >
      <span aria-hidden="true" className="font-semibold leading-none">J</span>
    </span>
  )
}
