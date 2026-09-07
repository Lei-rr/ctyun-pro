<div align="center">

# CTYUN-PRO

_✨ 天翼云电脑多账号纯协议持久保活 · 智能补足挂机引擎 · 每日任务全自动 · 现代化 Web 控制台 ✨_

<p align="center">
  <a href="https://github.com/Lei-rr/ctyun-pro/releases/latest">
    <img src="https://img.shields.io/github/v/release/Lei-rr/ctyun-pro?color=brightgreen&include_prereleases" alt="release">
  </a>
  <a href="https://github.com/Lei-rr/ctyun-pro/pkgs/container/ctyun-pro">
    <img src="https://img.shields.io/badge/docker-ghcr.io-blue?logo=docker" alt="docker pull">
  </a>
  <a href="https://nodejs.org/">
    <img src="https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg" alt="node">
  </a>
  <a href="https://github.com/Lei-rr/ctyun-pro/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license">
  </a>
  <a href="https://github.com/Lei-rr/ctyun-pro/stargazers">
    <img src="https://img.shields.io/github/stars/Lei-rr/ctyun-pro?color=yellow" alt="stars">
  </a>
</p>

<p align="center">
  <a href="#-部署教程">部署教程</a>
  ·
  <a href="#-功能特性">功能特性</a>
  ·
  <a href="#-配置参数">配置参数</a>
  ·
  <a href="#-常见问题-faq">常见问题 FAQ</a>
  ·
  <a href="#-免责声明">免责声明</a>
  ·
  <a href="https://github.com/Lei-rr/ctyun-pro/issues">意见反馈</a>
</p>

</div>

> [!NOTE]
> 🐳 **官方 Docker 镜像地址**：`ghcr.io/lei-rr/ctyun-pro:latest` 或指定版本 `ghcr.io/lei-rr/ctyun-pro:v1.2.1`  
> 镜像内已预置全套中文字体与 Chromium 无头浏览器内核，无需在宿主机额外配置浏览器环境，开箱即用！

> [!WARNING]
> ⚠️ **数据安全提示**：持久化数据目录内包含敏感的账号登录凭据与设备指纹，请妥善保管宿主机映射目录，切勿将数据文件公开泄露！

---

## 📖 项目简介

**CTYUN-PRO** 是一款专为天翼云电脑（CtYun Desktop）打造的生产级多账号集中运维管理系统。系统彻底摆脱臃肿的官方桌面客户端，基于底层 WebSocket 协议长连接与无头浏览器隔离挂机引擎，实现 7×24 小时低资源消耗稳定在线与自动化打卡升配。

- ⚡ **超轻量化运行**：单账号协议保活内存占用仅约 **30MB**，比官方客户端轻量 95% 以上，1C1G 甚至低配 VPS 均可轻松多开。
- 🎯 **精准智能挂机**：动态读取官方接口当前累计秒数，仅补足剩余时长；挂机时自动释放保活信道防踢，达标后无缝交接并秒级同步积分。
- 🪙 **全自动赚积分**：每日定时打卡、AI 对话、自动挂机，稳定拿满每日 300 积分；月末全自动消耗积分抢兑 8C16G 旗舰配置。

---

## ✨ 功能特性

+ [x] **7×24h 纯协议长连接保活**：基于天翼云官方 CLINK 协议通道，内置官方标准的 30s 活跃心跳与 REDQ 二进制动态握手，真正做到稳定不掉线。
+ [x] **全形态云电脑全面兼容**：深度兼容普通独立机（公众版/个人版）、抢占式桌面（Preemption）以及**政企桌面池（POOL，政企企业级核心形态）**，自适应信令下发。
+ [x] **智能补足挂机引擎 (Puppeteer-Core)**：
  + 自动实时查询官方任务累计时长，精准计算并补齐剩余分钟数；
  + 多账号单例 Chromium 进程池管理，`BrowserContext` 上下文沙箱强隔离；
  + 挂机前自动避让保活长连接，挂机完成后无缝恢复保活，自动触发今日积分结算刷新。
+ [x] **实例管理与电源控制**：云电脑实时运行状态监控，支持纯图标一键远程开机、关机与即时重启，并配备高可用防误触弹窗二次确认。
+ [x] **每日任务全自动流水线**：
  + 每日登录云电脑会话激活（+100 积分）；
  + 云智助手 AI 对话打卡（+100 积分）；
  + 智能补时挂机满 1 小时（+100 积分）。
+ [x] **离线积分商城与自动兑换**：
  + 本地化离线商品库缓存，支持一键强制拉取官方最新商品；
  + 自动识别匹配天翼云「8C16G 尊享版 / 4C8G 标准版 / 16C32G 旗舰版」规格；
  + 支持配置月末最后一天、每月指定日期或固定天数间隔自动执行积分升配。
+ [x] **设备安全白名单认证**：原生对接天翼云官方设备安全认证体系，已绑定熟设备秒级静默登录，新设备首次登录自动拉起短信二次认证。
+ [x] **今日积分实时看板**：控制台仪表盘实时统计当日积分获取总额，开机自动预载，挂机完成秒级跳变刷新。
+ [x] **全渠道 Webhook 通知**：支持配置企业微信机器人、钉钉机器人、飞书机器人、Server酱、Bark 与通用 Webhook，任务完成或异常即时通知。
+ [x] **生产级高可用架构**：采用原子化临时文件落盘（拒绝断电配置损坏）、优雅停机资源回收与 60s 网络超时保护。
+ [x] **现代化精致控制台**：基于 Vue 3 + Tailwind CSS + Radix UI 设计规范，支持深色高对比度主题切换、多账号日志智能折叠与置底。

