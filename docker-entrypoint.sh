#!/bin/sh
# 容器里的 127.0.0.1 是容器自己。frp 在宿主机上时，改走 Docker 网关。
set -e

target="${VITE_PROXY_TARGET:-}"
if [ -z "$target" ] && [ -f .env.pro ]; then
  target=$(grep -E '^VITE_PROXY_TARGET=' .env.pro | head -n 1 | cut -d= -f2- | tr -d '\r' | tr -d '"' | tr -d "'")
fi

case "$target" in
  ""|http://127.0.0.1:*|http://localhost:*|https://127.0.0.1:*|https://localhost:*)
    if [ -f /.dockerenv ] && [ -f /proc/net/route ]; then
      gw_hex=$(awk '$2 == "00000000" { print $3; exit }' /proc/net/route)
      if [ -n "$gw_hex" ] && [ "$gw_hex" != "00000000" ]; then
        port=4080
        case "$target" in
          *:*)
            port=${target##*:}
            port=${port%%/*}
            ;;
        esac
        b1=$((16#${gw_hex:6:2}))
        b2=$((16#${gw_hex:4:2}))
        b3=$((16#${gw_hex:2:2}))
        b4=$((16#${gw_hex:0:2}))
        export VITE_PROXY_TARGET="http://${b1}.${b2}.${b3}.${b4}:${port}"
        echo "frp proxy ${VITE_PROXY_TARGET}"
      fi
    fi
    ;;
esac

exec "$@"
