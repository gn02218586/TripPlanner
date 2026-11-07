// Google Maps JavaScript API 動態載入（官方 Dynamic Library Import 寫法的可讀版本）
// 之後各模組用 await lib('maps' | 'marker' | 'places' | 'routes') 取得函式庫。
import { GOOGLE_MAPS_API_KEY } from '../config.js';

let installed = false;

function installBootstrap(params) {
  const w = window;
  const g = (w.google = w.google || {});
  const maps = (g.maps = g.maps || {});
  if (maps.importLibrary) return;
  const libs = new Set();
  let loading = null;
  const load = () => loading || (loading = new Promise((resolve, reject) => {
    const qs = new URLSearchParams();
    qs.set('libraries', [...libs].join(','));
    for (const [k, v] of Object.entries(params)) qs.set(k.replace(/[A-Z]/g, t => '_' + t.toLowerCase()), v);
    qs.set('callback', 'google.maps.__ib__');
    const s = document.createElement('script');
    s.src = 'https://maps.googleapis.com/maps/api/js?' + qs;
    maps.__ib__ = resolve;
    s.onerror = () => { loading = null; reject(new Error('Google Maps JavaScript API 無法載入')); };
    s.async = true;
    document.head.append(s);
  }));
  maps.importLibrary = (name, ...rest) => { libs.add(name); return load().then(() => maps.importLibrary(name, ...rest)); };
}

export function lib(name) {
  if (!installed) {
    installBootstrap({ key: GOOGLE_MAPS_API_KEY, v: 'weekly', language: 'zh-TW' });
    installed = true;
  }
  return google.maps.importLibrary(name);
}
