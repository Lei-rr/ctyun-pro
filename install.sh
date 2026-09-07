#!/usr/bin/env bash
# ==============================================================================
# CTYUN-PRO Linux 原生二进制一键安装 & 开机自启守护脚本
# GitHub: https://github.com/Lei-rr/ctyun-pro
# ==============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
PLAIN='\033[0m'

INSTALL_DIR="/usr/local/bin"
BIN_FILE="${INSTALL_DIR}/ctyun-pro"
WORK_DIR="/opt/ctyun-pro"
DATA_DIR="${WORK_DIR}/data"
SERVICE_FILE="/etc/systemd/system/ctyun-pro.service"
DEFAULT_PORT=3088

# 检查 root 权限
if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}[ERROR]${PLAIN} 此脚本必须以 root 权限运行，请使用 sudo 或切换到 root 用户！"
    exit 1
fi

# 卸载逻辑
if [ "$1" = "uninstall" ]; then
    echo -e "${YELLOW}[INFO]${PLAIN} 正在卸载 CTYUN-PRO..."
    if command -v systemctl >/dev/null 2>&1; then
        systemctl stop ctyun-pro 2>/dev/null || true
        systemctl disable ctyun-pro 2>/dev/null || true
    fi
    rm -f "${SERVICE_FILE}"
    rm -f "${BIN_FILE}"
    if command -v systemctl >/dev/null 2>&1; then
        systemctl daemon-reload
    fi
    echo -e "${GREEN}[SUCCESS]${PLAIN} CTYUN-PRO 服务与可执行文件已彻底移除！"
    echo -e "${CYAN}[NOTE]${PLAIN} 数据目录 ${DATA_DIR} 已为您保留以防误删，如需彻底清除可手动执行：rm -rf ${WORK_DIR}"
    exit 0
fi

echo -e "${CYAN}====================================================${PLAIN}"
echo -e "${GREEN}        CTYUN-PRO 一键安装 & 开机自启部署脚本        ${PLAIN}"
echo -e "${CYAN}====================================================${PLAIN}"

# 检测系统架构
ARCH=$(uname -m)
case "${ARCH}" in
    x86_64|amd64)
        ASSET_NAME="ctyun-pro-linux-amd64"
        ;;
    aarch64|arm64)
        ASSET_NAME="ctyun-pro-linux-arm64"
        ;;
    *)
        echo -e "${RED}[ERROR]${PLAIN} 暂不支持当前 CPU 架构: ${ARCH}，请使用 Docker 或源码部署。"
        exit 1
        ;;
esac

echo -e "${BLUE}[1/4]${PLAIN} 检测到系统架构: ${GREEN}${ARCH}${PLAIN} (${ASSET_NAME})"

# 下载可执行文件
DOWNLOAD_URL="https://github.com/Lei-rr/ctyun-pro/releases/latest/download/${ASSET_NAME}"
echo -e "${BLUE}[2/4]${PLAIN} 正在从 GitHub 下载最新版本独立单文件..."
echo -e "      下载地址: ${CYAN}${DOWNLOAD_URL}${PLAIN}"

TMP_FILE="/tmp/${ASSET_NAME}"
if command -v curl >/dev/null 2>&1; then
    curl -fL --progress-bar "${DOWNLOAD_URL}" -o "${TMP_FILE}"
elif command -v wget >/dev/null 2>&1; then
    wget --show-progress -qO "${TMP_FILE}" "${DOWNLOAD_URL}"
else
    echo -e "${RED}[ERROR]${PLAIN} 未找到 curl 或 wget 工具，请先安装！"
    exit 1
fi

chmod +x "${TMP_FILE}"
mv -f "${TMP_FILE}" "${BIN_FILE}"
echo -e "${GREEN}[OK]${PLAIN} 可执行程序已安装至: ${BIN_FILE}"

# 创建工作与数据目录
mkdir -p "${DATA_DIR}"

# 配置 systemd 服务
echo -e "${BLUE}[3/4]${PLAIN} 配置 systemd 系统服务与开机自启..."

if command -v systemctl >/dev/null 2>&1; then
    cat <<EOF > "${SERVICE_FILE}"
[Unit]
Description=CTYUN-PRO Keepalive & CloudPC Management Service
After=network.target

[Service]
Type=simple
WorkingDirectory=${WORK_DIR}
Environment=PORT=${DEFAULT_PORT}
Environment=CTYUN_DATA_DIR=${DATA_DIR}
ExecStart=${BIN_FILE}
Restart=always
RestartSec=5s
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable ctyun-pro >/dev/null 2>&1
    systemctl restart ctyun-pro
    echo -e "${GREEN}[OK]${PLAIN} systemd 服务已成功注册并配置开机自启，服务已启动！"
else
    echo -e "${YELLOW}[WARN]${PLAIN} 未检测到 systemd，跳过系统服务配置。您可以直接手动运行：${BIN_FILE}"
fi

# 获取本机内网 IP
IP_ADDR=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")

echo -e "\n${GREEN}====================================================${PLAIN}"
echo -e "${GREEN}🎉 恭喜！CTYUN-PRO 原生部署成功并已开启开机自启！${PLAIN}"
echo -e "${GREEN}====================================================${PLAIN}"
echo -e "Web 控制台地址: ${CYAN}http://${IP_ADDR}:${DEFAULT_PORT}${PLAIN} (本地: http://127.0.0.1:${DEFAULT_PORT})"
echo -e "数据存储目录:   ${YELLOW}${DATA_DIR}${PLAIN}"
echo -e "\n${CYAN}常用服务管理命令：${PLAIN}"
echo -e "  启动服务:   ${GREEN}systemctl start ctyun-pro${PLAIN}"
echo -e "  停止服务:   ${GREEN}systemctl stop ctyun-pro${PLAIN}"
echo -e "  重启服务:   ${GREEN}systemctl restart ctyun-pro${PLAIN}"
echo -e "  查看状态:   ${GREEN}systemctl status ctyun-pro${PLAIN}"
echo -e "  查看实时日志: ${GREEN}journalctl -u ctyun-pro -f${PLAIN}"
echo -e "  一键卸载:   ${RED}curl -fsSL https://raw.githubusercontent.com/Lei-rr/ctyun-pro/main/install.sh | bash -s -- uninstall${PLAIN}"
echo -e "====================================================\n"
