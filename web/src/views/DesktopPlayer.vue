<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Button } from '@/shared/ui/button';
import { Monitor, AlertCircle, RefreshCw, Maximize2, Minimize2 } from 'lucide-vue-next';

const route = useRoute();
const router = useRouter();
// 全局唯一标识：通过路由传递 desktopId
const desktopId = ref<string>(String(route.params.instanceId || route.params.desktopId || ''));
const desktopTitle = ref<string>('');

const canvasRef = ref<HTMLCanvasElement | null>(null);
const containerRef = ref<HTMLDivElement | null>(null);

const statusText = ref<string>('正在获取机房直连凭证...');
const isConnected = ref<boolean>(false);
const errorMsg = ref<string>('');
const isFullscreen = ref<boolean>(false);
const streamInfo = ref<any>(null);

let clinkClient: any = null;
let canvasCtx: CanvasRenderingContext2D | null = null;
let videoDecoder: any = null;
let currentWidth = 1920;
let currentHeight = 1080;

// 加载 SDK 脚本
const loadSdk = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    if ((window as any).__getClinkClient) {
      return resolve();
    }
    const script = document.createElement('script');
    script.src = '/static/common/clink_sdk.js';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('推流驱动 SDK 加载失败'));
    document.head.appendChild(script);
  });
};

// 探测 H.264 NALU 关键帧
const isH264Keyframe = (buffer: ArrayBuffer | Uint8Array): boolean => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  for (let i = 0; i < bytes.length - 4; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && (bytes[i + 2] === 1 || (bytes[i + 2] === 0 && bytes[i + 3] === 1))) {
      const nalOffset = bytes[i + 2] === 1 ? i + 3 : i + 4;
      const nalType = bytes[nalOffset] & 0x1f;
      if (nalType === 5 || nalType === 7) return true; // IDR or SPS
    }
  }
  return false;
};

// 初始化 WebCodecs
const initWebCodecs = () => {
  if (typeof (window as any).VideoDecoder === 'undefined') return;
  try {
    videoDecoder = new (window as any).VideoDecoder({
      output: (frame: any) => {
        if (canvasCtx) {
          canvasCtx.drawImage(frame, 0, 0, currentWidth, currentHeight);
        }
        frame.close();
      },
      error: (e: any) => {
        console.warn('VideoDecoder runtime error:', e);
      },
    });

    videoDecoder.configure({
      codec: 'avc1.42c032',
      codedWidth: currentWidth,
      codedHeight: currentHeight,
      hardwareAcceleration: 'no-preference',
    });
  } catch (e) {
    console.warn('WebCodecs init failed, fallback to Wasm/Canvas2D:', e);
  }
};

