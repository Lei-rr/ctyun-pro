<div align="center">

# CtYun Pro (天翼云电脑智能管理系统)

**纯协议长连接保活 · 智能补足挂机引擎 · 多账号免密集中调度 · 现代化 Web 控制台**

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/Lei-rr/ctyun-pro?include_prereleases&color=emerald)](https://github.com/Lei-rr/ctyun-pro/releases)
[![Docker](https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker)](https://github.com/Lei-rr/ctyun-pro/pkgs/container/ctyun-pro)
[![Node](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)

[功能特性](#-功能特性) • [系统架构](#-系统架构) • [快速开始](#-快速开始) • [配置说明](#-配置说明) • [底层协议说明](#-底层协议说明) • [免责声明](#-免责声明)

</div>

---

## 📖 项目简介

**CtYun Pro** 是一款专为天翼云电脑（CtYun Desktop）打造的多账号自动化运维、纯协议持久保活与每日积分任务管理系统。

系统核心结合了 **原生 WebSocket 协议通道持久在线保活** 与 **单例隔离无头浏览器智能挂机引擎（Puppeteer-Core）**：
1. **7×24h 极致轻量保活**：无需启动庞大的官方客户端，直接通过原生 WebSocket 协议通道维持心跳，内存占用仅约 30MB。
2. **智能补足挂机引擎**：针对官方「使用 1 小时」(+100 积分) 任务，自动读取官方真实累计时长，仅补齐缺失的分钟数；挂机启动前自动让出底层保活信道防踢，达标后自动退出并无缝交接恢复长连接保活。
3. **现代化响应式控制台**：全中文现代化 Web UI，支持多账号状态监控、开机关机控制、每日任务定时调度与官方商城自动兑换。

---

## ✨ 功能特性

- 🚀 **原生协议长连接保活**：基于官方 CLINK 协议通道维持 7×24h 稳定长连接与 30s 活跃心跳响应。
- 🏢 **全形态云电脑全面兼容**：深度聚合官方底层接口，完美支持普通独立机（公众版/个人版）、**政企桌面池（POOL，政企企业级核心形态）**与抢占式桌面（Preemption），自适应动态下发 `objId` 与 `objType` 信令，企业政企账号即登即用。
- 📲 **新设备智能安全绑定**：原生对接官方设备安全白名单认证体系，已绑定的熟设备无感秒登，新设备首次登录自动拉起短信二次认证，绑定成功后永久免验。
- ⚡ **智能补足挂机引擎**：
  - 自动读取官方真实累计时长，精准计算并补齐剩余分钟数；
  - 多账号共享单例 Chromium 进程，通过独立上下文（`BrowserContext`）严格隔离；
  - 挂机前自动让出保活信道，挂机完成后无缝恢复长连接保活。
- 🖥️ **实例管理与电源控制**：天翼云电脑实例列表查询、实时状态同步，支持纯图标一键远程开机、关机与重启，并提供高可用防误触弹窗二次确认。开机状态自动异步轮询，就绪后秒级恢复保活。
- ⏰ **全自动任务打卡**：支持配置每日定时执行：
  - 登录云电脑会话激活（+100 积分）；
  - 云智助手 AI 对话打卡（+100 积分）；
  - 智能补时挂机满 1 小时（+100 积分）。
- 🎁 **离线积分商城与自动兑换**：
  - 本地化离线商品库，支持一键与官方商城同步最新产品；
  - 自动识别天翼云「精英版 / 尊享版 (8C16G)」、「标准版 (4C8G)」、「旗舰版 (16C32G)」规格；
  - 支持配置月末最后一天或每月指定日期自动消耗积分兑换 8C16G 升配包。
- 📊 **今日积分获取实时看板**：控制台仪表盘新增「今日已获积分」统计看板，开机自动预载并实时追踪当日积分入账情况。
- 🔔 **多渠道 Webhook 实时推送**：支持配置通用 Webhook、Server酱、Bark、企业微信机器人、飞书机器人与钉钉机器人，在每日打卡完成、自动兑换成功或发生异常时即时提醒。
- 🛡️ **生产级高可用架构**：
  - **原子化文件落盘**：配置与账号凭据采用临时文件 + 原子替换，彻底杜绝服务器断电或强杀导致的文件损坏；
  - **进程优雅停机**：捕获 SIGINT / SIGTERM 信号，安全关闭长连接与挂机浏览器内核，释放全部系统资源；
  - **60s 网络超时保护**：所有外部官方通信均带 60s 严格超时兜底，防止网络抖动阻塞主事件循环。
- 📜 **实时日志与智能防刷屏**：
  - WebSocket / SSE 全双工实时推流；
  - **多账号智能折叠**：支持宁夏、上海等多账号交替输出时独立计数合并（如 `x45 [上海] 心跳`）；
  - **最新日志自动置底**：被折叠的活跃日志更新时实时上浮置底，状态一目了然。
- 🎨 **现代化精致前端**：基于 Vue 3 + Tailwind CSS + Radix UI 设计规范，深度适配桌面端与移动端，内置深色高对比度主题。

---

## 🏗️ 目录结构

```text
ctyun-pro/
├── src/
│   ├── core/                    # 核心底层与协议封装
│   │   ├── account-manager.ts   # 多账号生命周期、状态维护与数据持久化
│   │   ├── client.ts            # 天翼云官方 OpenAPI 客户端 (签名/请求)
│   │   ├── logger.ts            # 全局日志中心 (带多账号智能折叠与置底保持)
│   │   └── protocol.ts          # CLINK 协议报文打包、解析与 RSA-OAEP Ticket
│   ├── keepalive/               # 长连接保活模块
│   │   ├── keepalive-manager.ts # 多账号 Worker 调度与生命周期管理
│   │   └── worker.ts            # MAIN 协议信道维护与 30s 心跳机制
│   ├── tasks/                   # 自动化任务系统
│   │   ├── ai-chat.ts           # 云智助手每日 AI 对话任务
│   │   ├── hang.ts              # 单例隔离智能挂机引擎 (Puppeteer-Core)
│   │   ├── redeem.ts            # 积分商城自动兑换处理器
│   │   ├── scheduler.ts         # 准点调度器 (Asia/Shanghai 时区)
│   │   ├── sign.ts              # 云手机/云电脑签到
│   │   └── task-runner.ts       # 每日综合任务链编排
│   ├── config.ts                # 系统运行配置与持久化路径定义
│   ├── server.ts                # Fastify Web 服务、API 路由与 WebSocket 订阅
│   └── index.ts                 # 服务端主入口
├── web/                         # Vue 3 现代化 Web 控制台
│   ├── src/
│   │   ├── stores/app.ts        # 全局状态管理 (Pinia)
│   │   ├── views/               # 控制台页面 (概览、实时日志等)
│   │   └── shared/ui/           # 现代化 UI 组件集
│   └── vite.config.ts           # 前端构建配置
├── Dockerfile                   # 生产环境镜像构建文件 (带 Chromium 支持)
└── docker-compose.yml           # 容器编排配置
```

---

## 🚀 快速开始

### 方式一：Docker 运行（推荐）

通过 GitHub Container Registry (GHCR) 直接拉取构建好的镜像启动：

```bash
docker run -d \
  --name ctyun-pro \
  --restart always \
  -p 3088:3088 \
  -v /data/ctyun-pro:/app/data \
  ghcr.io/lei-rr/ctyun-pro:latest
```

启动完成后，打开浏览器访问：`http://你的服务器IP:3088`

### 方式二：Docker Compose 编排

在项目根目录下直接使用 `docker-compose.yml` 启动：

```bash
docker compose up -d
```

### 方式三：源码运行

环境要求：
- **Node.js 20+**
- **Chromium / Chrome 浏览器内核**（若使用智能补足挂机功能必须安装）

#### 1. 系统依赖安装命令（按系统选择）：

> 💡 **提示**：智能挂机补时功能依赖系统底层 Chromium 浏览器。若日志提示 `系统未找到可用 Chromium 浏览器内核`，直接复制执行下方对应系统的命令即可解决：

- **Ubuntu / Debian**：
  ```bash
  # 1. 安装 Chromium 浏览器
  sudo apt-get update && sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium

  # 2. 安装 Node.js 20 (若未安装)
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```

- **CentOS / Rocky Linux / AlmaLinux**：
  ```bash
  # 1. 安装 Chromium 浏览器
  sudo dnf install -y epel-release && sudo dnf install -y chromium

  # 2. 安装 Node.js 20 (若未安装)
  curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
  sudo dnf install -y nodejs
  ```

- **Alpine Linux**：
  ```bash
  apk add --no-cache nodejs npm chromium
  ```

- **检查验证**：
  ```bash
  which chromium || which chromium-browser || which google-chrome
  # 输出任意路径（如 /usr/bin/chromium）即代表环境就绪
  ```

#### 2. 编译与启动服务：

```bash
# 1. 克隆代码仓库
git clone https://github.com/Lei-rr/ctyun-pro.git
cd ctyun-pro

# 2. 安装依赖
npm install

# 3. 编译服务端与 Web 前端
npm run build

# 4. 启动服务
npm start
```

服务默认监听 `http://127.0.0.1:3088`。

---

## ⚙️ 配置说明

服务端支持通过环境变量进行自定义配置：

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `3088` | Web 控制台与 HTTP API 监听端口 |
| `HOST` | `0.0.0.0` | 服务监听的 IP 地址 |
| `CTYUN_DATA_DIR` | `/app/data` (Docker) 或 `./data` | 持久化数据存放目录（账号配置、会话凭证等） |
| `TZ` | `Asia/Shanghai` | 定时任务与系统日志使用的时区（镜像内默认内置） |
| `ADMIN_PASSWORD` | `无` | 可选系统管理员访问密码 (亦可在 Web 设置中指定) |

> ⚠️ **安全提示**：数据目录内包含敏感的账号登录凭据与设备指纹，请妥善保管，勿将其提交至公开 Git 仓库。

---

## 🔬 底层协议说明

### 保活连接流程

```text
获取桌面连接信息
  │
  ├─► 1. 建立 MAIN WebSocket
  │     └─► 发送连接握手配置 JSON
  │
  ├─► 2. 等待 500ms 发送初始握手帧
  │     └─► 特征帧: UkVEUQIAAAACAAAAGgAAAAAAAAABAAEAAAABAAAAEgAAAAkAAAAECAAA
  │
  ├─► 3. 开启官方标准的 30s 活跃心跳定时器
  │     └─► 发送二进制保活 Ping 帧
  │
  └─► 4. 响应服务端信令校验
        ├─► 监听并响应服务端 REDQ 动态加密校验
        └─► 监听并响应 Type 103 用户身份探测
```

---

## 🛡️ 免责声明

1. 本项目仅供编程学习、网络协议分析以及个人对所属云资源的合法自动化运维使用。
2. 使用本项目时，请自觉遵守天翼云相关用户协议与活动规则，严禁将本项目用于未授权访问、高频滥用或侵犯他人合法权益的行为。
3. 作者不对因使用本项目导致的任何账号异常、服务受限或数据丢失等后果承担法律责任，使用者应自行评估并承担相应风险。

---

## 📄 开源许可证

本项目采用 [MIT License](LICENSE) 开源许可证。
