#!/usr/bin/env bash
# =============================================================================
#  Zagros Node — Official Installer Script (Docker-First Architecture)
#  Repository: https://github.com/ZagrosGM/zagros-scripts
#
#  Interactive Usage:
#    curl -sL https://raw.githubusercontent.com/ZagrosGM/Zagros-Node/main/zagros-node.sh | bash
#
#  Automated Usage:
#    curl -fsSL https://raw.githubusercontent.com/ZagrosGM/zagros-scripts/main/zagros-node.sh | \
#      sudo bash -s -- --name "Germany-01" --service-port 62050 --api-port 62051 \
#                     --registration-token "TOKEN"
# =============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${CYAN}====================================================${NC}"
echo -e "${CYAN}      Zagros Node Official Docker Installer         ${NC}"
echo -e "${CYAN}====================================================${NC}"

NODE_NAME=""
SERVICE_PORT=""
API_PORT=""
PANEL_URL=""
REGISTRATION_TOKEN=""
NODE_VERSION="v1.0.0-alpha.9"
DATA_DIR="/opt/zagros-node"
ACTION="install"
IS_INTERACTIVE=0

# Detect if stdin is terminal and no arguments were passed
if [ -t 0 ] && [ $# -eq 0 ]; then
    IS_INTERACTIVE=1
fi

# Parse CLI arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --name)
      NODE_NAME="$2"
      shift 2
      ;;
    --service-port|--port)
      SERVICE_PORT="$2"
      shift 2
      ;;
    --api-port)
      API_PORT="$2"
      shift 2
      ;;
    --panel|--panel-url)
      PANEL_URL="$2"
      shift 2
      ;;
    --registration-token|--token)
      REGISTRATION_TOKEN="$2"
      shift 2
      ;;
    --version)
      NODE_VERSION="$2"
      shift 2
      ;;
    --uninstall)
      ACTION="uninstall"
      shift
      ;;
    --update|--upgrade)
      ACTION="update"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
    echo -e "${RED}[✗] Please run as root (sudo bash)${NC}" >&2
    exit 1
fi

if [ "$ACTION" = "uninstall" ]; then
    echo -e "${RED}[*] Uninstalling Zagros Node...${NC}"
    if [ -f "$DATA_DIR/docker-compose.yml" ]; then
        docker compose -f "$DATA_DIR/docker-compose.yml" down 2>/dev/null || true
    fi
    docker stop zagros-node 2>/dev/null || true
    docker rm zagros-node 2>/dev/null || true
    systemctl stop zagros-node.service 2>/dev/null || true
    systemctl disable zagros-node.service 2>/dev/null || true
    rm -f /etc/systemd/system/zagros-node.service
    rm -f /usr/local/bin/zagros-node /usr/local/bin/zn
    systemctl daemon-reload 2>/dev/null || true
    echo -e "${GREEN}[✓] Zagros Node uninstalled successfully.${NC}"
    exit 0
fi

if [ "$ACTION" = "update" ]; then
    echo -e "${BLUE}[*] Updating Zagros Node container...${NC}"
    docker pull "ghcr.io/zagrosgm/zagros-node:${NODE_VERSION}"
    if [ -f "$DATA_DIR/docker-compose.yml" ]; then
        docker compose -f "$DATA_DIR/docker-compose.yml" up -d --force-recreate
    fi
    echo -e "${GREEN}[✓] Zagros Node updated to ${NODE_VERSION}.${NC}"
    exit 0
fi

# Interactive Prompts if no flags passed
if [ "$IS_INTERACTIVE" -eq 1 ]; then
    echo -e "${YELLOW}Interactive Mode:${NC} Press Enter to accept default values.\n"
    
    read -p "Node name [Zagros-Node-1]: " input_name
    NODE_NAME="${input_name:-Zagros-Node-1}"

    read -p "Service port [62050]: " input_service_port
    SERVICE_PORT="${input_service_port:-62050}"

    read -p "API port [62051]: " input_api_port
    API_PORT="${input_api_port:-62051}"
else
    NODE_NAME="${NODE_NAME:-Germany-01}"
    SERVICE_PORT="${SERVICE_PORT:-62050}"
    API_PORT="${API_PORT:-62051}"
