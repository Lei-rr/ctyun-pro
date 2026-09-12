import WebSocket from 'ws';
import { Protocol } from '../core/protocol.js';
import type { CtYunClient, Desktop, DesktopInfo } from '../core/client.js';
import type { Logger } from '../core/logger.js';
import { SignTask, isHangTaskName } from './sign.js';
import { DesktopSessionArbiter } from '../modules/arbiter/desktop-session-arbiter.js';

export interface HangTaskSession {
  accountName: string;
  startTime: number;
  status: 'running' | 'completed' | 'stopped' | 'failed';
  currentProgress: number;
  totalProgress: number;
  connectedAt?: number;
  message?: string;
  stop: () => Promise<void>;
}

const activeHangSessions = new Map<string, HangTaskSession>();

/**
 * 纯协议版云电脑挂机与登录任务处理器 (彻底剔除 Chromium/无头浏览器)
 * 1. 纯 WebSocket 二进制 Clink 协议连接天翼云网关 (wss://.../clinkProxy/{id}/MAIN)
 * 2. 握手后发送 Type 118 (身份) + Type 112 (会话认领) + Type 104 (通道就绪) + 5秒 Type 7 心跳
 * 3. 登录与挂机两任合一：连上数秒即达成「登录AI云电脑」，若开启挂机则原地续跑满 3600 秒达成「使用1小时」
 * 4. 监听服务端 Type 119/120/137 或 4001 抢占通知，检测到用户官方客户端接入立即主动避让，绝不冲突
 */
export class HangTask {
  public static async destroy(): Promise<void> {
    for (const session of activeHangSessions.values()) {
      try {
        await session.stop();
      } catch {}
    }
    activeHangSessions.clear();
  }

  public static isRunning(accountName: string): boolean {
    const s = activeHangSessions.get(accountName);
    return Boolean(s && s.status === 'running');
  }

  public static clearSession(accountName: string): void {
    activeHangSessions.delete(accountName);
  }

  public static renameSession(oldName: string, newName: string): void {
    const s = activeHangSessions.get(oldName);
    if (s) {
      s.accountName = newName;
      activeHangSessions.delete(oldName);
      activeHangSessions.set(newName, s);
    }
  }

  public static getHangInfo(accountName: string) {
    const s = activeHangSessions.get(accountName);
    if (!s) return null;

    let cur = s.currentProgress || 0;
    if (s.connectedAt) {
      const elapsed = Math.max(0, Math.floor((Date.now() - s.connectedAt) / 1000));
      cur = Math.min(s.totalProgress || 3600, cur + elapsed);
    }
    const message = s.connectedAt
      ? `纯协议挂机中 (${cur}/${s.totalProgress || 3600}秒)`
      : s.message || '协议准备中';

    return {
      running: s.status === 'running',
      startTime: s.startTime,
      currentProgress: cur,
      totalProgress: s.totalProgress,
      message,
    };
  }

  public static initPendingSession(accountName: string, cur: number = 0, total: number = 3600): void {
    if (activeHangSessions.has(accountName)) return;
    activeHangSessions.set(accountName, {
      accountName,
      startTime: Date.now(),
      status: 'running',
      currentProgress: cur,
      totalProgress: total,
      message: '正在准备挂机会话...',
      stop: async () => {},
    });
  }

  public static async stopHang(accountName: string): Promise<void> {
    const s = activeHangSessions.get(accountName);
    if (s) {
      try {
        await s.stop();
      } catch {}
      activeHangSessions.delete(accountName);
    }
  }

