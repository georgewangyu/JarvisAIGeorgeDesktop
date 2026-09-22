import { cn } from '@/lib/utils'

const iconUrl = `${import.meta.env.BASE_URL}apple-touch-icon.png`

// The approved Companion Signal is shared by desktop chrome and packaged icons.
export function BrandMark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn(
        'inline-flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#f1eafb]',
        className
      )}
      {...props}
    >
      <img alt="" aria-hidden="true" className="size-full object-contain" src={iconUrl} />
    </span>
  )
}
