
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/+$/, '') ?? '';
const WS_BASE = (import.meta.env.VITE_WS_BASE as string | undefined)?.replace(/\/+$/, '');

export function apiBase(): string {
  return API_BASE;
}

export function wsBase(): string {
  if (WS_BASE) return WS_BASE;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}
