const DATA_URL = "data/comparison-data.json";
const LIVE_WS_URL = getLiveWsUrl();
const AUDIO_PATHS = {
  source: "assets/audio/sample_voice_mandarin_male.wav",
  clone: "assets/audio/translate_audio.wav"
};
const LATENCY_PROFILE = {
  source: { startDelay: 0, completionLag: 0, output: "播放位置" },
  globalvoice: { startDelay: 0.46, completionLag: 0.68, output: "首字 0.72s / 终字 3.5s" },
  iflytek: { startDelay: 0.92, completionLag: 1.48, output: "首字 1.35s / 终字 5.2s" }
};
const state = {
  data: null,
  videos: [],
  syncing: false,
  latencyAudio: null,
  cloneAudio: null,
  latencyFrame: null,
  cloneFrame: null,
  latencyAutoPlayed: false,
  live: {
    ws: null,
    mediaStream: null,
    inputContext: null,
    sourceNode: null,
    processor: null,
    monitorGain: null,
    players: {},
    running: false,
    connecting: false,
    activeProvider: null,
    transcripts: {
      volcano: { source: createLiveTranscriptState(), translation: createLiveTranscriptState() },
      aliyun: { source: createLiveTranscriptState(), translation: createLiveTranscriptState() },
      iflytek: { source: createLiveTranscriptState(), translation: createLiveTranscriptState() }
    },
    latency: {
      volcano: createLiveLatencyState(),
      aliyun: createLiveLatencyState(),
      iflytek: createLiveLatencyState()
    }
  }
};

document.addEventListener("DOMContentLoaded", init);

function getLiveWsUrl() {
  const localHosts = new Set(["localhost", "127.0.0.1", ""]);
  if (localHosts.has(window.location.hostname)) {
    return "ws://127.0.0.1:8765";
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/live`;
}

async function init() {
  setupMobileNavigation();
  setupAudioExperience();
  setupLiveDemo();
  setupLiveDemoMotion();
  setupDemoCardMotion();
  try {
    const response = await fetch(DATA_URL, { cache: "no-store" });
    if (!response.ok) throw new Error(`Unable to load ${DATA_URL}`);
    state.data = await response.json();
    renderPage(state.data);
  } catch (error) {
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<div class="load-error">无法读取 ${DATA_URL}。请通过本地 Web Server 打开页面，例如在 compare-demo 目录运行 python -m http.server 8000。</div>`
    );
    console.error(error);
  }
}

function setupMobileNavigation() {
  const topbar = document.querySelector(".topbar");
  const button = document.querySelector("#mobileMenuButton");
  const menu = document.querySelector("#mobileNavMenu");
  if (!topbar || !button || !menu) return;

  const setOpen = (open) => {
    topbar.classList.toggle("is-menu-open", open);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "关闭页面导航" : "打开页面导航");
  };

  button.addEventListener("click", () => {
    setOpen(!topbar.classList.contains("is-menu-open"));
  });

  menu.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => setOpen(false));
  });

  document.addEventListener("click", (event) => {
    if (!topbar.classList.contains("is-menu-open")) return;
    if (topbar.contains(event.target)) return;
    setOpen(false);
  });

  window.addEventListener("resize", () => {
    if (window.matchMedia("(min-width: 761px)").matches) setOpen(false);
  });
}

function setupLiveDemo() {
  const startButton = document.querySelector("#liveStartButton");
  const stopButton = document.querySelector("#liveStopButton");
  if (!startButton || !stopButton) return;

  state.live.players = {
    volcano: new PcmAudioQueue("volcano"),
    aliyun: new PcmAudioQueue("aliyun"),
    iflytek: new PcmAudioQueue("iflytek")
  };

  startButton.addEventListener("click", startLiveDemo);
  stopButton.addEventListener("click", stopLiveDemo);
  window.addEventListener("beforeunload", () => {
    if (state.live.ws && state.live.ws.readyState === WebSocket.OPEN) {
      state.live.ws.send(JSON.stringify({ type: "stop" }));
    }
  });
}

function setupLiveDemoMotion() {
  if (!window.gsap || !window.ScrollTrigger) return;
  gsap.registerPlugin(ScrollTrigger);

  gsap.from(".live-demo-hero > div:first-child", {
    scrollTrigger: {
      trigger: "#live-demo",
      start: "top 78%",
      end: "top 40%",
      scrub: true
    },
    y: 28,
    opacity: 0.25,
    ease: "none"
  });

  gsap.from(".live-provider-panel", {
    scrollTrigger: {
      trigger: ".live-provider-grid",
      start: "top 84%"
    },
    y: 34,
    scale: 0.96,
    opacity: 0,
    stagger: 0.12,
    duration: 0.72,
    ease: "power3.out",
    clearProps: "transform,opacity"
  });
}

