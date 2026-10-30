import type { AttributeArray } from './types';

/** Smallest capacity, in points, a streaming loader allocates its buffers at. */
export const MIN_BUFFER_CAPACITY = 262_144;

/** Starting capacity, in points, for a loader's buffers. */
export function initialCapacity(budget: number): number {
  return Math.min(budget, MIN_BUFFER_CAPACITY);
}

/**
 * Capacity to grow buffers to so they hold `needed` points. Doubles, so repeated growth
 * stays cheap, but not past the budget unless `needed` already is.
 */
export function grownCapacity(capacity: number, needed: number, budget: number): number {
  if (needed <= capacity) {
    return capacity;
  }
  return Math.max(needed, Math.min(budget, Math.max(capacity * 2, MIN_BUFFER_CAPACITY)));
}

/**
 * Capacity to shrink buffers holding `used` points to once they are oversized, either for
 * the budget or for what they hold. Returns `capacity` when no shrink is warranted.
 */
export function fittedCapacity(capacity: number, used: number, budget: number): number {
  if (capacity <= budget && used * 4 >= capacity) {
    return capacity;
  }
  const target = Math.max(used, Math.min(budget, Math.max(used * 2, MIN_BUFFER_CAPACITY)));
  return Math.min(capacity, target);
}

/** Copy of `array` with room for `length` elements, keeping its first `keep`. */
export function resizedArray<T extends AttributeArray>(array: T, length: number, keep: number): T {
  const next = new (array.constructor as new (length: number) => T)(length);
  next.set(array.subarray(0, Math.min(keep, length)));
  return next;
}
