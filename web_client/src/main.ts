import "./app.css";
import { CanvasRenderer } from "./canvasRenderer";
import { DeviceSummary, TouchType } from "./protocol";
import { LoggedPacket, RemoteWebViewBrowserClient } from "./wsClient";

type UiSettings = {
  server: string;
  width: number;
  height: number;
  fullFrameTileCount: number;
  scalePercent: number;
  url: string;
  quality: number;
  maxBytesPerMsg: number;
};

const STORAGE_KEY = "rwv-browser-client-settings";
const HISTORY_KEY_SERVER = "rwv-server-history";
const HISTORY_KEY_URL = "rwv-url-history";
const BROWSER_ID_KEY = "rwv-browser-id";
const HISTORY_MAX = 10;
const SCALE_OPTIONS = [50, 75, 100, 125, 150, 200];

function getOrCreateBrowserId(): string {
  let id = localStorage.getItem(BROWSER_ID_KEY);
  if (!id) {
    id = `browser-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(BROWSER_ID_KEY, id);
  }
  return id;
}

const BROWSER_ID = getOrCreateBrowserId();

const defaults: UiSettings = {
  server: "127.0.0.1:8081",
  width: 480,
  height: 480,
  fullFrameTileCount: 1,
  scalePercent: 100,
  url: "http://127.0.0.1:8123/",
  quality: 85,
  maxBytesPerMsg: 61440
};

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) {
  throw new Error("Root container not found");
}

root.innerHTML = `
  <main class="layout">
    <section class="panel controls">
      <h1>Remote WebView Browser Client</h1>
      <label>Server
        <input id="server" type="text" placeholder="172.16.0.252:8081" />
      </label>
      <div class="row2">
        <label>Width
          <input id="width" type="number" min="1" step="1" />
        </label>
        <label>Height
          <input id="height" type="number" min="1" step="1" />
        </label>
      </div>
      <div class="row2">
        <label>JPEG q
          <input id="quality" type="number" min="1" max="100" />
        </label>
        <label>full_frame_tile_count
          <input id="fftc" type="number" min="1" step="1" />
        </label>
      </div>
      <div class="row2">
        <label>Max bytes/msg
          <input id="mbpm" type="number" min="1024" step="1024" />
        </label>
      </div>
      <div class="actions">
        <button id="connect">Connect</button>
        <button id="disconnect" class="ghost">Disconnect</button>
      </div>
      <label>Open URL
        <input id="url" type="text" placeholder="http://..." />
      </label>
      <div class="actions">
        <button id="openUrl">Send open_url</button>
      </div>
      <div class="device-list" id="deviceList"></div>
    </section>

    <section class="panel viewer">
      <div class="statusbar" id="statusbar">
        <span class="sb-chip" id="sb-status"><span class="sb-dot" id="sb-dot"></span><span id="sb-status-text">idle</span></span>
        <span class="sb-chip sb-device"><span class="sb-label">device</span><span class="sb-val" id="sb-device">—</span></span>
        <span class="sb-chip sb-zoom"><span class="sb-label">zoom</span><select id="scale" class="scale-inline" aria-label="Scale"></select></span>
        <span class="sb-chip"><span class="sb-label">frame</span><span class="sb-val" id="sb-frame">—</span></span>
        <span class="sb-chip sb-err"><span class="sb-label">err</span><span class="sb-val" id="sb-err">—</span></span>
      </div>
      <div class="stream-row">
        <canvas id="screen"></canvas>
        <div class="msglog-panel">
          <div class="msglog-filters" id="msglogFilters"></div>
          <div class="msglog-list" id="msglog"></div>
        </div>
      </div>
      <div class="current-url-display" id="currentUrlDisplay">Current URL: —</div>
    </section>
  </main>
`;

const elServer = byId<HTMLInputElement>("server");
const elWidth = byId<HTMLInputElement>("width");
const elHeight = byId<HTMLInputElement>("height");
const elQuality = byId<HTMLInputElement>("quality");
const elFftc = byId<HTMLInputElement>("fftc");
const elMbpm = byId<HTMLInputElement>("mbpm");
const elScale = byId<HTMLSelectElement>("scale");
const elUrl = byId<HTMLInputElement>("url");
const elConnect = byId<HTMLButtonElement>("connect");
const elDisconnect = byId<HTMLButtonElement>("disconnect");
const elOpenUrl = byId<HTMLButtonElement>("openUrl");
const elCanvas = byId<HTMLCanvasElement>("screen");
const elMsgLog = byId<HTMLDivElement>("msglog");
const elMsglogFilters = byId<HTMLDivElement>("msglogFilters");
const elSbDot = byId<HTMLSpanElement>("sb-dot");
const elSbStatusText = byId<HTMLSpanElement>("sb-status-text");
const elSbFrame = byId<HTMLSpanElement>("sb-frame");
const elSbErr = byId<HTMLSpanElement>("sb-err");
const elSbDevice = byId<HTMLSpanElement>("sb-device");
const elCurrentUrlDisplay = byId<HTMLDivElement>("currentUrlDisplay");
const elDeviceList = byId<HTMLDivElement>("deviceList");

const settings = loadSettings();

elScale.innerHTML = SCALE_OPTIONS.map((value) => `<option value="${value}">${value}%</option>`).join("");

elServer.value = settings.server;
elWidth.value = String(settings.width);
elHeight.value = String(settings.height);
elQuality.value = String(settings.quality);
elFftc.value = String(settings.fullFrameTileCount);
elMbpm.value = String(settings.maxBytesPerMsg);
elScale.value = String(settings.scalePercent);
elUrl.value = settings.url;

const renderer = new CanvasRenderer(elCanvas, settings.width, settings.height);
applyDisplayScale(elCanvas, settings.width, settings.height, settings.scalePercent);

applyDatalist(elServer, "server-list", loadHistory(HISTORY_KEY_SERVER));
applyDatalist(elUrl, "url-list", loadHistory(HISTORY_KEY_URL));

let intentConnected = false;

function updateButtons(status: string): void {
  const connecting = intentConnected && status !== "connected";
  elConnect.disabled = intentConnected;
  elConnect.textContent = connecting ? "Reconnecting…" : "Connect";
  elDisconnect.disabled = !intentConnected;
  elDisconnect.classList.toggle("ghost", !intentConnected);
}

updateButtons("idle");

let lastDeviceList: DeviceSummary[] = [];

const client = new RemoteWebViewBrowserClient(renderer, {
  onMetrics(metrics) {
    elSbStatusText.textContent = metrics.status;
    elSbDot.className = `sb-dot sb-dot--${metrics.status}`;
    elSbFrame.textContent = `${metrics.lastFrameId ?? "—"}/${metrics.frames ?? "—"}(${fmtBytes(metrics.bytes)})`;
    elSbErr.textContent = metrics.lastError || "—";
    elSbErr.classList.toggle("sb-val--err", !!metrics.lastError);
    elSbDevice.textContent = client.currentDeviceId ?? "—";
    updateButtons(metrics.status);
    renderDeviceList(lastDeviceList);
  },
  onURL(url: string) {
    elCurrentUrlDisplay.textContent = `Current URL: ${url}`;
  },
  onDeviceList(devices: DeviceSummary[]) {
    lastDeviceList = devices;
    renderDeviceList(devices);
  },
  onPacket(pkt: LoggedPacket) {
    appendLogEntry(pkt);
  },
});

function doConnect(deviceId?: string): void {
  const s = getSettingsFromUi();
  persistSettings(s);
  pushHistory(HISTORY_KEY_SERVER, s.server);
  applyDatalist(elServer, "server-list", loadHistory(HISTORY_KEY_SERVER));
  renderer.resize(s.width, s.height);
  applyDisplayScale(elCanvas, s.width, s.height, s.scalePercent);
  intentConnected = true;
  updateButtons("connecting");
  client.connect(s.server, {
    id: deviceId ?? BROWSER_ID,
    attach: deviceId !== undefined,
    w: s.width,
    h: s.height,
    fftc: s.fullFrameTileCount,
    q: s.quality,
    mbpm: s.maxBytesPerMsg
  });
}

elConnect.addEventListener("click", () => doConnect());

doConnect();


elScale.addEventListener("change", () => {
  const s = getSettingsFromUi();
  applyDisplayScale(elCanvas, s.width, s.height, s.scalePercent);
  persistSettings(s);
});

elDisconnect.addEventListener("click", () => {
  intentConnected = false;
  client.disconnect();
  elSbStatusText.textContent = "disconnected";
  elSbDot.className = "sb-dot sb-dot--disconnected";
  updateButtons("disconnected");
});

elUrl.addEventListener("keydown", (e) => { if (e.key === "Enter") elOpenUrl.click(); });

elOpenUrl.addEventListener("click", () => {
  const url = elUrl.value.trim();
  if (!url) {
    return;
  }

  if (!client.sendOpenUrl(url)) {
    elSbErr.textContent = "open_url failed (not connected)";
    elSbErr.classList.add("sb-val--err");
    return;
  }

  pushHistory(HISTORY_KEY_URL, url);
  applyDatalist(elUrl, "url-list", loadHistory(HISTORY_KEY_URL));
  const s = getSettingsFromUi();
  s.url = url;
  persistSettings(s);
});

attachTouchHandlers(elCanvas, client);

function attachTouchHandlers(canvas: HTMLCanvasElement, remoteClient: RemoteWebViewBrowserClient): void {
  const activePointers = new Set<number>();

  const map = (event: PointerEvent): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) * canvas.width) / rect.width;
    const y = ((event.clientY - rect.top) * canvas.height) / rect.height;
    return { x: Math.round(x), y: Math.round(y) };
  };

  const onDown = (event: PointerEvent): void => {
    canvas.setPointerCapture(event.pointerId);
    activePointers.add(event.pointerId);
    const p = map(event);
    remoteClient.sendTouch(TouchType.Down, event.pointerId, p.x, p.y);
  };

  const onMove = (event: PointerEvent): void => {
    if (!activePointers.has(event.pointerId)) return;
    const p = map(event);
    remoteClient.sendTouch(TouchType.Move, event.pointerId, p.x, p.y);
  };

  const onUp = (event: PointerEvent): void => {
    if (!activePointers.has(event.pointerId)) return;
    activePointers.delete(event.pointerId);
    const p = map(event);
    remoteClient.sendTouch(TouchType.Up, event.pointerId, p.x, p.y);
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
}

function getSettingsFromUi(): UiSettings {
  return {
    server: elServer.value.trim() || defaults.server,
    width: readPositiveInt(elWidth.value, defaults.width),
    height: readPositiveInt(elHeight.value, defaults.height),
    fullFrameTileCount: readPositiveInt(elFftc.value, defaults.fullFrameTileCount),
    scalePercent: readScalePercent(elScale.value, defaults.scalePercent),
    quality: readPositiveInt(elQuality.value, defaults.quality),
    maxBytesPerMsg: readPositiveInt(elMbpm.value, defaults.maxBytesPerMsg),
    url: elUrl.value.trim() || defaults.url
  };
}

function loadSettings(): UiSettings {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) {
      return { ...defaults };
    }

    const parsed = JSON.parse(text) as Partial<UiSettings>;
    return {
      server: parsed.server ?? defaults.server,
      width: parsed.width ?? defaults.width,
      height: parsed.height ?? defaults.height,
      fullFrameTileCount: readPositiveInt(String(parsed.fullFrameTileCount ?? ""), defaults.fullFrameTileCount),
      scalePercent: readScalePercent(parsed.scalePercent, defaults.scalePercent),
      url: parsed.url ?? defaults.url,
      quality: parsed.quality ?? defaults.quality,
      maxBytesPerMsg: parsed.maxBytesPerMsg ?? defaults.maxBytesPerMsg
    };
  } catch {
    return { ...defaults };
  }
}

function persistSettings(settingsToStore: UiSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settingsToStore));
}

function readPositiveInt(value: string, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.round(n);
}

function readScalePercent(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return fallback;
  }
  return Math.min(Math.max(Math.round(n), 10), 400);
}

function applyDisplayScale(canvas: HTMLCanvasElement, width: number, height: number, scalePercent: number): void {
  const scale = scalePercent / 100;
  canvas.style.width = `${Math.max(1, Math.round(width * scale))}px`;
  canvas.style.height = `${Math.max(1, Math.round(height * scale))}px`;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing element: ${id}`);
  }
  return node as T;
}

