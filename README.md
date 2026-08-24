# AI Voicelink Conference 竞品对比演示页

用于展示 **AI Voicelink - Conference（页面中展示为「全球语-会译通」）** 与对比产品的会议同传能力、延迟、处理效率和产品工作流。页面既可作为静态演示页使用，也可选择启动本地实时同传后端，直接在浏览器中采集麦克风音频进行模型体验。

> 对比指标、文案、音视频均为项目演示素材。对外发布或更新结论前，请先确认测试样本、数据来源和品牌表述。

## 功能概览

- 响应式竞品对比页：支持桌面和移动端导航。
- 数据驱动的 KPI、雷达图、差距图、指标表和能力矩阵。
- 双视频同步播放与延迟、声纹克隆效果演示。
- 可选的实时同传控制台：浏览器麦克风采集、文本回传和译音播放。
- 实时后端支持火山 AST、阿里云 Qwen LiveTranslate 和讯飞同传；实际可用性取决于已配置的服务密钥与语种限制。

## 项目结构

```text
compare-demo/
├─ index.html                    # 页面结构、静态文案和实时控制台
├─ style.css                     # 页面样式及响应式规则
├─ script.js                     # 图表渲染、音视频交互、WebSocket 客户端
├─ data/comparison-data.json     # 对比品牌、指标、视频等展示数据
├─ assets/audio/                 # 延迟与译音演示音频
├─ images/                       # Logo 与页面图片
├─ videos/                       # 对比演示视频
├─ manual/
│  ├─ conference.html             # 会译通客户操作手册（独立 HTML）
│  └─ app.html                    # AI VoiceLink App 操作手册（独立 HTML）
├─ backend/
│  ├─ live_demo_server.py        # 浏览器与各同传服务之间的 WebSocket 桥接服务
│  ├─ ast_live_client.py         # 火山 AST 客户端
│  ├─ livetranslate_client.py    # 阿里 Qwen LiveTranslate 客户端
│  ├─ python_protogen/           # 火山 AST 所需的生成 protobuf 文件
│  └─ .env                       # 本地密钥（不纳入 Git）
└─ package.json                  # 前端开发依赖（Playwright）
```

`manual/conference.html` 和 `manual/app.html` 均为可独立打开的交互式 HTML 手册，不依赖实时同传后端。发布静态站点时请一并保留 `manual/` 目录。

## 快速启动

### 1. 运行静态页面

页面需要 HTTP Server 才能读取 `data/comparison-data.json`；不要直接双击打开 `index.html`。

在项目根目录运行：

```bash
python -m http.server 8000
```