async function startLiveDemo() {
  if (state.live.running || state.live.connecting) return;

  const startButton = document.querySelector("#liveStartButton");
  const stopButton = document.querySelector("#liveStopButton");
  const sourceLanguage = document.querySelector("#liveSourceLanguage").value;
  const targetLanguage = document.querySelector("#liveTargetLanguage").value;
  const voiceClone = document.querySelector("#liveVoiceClone").checked;
  const audioEnabled = document.querySelector("#liveAudioOutput").checked;
  const provider = getSelectedLiveProvider();
  const languageCheck = validateLiveProviderLanguage(provider, sourceLanguage, targetLanguage);

  if (!languageCheck.ok) {
    setLiveStatus("语种组合不可用", languageCheck.message);
    return;
  }

  resetLivePanels(provider);
  setLiveStatus("连接后端", `正在连接 ${LIVE_WS_URL}`);
  startButton.disabled = true;
  stopButton.disabled = false;
  state.live.connecting = true;

  try {
    await connectLiveSocket();
    await startMicrophoneStreaming();
    await resumeLivePlayers();
    state.live.activeProvider = provider;

    state.live.ws.send(JSON.stringify({
      type: "start",
      sourceLanguage,
      targetLanguage,
      voiceClone,
      audioEnabled,
      providers: [provider]
    }));

    state.live.running = true;
    setLiveStatus("采集中", `麦克风音频正在发送到${getProviderDisplayName(provider)}`);
    startButton.textContent = "实时同传中";
  } catch (error) {
    await stopLiveDemo();
    setLiveStatus("启动失败", error.message || String(error));
  } finally {
    state.live.connecting = false;
  }
}

function validateLiveProviderLanguage(provider, sourceLanguage, targetLanguage) {
  if (provider === "iflytek") {
    return sourceLanguage === "zh" && targetLanguage === "en"
      ? { ok: true }
      : { ok: false, message: "讯飞同传当前仅支持中文普通话到英语，请选择 中文 -> 英语" };
  }
  if (provider === "volcano") {
    return ["zh", "en"].includes(sourceLanguage) || ["zh", "en"].includes(targetLanguage)
      ? { ok: true }
      : { ok: false, message: "火山 AST 要求源语言或目标语言至少一端为中文或英语" };
  }
  return { ok: true };
}

function getProviderDisplayName(provider) {
  const names = {
    volcano: "火山 AST",
    aliyun: "阿里 Qwen",
    iflytek: "讯飞同传"
  };
  return names[provider] || provider;
}

function getSelectedLiveProvider() {
  const selected = document.querySelector('input[name="liveProvider"]:checked');
  return selected ? selected.value : "volcano";
}

async function stopLiveDemo() {
  stopMicrophoneStreaming();

  if (state.live.ws && state.live.ws.readyState === WebSocket.OPEN) {
    state.live.ws.send(JSON.stringify({ type: "stop" }));
  }

  Object.values(state.live.players).forEach((player) => player.resetClock());
  state.live.running = false;
  state.live.connecting = false;
  state.live.activeProvider = null;

  const startButton = document.querySelector("#liveStartButton");
  const stopButton = document.querySelector("#liveStopButton");
  if (startButton) {
    startButton.disabled = false;
    startButton.textContent = "开始实时同传";
  }
  if (stopButton) stopButton.disabled = true;
  setLiveStatus("已停止", "本地采集已关闭");
  markLivePanelsStopped();
}

function connectLiveSocket() {
  return new Promise((resolve, reject) => {
    if (state.live.ws && state.live.ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }

    const ws = new WebSocket(LIVE_WS_URL);
    state.live.ws = ws;
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("message", (event) => handleLiveMessage(event.data));
    ws.addEventListener("close", () => {
      if (state.live.running) {
        setLiveStatus("连接断开", "后端 WebSocket 已关闭");
        stopMicrophoneStreaming();
        state.live.running = false;
      }
    });
    ws.addEventListener("error", () => reject(new Error("无法连接 live demo 后端，请先运行 backend/live_demo_server.py")));
  });
}

function handleLiveMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch (error) {
    console.warn("Invalid live message", raw);
    return;
  }

  if (message.type === "session_status") {
    setLiveStatus(message.status || "会话", message.message || getLiveSessionCopy(message.status));
    if (message.status === "audio") {
      markLiveAudioStarted();
    }
    return;
  }

  if (message.type === "provider_status") {
    updateProviderStatus(message.provider, message.status, message.message);
    return;
  }

  if (message.type === "provider_event") {
    updateProviderEvent(message.provider, message.event);
    return;
  }

  if (message.type === "source_text" || message.type === "translation_text") {
    updateLiveText(
      message.provider,
      message.type === "source_text" ? "source" : "translation",
      message.text || "",
      Boolean(message.final)
    );
    return;
  }

  if (message.type === "audio") {
    const player = state.live.players[message.provider];
    if (player) {
      player.play(message.audio, message.encoding, message.sampleRate);
      setAudioState(message.provider, "播放译后声音");
      updateLiveAudioLatency(message.provider);
    }
    return;
  }

  if (message.type === "error") {
    setLiveStatus("后端错误", message.message || "未知错误");
  }
}

function getLiveSessionCopy(status) {
  const copy = {
    idle: "后端已就绪",
    starting: "正在启动模型会话",
    ready: "模型会话已就绪",
    audio: "音频链路已通",
    stopped: "会话已停止"
  };
  return copy[status] || "状态更新";
}