function renderDeviceList(devices: DeviceSummary[]): void {
  if (devices.length === 0) {
    elDeviceList.innerHTML = "";
    return;
  }
  const activeId = client.currentDeviceId;
  elDeviceList.innerHTML = `
    <div class="device-list-title">Connected devices</div>
    ${devices.map(d => {
      const isActive = d.id === activeId;
      const ago = Math.round((Date.now() - d.lastActive) / 1000);
      const agoStr = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;
      const shortUrl = d.url ? d.url.replace(/^https?:\/\//, "").slice(0, 40) : "—";
      return `<div class="device-item${isActive ? " device-item--active" : ""}">
        ${isActive ? '<div class="device-active-indicator">▶</div>' : ""}
        <div class="device-id">${d.id}</div>
        <div class="device-url" title="${d.url}">${shortUrl}</div>
        <div class="device-ago">${agoStr}</div>
        <div class="device-actions">
          ${isActive ? "" : `<button class="device-btn connect-btn" data-id="${d.id}" data-url="${d.url}" title="Connect to this device">→</button>`}
          <button class="device-btn kill-btn" data-id="${d.id}" title="Kill this device">✕</button>
        </div>
      </div>`;
    }).join("")}
  `;

  elDeviceList.querySelectorAll<HTMLElement>(".connect-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id!;
      const url = btn.dataset.url ?? "";
      if (url) elUrl.value = url;
      doConnect(id);
    });
  });

  elDeviceList.querySelectorAll<HTMLElement>(".kill-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      client.sendKillDevice(btn.dataset.id!);
    });
  });
}