// 获取推流参数并启动
const initDesktop = async () => {
  errorMsg.value = '';
  statusText.value = '正在获取机房直连凭证...';
  try {
    // 1. 获取直连参数 (标准 RESTful API: /api/instances/:id/stream，安全鉴权直连)
    const token = localStorage.getItem('ctyun_admin_token') || '';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) {
      headers['x-admin-token'] = token;
      headers['Authorization'] = `Bearer ${token}`;
    }

    const res = await fetch(`/api/instances/${encodeURIComponent(desktopId.value)}/stream`, {
      headers,
    });
    const json = await res.json();
    if (!json.success || !json.data) {
      if (res.status === 401 || json.msg?.includes('未授权') || json.msg?.includes('登录')) {
        throw new Error('未授权访问：请先登录系统控制台后再打开云电脑直连通道');
      }
      throw new Error(json.msg || json.error || '获取机房连接凭据失败');
    }

    const data = json.data;
    streamInfo.value = data;
    desktopTitle.value = data.desktopName || `${data.accountName} - ${data.desktopId}`;
    statusText.value = `获取成功 [网关: ${data.wsHost}]，加载解码驱动...`;

    // 2. 确保 SDK 加载
    await loadSdk();
    const ClinkClientClass = (window as any).__getClinkClient();
    if (!ClinkClientClass) {
      throw new Error('未能在全局找到 ClinkClient 驱动类');
    }

    if (clinkClient) {
      try { clinkClient.stop(); } catch (e) {}
      clinkClient = null;
    }

    // 3. 实例化 ClinkClient
    clinkClient = new ClinkClientClass();
    clinkClient.setAllowIo(true);
    clinkClient.setAllowResize(true);
    clinkClient.setAllowChangeResolution(true);

    // 适配高清屏幕像素比
    const dpr = window.devicePixelRatio || 1;
    if (canvasRef.value) {
      canvasCtx = canvasRef.value.getContext('2d');
      canvasRef.value.width = currentWidth;
      canvasRef.value.height = currentHeight;
      canvasRef.value.style.imageRendering = '-webkit-optimize-contrast';
    }

    // 4. 初始化 WebCodecs 硬解（若浏览器支持）
    initWebCodecs();

    // 5. 监听分辨率与画面帧
    clinkClient.onDisplayChange.on((e: any) => {
      if (e.width && e.height) {
        currentWidth = e.width;
        currentHeight = e.height;
        if (canvasRef.value) {
          canvasRef.value.width = e.width;
          canvasRef.value.height = e.height;
        }
        if (videoDecoder && videoDecoder.state !== 'closed') {
          try {
            videoDecoder.configure({
              codec: 'avc1.42c032',
              codedWidth: e.width,
              codedHeight: e.height,
              hardwareAcceleration: 'no-preference',
            });
          } catch (err) {
            console.warn('Reconfig VideoDecoder error:', err);
          }
        }
      }
    });

    clinkClient.onImageUpdate.on((e: any) => {
      // 图像软解切片绘制（Wasm / 2D Canvas）
      if (e.type === 0 || !e.type) { // IMAGE
        if (canvasCtx && e.data instanceof Uint8ClampedArray) {
          const imgData = new ImageData(e.data, e.w || e.width, e.h || e.height);
          canvasCtx.putImageData(imgData, e.x || 0, e.y || 0);
        } else if (canvasCtx && e.data) {
          try {
            canvasCtx.drawImage(e.data, e.x || 0, e.y || 0);
          } catch (err) {}
        }
      } else if (e.type === 1) { // STREAM (H.264)
        if (videoDecoder && videoDecoder.state === 'configured') {
          try {
            const isKey = isH264Keyframe(e.data);
            const chunk = new (window as any).EncodedVideoChunk({
              type: isKey ? 'key' : 'delta',
              timestamp: 0,
              data: new Uint8Array(e.data),
            });
            videoDecoder.decode(chunk);
          } catch (err: any) {
            console.warn('WebCodecs decode warning:', err);
          }
        }
      }
    });

    clinkClient.onClinkStateChange.on((e: any) => {
      // 2: CONNECTED, 3: FIRSTIMAGE
      if (e.state === 2 || e.state === 3) {
        isConnected.value = true;
        statusText.value = '云电脑已连接 (直连机房长连接)';
      } else if (e.state === 4 || e.state === 5) {
        isConnected.value = false;
        statusText.value = '连接已断开';
      }
    });

    // 6. 构造 Clink 连接参数并启动
    const desktopInfo = data.desktopInfo || {};
    // 严禁写死 IP：严格由天翼云接口动态反查下发的 host/port 或 internalIp/internalPort 动态装配 SNI
    const targetHost = desktopInfo.host || desktopInfo.internalIp;
    const targetPort = desktopInfo.port || desktopInfo.internalPort;
    const servername = (targetHost && targetPort) ? `${targetHost}:${targetPort}` : '';
    const clinkConfig = {
      uri: data.wsHost,
      host: targetHost,
      port: targetPort,
      servername: servername,
      cert: desktopInfo.clientCert,
      ca: desktopInfo.caCert,
      key: desktopInfo.clientKey,
      ssl: true,
      oqs: desktopInfo.desktopCertCategory || 0,
      token: desktopInfo.token || desktopInfo.ticket || '',
      desktopId: data.desktopId,
      deviceCode: data.deviceCode || 'web_chrome_desktop',
      deviceType: 100,
      userAccount: data.userAccount || '',
      screen: {
        w: Math.round(window.innerWidth * (window.devicePixelRatio || 1)),
        h: Math.round(window.innerHeight * (window.devicePixelRatio || 1)),
      },
      picQuality: 4, // ri.BIT_32 32位超清真彩色
      videoQuality: 3, // oi.BEST 最高画质
      subjpegQuality: 100, // 100% 最高无损采样
      clipBoardIn: desktopInfo.clipBoardIn,
      clipBoardOut: desktopInfo.clipBoardOut,
      dragFileIn: desktopInfo.dragFileIn,
      dragFileOut: desktopInfo.dragFileOut,
      clientStrategy: desktopInfo.clientStrategy,
    };

    statusText.value = '正在与机房 WSS 网关握手建立通道...';
    clinkClient.run(clinkConfig);

  } catch (err: any) {
    errorMsg.value = err.message || '连接失败';
    statusText.value = '连接异常中止';
  }
};

// 键鼠事件捕获与转发
const handleMouseMove = (e: MouseEvent) => {
  if (!clinkClient || !canvasRef.value) return;
  const rect = canvasRef.value.getBoundingClientRect();
  const scaleX = currentWidth / rect.width;
  const scaleY = currentHeight / rect.height;
  const x = Math.round((e.clientX - rect.left) * scaleX);
  const y = Math.round((e.clientY - rect.top) * scaleY);
  clinkClient.mouse({
    type: 1, // MOVE
    x,
    y,
    button: 0,
  });
};

const handleMouseDown = (e: MouseEvent) => {
  if (!clinkClient || !canvasRef.value) return;
  const btn = e.button === 0 ? 1 : e.button === 1 ? 2 : 3; // LEFT:1, MIDDLE:2, RIGHT:3
  clinkClient.mouse({
    type: 0, // DOWN
    button: btn,
  });
};

