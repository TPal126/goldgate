import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function toJsonl(items: unknown[]): string {
  return items.map((i) => JSON.stringify(i)).join('\n') + '\n';
}

export function parseJsonl<T>(text: string): T[] {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function readJsonlFile<T>(path: string): T[] {
  return parseJsonl<T>(readFileSync(path, 'utf8'));
}

export function writeJsonlFile(path: string, items: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, toJsonl(items), 'utf8');
}