async function startMicrophoneStreaming() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("当前浏览器不支持麦克风采集");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const context = new AudioContextClass();
  const sourceNode = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(4096, 1, 1);
  const monitorGain = context.createGain();
  monitorGain.gain.value = 0;

  processor.onaudioprocess = (event) => {
    if (!state.live.running) return;
    if (!state.live.ws || state.live.ws.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    const pcm = resampleToInt16(input, context.sampleRate, 16000);
    if (pcm.length === 0) return;
    recordLiveAudioPacketSent();
    state.live.ws.send(JSON.stringify({
      type: "audio",
      audio: bytesToBase64(new Uint8Array(pcm.buffer))
    }));
    pulseMicMeters();
  };

  sourceNode.connect(processor);
  processor.connect(monitorGain);
  monitorGain.connect(context.destination);
  await context.resume();

  state.live.mediaStream = stream;
  state.live.inputContext = context;
  state.live.sourceNode = sourceNode;
  state.live.processor = processor;
  state.live.monitorGain = monitorGain;
}

function stopMicrophoneStreaming() {
  if (state.live.processor) {
    state.live.processor.disconnect();
    state.live.processor.onaudioprocess = null;
  }
  if (state.live.monitorGain) state.live.monitorGain.disconnect();
  if (state.live.sourceNode) state.live.sourceNode.disconnect();
  if (state.live.inputContext) state.live.inputContext.close();
  if (state.live.mediaStream) {
    state.live.mediaStream.getTracks().forEach((track) => track.stop());
  }

  state.live.processor = null;
  state.live.monitorGain = null;
  state.live.sourceNode = null;
  state.live.inputContext = null;
  state.live.mediaStream = null;
}

async function resumeLivePlayers() {
  await Promise.all(Object.values(state.live.players).map((player) => player.resume()));
}

function resampleToInt16(input, inputRate, outputRate) {
  if (outputRate === inputRate) {
    return floatToInt16(input);
  }

  const ratio = inputRate / outputRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(input.length - 1, left + 1);
    const weight = sourceIndex - left;
    const sample = input[left] * (1 - weight) + input[right] * weight;
    output[index] = floatSampleToInt16(sample);
  }

  return output;
}

function floatToInt16(input) {
  const output = new Int16Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    output[index] = floatSampleToInt16(input[index]);
  }
  return output;
}

function floatSampleToInt16(sample) {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

class PcmAudioQueue {
  constructor(provider) {
    this.provider = provider;
    this.context = null;
    this.nextTime = 0;
  }

  ensureContext() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.context = new AudioContextClass();
      this.nextTime = this.context.currentTime;
    }
    return this.context;
  }

  async resume() {
    const context = this.ensureContext();
    if (context.state === "suspended") await context.resume();
  }

  resetClock() {
    if (this.context) {
      this.nextTime = this.context.currentTime;
    }
  }

  play(base64, encoding, sampleRate) {
    const context = this.ensureContext();
    const samples = decodePcmSamples(base64, encoding);
    if (!samples.length) return;

    const buffer = context.createBuffer(1, samples.length, sampleRate || 24000);
    buffer.copyToChannel(samples, 0);

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const startAt = Math.max(context.currentTime + 0.02, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;
  }
}

function decodePcmSamples(base64, encoding) {
  const bytes = base64ToBytes(base64);
  if (encoding === "pcm_f32le") {
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }

  const int16 = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const output = new Float32Array(int16.length);
  for (let index = 0; index < int16.length; index += 1) {
    output[index] = Math.max(-1, Math.min(1, int16[index] / 32768));
  }
  return output;
}

function createLiveTranscriptState() {
  return {
    history: [],
    current: "",
    currentFinal: false
  };
}

function createLiveLatencyState() {
  return {
    lastPacketSentAt: null,
    lastAudioReturnedAt: null,
    lastLatencyMs: null
  };
}

function resetLivePanels(activeProvider) {
  state.live.transcripts = {
    volcano: { source: createLiveTranscriptState(), translation: createLiveTranscriptState() },
    aliyun: { source: createLiveTranscriptState(), translation: createLiveTranscriptState() },
    iflytek: { source: createLiveTranscriptState(), translation: createLiveTranscriptState() }
  };
  state.live.latency = {
    volcano: createLiveLatencyState(),
    aliyun: createLiveLatencyState(),
    iflytek: createLiveLatencyState()
  };

  document.querySelectorAll("[data-live-provider]").forEach((panel) => {
    const isActive = panel.dataset.liveProvider === activeProvider;
    panel.classList.remove("is-live", "has-error");
    panel.classList.toggle("is-disabled", !isActive);
    panel.querySelector("[data-provider-status]").textContent = isActive ? "连接中" : "未启用";
    panel.querySelector("[data-source-text]").textContent = isActive ? "正在等待识别原文。" : "本轮未选择该模型。";
    panel.querySelector("[data-translation-text]").textContent = isActive ? "正在等待翻译结果。" : "切换模型后重新开始即可试用。";
    panel.querySelector("[data-provider-event]").textContent = isActive ? "等待事件" : "未启用";
    panel.querySelector("[data-audio-state]").textContent = "音频待命";
    setLatencyBadge(panel.dataset.liveProvider, isActive ? "语音延迟待测" : "未启用", "idle");
  });
}

function markLivePanelsStopped() {
  document.querySelectorAll("[data-live-provider]").forEach((panel) => {
    panel.classList.remove("is-live");
    const status = panel.querySelector("[data-provider-status]");
    if (status && status.textContent !== "错误") status.textContent = "已停止";
  });
}