  /**
   * 纯协议执行云电脑会话激活与挂机任务
   * @param onlyLoginTask 若为 true，则仅激活登录会话（用于只做「登录AI云电脑」任务，握手达成即关闭）；若为 false，则持续挂机至满 1 小时
   */
  public static async executeProtocolHang(
    accountName: string,
    client: CtYunClient,
    logger: Logger,
    options: {
      onlyLoginTask?: boolean;
      desktopId?: string;
      onProgress?: (cur: number, total: number) => void;
    } = {},
  ): Promise<{ success: boolean; message: string; isCompleted?: boolean }> {
    if (!client.loginInfo) {
      return { success: false, message: '账号未登录，无法执行任务' };
    }

    const existingSession = activeHangSessions.get(accountName);
    if (existingSession && existingSession.connectedAt) {
      return { success: true, message: '当前已有挂机任务在运行中，请勿重复启动' };
    }

    // 1. 获取目标云电脑实例
    let targetDesktop: Desktop | undefined;
    try {
      const desktops = await client.getDesktopList();
      if (options.desktopId) {
        targetDesktop = desktops.find((d) => String(d.desktopId) === String(options.desktopId));
      }
      if (!targetDesktop) {
        targetDesktop = desktops.find((d) => d.useStatusText === '运行中' || d.useStatusText === '离线运行') || desktops[0];
      }
    } catch (e: any) {
      return { success: false, message: `获取云电脑列表失败: ${e.message}` };
    }

    if (!targetDesktop) {
      return { success: false, message: '未找到可用云电脑实例' };
    }

    const dId = String(targetDesktop.desktopId);
    const dName =
      targetDesktop.desktopName ||
      (targetDesktop as any).computerName ||
      (targetDesktop as any).name ||
      targetDesktop.desktopCode ||
      dId;
    const logPrefix = dName ? `${accountName} - ${dName}` : accountName;

    // 2. 核验是否需要开机
    const isRunning = targetDesktop.useStatusText === '运行中' || targetDesktop.useStatusText === '离线运行';
    if (!isRunning) {
      logger.addLog('warn', `[${logPrefix}] 云电脑当前为 [${targetDesktop.useStatusText}]，正在下发开机指令...`);
      try {
        await client.operateDesktop(dId, 'on');
      } catch (e: any) {
        logger.addLog('warn', `[${logPrefix}] 下发开机指令提示: ${e.message}`);
      }

      // 等待开机就绪（最多等待 3 分钟）
      let ready = false;
      for (let i = 0; i < 36; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        try {
          const list = await client.getDesktopList();
          const cur = list.find((d) => String(d.desktopId) === dId);
          if (cur && (cur.useStatusText === '运行中' || cur.useStatusText === '离线运行')) {
            targetDesktop.useStatusText = cur.useStatusText;
            ready = true;
            logger.addLog('success', `[${logPrefix}] 云电脑开机就绪`);
            break;
          }
        } catch {}
      }
      if (!ready) {
        return { success: false, message: '等待云电脑开机超时' };
      }
    }

    // 3. 动态核验当前任务进度（必须先调用官方接口确认真实基线）
    let currentProgress = 0;
    let totalProgress = 3600;
    try {
      const summary = await SignTask.getPointsAndTasks(client);
      const hangTask = summary.tasks.find((t: any) => t.type === 'hang' || isHangTaskName(t.name, t.totalProgress));
      if (hangTask) {
        currentProgress = hangTask.currentProgress || 0;
        totalProgress = hangTask.totalProgress || 3600;
        if (!options.onlyLoginTask && (hangTask.isCompleted || currentProgress >= totalProgress)) {
          logger.addLog('success', `[${logPrefix}] 任务中心核验今日「使用1小时」已达成 (${currentProgress}/${totalProgress}秒，+100积分)，无需挂机`);
          options.onProgress?.(currentProgress, totalProgress);
          return { success: true, message: `今日挂机任务已达成 (${currentProgress}/${totalProgress}秒)`, isCompleted: true };
        }
      }
    } catch (e: any) {
      logger.addLog('warn', `[${logPrefix}] 查询初始任务状态失败，将基于默认进度启动: ${e.message}`);
    }

    // 4. 获取 Clink 接入信道与双向 SSL 证书
    let desktopInfo: DesktopInfo | null = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        desktopInfo = await client.connectDesktop(targetDesktop);
        if (desktopInfo && desktopInfo.clinkLvsOutHost) break;
      } catch (e: any) {
        if (attempt === 5) {
          return { success: false, message: `获取云电脑连接信息失败: ${e.message}` };
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    if (!desktopInfo || !desktopInfo.clinkLvsOutHost) {
      return { success: false, message: '获取云电脑网关参数异常' };
    }

    // 5. 纯协议握手长连接：向仲裁器申请 TASK 独占租约，杜绝 1005 竞态互踢
    const arbiter = DesktopSessionArbiter.getInstance();
    arbiter.setLogger(logger);
    let ws: WebSocket | null = null;
    let heartbeatTimer: NodeJS.Timeout | null = null;
    let progressUpdateTimer: NodeJS.Timeout | null = null;
    let isTerminated = false;
    let sessionResult: { success: boolean; message: string; isCompleted?: boolean } = {
      success: true,
      message: '挂机完成',
    };

    const cleanup = async () => {
      isTerminated = true;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (progressUpdateTimer) {
        clearInterval(progressUpdateTimer);
        progressUpdateTimer = null;
      }
      if (ws) {
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.close(1000, 'Normal Close');
          }
        } catch {}
        ws = null;
      }
      await arbiter.releaseLease(dId, options.onlyLoginTask ? 'hang' : 'hang', accountName);
    };