fi

# Port validation
if ! [[ "$SERVICE_PORT" =~ ^[0-9]+$ ]] || [ "$SERVICE_PORT" -lt 1 ] || [ "$SERVICE_PORT" -gt 65535 ]; then
    echo -e "${RED}[✗] Invalid Service Port: ${SERVICE_PORT}${NC}" >&2
    exit 1
fi
if ! [[ "$API_PORT" =~ ^[0-9]+$ ]] || [ "$API_PORT" -lt 1 ] || [ "$API_PORT" -gt 65535 ]; then
    echo -e "${RED}[✗] Invalid API Port: ${API_PORT}${NC}" >&2
    exit 1
fi
if [ "$SERVICE_PORT" -eq "$API_PORT" ]; then
    echo -e "${RED}[✗] Service Port and API Port cannot be identical!${NC}" >&2
    exit 1
fi

# Generate One-Time Registration Token if not provided
if [ -z "$REGISTRATION_TOKEN" ]; then
    REGISTRATION_TOKEN=$(openssl rand -hex 32)
fi

# 1. Install Docker & dependencies if missing
if ! command -v docker >/dev/null 2>&1; then
    echo -e "${BLUE}[*] Installing Docker...${NC}"
    curl -fsSL https://get.docker.com | sh
    systemctl enable --now docker
fi

for tool in curl openssl; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo -e "${BLUE}[*] Installing $tool...${NC}"
        if command -v apt-get >/dev/null 2>&1; then
            apt-get update -qq && apt-get install -y -qq "$tool"
        elif command -v dnf >/dev/null 2>&1; then
            dnf install -y "$tool"
        elif command -v yum >/dev/null 2>&1; then
            yum install -y "$tool"
        fi
    fi
done

# 2. Setup Data Directory & TLS Certificates
mkdir -p "$DATA_DIR/certs" "$DATA_DIR/data" "$DATA_DIR/logs"
chmod 700 "$DATA_DIR" "$DATA_DIR/data" "$DATA_DIR/certs"

if [ -f "$DATA_DIR/data/identity.json" ]; then
    rm -f "$DATA_DIR/data/identity.json" "$DATA_DIR/certs/node.crt" "$DATA_DIR/certs/node.key"
fi

