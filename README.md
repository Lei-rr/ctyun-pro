# CtYun Pro

天翼云电脑多账号管理、纯协议保活和积分任务辅助工具。

## 项目状态

当前项目使用 Node.js 服务端和 Vue 3 管理界面。云电脑连接使用 HTTPS API 和 CLINK WebSocket 协议，不依赖 Chromium、Puppeteer 或 Playwright。

协议实现基于当前官方 Web 端连接流程整理，天翼云服务端升级后可能需要调整协议字段或消息处理逻辑。项目不保证协议永久兼容。

## 功能

- 多账号配置和独立设备标识；
- 天翼云电脑列表查询和电源操作；
- 纯协议云电脑连接与自动重连；
- `MAIN`、`DISPLAY`、`INPUTS` 三通道 CLINK 会话；
- 登录后自动维持云电脑会话，同时累计“使用 1 小时”任务时长；
- 每日签到、任务进度查询和云智助手任务；
- 积分商城商品查询和兑换策略；
- WebSocket/SSE 日志推送；
- 响应式 Vue 管理界面和管理员访问控制。

## 工作方式

登录账号后，系统会查询云电脑连接信息并启动纯协议会话。普通保活和“使用 1 小时”任务共用这套连接，不需要额外点击挂机按钮。

任务进度由官方服务端结算，接口不一定实时反映连接期间产生的时长。停止连接后可能需要等待一段时间，任务接口才会显示新增进度。

## 技术栈

- Node.js 20+
- TypeScript
- Fastify 5
- `ws`
- Vue 3
- Vite
- Tailwind CSS
- shadcn-vue 风格组件

## 目录结构

```text
src/
├── core/
│   ├── account-manager.ts       # 账号状态、持久化和业务协调
│   ├── client.ts                # 天翼云 HTTP API 客户端
│   ├── logger.ts                # 日志记录与订阅
│   └── protocol.ts              # CLINK 报文和 RSA Ticket
├── keepalive/
│   ├── keepalive-manager.ts     # 多账号 Worker 管理
│   └── worker.ts                # MAIN/DISPLAY/INPUTS 协议连接
├── tasks/
│   ├── ai-chat.ts               # 云智助手任务
│   ├── redeem.ts                # 积分兑换
│   ├── scheduler.ts             # 定时调度
│   ├── sign.ts                  # 签到和任务查询
│   └── task-runner.ts           # 每日任务编排
├── config.ts                    # 配置和数据目录
├── server.ts                    # HTTP API、静态页面和实时推送
└── index.ts                     # 服务端入口

web/
└── src/
    ├── stores/app.ts            # 前端状态和 API 调用
    ├── views/                  # 页面
    └── shared/ui/              # 通用组件
```

## 快速开始

### 源码运行

环境要求：Node.js 20 或更高版本。

```bash
git clone https://github.com/Lei-rr/ctyun-pro.git
cd ctyun-pro
npm install
npm run build
npm start
```

启动后访问：

```text
http://127.0.0.1:3088
```

开发模式：

```bash
npm run dev
npm run dev:web
```

### Docker Compose

```bash
docker compose up -d --build
```

默认数据目录为项目下的 `data/`。生产环境应使用独立的持久化目录，并限制管理端口的访问范围。

## 配置

服务端支持以下环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CTYUN_PORT` | `3088` | HTTP 服务端口 |
| `PORT` | `3088` | HTTP 服务端口，优先级高于 `CTYUN_PORT` |
| `HOST` | `0.0.0.0` | HTTP 监听地址 |
| `CTYUN_DATA_DIR` | 当前目录 `data/` | 数据目录 |
| `CTYUN_CONFIG` | `data/config.json` | 配置文件路径 |
| `TZ` | 系统时区 | 定时任务使用的时区 |

账号、设备标识和登录信息保存在数据目录中。不要把 `data/config.json`、账号密码、`secretKey`、Token 或证书提交到 Git 仓库。

## CLINK 协议说明

协议相关代码集中在：

- `src/core/protocol.ts`：CLINK Header、RSA-OAEP Ticket、通用消息和登录信息编码；
- `src/keepalive/worker.ts`：WebSocket 生命周期、认证、消息分片和三通道管理；
- `src/core/client.ts`：连接接口、动态证书和桌面 Token 获取。

当前连接流程：

```text
获取桌面连接信息
  -> 建立 MAIN WebSocket
  -> 发送连接 JSON
  -> 等待代理 0x01
  -> 发送 CLINK Header
  -> 解析服务端 Link Header 和 RSA 公钥
  -> 生成 RSA-OAEP/SHA-1 Ticket
  -> 等待认证成功
  -> 处理 MAIN_INIT
  -> 发送用户信息、登录信息和通道请求
  -> 读取服务端动态 channelId
  -> 建立 DISPLAY 和 INPUTS
  -> 发送 DISPLAY 初始化信息
  -> MAIN 每 5 秒发送活跃心跳，并处理 PING/PONG 和 ACK
```

以下字段必须在运行时动态获取：

- 网关地址 `clinkLvsOutHost`；
- 连接证书 `caCert`、`clientCert`、`clientKey`；
- 桌面 Token；
- MAIN 返回的连接 ID；
- 服务端下发的 DISPLAY/INPUTS 通道 ID；
- Link Header 中的 RSA 公钥。

以下内容属于协议适配层，可能随官方更新变化：

- CLINK Header 字段布局和能力位；
- RSA Ticket 格式；
- MAIN、DISPLAY、INPUTS 消息号；
- MAIN 登录信息结构；
- DISPLAY 设置和初始化报文；
- ACK、心跳和通道列表结构。

## 协议更新后的排查

建议先执行构建，再做短连接测试：

```bash
npm run build
```

排查顺序：

1. HTTP 连接接口没有返回连接信息：检查账号登录态、请求签名、设备标识和客户端版本；
2. 没有收到代理 `0x01`：检查网关地址、桌面 ID、Origin 和连接 JSON；
3. RSA 认证失败：检查 Link Header 解析、RSA-OAEP 参数、Header 能力位和 Ticket 长度；
4. MAIN 认证成功但没有初始化：检查 CLINK 消息分片重组和消息长度字段；
5. DISPLAY/INPUTS 认证失败：检查动态连接 ID、动态通道 ID 和子通道 Header；
6. 三通道成功但任务进度不变：等待官方延迟结算，再检查 DISPLAY 初始化和控制消息处理。

短测试只能验证连接和认证，不能单独证明任务计时。任务计时应使用较长连接，并在停止后再次查询官方任务接口。

## 开发检查

```bash
npm run build:server
npm run build:web
npm run build
```

提交前请确认：

- `git diff --check` 无输出；
- 没有提交账号、密码、Token、证书或本地数据；
- 协议改动经过实际网关连接测试；
- README 中的协议流程与当前源码一致。

## 安全与合规

本项目仅用于个人学习、协议研究和合法的自动化运维。使用前请确认符合天翼云服务条款、活动规则以及所在地法律法规。

项目不会绕过账号安全验证，也不应被用于未授权访问、批量滥用或影响他人服务的行为。使用者应自行承担使用本项目产生的风险。

## 许可证

本项目使用 MIT License。详见 [LICENSE](LICENSE)。

## 反馈

请通过 GitHub Issue 提交问题，并附上：

- Node.js 版本；
- 部署方式；
- 发生问题的时间和错误码；
- 脱敏后的相关日志；
- 是否能复现，以及复现步骤。

不要在 Issue、日志或截图中公开账号密码、Token、`secretKey`、证书和验证码。
