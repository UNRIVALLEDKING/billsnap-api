#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VPS. Run as root:
#   DEPLOY_SSH_PUBKEY="ssh-ed25519 AAAA..." ./bootstrap.sh
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
: "${DEPLOY_SSH_PUBKEY:?set DEPLOY_SSH_PUBKEY to the public key the deploy user logs in with}"
DEPLOY_USER="${DEPLOY_USER:-deploy}"
APP_DIR="${APP_DIR:-/srv/billdrop}"
export DEBIAN_FRONTEND=noninteractive

echo ">> packages"
apt-get update
apt-get install -y ca-certificates curl gnupg ufw fail2ban unattended-upgrades

echo ">> docker (official apt repo)"
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  >/etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

echo ">> deploy user"
id "$DEPLOY_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos "" "$DEPLOY_USER"
usermod -aG docker "$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
grep -qxF "$DEPLOY_SSH_PUBKEY" "/home/$DEPLOY_USER/.ssh/authorized_keys" 2>/dev/null ||
  echo "$DEPLOY_SSH_PUBKEY" >>"/home/$DEPLOY_USER/.ssh/authorized_keys"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh/authorized_keys"
chmod 600 "/home/$DEPLOY_USER/.ssh/authorized_keys"
install -d -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"

echo ">> ssh hardening (keys only, no root login)"
cat >/etc/ssh/sshd_config.d/99-billdrop.conf <<'SSHD'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
SSHD
sshd -t && systemctl reload ssh

echo ">> firewall: 22, 80, 443"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo ">> fail2ban"
systemctl enable --now fail2ban

echo ">> unattended security upgrades"
echo 'APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";' >/etc/apt/apt.conf.d/20auto-upgrades
systemctl enable --now unattended-upgrades

echo ">> done. Copy deploy/ and a filled-in .env to $APP_DIR, then run deploy.sh."
