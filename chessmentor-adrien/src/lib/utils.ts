/**
 * Shared CSS class composition used by src/components/ui wrappers.
 * clsx resolves conditional class inputs; tailwind-merge resolves utility conflicts.
 */

import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