function setLiveStatus(label, detail) {
  const statusLine = document.querySelector("#liveStatusLine");
  if (!statusLine) return;
  statusLine.querySelector("span").textContent = label;
  statusLine.querySelector("strong").textContent = detail;
}

function getProviderPanel(provider) {
  return document.querySelector(`[data-live-provider="${provider}"]`);
}

function updateProviderStatus(provider, status, message) {
  const panel = getProviderPanel(provider);
  if (!panel) return;
  const output = panel.querySelector("[data-provider-status]");
  const statusText = {
    connecting: "连接中",
    connected: "在线",
    closed: "已关闭",
    error: "错误"
  };
  output.textContent = statusText[status] || status;
  panel.classList.toggle("is-live", status === "connected");
  panel.classList.toggle("has-error", status === "error");
  if (message) panel.querySelector("[data-provider-event]").textContent = message;
}

function updateProviderEvent(provider, eventName) {
  const panel = getProviderPanel(provider);
  if (!panel || !eventName) return;
  panel.querySelector("[data-provider-event]").textContent = eventName;
}

function updateLiveText(provider, kind, text, final) {
  const panel = getProviderPanel(provider);
  if (!panel || !text) return;

  const key = kind === "source" ? "source" : "translation";
  const field = panel.querySelector(kind === "source" ? "[data-source-text]" : "[data-translation-text]");
  if (!state.live.transcripts[provider]) {
    state.live.transcripts[provider] = {
      source: createLiveTranscriptState(),
      translation: createLiveTranscriptState()
    };
  }
  const store = state.live.transcripts[provider][key];
  const normalizedText = text.trim();
  if (!normalizedText) return;

  if (final) {
    if (store.currentFinal && store.current && store.current !== normalizedText) {
      store.history.push(store.current);
    }
    store.current = normalizedText;
    store.currentFinal = true;
  } else {
    if (store.currentFinal && store.current) {
      store.history.push(store.current);
      store.current = "";
    }
    store.current = normalizedText;
    store.currentFinal = false;
  }

  renderLiveTranscript(field, store);
}

function renderLiveTranscript(field, store) {
  const history = store.history
    .filter(Boolean)
    .map((line) => `<span class="live-text-line is-history">${escapeHtml(line)}</span>`)
    .join("");
  const current = store.current
    ? `<span class="live-text-line is-current">${escapeHtml(store.current)}</span>`
    : "";

  field.innerHTML = history + current;
  field.scrollTop = field.scrollHeight;
  requestAnimationFrame(() => {
    field.scrollTop = field.scrollHeight;
  });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function setAudioState(provider, text) {
  const panel = getProviderPanel(provider);
  if (!panel) return;
  panel.querySelector("[data-audio-state]").textContent = text;
  panel.classList.add("audio-active");
  clearTimeout(panel._audioTimer);
  panel._audioTimer = setTimeout(() => panel.classList.remove("audio-active"), 420);
}

function markLiveAudioStarted() {
  document.querySelectorAll(".live-provider-panel.is-live").forEach((panel) => {
    const provider = panel.dataset.liveProvider;
    const latency = state.live.latency[provider];
    if (!latency || latency.lastLatencyMs !== null) return;
    setLatencyBadge(provider, "等待语音", "timing");
  });
}

function recordLiveAudioPacketSent() {
  const provider = state.live.activeProvider || getSelectedLiveProvider();
  const latency = state.live.latency[provider];
  if (!latency) return;
  latency.lastPacketSentAt = performance.now();
}

function updateLiveAudioLatency(provider) {
  const latency = state.live.latency[provider];
  if (!latency) return;

  const now = performance.now();
  if (latency.lastPacketSentAt === null) {
    setLatencyBadge(provider, "语音 --ms", "ready");
    return;
  }

  const latencyMs = Math.max(0, Math.round(now - latency.lastPacketSentAt));
  latency.lastAudioReturnedAt = now;
  latency.lastLatencyMs = latencyMs;
  setLatencyBadge(provider, `语音 ${latencyMs}ms`, "ready");
}

function setLatencyBadge(provider, text, mode) {
  const panel = getProviderPanel(provider);
  if (!panel) return;
  const badge = panel.querySelector("[data-latency-badge]");
  if (!badge) return;
  badge.textContent = text;
  badge.dataset.latencyMode = mode;
}

function pulseMicMeters() {
  document.querySelectorAll(".live-provider-panel.is-live").forEach((panel) => {
    panel.classList.add("mic-active");
    clearTimeout(panel._micTimer);
    panel._micTimer = setTimeout(() => panel.classList.remove("mic-active"), 180);
  });
}

function renderPage(data) {
  renderVideos(data);
  renderDemoScript(data.demoScript);
  renderKpis(data);
  renderRadar(data);
  renderGapChart(data);
  renderSpeedChart(data);
  renderMetricTable(data);
  renderCapabilityMatrix(data);
  renderConclusion(data.conclusion);
  setupVideoSync();
}

function setupAudioExperience() {
  hydrateSpeechTokens();
  setupLatencyDemo();
  setupCloneDemo();
}

function setupLatencyDemo() {
  const button = document.querySelector("#playLatencyDemo");
  const summary = document.querySelector("#latencySummary");
  const rows = [...document.querySelectorAll("[data-line]")];
  if (!button || !summary || rows.length === 0) return;

  state.latencyAudio = new Audio(AUDIO_PATHS.source);
  state.latencyAudio.preload = "auto";
  resetLatencyRows(rows);

  button.addEventListener("click", () => startLatencyDemo(rows, summary, button));
  setupLatencyAutoPlay(rows, summary, button);
}

function hydrateSpeechTokens() {
  document.querySelectorAll(".speech-text").forEach((line) => {
    const text = line.dataset.copy || line.textContent.trim();
    const isCjk = /[\u3400-\u9fff]/.test(text);
    const tokens = isCjk
      ? [...text]
      : text.split(/\s+/).filter(Boolean);

    line.innerHTML = tokens.map((token) => {
      const gap = isCjk || /[.,!?;:]$/.test(token) ? "" : " has-gap";
      return `<span class="speech-token${gap}">${token}</span>`;
    }).join("");
  });
}

function startLatencyDemo(rows, summary, button, options = {}) {
  stopClonePlayback();
  if (state.latencyFrame) cancelAnimationFrame(state.latencyFrame);
  state.latencyAudio.pause();
  state.latencyAudio.currentTime = 0;
  resetLatencyRows(rows);
  summary.textContent = options.auto ? "自动演示中" : "演示中";
  button.classList.add("is-playing");
  button.querySelector("span:last-child").textContent = "重新演示";

  const startedAt = performance.now();
  const playback = state.latencyAudio.play();
  if (playback) {
    playback.catch(() => {
      if (options.auto) {
        summary.textContent = "点击开启声音";
      } else {
        summary.textContent = "浏览器阻止播放";
      }
      button.classList.remove("is-playing");
    });
  }
  runLatencyTimeline(rows, summary, button, startedAt);
}

function setupLatencyAutoPlay(rows, summary, button) {
  const card = document.querySelector(".interpretation-card");
  if (!card || !("IntersectionObserver" in window)) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const rect = entry.target.getBoundingClientRect();
      const fullyVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;
      const fallbackVisible = rect.height > window.innerHeight && entry.intersectionRatio >= 0.82;
      if (state.latencyAutoPlayed || (!fullyVisible && !fallbackVisible)) return;
      state.latencyAutoPlayed = true;
      startLatencyDemo(rows, summary, button, { auto: true });
      observer.disconnect();
    });
  }, { threshold: [0.5, 0.82, 0.98, 1] });

  observer.observe(card);
}