function loadHistory(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) || "[]");
  } catch {
    return [];
  }
}

function pushHistory(key: string, value: string): void {
  if (!value) return;
  const hist = loadHistory(key).filter(v => v !== value);
  hist.unshift(value);
  localStorage.setItem(key, JSON.stringify(hist.slice(0, HISTORY_MAX)));
}

const LOG_TYPES: { typeId: number; label: string }[] = [
  { typeId: 1, label: "Frame" },
  { typeId: 2, label: "Touch" },
  { typeId: 3, label: "FrameStats" },
  { typeId: 4, label: "OpenURL" },
  { typeId: 5, label: "Keepalive" },
  { typeId: 6, label: "CurrentURL" },
  { typeId: 7, label: "DeviceList" },
  { typeId: 8, label: "KillDevice" },
];

const activeFilters = new Set<number>(LOG_TYPES.map(t => t.typeId));

function buildFilters(): void {
  elMsglogFilters.innerHTML = "";
  for (const { typeId, label } of LOG_TYPES) {
    const btn = document.createElement("button");
    btn.className = "filter-chip" + (activeFilters.has(typeId) ? " active" : "");
    btn.dataset.typeid = String(typeId);
    btn.textContent = `${typeId} ${label}`;
    btn.addEventListener("click", () => {
      if (activeFilters.has(typeId)) {
        activeFilters.delete(typeId);
        btn.classList.remove("active");
      } else {
        activeFilters.add(typeId);
        btn.classList.add("active");
      }
      applyFilters();
    });
    elMsglogFilters.appendChild(btn);
  }
}

