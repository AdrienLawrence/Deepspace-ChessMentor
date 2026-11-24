import * as React from 'react'
import { cva } from 'class-variance-authority'

// Local class-name helper: src/lib/utils.ts wraps clsx and tailwind-merge.
import { cn } from '@/lib/utils'

const labelVariants = cva(
  'text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
)

const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label ref={ref} className={cn(labelVariants(), className)} {...props} />
  ),
)

Label.displayName = 'Label'

export { Label }