function resetLatencyRows(rows) {
  rows.forEach((row) => {
    const key = row.dataset.line;
    setLineProgress(row, 0);
    const output = row.querySelector("output");
    if (output) output.textContent = LATENCY_PROFILE[key].output;
  });
}

function runLatencyTimeline(rows, summary, button, startedAt) {
  const fallbackDuration = 4.4;
  const audioDuration = Number.isFinite(state.latencyAudio.duration) && state.latencyAudio.duration > 0
    ? state.latencyAudio.duration
    : fallbackDuration;
  const totalRun = audioDuration + Math.max(...Object.values(LATENCY_PROFILE).map((item) => item.completionLag));

  const tick = (now) => {
    const elapsed = (now - startedAt) / 1000;

    rows.forEach((row) => {
      const profile = LATENCY_PROFILE[row.dataset.line];
      const duration = audioDuration + profile.completionLag - profile.startDelay;
      const progress = profile.startDelay === 0
        ? elapsed / audioDuration
        : (elapsed - profile.startDelay) / duration;
      setLineProgress(row, progress);
    });

    if (elapsed < totalRun) {
      state.latencyFrame = requestAnimationFrame(tick);
      return;
    }

    rows.forEach((row) => setLineProgress(row, 1));
    setLatencyFinalOutputs(rows);
    summary.textContent = "全球语终字快 1.7s";
    button.classList.remove("is-playing");
  };

  state.latencyFrame = requestAnimationFrame(tick);
}

function setLineProgress(row, progress) {
  const safeProgress = Math.max(0, Math.min(1, progress));
  const tokens = [...row.querySelectorAll(".speech-token")];
  const activeCount = safeProgress <= 0 ? 0 : Math.ceil(safeProgress * tokens.length);
  row.style.setProperty("--reveal", safeProgress.toFixed(3));
  row.classList.toggle("is-speaking", safeProgress > 0 && safeProgress < 1);

  tokens.forEach((token, index) => {
    const isOn = index < activeCount || safeProgress >= 1;
    token.classList.toggle("is-on", isOn);
    token.classList.toggle("is-current", isOn && index === Math.max(0, activeCount - 1) && safeProgress < 1);
  });
}

function setLatencyFinalOutputs(rows) {
  const finalOutputs = {
    source: "音频完成",
    globalvoice: "质量 85.6 / 快 1.7s",
    iflytek: "质量 80.0 / 慢 1.7s"
  };

  rows.forEach((row) => {
    const output = row.querySelector("output");
    if (output) output.textContent = finalOutputs[row.dataset.line];
  });
}