function applyFilters(): void {
  for (const entry of elMsgLog.children) {
    const el = entry as HTMLElement;
    const id = Number(el.dataset.typeid);
    el.style.display = activeFilters.has(id) ? "" : "none";
  }
}

buildFilters();

const TILE_TTL_MS = 30_000;

setInterval(() => {
  const cutoff = Date.now() - TILE_TTL_MS;
  for (const el of [...elMsgLog.children] as HTMLElement[]) {
    if (el.dataset.ts && Number(el.dataset.ts) < cutoff) el.remove();
  }
}, 5_000);

function appendLogEntry(pkt: LoggedPacket): void {
  const entry = document.createElement("div");
  entry.dataset.typeid = String(pkt.typeId);
  if (!activeFilters.has(pkt.typeId)) entry.style.display = "none";

  if (pkt.kind === 'tile') {
    entry.className = "log-entry log-tile";
    entry.dataset.ts = String(Date.now());
    const dir = document.createElement("span");
    dir.className = "log-dir log-dir--in";
    dir.textContent = "↓";
    entry.appendChild(dir);
    const id = document.createElement("span");
    id.className = "log-typeid";
    id.textContent = String(pkt.typeId);
    entry.appendChild(id);
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 32;
    canvas.className = "log-thumb";
    const info = document.createElement("span");
    info.className = "log-info";
    info.textContent = `${pkt.x},${pkt.y} ${pkt.w}×${pkt.h} [f${pkt.frameId}]`;
    entry.appendChild(canvas);
    entry.appendChild(info);
    drawTileThumb(canvas, pkt.data).catch(() => {});
  } else {
    entry.className = `log-entry log-text log-${pkt.dir}`;
    const dir = document.createElement("span");
    dir.className = `log-dir log-dir--${pkt.dir}`;
    dir.textContent = pkt.dir === 'in' ? "↓" : "↑";
    entry.appendChild(dir);
    const id = document.createElement("span");
    id.className = "log-typeid";
    id.textContent = String(pkt.typeId);
    entry.appendChild(id);
    const label = document.createElement("span");
    label.className = "log-label";
    label.textContent = pkt.label;
    entry.appendChild(label);
    if (pkt.content) {
      const content = document.createElement("span");
      content.className = "log-content";
      content.textContent = pkt.content;
      entry.appendChild(content);
    }
  }

  elMsgLog.prepend(entry);
}

async function drawTileThumb(canvas: HTMLCanvasElement, data: Uint8Array): Promise<void> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const blob = new Blob([copy], { type: "image/jpeg" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = reject;
      img.src = url;
    });
    const ctx = canvas.getContext("2d");
    if (ctx) ctx.drawImage(img, 0, 0, 32, 32);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function applyDatalist(inputEl: HTMLInputElement, listId: string, items: string[]): void {
  let dl = document.getElementById(listId) as HTMLDataListElement | null;
  if (!dl) {
    dl = document.createElement("datalist");
    dl.id = listId;
    document.body.appendChild(dl);
  }
  dl.innerHTML = items.map(v => `<option value="${v}">`).join("");
  inputEl.setAttribute("list", listId);
}
