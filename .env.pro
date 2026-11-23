# 正式环境。容器里的 127.0.0.1 到不了宿主机上的 frp，登录会 503。
# 页面目前是 http://prev-frp.xuandou.vip:4100，cookie 不能带 Secure。
NODE_ENV=production
TZ=Asia/Shanghai
HTTP_ADDR=0.0.0.0:4100
TLS_ENABLE=false
FRP_HTTP_URL=https://prev-frp.xuandou.vip
FRP_WS_URL=wss://prev-frp.xuandou.vip/ws
FRP_CONNECT_TIMEOUT_MS=8000
DEV_AUTH=false
CUSTOMER_SECRET=xuandou-ai-customer-pro-secret
COOKIE_SECURE=false