function setupCloneDemo() {
  const button = document.querySelector("#playCloneDemo");
  const card = button ? button.closest(".advantage-card") : null;
  const items = card ? [...card.querySelectorAll(".advantage-item")] : [];
  const targetLine = document.querySelector('[data-line="globalvoice"]');
  const latencyButton = document.querySelector("#playLatencyDemo");
  const summary = document.querySelector("#latencySummary");
  if (!button || !card || items.length === 0 || !targetLine) return;

  state.cloneAudio = new Audio(AUDIO_PATHS.clone);
  state.cloneAudio.preload = "auto";

  button.addEventListener("click", () => {
    if (state.cloneFrame) cancelAnimationFrame(state.cloneFrame);
    if (state.latencyFrame) cancelAnimationFrame(state.latencyFrame);
    state.cloneFrame = null;
    state.latencyFrame = null;
    if (state.latencyAudio) state.latencyAudio.pause();
    if (latencyButton) {
      latencyButton.classList.remove("is-playing");
      latencyButton.querySelector("span:last-child").textContent = "重新演示";
    }
    if (summary) summary.textContent = "译文音频播放中";

    state.cloneAudio.pause();
    state.cloneAudio.currentTime = 0;
    setLineProgress(targetLine, 0);
    targetLine.querySelector("output").textContent = "译文播放中";
    card.classList.add("is-playing");
    button.classList.add("is-playing");
    button.querySelector("span:last-child").textContent = "播放中";

    const playback = state.cloneAudio.play();
    if (playback) {
      playback.catch(() => {
        card.classList.remove("is-playing");
        button.classList.remove("is-playing");
        button.querySelector("span:last-child").textContent = "播放译文音频";
        targetLine.querySelector("output").textContent = "播放失败";
      });
    }
    runCloneHighlights(items, button, card, targetLine);
  });

  state.cloneAudio.addEventListener("ended", () => {
    if (state.cloneFrame) cancelAnimationFrame(state.cloneFrame);
    state.cloneFrame = null;
    setLineProgress(targetLine, 1);
    targetLine.querySelector("output").textContent = "译文完成";
    if (summary) summary.textContent = "译文音频完成";
    card.classList.remove("is-playing");
    button.classList.remove("is-playing");
    button.querySelector("span:last-child").textContent = "重播";
    setActiveAdvantage(items, 2);
  });
}

function stopClonePlayback() {
  const button = document.querySelector("#playCloneDemo");
  const card = button ? button.closest(".advantage-card") : null;

  if (state.cloneFrame) cancelAnimationFrame(state.cloneFrame);
  state.cloneFrame = null;
  if (state.cloneAudio) {
    state.cloneAudio.pause();
    state.cloneAudio.currentTime = 0;
  }
  if (card) card.classList.remove("is-playing");
  if (button) {
    button.classList.remove("is-playing");
    button.querySelector("span:last-child").textContent = "播放译文音频";
  }
}

function runCloneHighlights(items, button, card, targetLine) {
  const tick = () => {
    const duration = Number.isFinite(state.cloneAudio.duration) && state.cloneAudio.duration > 0
      ? state.cloneAudio.duration
      : 6;
    const progress = Math.min(0.999, state.cloneAudio.currentTime / duration);
    setLineProgress(targetLine, progress);
    targetLine.querySelector("output").textContent = "译文播放中";
    setActiveAdvantage(items, Math.floor(progress * items.length));

    if (!state.cloneAudio.paused && !state.cloneAudio.ended) {
      state.cloneFrame = requestAnimationFrame(tick);
      return;
    }

    card.classList.remove("is-playing");
    button.classList.remove("is-playing");
  };

  state.cloneFrame = requestAnimationFrame(tick);
}

function setActiveAdvantage(items, activeIndex) {
  items.forEach((item, index) => {
    item.classList.toggle("active", index === activeIndex);
  });
}

function setupDemoCardMotion() {
  const cards = [...document.querySelectorAll("[data-demo-card]")];
  if (cards.length === 0) return;

  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.28 });
    cards.forEach((card) => observer.observe(card));
    return;
  }

  cards.forEach((card) => card.classList.add("is-visible"));
}

function vendorById(data, id) {
  return data.vendors.find((vendor) => vendor.id === id);
}

