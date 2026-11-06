set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update >/dev/null 2>&1
printf 'apt_update_exit=0\n'
apt-get install -y --no-install-recommends ca-certificates curl xz-utils python3 python-is-python3 git build-essential pkg-config procps tini >/dev/null 2>&1
printf 'apt_install_exit=0\n'
case "$(uname -m)" in aarch64) arch=arm64 ;; x86_64) arch=x64 ;; *) exit 91 ;; esac
mkdir -p /opt/node-download /workspace
cd /opt/node-download
curl -fsSLO "https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-${arch}.tar.xz"
curl -fsSLO https://nodejs.org/dist/v22.23.3/SHASUMS256.txt
sha256sum --check --ignore-missing SHASUMS256.txt >/dev/null
printf 'node_archive_checksum_exit=0\n'
printf 'node_archive_sha256=%s\n' "$(sha256sum "node-v22.23.3-linux-${arch}.tar.xz" | cut -d' ' -f1)"
tar -xJf "node-v22.23.3-linux-${arch}.tar.xz" -C /usr/local --strip-components=1
node --version
npm --version
python --version
test -x /usr/bin/tini
printf 'tini_present=1\n'
dpkg-query -W -f='pkg=${Package} ${Version}\n' ca-certificates curl xz-utils python3 python-is-python3 git build-essential pkg-config procps tini
. /etc/os-release
printf 'linux_distribution=%s\n' "$PRETTY_NAME"
