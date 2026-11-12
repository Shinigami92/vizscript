import { defineConfig } from 'vitest/config';

const SEED = Date.now();

export const VERSION = '1.0.0';
export function helper(value: number): number {
  return value * 2;
}
export const twice = (value: number): number => helper(value);
export type Options = { seed: number };
export { SEED, helper as double };
export { parse } from './parser';
export * from './types';

export default defineConfig({ seed: SEED });
