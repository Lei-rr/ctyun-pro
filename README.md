<div align="center">

# ⚡ CTYUN-PRO

_✨ 天翼云电脑多账号极轻量保活 · 智能自动做任务 · 现代化 Web 运维控制台 ✨_

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
  <a href="#免责声明">免责声明</a> •
  <a href="#功能说明与特性">功能说明与特性</a> •
  <a href="#核心亮点">核心亮点</a> •
  <a href="#部署教程">部署教程</a> •
  <a href="#配置说明">配置说明</a> •
  <a href="#star-历史趋势">Star 历史趋势</a>
</p>

</div>

---

## 🛡️ 免责声明

1. **本项目仅供编程学习、技术研究与个人合法拥有的天翼云资源集中运维管理使用**。
2. 使用本项目时，使用者必须严格遵守天翼云官方相关用户服务协议与活动规范。**严禁将本项目用于未授权批量访问、网络攻击、商业牟利或任何侵犯第三方合法权益的行为**。
3. 本项目为开源软件，作者不对因使用本项目（包括但不限于账号异常、服务受限、积分清零、资源回收或数据丢失等）导致的任何直接或间接后果承担任何法律责任。
4. 使用者在部署与运行本项目时，即代表已充分理解并自愿承担可能产生的所有使用风险。

---

## 💡 功能说明与特性

**CTYUN-PRO** 专为多账号集中运维天翼云电脑而生，基于现代化全栈架构构建，提供稳定、安全且自动化的云电脑管理体验：

- 🖥️ **Web 原生免密远程控制**：无需安装任何官方客户端或第三方插件，支持直接在浏览器中免密、秒级直连操控云电脑桌面（`/desktop/:id`）；集成 W3C Keyboard Lock API 独占捕获系统快捷键（Alt+Tab、Win 键、Ctrl+W 等），操作体验完全媲美本地真机；
- ⚡ **原生协议通信架构**：采用高效的原生协议长连与通信机制，系统运行资源开销极低，单容器仅需几十兆内存，保障在各类服务器及轻量 VPS 环境中持久稳定运行；
- 🔐 **长效凭证持久化管理**：基于天翼云原生 secretKey 长期鉴权与持久化存储，凭证长效稳定，避免无效轮转与频繁重登；
- 🎯 **日常任务解耦自动化**：每日自动打卡、AI 对话及云电脑登录等日常积分任务高度解耦，支持自定义按需调度执行；
- 🛡️ **双向感知与智能避让机制**：精准感知真机客户端登录及前台 Web 直连视窗接入，后台自动优雅断开让位，前台关闭后毫秒级恢复，彻底杜绝多端互踢冲突；
- 🎲 **拟真离散离线防风控**：内置任务多账号阶梯并发抖动，多账号随机离散执行，消除批量机器人并发特征；
- 🎁 **全自动积分策略兑换**：支持按周期策略自动兑换数据盘永久扩容包或时长包，资产收益全自动收拢入库。

> 💡 **官方镜像地址**：
> - **GitHub 官方源（海外/默认）**：`ghcr.io/lei-rr/ctyun-pro:latest` 或 `ghcr.io/lei-rr/ctyun-pro:v2.3.0`
> - **阿里云高速源（国内推荐 ⚡）**：`crpi-kbafcu5p49r7b1k1.cn-hangzhou.personal.cr.aliyuncs.com/lei-rr/ctyun-pro:latest` 或 `crpi-kbafcu5p49r7b1k1.cn-hangzhou.personal.cr.aliyuncs.com/lei-rr/ctyun-pro:v2.3.0`

---

## 🌟 核心亮点

- 🖥️ **Web 原生免密远程控制**：浏览器新标签页一键直连操控桌面，独占锁定系统级快捷键，沉浸式办公操控体验。
- ⚡ **顶级 RESTful 架构**：全栈统一为 `desktop` 顶级标准体系，提供干净规范的 `/desktop/:id` 直连与 `/api/desktops/*` 管理接口。
- 🔄 **日常任务全自动**：每日自动完成签到、AI 对话打卡与云电脑登录激活，全天自动守护。
- ⏱️ **任务与时长解耦**：基础打卡秒级完成；如需累加使用时长，系统自动平滑维持心跳，无需反复重新连接。
- 🛡️ **智能防顶号让位**：遇到用户真机客户端或前台网页操作时，后台智能感知并主动避让，杜绝多端互踢。
- 🎲 **定时错峰防风控**：多账号执行内置随机执行抖动，避免同一时间并发请求触发官方接口频控。
- 🎁 **全自动积分兑换**：支持按策略自动定时兑换云电脑硬盘扩容包、时长包或优惠券。
- 📊 **现代化精致面板**：基于 Vue 3 + Tailwind CSS 构建，状态实时看板、日志折叠置底、移动端完美适配。
- 🔔 **多渠道消息推送**：支持企业微信、飞书、钉钉、Bark、Server酱、PushPlus 等主流通知推送。

---

## 🚀 部署教程

### 方式一：Docker 一键部署（首选推荐 👍）

```bash
docker run -d \
  --name ctyun-pro \
  --restart unless-stopped \
  -p 3088:3088 \
  -v /data/ctyun-pro:/app/data \
  ghcr.io/lei-rr/ctyun-pro:latest
```

> 💡 **国内服务器加速**：国内机器拉取 GitHub 较慢时，可直接替换为阿里云国内镜像：
> ```bash
> crpi-kbafcu5p49r7b1k1.cn-hangzhou.personal.cr.aliyuncs.com/lei-rr/ctyun-pro:latest
> ```

启动成功后，浏览器访问：`http://你的服务器IP:3088`  
- **默认管理密码**：默认免密直接访问（可在控制台「系统设置」中随时设置密码保护，或在启动容器时通过环境变量 `ADMIN_PASSWORD` 指定）

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

### 方式三：Linux 一键安装脚本（免 Docker / systemd 守护）

适用于小内存 VPS 或无 Docker 环境的 Linux 宿主机：

```bash
curl -fsSL https://raw.githubusercontent.com/Lei-rr/ctyun-pro/main/install.sh | bash
```

- 自动识别系统架构，下载单文件并自动注册为开机自启系统服务；
- 管理命令：
  ```bash
  systemctl restart ctyun-pro   # 重启服务
  systemctl status ctyun-pro    # 查看运行状态
  journalctl -u ctyun-pro -f    # 查看实时日志
  ```

---

### 方式四：Windows 桌面原生运行

1. 前往 [GitHub Releases](https://github.com/Lei-rr/ctyun-pro/releases) 下载最新版本的 `ctyun-pro-windows-x64.exe`；
2. 项目已贴心内置一键启动脚本 [`start-windows.bat`](start-windows.bat)：将脚本与 exe 放置于同一目录下，双击 `start-windows.bat` 即可自动完成数据目录初始化、环境配置并在默认浏览器中秒开控制台（`http://127.0.0.1:3088`）。

---

## ⚙️ 配置说明

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3088` | Web 控制台与服务监听端口 |
| `HOST` | `0.0.0.0` | 服务监听地址 |
| `CTYUN_DATA_DIR` | `/app/data` | 数据持久化与配置文件目录 |

系统遵循**纯文件式配置设计**，账号信息、任务策略、兑换规则与 Webhook 通知均在 Web 控制台随时调整并持久化保存，容器升级重建数据零丢失。

---

## 🌟 Star 历史趋势

[![Star History Chart](https://api.star-history.com/svg?repos=Lei-rr/ctyun-pro&type=Date)](https://github.com/Lei-rr/ctyun-pro/stargazers)

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源发布。
