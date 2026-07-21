#!/bin/sh
# Container entrypoint. When TS_AUTHKEY is provided (e.g. on Railway), bring up
# Tailscale in userspace-networking mode so the app can reach the local Apple
# Music wrapper over the tailnet. Railway/most PaaS containers have no /dev/net/tun,
# so we use userspace networking + a local SOCKS5 proxy (localhost:1055) that the
# wrapper client dials through (APPLE_WRAPPER_SOCKS5). No-ops without TS_AUTHKEY.
set -e

if [ -n "${TS_AUTHKEY}" ]; then
    echo "[tailscale] starting userspace daemon (SOCKS5 + HTTP proxy on localhost:1055)..."
    mkdir -p /var/run/tailscale /var/lib/tailscale
    tailscaled \
        --state=/var/lib/tailscale/tailscaled.state \
        --socket=/var/run/tailscale/tailscaled.sock \
        --tun=userspace-networking \
        --socks5-server=localhost:1055 \
        --outbound-http-proxy-listen=localhost:1055 &

    # Wait for the control socket before authenticating.
    i=0
    while [ ! -S /var/run/tailscale/tailscaled.sock ] && [ "$i" -lt 30 ]; do
        i=$((i + 1))
        sleep 0.3
    done

    tailscale up \
        --authkey="${TS_AUTHKEY}" \
        --hostname="${TS_HOSTNAME:-tryptify-railway}" \
        ${TS_EXTRA_ARGS:-}
    echo "[tailscale] up. status:"
    tailscale status || true
else
    echo "[tailscale] TS_AUTHKEY unset - skipping tailnet. The wrapper will be unreachable unless APPLE_WRAPPER_HOST is routable without Tailscale."
fi

exec "$@"
