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
  <a href="#-核心亮点">核心亮点</a> •
  <a href="#-部署教程">部署教程</a> •
  <a href="#-系统特性">系统特性</a> •
  <a href="#-配置说明">配置说明</a> •
  <a href="#-常见问题-faq">常见问题</a> •
  <a href="#-免责声明">免责声明</a>
</p>

</div>

---

## 🛡️ 免责声明

1. **本项目仅供编程学习、技术研究与个人合法拥有的天翼云资源集中运维管理使用**。
2. 使用本项目时，使用者必须严格遵守天翼云官方相关用户服务协议与活动规范。**严禁将本项目用于未授权批量访问、网络攻击、商业牟利或任何侵犯第三方合法权益的行为**。
3. 本项目为开源软件，作者不对因使用本项目（包括但不限于账号异常、服务受限、积分清零、资源回收或数据丢失等）导致的任何直接或间接后果承担任何法律责任。
4. 使用者在部署与运行本项目时，即代表已充分理解并自愿承担可能产生的所有使用风险。

---

## 💡 为什么选择 CTYUN-PRO？

传统的云电脑自动化工具通常依赖重型无头浏览器（Puppeteer/Chromium）或 Windows 桌面客户端，内存动辄占用 1.5GB ~ 2GB，在弱网或小配置 VPS 上极易卡死崩溃，且容易和手机 App、电脑客户端互相顶号。

**CTYUN-PRO 2.0.0** 经过全面架构精简优化，彻底移除了任何浏览器与桌面运行库依赖：
- ⚡ **内存节省 95%**：单容器运行仅需几十兆内存，低配轻量 VPS 亦可轻松流畅运行；
- 🎯 **日常任务解耦**：签到打卡、AI 对话与 1 小时时长挂机完全解耦，即便关闭挂机功能，日常基础积分也能稳定全自动入账；
- 🛡️ **智能避让真机**：内置官方客户端抢占感知，当你在手机或电脑登录真实客户端时，系统自动让位，绝不抢占你的正常操作！

> 💡 **官方镜像地址**：
> - **GitHub 官方源（海外/默认）**：`ghcr.io/lei-rr/ctyun-pro:latest` 或 `ghcr.io/lei-rr/ctyun-pro:v2.0.0`
> - **阿里云高速源（国内推荐 ⚡）**：`crpi-kbafcu5p49r7b1k1.cn-hangzhou.personal.cr.aliyuncs.com/lei-rr/ctyun-pro:latest` 或 `crpi-kbafcu5p49r7b1k1.cn-hangzhou.personal.cr.aliyuncs.com/lei-rr/ctyun-pro:v2.0.0`

---

## 🌟 核心亮点

- ⚡ **轻量纯净架构**：无需安装 Chromium 或任何浏览器驱动，全流程极速启动，容器镜像小巧清爽。
- 🔄 **日常任务全自动**：每日自动完成签到、AI 对话打卡与云电脑登录激活，全天自动守护。
- ⏱️ **任务与时长解耦**：基础打卡秒级完成；如需累加使用时长，系统自动平滑维持心跳，无需反复重新连接。
- 🛡️ **智能防顶号让位**：遇到用户真机客户端连入时，后台智能感知并主动避让，杜绝多端互踢。
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
  -v /guolei/ctyun-pro:/app/data \
  ghcr.io/lei-rr/ctyun-pro:latest
```

> 💡 **国内服务器加速**：国内机器拉取 GitHub 较慢时，可直接替换为阿里云国内镜像：
> ```bash
> crpi-kbafcu5p49r7b1k1.cn-hangzhou.personal.cr.aliyuncs.com/lei-rr/ctyun-pro:latest
> ```

启动成功后，浏览器访问：`http://你的服务器IP:3088`  
- **默认管理密码**：`admin123`（登录后可在控制台「系统设置」中修改）

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

### 方式四：Windows / 独立二进制直接运行

- **Windows 用户**：前往 [GitHub Releases](https://github.com/Lei-rr/ctyun-pro/releases) 下载 `ctyun-pro-windows-x64.exe`，直接双击运行，打开浏览器访问 `http://127.0.0.1:3088` 即可使用。

---

## ⚙️ 配置说明

| 配置项 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3088` | Web 控制台与服务监听端口 |
| `HOST` | `0.0.0.0` | 服务监听地址 |
| `CTYUN_DATA_DIR` | `/app/data` | 数据持久化与配置文件目录 |

系统遵循**纯文件式配置设计**，账号信息、任务策略、兑换规则与 Webhook 通知均在 Web 控制台随时调整并持久化保存，容器升级重建数据零丢失。

---

## ❓ 常见问题 (FAQ)

<details>
<summary><b>Q: 挂机时会不会影响我手机/电脑客户端正常登录？</b></summary>
<br>
A: 完全不会。系统内置官方客户端抢占感知机制，当检测到你在真机客户端上线时，系统会自动让出桌面会话并避让 20 分钟；且日常保活不占用独占会话，与官方客户端和平共存。
</details>

<details>
<summary><b>Q: 为什么挂机完成后积分没有立刻刷新？</b></summary>
<br>
A: 官方计费网关存在约 3~5 分钟的结算延迟。系统在挂机结束后会自动拉取官方最新积分并同步更新看板。
</details>

<details>
<summary><b>Q: 数据如何备份或迁移？</b></summary>
<br>
A: 系统的所有数据均保存在挂载的持久化目录（如 `/guolei/ctyun-pro`）中，迁移时只需将该目录复制到新机器对应的挂载路径即可无缝恢复。
</details>

---

## 🌟 Star 历史趋势

[![Star History Chart](https://api.star-history.com/svg?repos=Lei-rr/ctyun-pro&type=Date)](https://github.com/Lei-rr/ctyun-pro/stargazers)

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 开源发布。
