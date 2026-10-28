import type { HtmlTagDescriptor, Plugin } from 'vite';

export const PWA_MODE: 'web';
export function webManifest(version: string): Record<string, unknown>;
export function headTags(): HtmlTagDescriptor[];
export function serviceWorkerSource(files: string[], version: string): string;
export function pwa(options: { version: string }): Plugin;