if [ ! -f "$DATA_DIR/certs/node.crt" ] || [ ! -f "$DATA_DIR/certs/node.key" ]; then
    echo -e "${BLUE}[*] Generating self-signed TLS Certificate...${NC}"
    PUBLIC_IP=$(curl -s -m 5 https://api.ipify.org || curl -s -m 5 https://ifconfig.me || echo "127.0.0.1")
    
    SAN="IP:${PUBLIC_IP}"
    if [[ ! "$PUBLIC_IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        SAN="DNS:${PUBLIC_IP}"
    fi

    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$DATA_DIR/certs/node.key" \
      -out "$DATA_DIR/certs/node.crt" \
      -days 3650 \
      -subj "/CN=${NODE_NAME}" \
      -addext "subjectAltName=${SAN},IP:127.0.0.1,DNS:localhost,DNS:${NODE_NAME}" >/dev/null 2>&1
    chmod 600 "$DATA_DIR/certs/node.key"
    chmod 644 "$DATA_DIR/certs/node.crt"
fi

FINGERPRINT=$(openssl x509 -noout -fingerprint -sha256 -in "$DATA_DIR/certs/node.crt" | cut -d'=' -f2 | tr -d ':')
CERT_PEM=$(cat "$DATA_DIR/certs/node.crt")
REGISTRATION_HASH=$(printf '%s' "$REGISTRATION_TOKEN" | sha256sum | cut -d' ' -f1)

# 3. Create .env Configuration
cat << EOF > "$DATA_DIR/.env"
ZAGROS_NODE_NAME=${NODE_NAME}
NODE_SERVICE_PORT=${SERVICE_PORT}
NODE_API_PORT=${API_PORT}
ZAGROS_NODE_SERVICE_PORT=${SERVICE_PORT}
ZAGROS_NODE_PORT=${API_PORT}
ZAGROS_NODE_DATA=/var/lib/zagros-node
ZAGROS_NODE_REGISTRATION_TOKEN=${REGISTRATION_TOKEN}
ZAGROS_NODE_REGISTRATION_HASH=${REGISTRATION_HASH}
PANEL_URL=${PANEL_URL}
ZAGROS_NODE_FINGERPRINT=${FINGERPRINT}
ZAGROS_NODE_VERSION=${NODE_VERSION}
EOF
chmod 600 "$DATA_DIR/.env"

# 4. Create docker-compose.yml
cat << EOF > "$DATA_DIR/docker-compose.yml"
name: zagros-node

services:
  zagros-node:
    image: ghcr.io/zagrosgm/zagros-node:${NODE_VERSION}
    container_name: zagros-node
    restart: always
    network_mode: host
    privileged: true
    env_file:
      - .env
    volumes:
      - ./data:/var/lib/zagros-node
      - ./certs:/var/lib/zagros-node/certs
      - ./logs:/var/lib/zagros-node/logs
EOF
chmod 600 "$DATA_DIR/docker-compose.yml"

# 5. Create Systemd Service for Docker Compose lifecycle
cat << EOF > /etc/systemd/system/zagros-node.service
[Unit]
Description=Zagros Node Agent Docker Service
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${DATA_DIR}
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down
ExecReload=/usr/bin/docker compose restart
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable zagros-node.service 2>/dev/null || true

# 6. Install CLI Executable (/usr/local/bin/zagros-node & /usr/local/bin/zn)
cat << 'EOF' > /usr/local/bin/zagros-node
#!/usr/bin/env bash
# Zagros Node Official CLI — Absolute Paths independent of CWD
set -euo pipefail

DATA_DIR="/opt/zagros-node"
cmd="${1:-status}"
shift || true

case "$cmd" in
  status)
    echo -e "\033[1;36m--- Zagros Node Status ---\033[0m"
    if [ -f "$DATA_DIR/.env" ]; then
      grep -E "^(ZAGROS_NODE_NAME|NODE_SERVICE_PORT|NODE_API_PORT|ZAGROS_NODE_VERSION)=" "$DATA_DIR/.env" || true
    fi
    docker ps --filter "name=zagros-node" --format "Container Status: {{.Status}} ({{.Image}})"
    if [ -f "$DATA_DIR/certs/node.crt" ]; then
      echo "TLS Certificate: Valid (/opt/zagros-node/certs/node.crt)"
    else
      echo "TLS Certificate: Missing"
    fi
    ;;
  start|up)
    docker compose -f "$DATA_DIR/docker-compose.yml" up -d
    ;;
  stop|down)
    docker compose -f "$DATA_DIR/docker-compose.yml" down
    ;;
  restart)
    docker compose -f "$DATA_DIR/docker-compose.yml" restart
    ;;
  logs)
    docker logs -f --tail "${1:-200}" zagros-node
    ;;
  update)
    docker compose -f "$DATA_DIR/docker-compose.yml" pull
    docker compose -f "$DATA_DIR/docker-compose.yml" up -d --force-recreate
    ;;
  config)
    echo -e "\033[1;36m--- Configuration (${DATA_DIR}/.env) ---\033[0m"
    if [ -f "$DATA_DIR/.env" ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        [[ -z "$line" || "$line" =~ ^# ]] && continue
        key="${line%%=*}"
        val="${line#*=}"
        lowkey=$(echo "$key" | tr '[:upper:]' '[:lower:]')
        if [[ "$lowkey" =~ (token|secret|key|pass|private) ]]; then
          echo "${key}=${val:0:3}********"
        else
          echo "${line}"
        fi
      done < "$DATA_DIR/.env"
    fi
    ;;
  doctor)
    echo -e "\033[1;36m--- Zagros Node Diagnostics ---\033[0m"
    echo -n "Docker Daemon:   " && docker info >/dev/null 2>&1 && echo "OK" || echo "FAIL"
    echo -n "Container State: " && docker ps --filter "name=zagros-node" --format "{{.Status}}"
    echo -n "TLS Certificate: " && [ -f "$DATA_DIR/certs/node.crt" ] && echo "OK" || echo "MISSING"
    ;;
  version)
    if [ -f "$DATA_DIR/.env" ]; then
      grep "^ZAGROS_NODE_VERSION=" "$DATA_DIR/.env" | cut -d'=' -f2
    else
      echo "v1.0.0-alpha.9"
    fi
    ;;
  uninstall)
    docker compose -f "$DATA_DIR/docker-compose.yml" down 2>/dev/null || true
    systemctl stop zagros-node.service 2>/dev/null || true
    systemctl disable zagros-node.service 2>/dev/null || true
    rm -f /etc/systemd/system/zagros-node.service /usr/local/bin/zagros-node /usr/local/bin/zn
    systemctl daemon-reload 2>/dev/null || true
    echo "Zagros Node uninstalled."
    ;;
  *)
    echo "Usage: zagros-node {status|start|stop|restart|up|down|logs|update|config|doctor|version|uninstall}"
    ;;
