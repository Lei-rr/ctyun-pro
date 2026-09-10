<div align="center">

# ⚡ CTYUN-PRO (天翼云电脑智能管理运维系统)

_✨ 天翼云电脑多账号纯协议持久保活 · 纯协议智能挂机 · 每日任务全自动 · 现代化 Web 控制台 ✨_

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Docker Image Size](https://img.shields.io/badge/Docker%20Image-~80MB-brightgreen.svg)](https://github.com/Lei-rr/ctyun-pro/pkgs/container/ctyun-pro)
[![Release](https://img.shields.io/github/v/release/Lei-rr/ctyun-pro?color=orange)](https://github.com/Lei-rr/ctyun-pro/releases)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-green.svg)](https://nodejs.org/)

<p align="center">
  <a href="#-核心亮点">核心亮点</a> •
  <a href="#-部署教程">部署教程</a> •
  <a href="#-纯二进制运行免-docker">原生单二进制运行</a> •
  <a href="#-系统架构">系统架构</a> •
  <a href="#-环境变量">环境变量</a> •
  <a href="#-常见问题-faq">常见问题</a>
</p>

</div>

---

### 💡 为什么选择 CTYUN-PRO？

传统的云电脑保活与挂机脚本大多依赖重型无头浏览器（Puppeteer/Chromium）或 Windows 桌面客户端，不仅内存占用动辄 1.5GB ~ 2GB，在弱网或小内存 VPS 上频繁崩溃，还经常由于抢占桌面造成官方客户端无法登录。

**CTYUN-PRO 2.0.0** 经过全面架构重构，彻底砍掉了一切浏览器及系统桌面依赖，全流程基于 Node.js 原生 HTTP 与 WebSocket 二进制 Clink 协议驱动：
- 内存开销骤降 **95%**，单容器仅占用数十兆内存；
- 日常 3 项任务与挂机时长彻底解耦，无论是否需要 1 小时时长任务，签到与打卡均 100% 稳定结算；
- 具备官方客户端上线智能避让感知，绝不影响真实客户端使用！

> 💡 **镜像源提示**：
> - **GitHub 官方源（海外/默认）**：`ghcr.io/lei-rr/ctyun-pro:latest` 或 `ghcr.io/lei-rr/ctyun-pro:v2.0.0`
> - **阿里云高速源（国内推荐 ⚡）**：`crpi-kbafcu5p49r7b1k1.cn-hangzhou.personal.cr.aliyuncs.com/lei-rr/ctyun-pro:latest` 或 `crpi-kbafcu5p49r7b1k1.cn-hangzhou.personal.cr.aliyuncs.com/lei-rr/ctyun-pro:v2.0.0`
> 纯协议极轻量镜像，全平台通用，无需在宿主机额外配置任何浏览器或动态库环境，开箱即用！

---

## 🌟 核心特性

**CTYUN-PRO** 是一款专为天翼云电脑（CtYun Desktop）打造的生产级多账号集中运维管理系统。

- ⚡ **纯协议零浏览器**：彻底砍掉 Chromium/Playwright 以及 Windows 客户端依赖，挂机与保活完全采用二进制 Clink 握手与心跳协议，CPU 与内存开销骤降（镜像仅约数十兆）。
- 🔌 **双模式协议解耦**：
  + **日常保活（开机防休眠）**：保持旁观者长连接（只响应 Type 118 身份应答），绝不发送独占认领包，手机 App 与 PC 客户端随时登录零冲突；
  + **任务挂机（1小时时长累加）**：按需发送独占认领包与 Type 104 就绪包，维持 5 秒 Type 7 二进制心跳；深度监听 Type 119/120/137 抢占信号，官方客户端连入自动让位。
- 🔄 **日常任务与挂机彻底解耦**：
  + 挂机开关关闭时，每日签到（+100）、AI 对话（+100）、登录云电脑（+100）3 项日常打卡任务依旧 100% 顺畅执行并秒级入账，执行完毕干净断开；
  + 挂机开关开启时，就地无缝续跑 1 小时挂机心跳，两任合一，无需重复建连。
- 🎯 **每日任务错峰抖动（Jitter）**：
  + 任务定时加入 1~15 秒随机抖动防风控机制，杜绝多账号同分钟并发冲击官方接口。
- 🛡️ **生产级状态自愈与持久化**：
  + 纯文件式数据卷驱动（`/app/data`），配置与 Token 原子化落盘，重启自愈零丢失。
- 🎁 **全自动积分商城自动抢兑**：
  + 支持配置每日 07:00 自动兑换策略（默认每 4 天自动兑换 1G 数据盘永久扩容），并支持多种云电脑时长包与优惠券兑换。
- 🔔 **多通道消息通知**：
  + 每日打卡报告、挂机达标结算、凭据失效预警即时推送至企业微信、飞书、钉钉、Bark、Server酱、PushPlus 等平台。

---

## 🚀 部署教程

### 方式一：Docker 一键部署（首选推荐）

```bash
docker run -d \
  --name ctyun-pro \
  --restart unless-stopped \
  -p 3088:3088 \
  -v /guolei/ctyun-pro:/app/data \
  ghcr.io/lei-rr/ctyun-pro:latest
```

> 💡 **国内加速**：国内服务器如果拉取 GitHub Packages 较慢，可直接将镜像替换为阿里云国内高速源：
> ```bash
> crpi-kbafcu5p49r7b1k1.cn-hangzhou.personal.cr.aliyuncs.com/lei-rr/ctyun-pro:latest
> ```

启动成功后，使用浏览器访问：`http://你的服务器IP:3088`

- **默认管理密码**：`admin123`（首次登录后请在控制台「系统设置」中修改）

---

### 方式二：Docker Compose 编排部署

创建 `docker-compose.yml`：

```yaml
version: '3.8'

services:
  ctyun-pro:
    image: ghcr.io/lei-rr/ctyun-pro:latest
    container_name: ctyun-pro
    restart: unless-stopped
    ports:
      - "3088:3088"
    volumes:
      - ./data:/app/data
```

启动命令：
```bash
docker compose up -d
```

---

### 方式三：一键安装脚本（免 Docker / Linux 原生服务）

针对小内存 VPS（如 512MB 内存小鸡）或无 Docker 环境的 Linux 宿主机：

```bash
curl -fsSL https://raw.githubusercontent.com/Lei-rr/ctyun-pro/main/install.sh | bash
```

- 自动识别 `x86_64` 与 `aarch64` 架构；
- 自动下载原生独立二进制并注册 systemd 服务开机自启；
- 运维管理：
  ```bash
  systemctl restart ctyun-pro   # 重启
  systemctl status ctyun-pro    # 查看状态
  journalctl -u ctyun-pro -f    # 查看实时日志
  ```

---

### 方式四：Windows 原生单二进制运行

1. 从 [GitHub Releases](https://github.com/Lei-rr/ctyun-pro/releases) 下载 `ctyun-pro-windows-x64.exe`；
2. 直接双击运行程序，打开浏览器访问 `http://127.0.0.1:3088` 即可开始使用。无需安装 Python、Node.js 或额外浏览器依赖。

---

### 方式五：源码本地运行

```bash
# 1. 克隆代码
git clone https://github.com/Lei-rr/ctyun-pro.git
cd ctyun-pro

# 2. 安装依赖并编译打包
npm install
npm run build

# 3. 启动服务
npm start
```

---

## ⚙️ 环境变量与配置

| 变量名 | 默认值 | 作用说明 |
|---|---|---|
| `PORT` | `3088` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 绑定监听地址 |
| `CTYUN_DATA_DIR` | `/app/data` | 数据持久化与配置文件存储目录 |

系统遵循**纯文件式配置原则**，除端口与数据目录外，账号、密码、调度时间、Webhook 等所有参数均统一在 Web 页面动态修改并原子保存在挂载目录下的 `config.json` 中，容器重建或升级永不丢失。

---

## ❓ 常见问题 (FAQ)

#### Q: 纯协议挂机会不会被官方封号？
A: CTYUN-PRO 严格对齐官方 Web 端客户端在建连时的二进制封包序列（SSL 握手协商 -> REDQ 动态应答 -> Type 103/118 身份校验 -> Type 112 客户端信息包 -> Type 104 通道就绪 -> Type 7 5秒心跳），对网关表现为一个极度标准的正常桌面端连接会话。

#### Q: 挂机时会不会影响我手机/电脑官方客户端登录？
A: 完全不会。挂机引擎内置客户端抢占监听（监听网关 Type 119/120/137 通知与 4001 Preempted 状态码）。一旦检测到你在真机客户端连入，系统立即主动让出桌面会话并避让 20 分钟；且日常保活不发独占会话包，与官方客户端完全互不冲突。

#### Q: 为什么有时候界面显示挂机完成了，但积分没有立刻增加？
A: 天翼云官方计费结算存在约 3~5 分钟的分段窗口结算延迟，时长达标后网关会异步入账。系统在挂机结束后会自动拉取官方最新积分并刷新看板。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源发布。仅供技术研究交流使用，请勿用于违反天翼云用户协议或法律法规的用途。