---

## 🚀 部署教程

### 方式一：Docker 一键部署（强烈推荐 👍）

无需在宿主机安装任何浏览器依赖，拉取镜像即可开箱即用：

```bash
docker run -d \
  --name ctyun-pro \
  --restart unless-stopped \
  -p 3088:3088 \
  -v /data/ctyun-pro:/app/data \
  ghcr.io/lei-rr/ctyun-pro:latest
```

启动成功后，使用浏览器访问：`http://你的服务器IP:3088`

---

### 方式二：Docker Compose 编排部署

在宿主机创建 `docker-compose.yml` 文件：

```yaml
services:
  ctyun-pro:
    image: ghcr.io/lei-rr/ctyun-pro:latest
    container_name: ctyun-pro
    restart: unless-stopped
    ports:
      - "3088:3088"
    volumes:
      - ./data:/app/data
    environment:
      - PORT=3088
      - HOST=0.0.0.0
      - TZ=Asia/Shanghai
```

执行启动命令：

```bash
docker compose up -d
```

---

### 方式三：源码本地编译运行

#### 1. 系统依赖安装（按需执行）
智能补足挂机引擎依赖系统底层 Chromium 浏览器。如果在执行智能挂机时提示内核缺失，执行下方对应发行版命令即可：

- **Ubuntu / Debian**：
  ```bash
  sudo apt-get update && sudo apt-get install -y chromium-browser nodejs npm || sudo apt-get install -y chromium nodejs npm
  ```
- **CentOS / RHEL / Rocky Linux**：
  ```bash
  sudo dnf install -y epel-release && sudo dnf install -y chromium nodejs npm
  ```
- **Alpine Linux**：
  ```bash
  apk add --no-cache nodejs npm chromium
  ```

#### 2. 克隆与编译启动
```bash
# 1. 克隆代码仓库
git clone https://github.com/Lei-rr/ctyun-pro.git
cd ctyun-pro

# 2. 安装项目依赖
npm install

# 3. 编译后端与 Web 前端
npm run build

# 4. 启动服务
npm start
```

---

## ⚙️ 配置参数

系统支持通过环境变量进行自定义配置：

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `3088` | Web 控制台与 HTTP API 服务端口 |
| `HOST` | `0.0.0.0` | 服务监听绑定的网络地址 |
| `CTYUN_DATA_DIR` | `/app/data` (Docker) 或 `./data` | 持久化数据存放目录（��号信息、配置、日志等） |
| `TZ` | `Asia/Shanghai` | 定时任务与日志时区（推荐保持东八区） |
| `ADMIN_PASSWORD` | `空` | 可选系统管理员访问密码（可在 Web 控制台随时修改） |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` (Docker) | Chromium 内核执行文件路径 |

---

## ❓ 常见问题 (FAQ)

<details>
<summary><b>Q: 为什么挂机 1 小时任务提示“未找到进入AI云电脑按钮”？</b></summary>
<br>
A: 天翼云官方在云电脑处于「已关机」状态时，卡片上显示的是「开机」按钮，此时不存在「进入」按钮。请先在控制台点击云电脑开机，或开启账号的自动保活（系统开机就绪后会自动接入），待云电脑运行中时即可正常挂机。
</details>

<details>
<summary><b>Q: 多账号挂机时会相互冲突或者挤下线吗？</b></summary>
<br>
A: 完全不会。CTYUN-PRO 后端采用单例 Chromium 浏览器多上下文隔离设计（BrowserContext 沙箱隔离），不同账号的 Cookies、LocalStorage 与缓存互不干扰；且挂机启动时会自动优雅让出底层的保活长连接信道，防止多端登录互踢。
</details>

<details>
<summary><b>Q: 数据如何备份和迁移到新机器？</b></summary>
<br>
A: 系统的所有账号凭据、任务设置与商品目录均保存在映射的持久化数据目录（如 `/data/ctyun-pro`）下。迁移机器时，直接将该目录完整打包复制到新服务器的对应路径，重新运行 Docker 容器即可无缝恢复所有数据。
</details>

<details>
<summary><b>Q: 如何修改管理员登录密码？</b></summary>
<br>
A: 可以直接在容器启动时传入环境变量 `-e ADMIN_PASSWORD=你的新密码`，或者登录 Web 控制台后，进入系统设置面板进行图形化修改。
</details>

---

## 🛡️ 免责声明

1. **本项目仅供编程学习、计算机网络协议逆向分析以及个人对所属合法天翼云资源的自动化运维使用**。
2. 使用本项目时，使用者必须严格遵守天翼云官方相关用户服务协议与活动规则，**严禁将本项目用于未授权批量访问、网络攻击、商业牟利或任何侵犯第三方合法权益的违法违规行为**。
3. 本项目为开源软件，作者不对因使用本项目（包括但不限于账号异常、服务受限、积分清零、资源回收或数据丢失等）导致的任何直接或间接后果承担法律责任。
4. 使用者在部署与运行本项目时，即代表已充分理解并自愿承担可能产生的所有风险。

---

## 🌟 Star 历史趋势

[![Star History Chart](https://api.star-history.com/svg?repos=Lei-rr/ctyun-pro&type=Date)](https://github.com/Lei-rr/ctyun-pro/stargazers)

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 协议开源。