然后访问 [http://127.0.0.1:8000](http://127.0.0.1:8000)。静态图表、视频、预置音频演示均可使用，无需配置任何 API 密钥。若系统将 Python 3 命令命名为 `python3` 或 `py`，请以对应命令替换 `python`。

### 2. 启动实时同传后端（可选）

实时演示需要 Python 3.10+。建议使用虚拟环境，避免将依赖安装到系统 Python：

```bash
cd backend
python -m venv .venv
# macOS / Linux
source .venv/bin/activate
# Windows PowerShell：.\.venv\Scripts\Activate.ps1
python -m pip install websockets python-dotenv protobuf
```

安装完成后，在 `backend/` 目录启动服务：

```bash
python live_demo_server.py
```

服务默认监听 `ws://127.0.0.1:8765`。当页面运行在 `localhost` 或 `127.0.0.1` 时，前端会自动连接此地址。启动成功后，在页面的“实时同传”区域选择模型并点击“开始实时同传”，浏览器会请求麦克风权限。

仓库会忽略所有 `.ps1` 文件；如需团队共用启动脚本，请提供跨平台脚本或将 PowerShell 脚本的使用方式另行记录，避免依赖个人 Conda 路径。

## 实时服务配置

在 `backend/.env` 中配置密钥。该文件已被 `.gitignore` 排除，严禁提交真实密钥。

```dotenv
# 阿里 Qwen LiveTranslate
DASHSCOPE_API_KEY=your_dashscope_key

# 火山 AST：二选一认证方式
AST_API_KEY=your_ast_api_key
# AST_APP_KEY=your_ast_app_key
# AST_ACCESS_KEY=your_ast_access_key
# AST_RESOURCE_ID=volc.service_type.10053

# 讯飞同传（也兼容 APPID / APISecret / APIKey 这组旧变量名）
IFLYTEK_APPID=your_app_id
IFLYTEK_API_SECRET=your_api_secret
IFLYTEK_API_KEY=your_api_key

# 可选参数
# AST_TTS_RESOURCE_ID=seed-icl-2.0
# IFLYTEK_TTS_VOICE=x2_catherine
# IFLYTEK_CLOSE_GRACE_SECONDS=8
# LIVE_DEMO_HOST=127.0.0.1
# LIVE_DEMO_PORT=8765
```

模型语种限制由前端 `script.js` 和后端 `backend/live_demo_server.py` 同时校验：

| 模型 | 支持情况 |
| --- | --- |
| 火山 AST | 中文、英语、德语、法语、西班牙语、印尼语、日语、葡萄牙语；源或目标语言至少一端须为中/英。 |
| 阿里 Qwen LiveTranslate | 覆盖 30 余种页面列出的语言，具体能力以阿里云服务权限为准。 |
| 讯飞同传 | 当前仅允许中文普通话 → 英语，且页面标明不提供声纹克隆。 |

## 常见修改入口

| 需求 | 修改位置 |
| --- | --- |
| 修改指标、结论、视频路径或品牌资料 | `data/comparison-data.json` |
| 修改页面静态文案、区块顺序或实时面板 | `index.html` |
| 修改交互、图表、视频同步或 WebSocket 行为 | `script.js` |
| 修改视觉样式和移动端适配 | `style.css` |
| 修改实时模型协议、鉴权或服务端事件 | `backend/live_demo_server.py` 及对应客户端文件 |
| 替换演示媒体 | `assets/audio/`、`images/`、`videos/`，并同步更新引用路径 |

更新展示数据时，建议保留 `comparison-data.json` 的字段结构：`vendors` 提供品牌、Logo、视频；`kpis` 提供数值及“越高/越低越好”规则；其余数组用于表格、能力矩阵和结论渲染。

## 部署说明

- 仅展示静态内容时，将项目根目录作为静态站点发布即可；必须保留 `data`、`assets`、`images` 和 `videos` 的相对目录结构。
- 操作手册需随站点一并发布：会译通手册位于 `/manual/conference.html`，App 手册位于 `/manual/app.html`。
- 开启实时同传时，生产环境前端不再连接 `:8765`，而会连接同域的 `ws(s)://<站点>/live`。因此需要由 Nginx、Caddy 或应用网关将 `/live` 的 WebSocket 请求反向代理到 `live_demo_server.py`。
- 麦克风采集在生产环境应通过 HTTPS 提供；现代浏览器通常只对 `localhost` 放宽该限制。
- 不要把 `backend/.env`、服务商密钥或内部测试原始资料部署到公开静态站点。

## 验收清单

1. 通过本地 HTTP Server 打开页面，确认没有“无法读取数据”提示。
2. 检查两段视频可播放，且“同步播放 / 暂停”按钮正常工作。
3. 检查延迟、声纹克隆演示音频和移动端菜单。
4. 如交接实时功能：确认后端出现 `Live demo backend listening on ws://127.0.0.1:8765`，配置正确密钥后验证至少一个模型的连通、字幕和译音输出。
5. 发布前复核 `data/comparison-data.json` 中的测试日期、对比结论、素材版权及脱敏后的品牌文案。

## 当前维护提示

- 仓库会忽略所有 `.ps1` 脚本；它们仅用于本地辅助启动，不应作为项目必需环境配置。
- 仓库目前没有锁定 Python 依赖的 `requirements.txt` 或自动化前端构建流程；若计划长期维护，建议补充依赖锁定、真实密钥的 `.env.example` 模板，以及部署环境的 WebSocket 反向代理配置。