    const acquired = await arbiter.acquireLease(
      dId,
      'hang',
      accountName,
      async () => {
        logger.addLog('info', `[${logPrefix}] 收到高优先级独占让位信号，挂机会话主动释放`);
        await cleanup();
      },
    );

    if (!acquired) {
      return { success: false, message: '无法获取桌面连接独占锁，当前桌面正在被使用或正在直连' };
    }

    const hostParts = desktopInfo.clinkLvsOutHost.split(':');
    const wsUrl = `wss://${desktopInfo.clinkLvsOutHost}/clinkProxy/${dId}/MAIN`;

    logger.addLog(
      'info',
      options.onlyLoginTask
        ? `[${logPrefix}] 纯协议连接云电脑完成登录任务 (${desktopInfo.clinkLvsOutHost})...`
        : `[${logPrefix}] 纯协议启动挂机：当前累计 ${currentProgress}/${totalProgress}秒，连接网关中...`,
    );

    const session: HangTaskSession = {
      accountName,
      startTime: Date.now(),
      status: 'running',
      currentProgress,
      totalProgress,
      message: options.onlyLoginTask ? '纯协议激活会话中' : `纯协议挂机中 (${currentProgress}/${totalProgress}秒)`,
      stop: async () => {
        sessionResult = { success: true, message: '挂机任务已被手动中止' };
        await cleanup();
      },
    };
    activeHangSessions.set(accountName, session);