const handleMouseUp = (e: MouseEvent) => {
  if (!clinkClient || !canvasRef.value) return;
  const btn = e.button === 0 ? 1 : e.button === 1 ? 2 : 3;
  clinkClient.mouse({
    type: 2, // UP
    button: btn,
  });
};

const handleContextMenu = (e: MouseEvent) => {
  e.preventDefault(); // 阻止浏览器原生右键菜单
};

const handleWheel = (e: WheelEvent) => {
  if (!clinkClient) return;
  e.preventDefault();
  clinkClient.mouse({
    type: 0,
    button: e.deltaY > 0 ? 5 : 4, // 5: WHEEL_DOWN, 4: WHEEL_UP
  });
  setTimeout(() => {
    clinkClient.mouse({
      type: 2,
      button: e.deltaY > 0 ? 5 : 4,
    });
  }, 30);
};

const handleKeyDown = (e: KeyboardEvent) => {
  if (!clinkClient) return;
  e.preventDefault();
  clinkClient.keyboard({
    type: 1, // DOWN
    key: e.keyCode || e.which,
  });
};

const handleKeyUp = (e: KeyboardEvent) => {
  if (!clinkClient) return;
  e.preventDefault();
  clinkClient.keyboard({
    type: 0, // UP
    key: e.keyCode || e.which,
  });
};

const toggleFullscreen = () => {
  if (!containerRef.value) return;
  if (!document.fullscreenElement) {
    containerRef.value.requestFullscreen().catch(() => {});
    isFullscreen.value = true;
  } else {
    document.exitFullscreen().catch(() => {});
    isFullscreen.value = false;
  }
};

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  initDesktop();
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeyDown);
  window.removeEventListener('keyup', handleKeyUp);
  if (clinkClient) {
    try { clinkClient.stop(); } catch (e) {}
    clinkClient = null;
  }
  if (videoDecoder && videoDecoder.state !== 'closed') {
    try { videoDecoder.close(); } catch (e) {}
  }
});
</script>

<template>
  <div ref="containerRef" class="relative flex flex-col h-screen w-screen bg-[#09090b] text-neutral-100 select-none overflow-hidden">
    <!-- 顶部状态与控制栏 -->
    <header class="h-12 border-b border-border/40 bg-background/95 backdrop-blur px-4 flex items-center justify-between z-10 shrink-0">
      <div class="flex items-center gap-3">
        <Button variant="ghost" size="sm" class="h-8 gap-1.5 text-xs text-muted-foreground hover:text-foreground" @click="router.push('/')">
          <ArrowLeft class="w-3.5 h-3.5" />
          返回控制台
        </Button>
        <div class="h-4 w-px bg-border/60"></div>
        <div class="flex items-center gap-2">
          <Monitor class="w-4 h-4 text-primary" />
          <span class="font-medium text-sm">{{ desktopTitle || '云电脑视窗' }}</span>
          <span class="text-xs text-muted-foreground font-mono">({{ desktopId }})</span>
        </div>
      </div>

      <div class="flex items-center gap-3">
        <div class="flex items-center gap-2 text-xs">
          <span class="w-2 h-2 rounded-full" :class="isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'"></span>
          <span class="text-muted-foreground">{{ statusText }}</span>
        </div>

        <Button variant="outline" size="sm" class="h-8 gap-1.5 text-xs" @click="initDesktop">
          <RefreshCw class="w-3.5 h-3.5" />
          重连
        </Button>

        <Button variant="outline" size="sm" class="h-8 gap-1.5 text-xs" @click="toggleFullscreen">
          <component :is="isFullscreen ? Minimize2 : Maximize2" class="w-3.5 h-3.5" />
          {{ isFullscreen ? '退出全屏' : '全屏' }}
        </Button>
      </div>
    </header>

    <!-- 主画布视口区域 -->
    <main class="relative flex-1 w-full h-full flex items-center justify-center bg-black/95 overflow-hidden">
      <!-- 错误警报遮罩 -->
      <div v-if="errorMsg" class="absolute inset-0 z-20 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
        <div class="max-w-md w-full bg-neutral-900 border border-destructive/40 rounded-xl p-6 text-center space-y-4 shadow-2xl">
          <div class="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center text-destructive">
            <AlertCircle class="w-6 h-6" />
          </div>
          <h3 class="text-base font-semibold text-foreground">直连推流通道建立失败</h3>
          <p class="text-xs text-muted-foreground leading-relaxed">{{ errorMsg }}</p>
          <div class="pt-2 flex justify-center gap-3">
            <Button variant="outline" size="sm" @click="router.push('/')">返回控制台</Button>
            <Button variant="default" size="sm" @click="initDesktop">重试连接</Button>
          </div>
        </div>
      </div>

      <!-- Canvas 渲染图层 -->
      <canvas
        ref="canvasRef"
        class="max-w-full max-h-full object-contain cursor-default"
        @mousemove="handleMouseMove"
        @mousedown="handleMouseDown"
        @mouseup="handleMouseUp"
        @contextmenu="handleContextMenu"
        @wheel="handleWheel"
      ></canvas>
    </main>
  </div>
</template>