esac
EOF
chmod +x /usr/local/bin/zagros-node
ln -sf /usr/local/bin/zagros-node /usr/local/bin/zn

# 7. Pull & Start Container
echo -e "${BLUE}[*] Pulling and starting Zagros Node container...${NC}"
docker compose -f "$DATA_DIR/docker-compose.yml" pull -q || true
docker compose -f "$DATA_DIR/docker-compose.yml" up -d

# 8. Complete Registration with Zagros Panel if PANEL_URL and TOKEN provided
if [ -n "$PANEL_URL" ] && [ -n "$REGISTRATION_TOKEN" ]; then
    echo -e "${BLUE}[*] Waiting for Node API startup...${NC}"
    for i in {1..10}; do
        if curl -k -s "https://127.0.0.1:${API_PORT}/v1/health" >/dev/null 2>&1 || curl -k -s "https://127.0.0.1:${API_PORT}/" >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done

    echo -e "${BLUE}[*] Registering with Zagros Panel (${PANEL_URL})...${NC}"
    PUBLIC_IP=$(curl -s -m 5 https://api.ipify.org || curl -s -m 5 https://ifconfig.me || echo "127.0.0.1")
    ESCAPED_CERT=$(python3 -c "import json, sys; print(json.dumps(sys.stdin.read()))" < "$DATA_DIR/certs/node.crt" 2>/dev/null || echo "\"\"")

    PAYLOAD=$(cat << EOF
{
  "registration_token": "${REGISTRATION_TOKEN}",
  "address": "${PUBLIC_IP}",
  "port": ${SERVICE_PORT},
  "api_port": ${API_PORT},
  "certificate_pem": ${ESCAPED_CERT},
  "fingerprint": "${FINGERPRINT}"
}
EOF
)

    for retry in {1..5}; do
        REG_RESP=$(curl -s -k -X POST "${PANEL_URL}/api/zagros/nodes/complete-registration" \
          -H "Content-Type: application/json" \
          -d "$PAYLOAD" || true)

        if echo "$REG_RESP" | grep -q '"ok":true'; then
            echo -e "${GREEN}[✓] Node registered with Zagros Panel successfully!${NC}"
            break
        else
            if [ $retry -lt 5 ]; then
                sleep 2
            else
                echo -e "${YELLOW}[!] Panel registration response: ${REG_RESP}${NC}"
            fi
        fi
    done
fi

echo -e "${GREEN}====================================================${NC}"
echo -e "${GREEN}            Zagros Node Installation                ${NC}"
echo -e "${GREEN}====================================================${NC}"
echo -e "Node Name:                           ${CYAN}${NODE_NAME}${NC}"
echo -e "Service Port:                        ${CYAN}${SERVICE_PORT}${NC}"
echo -e "API Port:                            ${CYAN}${API_PORT}${NC}"
echo -e ""
echo -e "One-Time Registration Token:"
echo -e "${YELLOW}${REGISTRATION_TOKEN}${NC}"
echo -e ""
echo -e "TLS SHA-256 Certificate Fingerprint:"
echo -e "${YELLOW}${FINGERPRINT}${NC}"
echo -e "${GREEN}====================================================${NC}"
echo -e "${GREEN}Enter these values in Zagros Panel -> Node Management${NC}"
echo -e "${GREEN}====================================================${NC}"
