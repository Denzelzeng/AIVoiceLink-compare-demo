const DATA_URL = "data/comparison-data.json";
const state = {
  data: null,
  videos: [],
  syncing: false
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
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
    <article class="video-card">
      <header class="video-card-head">
        <img src="${vendor.logo}" alt="${vendor.name}">
        <span>${vendor.rank}</span>
      </header>
      <div class="video-shell">
        <video preload="none" controls playsinline data-vendor="${vendor.id}">
          <source src="${vendor.video}" type="video/mp4">
        </video>
        <div class="video-placeholder">
          <div>
            <strong>${vendor.shortName} 演示视频位</strong>
            <small>${vendor.video}</small>
          </div>
        </div>
      </div>
    </article>
  `).join("");

  state.videos = [...grid.querySelectorAll("video")];
  state.videos.forEach((video) => {
    const placeholder = video.parentElement.querySelector(".video-placeholder");
    video.addEventListener("loadeddata", () => {
      placeholder.style.display = "none";
    });
    video.addEventListener("error", () => {
      placeholder.style.display = "grid";
    });
  });
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

  playButton.addEventListener("click", () => {
    state.videos.forEach((video) => {
      const result = video.play();
      if (result) result.catch(() => {});
    });
  });

  pauseButton.addEventListener("click", () => {
    state.videos.forEach((video) => video.pause());
  });

  resetButton.addEventListener("click", () => {
    state.videos.forEach((video) => {
      video.pause();
      video.currentTime = 0;
    });
  });

  state.videos.forEach((video) => {
    video.addEventListener("seeked", () => {
      if (!lockSync.checked || state.syncing) return;
      state.syncing = true;
      state.videos.forEach((other) => {
        if (other !== video && Math.abs(other.currentTime - video.currentTime) > 0.2) {
          other.currentTime = video.currentTime;
        }
      });
      state.syncing = false;
    });

    video.addEventListener("timeupdate", () => {
      if (!lockSync.checked || state.syncing || video.paused) return;
      const driftTarget = state.videos.find((other) => other !== video && Math.abs(other.currentTime - video.currentTime) > 0.45);
      if (!driftTarget) return;
      state.syncing = true;
      driftTarget.currentTime = video.currentTime;
      state.syncing = false;
    });
  });
}