function formatValue(value, unit = "") {
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${text}${unit}`;
}

function getAdvantage(metric) {
  const diff = metric.globalvoice - metric.iflytek;
  if (metric.better === "lower") {
    return metric.unit === "秒" ? `快 ${Math.abs(diff).toFixed(1)} 秒` : `低 ${Math.abs(diff).toFixed(2)} 倍`;
  }
  if (metric.unit === "%") return "持平";
  return `+${diff.toFixed(1)}${metric.unit}`;
}

function renderVideos(data) {
  const grid = document.querySelector("#videoGrid");
  grid.innerHTML = data.vendors.map((vendor) => `
    <article class="video-card" data-video-card="${vendor.id}">
      <header class="video-card-head">
        <div class="video-brand">
          <img src="${vendor.logo}" alt="${vendor.name}">
          <span>${vendor.name}</span>
        </div>
        <span class="video-badge">${vendor.rank}</span>
      </header>
      <div class="video-shell">
        <video preload="none" controls playsinline data-vendor="${vendor.id}">
          <source src="${vendor.video}" type="video/mp4">
        </video>
        <div class="video-placeholder">
          <div>
            <strong>${vendor.shortName} 演示视频</strong>
            <small>点击按钮播放</small>
          </div>
        </div>
      </div>
    </article>
  `).join("");

  state.videos = [...grid.querySelectorAll("video")];
  state.videos.forEach((video) => {
    const card = video.closest(".video-card");
    const placeholder = card.querySelector(".video-placeholder");
    video.addEventListener("loadeddata", () => {
      placeholder.style.display = "none";
    });
    video.addEventListener("error", () => {
      placeholder.style.display = "grid";
      setVideoCardState(video, "加载失败");
    });
    video.addEventListener("play", () => setVideoCardState(video, video.muted ? "静音播放中" : "播放中"));
    video.addEventListener("pause", () => {
      if (!video.ended) setVideoCardState(video, "已暂停");
    });
    video.addEventListener("ended", () => {
      setVideoCardState(video, "已结束");
    });
    video.addEventListener("waiting", () => setVideoCardState(video, "缓冲中"));
  });
}

function setVideoCardState(video, label) {
  const card = video.closest(".video-card");
  if (!card) return;
  const status = card.querySelector(".video-status");
  if (status) status.textContent = label;
  card.classList.toggle("is-playing", !video.paused && !video.ended);
  card.classList.toggle("is-ended", video.ended);
}

function renderDemoScript(items) {
  document.querySelector("#demoScript").innerHTML = items.map((item, index) => `
    <article class="script-card">
      <b>${String(index + 1).padStart(2, "0")}</b>
      <h3>${item.step}</h3>
      <p><strong>全球语：</strong>${item.globalvoice}</p>
      <p><strong>x飞：</strong>${item.iflytek}</p>
    </article>
  `).join("");
}

function renderKpis(data) {
  const featured = ["quality", "firstFinal", "fullProcess", "realtimeFactor"];
  const metrics = featured.map((key) => data.kpis.find((metric) => metric.key === key));

  document.querySelector("#kpiGrid").innerHTML = metrics.map((metric) => `
    <article class="kpi-card">
      <header>
        <span>${metric.label}</span>
        <span class="delta">${getAdvantage(metric)}</span>
      </header>
      <strong>${formatValue(metric.globalvoice, "")}<small>${metric.unit}</small></strong>
      <p>${metric.description}；x飞为 ${formatValue(metric.iflytek, metric.unit)}。</p>
    </article>
  `).join("");
}

function renderRadar(data) {
  const metrics = data.kpis.filter((metric) => ["quality", "semantic", "naturalness", "tone", "localization"].includes(metric.key));
  const size = 560;
  const center = size / 2;
  const radius = 190;
  const max = 100;
  const angleStep = (Math.PI * 2) / metrics.length;
  const series = [
    { id: "globalvoice", label: "全球语", color: "#1769e0" },
    { id: "iflytek", label: "x飞", color: "#f97316" }
  ];

  const point = (index, value = max) => {
    const angle = -Math.PI / 2 + index * angleStep;
    const r = radius * (value / max);
    return [center + Math.cos(angle) * r, center + Math.sin(angle) * r];
  };

  const rings = [20, 40, 60, 80, 100].map((value) => {
    const points = metrics.map((_, index) => point(index, value).join(",")).join(" ");
    return `<polygon points="${points}" fill="none" stroke="#dbe5f1" stroke-width="1" />`;
  }).join("");

  const axes = metrics.map((metric, index) => {
    const [x, y] = point(index, 100);
    const [tx, ty] = point(index, 116);
    return `
      <line x1="${center}" y1="${center}" x2="${x}" y2="${y}" stroke="#dbe5f1" stroke-width="1" />
      <text x="${tx}" y="${ty}" text-anchor="middle" dominant-baseline="middle" class="axis-label">${metric.label}</text>
    `;
  }).join("");

  const polygons = series.map((item) => {
    const points = metrics.map((metric, index) => point(index, metric[item.id]).join(",")).join(" ");
    return `<polygon points="${points}" fill="${item.color}22" stroke="${item.color}" stroke-width="3" />`;
  }).join("");

  document.querySelector("#radarChart").innerHTML = `
    <svg viewBox="0 0 ${size} ${size}" role="img" aria-label="五维翻译质量雷达图">
      ${rings}
      ${axes}
      ${polygons}
    </svg>
    <div class="legend-row">
      ${series.map((item) => `<span><i class="legend-dot" style="background:${item.color}"></i>${item.label}</span>`).join("")}
    </div>
  `;
}

function renderGapChart(data) {
  const metrics = data.kpis.filter((metric) => ["quality", "semantic", "naturalness", "tone", "localization", "similarity"].includes(metric.key));
  const maxGap = Math.max(...metrics.map((metric) => Math.abs(metric.globalvoice - metric.iflytek)));

  document.querySelector("#gapChart").innerHTML = metrics.map((metric) => {
    const gap = metric.globalvoice - metric.iflytek;
    const width = Math.max(8, (Math.abs(gap) / maxGap) * 100);
    return `
      <div class="bar-row">
        <span>${metric.label}</span>
        <div class="bar-track"><div class="bar-fill" style="--w:${width}%"></div></div>
        <span class="bar-value">+${gap.toFixed(1)}</span>
      </div>
    `;
  }).join("");
}

function renderSpeedChart(data) {
  const metrics = data.kpis.filter((metric) => ["firstFinal", "fullProcess", "realtimeFactor"].includes(metric.key));
  const max = Math.max(...metrics.flatMap((metric) => [metric.globalvoice, metric.iflytek]));

  document.querySelector("#speedChart").innerHTML = metrics.map((metric) => {
    const globalWidth = Math.max(8, (metric.globalvoice / max) * 100);
    const iflytekWidth = Math.max(8, (metric.iflytek / max) * 100);
    return `
      <div class="bar-row">
        <span>${metric.label}</span>
        <div class="bar-track"><div class="bar-fill" style="--w:${globalWidth}%; background:#1769e0"></div></div>
        <span class="bar-value">${formatValue(metric.globalvoice, metric.unit)}</span>
      </div>
      <div class="bar-row">
        <span>x飞</span>
        <div class="bar-track"><div class="bar-fill" style="--w:${iflytekWidth}%; background:#f97316"></div></div>
        <span class="bar-value">${formatValue(metric.iflytek, metric.unit)}</span>
      </div>
    `;
  }).join("");
}

function renderMetricTable(data) {
  const globalVendor = vendorById(data, "globalvoice");
  const iflytekVendor = vendorById(data, "iflytek");
  const rows = data.kpis.map((metric) => {
    const globalWins = metric.better === "higher"
      ? metric.globalvoice >= metric.iflytek
      : metric.globalvoice <= metric.iflytek;
    const iflytekWins = metric.better === "higher"
      ? metric.iflytek > metric.globalvoice
      : metric.iflytek < metric.globalvoice;

    return `
      <tr>
        <td><strong>${metric.label}</strong><br><small>${metric.description}</small></td>
        <td class="${globalWins ? "win" : ""}">${formatValue(metric.globalvoice, metric.unit)}</td>
        <td class="${iflytekWins ? "win" : ""}">${formatValue(metric.iflytek, metric.unit)}</td>
        <td>${metric.better === "higher" ? "越高越好" : "越低越好"}</td>
      </tr>
    `;
  }).join("");

  document.querySelector("#metricTable").innerHTML = `
    <thead>
      <tr>
        <th>评估维度</th>
        <th>${globalVendor.shortName}</th>
        <th>${iflytekVendor.shortName}</th>
        <th>指标说明</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  `;
}

function renderCapabilityMatrix(data) {
  const statusMap = {
    yes: { className: "yes", label: "✓", text: "支持" },
    partial: { className: "partial", label: "○", text: "部分" },
    no: { className: "no", label: "×", text: "未覆盖" }
  };

  document.querySelector("#capabilityMatrix").innerHTML = data.capabilities.map((group) => `
    <section class="capability-group">
      <h3>${group.group}</h3>
      ${group.items.map((item) => `
        <div class="capability-row">
          <div class="capability-name">${item.name}</div>
          <div><span class="status ${statusMap[item.globalvoice].className}" title="${statusMap[item.globalvoice].text}">${statusMap[item.globalvoice].label}</span> 全球语</div>
          <div><span class="status ${statusMap[item.iflytek].className}" title="${statusMap[item.iflytek].text}">${statusMap[item.iflytek].label}</span> x飞</div>
          <div class="capability-note">${item.note}</div>
        </div>
      `).join("")}
    </section>
  `).join("");
}

function renderConclusion(conclusion) {
  document.querySelector("#conclusionHeadline").textContent = conclusion.headline;
  document.querySelector("#conclusionPoints").innerHTML = conclusion.points.map((point) => `<li>${point}</li>`).join("");
}

function setupVideoSync() {
  const playButton = document.querySelector("#syncPlay");
  const pauseButton = document.querySelector("#syncPause");
  const resetButton = document.querySelector("#syncReset");
  const lockSync = document.querySelector("#lockSync");
  const videoMode = document.querySelector("#videoMode");

  playButton.addEventListener("click", () => {
    startVideoPlayback();
    if (videoMode) videoMode.textContent = "同步播放中";
  });

  pauseButton.addEventListener("click", () => {
    state.videos.forEach((video) => video.pause());
    if (videoMode) videoMode.textContent = "已暂停";
  });

  resetButton.addEventListener("click", () => {
    state.videos.forEach((video) => {
      video.pause();
      video.currentTime = 0;
      setVideoCardState(video, "待播放");
    });
    if (videoMode) videoMode.textContent = "已重置";
  });

  state.videos.forEach((video) => {
    video.addEventListener("seeked", () => {
      if (!lockSync.checked || state.syncing) return;
      syncVideoPeers(video, 0.2);
    });

    video.addEventListener("timeupdate", () => {
      if (!lockSync.checked || state.syncing || video.paused || video.ended) return;
      syncVideoPeers(video, 0.45);
    });
  });
}

function startVideoPlayback() {
  state.videos.forEach((video) => {
    if (video.ended) video.currentTime = 0;
    const result = video.play();
    if (result) {
      result.catch(() => setVideoCardState(video, "播放受阻"));
    }
  });
}

function syncVideoPeers(source, tolerance) {
  if (source.ended) return;
  const sourceTime = source.currentTime;
  state.syncing = true;
  state.videos.forEach((target) => {
    if (target === source || target.ended) return;
    const nextTime = clampVideoTime(target, sourceTime);
    if (Math.abs(target.currentTime - nextTime) > tolerance) {
      target.currentTime = nextTime;
    }
  });
  state.syncing = false;
}

function getVideoDuration(video) {
  return Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
}

function clampVideoTime(video, time) {
  const duration = getVideoDuration(video);
  if (!duration) return Math.max(0, time);
  return Math.max(0, Math.min(time, Math.max(0, duration - 0.08)));
}
