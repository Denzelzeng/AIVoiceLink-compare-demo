const DATA_URL = "data/comparison-data.json";
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
  latencyAutoPlayed: false
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  setupAudioExperience();
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
      <p><strong>讯飞：</strong>${item.iflytek}</p>
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
      <p>${metric.description}；讯飞为 ${formatValue(metric.iflytek, metric.unit)}。</p>
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
    { id: "iflytek", label: "讯飞", color: "#f97316" }
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
        <span>讯飞</span>
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
          <div><span class="status ${statusMap[item.iflytek].className}" title="${statusMap[item.iflytek].text}">${statusMap[item.iflytek].label}</span> 讯飞</div>
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