    try {
      const connectPromise = new Promise<{ success: boolean; message: string; isCompleted?: boolean }>((resolve) => {
        ws = new WebSocket(wsUrl, ['binary'], {
          headers: {
            Origin: 'https://pc.ctyun.cn',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
          rejectUnauthorized: false,
          handshakeTimeout: 15000,
        });

        ws.on('open', () => {
          logger.addLog('info', `[${logPrefix}] 纯协议信道已建立，发送 SSL 认证握手...`);

          // 1. 发送连接握手 JSON
          const connectMessage = {
            type: 1,
            ssl: 1,
            host: hostParts[0],
            port: hostParts.length > 1 ? hostParts[1] : '443',
            ca: desktopInfo!.caCert,
            cert: desktopInfo!.clientCert,
            key: desktopInfo!.clientKey,
            servername: `${desktopInfo!.host}:${desktopInfo!.port}`,
            oqs: 0,
          };

          try {
            ws?.send(JSON.stringify(connectMessage));
          } catch (e: any) {
            resolve({ success: false, message: `发送握手配置失败: ${e.message}` });
            return;
          }

          // 2. 500ms 后发送原生初始握手二进制帧
          setTimeout(() => {
            if (isTerminated || !ws || ws.readyState !== WebSocket.OPEN) return;
            try {
              const initialPayload = Buffer.from('UkVEUQIAAAACAAAAGgAAAAAAAAABAAEAAAABAAAAEgAAAAkAAAAECAAA', 'base64');
              ws.send(initialPayload);
            } catch {}
          }, 500);
        });

        ws.on('message', async (data: WebSocket.RawData) => {
          if (isTerminated || !ws || ws.readyState !== WebSocket.OPEN) return;
          const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);

          // A. 收到 REDQ 保活校验帧 -> 动态响应
          if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === 'REDQ') {
            try {
              const response = Protocol.executeRedqEncryption(buffer);
              ws.send(response);
            } catch (err: any) {
              logger.addLog('warn', `[${logPrefix}] 处理 REDQ 异常: ${err.message}`);
            }
            return;
          }

          // B. 解析服务端下发的 CLINK 协议消息
          try {
            const infos = Protocol.parseSendInfo(buffer);
            for (const info of infos) {
              // 收到服务端 Type 103 用户认证挑战
              if (info.type === 103) {
                logger.addLog('info', `[${logPrefix}] 收到云电脑 103 握手认证，正在回传用户凭证与通道认领包...`);

                // 1. 回传 Type 118 用户身份包
                const userPayload = JSON.stringify({
                  type: 1,
                  userName: client.loginInfo!.userName,
                  userInfo: '',
                  userId: client.loginInfo!.userId,
                });
                const msg118 = Protocol.buildSendInfoBuffer(118, Buffer.from(userPayload, 'utf-8'), true);
                ws.send(msg118);

                // 2. 发送 Type 112 会话认领包 (CLINK_MSGC_MAIN_CLIENT_LOGIN_INFO)
                // 官方任务中心由此确认终端正式登入并接入云电脑，瞬间达成「登录AI云电脑」！
                const msg112 = Protocol.buildMainClientLoginInfo(
                  dId,
                  desktopInfo!.token || '',
                  '60',
                  client.getDeviceCode(),
                  client.loginInfo!.userName,
                );
                ws.send(msg112);

                // 3. 发送 Type 104 通道挂接就绪包 (CLINK_MSGC_MAIN_ATTACH_CHANNELS)
                const msg104 = Protocol.buildMessage(104);
                ws.send(msg104);

                logger.addLog('success', `[${logPrefix}] 桌面会话认领与通道挂接完成，在线状态已激活！`);
                session.connectedAt = Date.now();

                // 若本次只做「登录AI云电脑」任务，握手完成后等待 3 秒确保服务端确认即可优雅退出
                if (options.onlyLoginTask) {
                  setTimeout(() => {
                    resolve({ success: true, message: '已完成纯协议桌面登录激活 (+100积分)' });
                  }, 3000);
                  return;
                }

                // 4. 若为「挂机1小时」任务，启动官方标准的每 30 秒 1 次 Type 7 心跳，维持长连活跃
                if (!heartbeatTimer) {
                  heartbeatTimer = setInterval(() => {
                    if (ws && ws.readyState === WebSocket.OPEN) {
                      try {
                        const hbBuf = Protocol.buildMessage(7); // Type 7 心跳包
                        ws.send(hbBuf);
                        logger.addLog('info', `[${logPrefix}] 发送客户端活跃心跳 (30s 心跳保活)`);
                      } catch {}
                    }
                  }, 30000);
                }

                // 5. 纯本地时间平滑推演进度 (每 1 秒根据本地时间戳递增计算流逝秒数，严禁中途频繁轮询接口)
                if (!progressUpdateTimer) {
                  let isClosing = false;
                  progressUpdateTimer = setInterval(async () => {
                    if (isTerminated || isClosing || !ws || ws.readyState !== WebSocket.OPEN) return;
                    const elapsedSec = Math.floor((Date.now() - (session.connectedAt || session.startTime)) / 1000);
                    const cur = Math.min(totalProgress, currentProgress + elapsedSec);
                    session.currentProgress = cur;
                    options.onProgress?.(cur, totalProgress);

                    // 达到 3600 秒（目标时长）后触发优雅结束流程
                    if (currentProgress + elapsedSec >= totalProgress) {
                      isClosing = true;
                      if (progressUpdateTimer) {
                        clearInterval(progressUpdateTimer);
                        progressUpdateTimer = null;
                      }

                      // 达到 3600 秒时间后，在主动断开长连前缓冲 2 秒，确保官方离线结算时物理时长绝对达标（防秒级截断），而业务与判定基准始终是 3600s
                      logger.addLog('info', `[${logPrefix}] 挂机时长已达到目标 (${totalProgress}/${totalProgress}秒)，缓冲 2 秒后主动断开长连触发官方离线结算...`);
                      await new Promise((r) => setTimeout(r, 2000));

                      // 立即从全局会话中移除并清理，确保外部读取立即为已完成
                      activeHangSessions.delete(accountName);
                      await cleanup();

                      // 离线断开后，等待 3 秒调用官方接口核验积分与时长
                      try {
                        await new Promise((r) => setTimeout(r, 3000));
                        const summary = await SignTask.getPointsAndTasks(client);
                        const t = summary.tasks.find((item: any) => item.type === 'hang' || isHangTaskName(item.name, item.totalProgress));
                        const cloudProgress = t?.currentProgress || 0;
                        const isDone = Boolean(t && (t.isCompleted || (t as any).status === 2 || cloudProgress >= totalProgress));

                        if (isDone) {
                          logger.addLog('success', `[${logPrefix}] 官方接口复核通过：今日使用 AI 云电脑 1 小时任务已达成 (+100积分)！`);
                          resolve({ success: true, message: `今日挂机任务已达成 (${totalProgress}/${totalProgress}秒)`, isCompleted: true });
                        } else {
                          // 如果官方由于离线同步延迟刚好差 1~2 秒，且推演已经满额，再宽容等待 3 秒重试一次官方复核，防误判
                          await new Promise((r) => setTimeout(r, 3000));
                          try {
                            const secondSummary = await SignTask.getPointsAndTasks(client);
                            const t2 = secondSummary.tasks.find((item: any) => item.type === 'hang' || isHangTaskName(item.name, item.totalProgress));
                            const cloudProgress2 = t2?.currentProgress || 0;
                            const isDone2 = Boolean(t2 && (t2.isCompleted || (t2 as any).status === 2 || cloudProgress2 >= totalProgress));
                            if (isDone2) {
                              logger.addLog('success', `[${logPrefix}] 官方接口二次复核通过：今日使用 AI 云电脑 1 小时任务已达成 (+100积分)！`);
                              resolve({ success: true, message: `今日挂机任务已达成 (${totalProgress}/${totalProgress}秒)`, isCompleted: true });
                              return;
                            }
                          } catch {}

                          const gap = Math.max(1, totalProgress - cloudProgress);
                          logger.addLog('warn', `[${logPrefix}] 官方接口复核发现时长未计满 (云端记录: ${cloudProgress}/${totalProgress}秒)，仍差 ${gap} 秒，需自动补挂`);
                          resolve({ success: false, message: `云端时长不足 (当前 ${cloudProgress}/${totalProgress}秒)，触发补挂`, isCompleted: false });
                        }
                      } catch (err: any) {
                        logger.addLog('info', `[${logPrefix}] 会话已正常结算，复核请求异常: ${err.message}`);
                        resolve({ success: true, message: `挂机会话已结算 (${totalProgress}/${totalProgress}秒)` });
                      }
                    }
                  }, 1000);
                }
              }

              // C. 互踢避让与抢占保护：收到 Type 119/120/137 服务端离线通知或多端抢占通知
              if (info.type === 119 || info.type === 120 || info.type === 137) {
                logger.addLog('info', `[${logPrefix}] 收到服务端会话通知 (Type ${info.type})，用户客户端已接入，纯协议通道主动让位...`);
                resolve({ success: true, message: '检测到官方客户端接入，纯协议通道主动避让' });
                return;
              }
            }
          } catch {}
        });

        ws.on('close', async (code, reason) => {
          const reasonStr = reason?.toString() || '';
          if (isTerminated) return;
          if (code === 4001 || reasonStr.includes('preempt') || reasonStr.includes('conflict')) {
            logger.addLog('warn', `[${logPrefix}] 网关通知桌面被真实客户端接入，纯协议任务主动让位`);
            resolve({ success: true, message: '客户端主动接入，任务让位' });
            return;
          }

          logger.addLog('warn', `[${logPrefix}] 挂机连接异常关闭 (${code}, ${reasonStr || '网络连接关闭'})，正在核验已结算时长...`);
          await cleanup();

          // 等待 3 秒让天翼云完成离线会话结算
          await new Promise((r) => setTimeout(r, 3000));
          try {
            const summary = await SignTask.getPointsAndTasks(client);
            const t = summary.tasks.find((item: any) => item.type === 'hang' || isHangTaskName(item.name, item.totalProgress));
            const cloudProgress = t?.currentProgress || 0;
            const isDone = Boolean(t && (t.isCompleted || (t as any).status === 2 || cloudProgress >= totalProgress));

            if (isDone) {
              logger.addLog('success', `[${logPrefix}] 官方接口复核确认：使用 AI 云电脑 1 小时任务已达成 (+100积分)！`);
              resolve({ success: true, message: `挂机任务已达成 (${cloudProgress}/${totalProgress}秒)`, isCompleted: true });
            } else {
              const gap = Math.max(1, totalProgress - cloudProgress);
              logger.addLog('info', `[${logPrefix}] 断线结算核验：当前累计 ${cloudProgress}/${totalProgress}秒，尚差 ${gap} 秒，准备自动续挂`);
              resolve({ success: false, message: `断线需续挂 (当前 ${cloudProgress}/${totalProgress}秒)`, isCompleted: false });
            }
          } catch (err: any) {
            resolve({ success: false, message: `网络连接关闭 (Code: ${code})，复核失败: ${err.message}` });
          }
        });

        ws.on('error', (err) => {
          if (!isTerminated) {
            resolve({ success: false, message: `WebSocket 连接异常: ${err.message}` });
          }
        });
      });

      const res = await connectPromise;
      sessionResult = res;
    } catch (e: any) {
      sessionResult = { success: false, message: `挂机执行异常: ${e.message}` };
    } finally {
      await cleanup();
      const currentName = session?.accountName || accountName;
      activeHangSessions.delete(currentName);
      if (currentName !== accountName) {
        activeHangSessions.delete(accountName);
      }
    }

    return sessionResult;
  }

  /**
   * 兼容入口：执行智能挂机
   */
  public static async executeSmartHang(
    accountName: string,
    client: CtYunClient,
    logger: Logger,
    onProgress?: (cur: number, total: number) => void,
  ): Promise<{ success: boolean; message: string; isCompleted?: boolean }> {
    return this.executeProtocolHang(accountName, client, logger, {
      onlyLoginTask: false,
      onProgress,
    });
  }
}
