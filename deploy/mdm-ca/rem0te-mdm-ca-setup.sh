#!/bin/bash
# rem0te-mdm-ca-setup.sh — the own MDM's device identity CA, once (0.84 Harbor).
#
#   sudo ./deploy/mdm-ca/rem0te-mdm-ca-setup.sh --dns-name remote.example.com [options]
#
# Rem0te's Apple MDM server checks every message a device sends against a
# certificate the device got at enrollment. That certificate comes from
# this CA: step-ca, run as its own system user `rem0te-mdm-ca`, whose keys
# the portal (`reboot`) can never read (docs/own-mdm.md "Security model",
# §93). The portal never calls the CA and never signs a device certificate;
# a device asks the CA itself, over ACME (device-attest-01, Apple's
# attestation), through the one Caddy route deploy/caddy/Caddyfile names:
#
#     handle /acme/rem0te-mdm/* { reverse_proxy https://127.0.0.1:<port> … }
#
# What it does:
#   1. creates the system user rem0te-mdm-ca (no login shell) and
#      /etc/rem0te-mdm-ca (0700, the CA's keys and ca.json) and
#      /var/lib/rem0te-mdm-ca (0700, its database);
#   2. downloads step-ca v${STEP_CA_VERSION} from GitHub into a temporary
#      directory, checks its SHA-256 against the pinned value below, and
#      installs the one binary to /usr/local/lib/rem0te-mdm-ca/step-ca
#      (or uses --step-ca-bin);
#   3. as that user, with umask 077, makes a root (EC P-384, 10 years) and
#      an intermediate (RSA 3072, 5 years, pathlen 0) with openssl, and a
#      profile-signing certificate (EC P-256, 2 years) from the intermediate;
#   4. writes ca.json: listening on 127.0.0.1:<port> only, one ACME
#      provisioner `rem0te-mdm` offering device-attest-01 with Apple
#      attestation and nothing else;
#   5. installs and starts rem0te-mdm-ca.service;
#   6. copies the PUBLIC files the portal and Caddy need into
#      /etc/rem0te-mdm-ca/public (0755): root_ca.crt, intermediate_ca.crt,
#      and prints what to upload in Settings → Mobile devices, step 6.
#
# The profile-signing key is the one secret that leaves the CA user: it is
# written to /etc/rem0te-mdm-ca/handoff/profile-signer.key (0600, root) to be
# pasted into step 6, where the portal seals it. Delete the handoff
# directory afterwards (the script prints the command).
#
# Safe to run again: it never regenerates or overwrites a key; with every
# key present it only rewrites ca.json and the unit.
#
# NOTHING here has been run against a real iPhone or iPad, or with Apple's
# attestation: the test suite runs it in a temporary directory with a SCEP
# provisioner instead (below), because the device simulator cannot do ACME.
#
# Every path can be moved, so the test (apps/api/scripts/e2e-mdm-apple.mjs)
# runs it inside a temporary directory as an ordinary user:
#   --prefix DIR          every default path under DIR (etc/, var/, usr/)
#   --no-user             no system user, no chown: everything as the caller
#   --no-systemd          install no unit (run step-ca yourself)
#   --port N              the CA's TLS port on 127.0.0.1 (default 9451)
#   --dns-name NAME       the public name devices reach (repeatable)
#   --step-ca-bin PATH    use this step-ca binary instead of downloading one. The
#                         pin is the release tarball's, so this binary is yours to
#                         have verified (CI checks the tarball first). --no-pin-check
#                         (test-only, needs --prefix) skips the download's check
#   --test-scep-port N --test-scep-challenge S
#                         TEST ONLY: also a SCEP provisioner on plain HTTP
#                         127.0.0.1:N (the device simulator's identity). It is
#                         refused without --prefix: never on a real server.
set -euo pipefail

STEP_CA_VERSION=0.30.2
STEP_CA_TARBALL=step-ca_linux_amd64.tar.gz
# From the release's checksums.txt (github.com/smallstep/certificates, v0.30.2).
STEP_CA_SHA256=1726ee7b6a24c67abb8c9e96ad671623b29b3d34f6a712f7087495f31331e54b
STEP_CA_URL="https://github.com/smallstep/certificates/releases/download/v${STEP_CA_VERSION}/${STEP_CA_TARBALL}"

die() { echo "rem0te-mdm-ca-setup: $*" >&2; exit 1; }

prefix='' no_user=0 no_systemd=0 port=9451 o_bin='' no_pin=0 scep_port='' scep_challenge=''
dns=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --prefix) prefix=$2; shift 2 ;;
    --no-user) no_user=1; shift ;;
    --no-systemd) no_systemd=1; shift ;;
    --port) port=$2; shift 2 ;;
    --dns-name) dns+=("$2"); shift 2 ;;
    --step-ca-bin) o_bin=$2; shift 2 ;;
    --no-pin-check) no_pin=1; shift ;;
    --test-scep-port) scep_port=$2; shift 2 ;;
    --test-scep-challenge) scep_challenge=$2; shift 2 ;;
    -h|--help) sed -n '2,60p' "$0"; exit 0 ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
done

[[ $port =~ ^[0-9]{2,5}$ ]] || die "--port must be a number"
[[ ${#dns[@]} -gt 0 ]] || die "give --dns-name (the portal's public name)"
for n in "${dns[@]}"; do [[ $n =~ ^[A-Za-z0-9.-]{1,253}$ ]] || die "bad --dns-name $n"; done
if [[ -n $scep_port || -n $scep_challenge ]]; then
  [[ -n $prefix ]] || die "the SCEP provisioner is for the test suite only (it needs --prefix)"
  [[ $scep_port =~ ^[0-9]{2,5}$ ]] || die "--test-scep-port must be a number"
  [[ $scep_challenge =~ ^[A-Za-z0-9._-]{8,128}$ ]] || die "--test-scep-challenge must be 8-128 of [A-Za-z0-9._-]"
fi
[[ $no_pin -eq 0 || -n $prefix ]] || die "--no-pin-check is for the test suite only (it needs --prefix)"
if [[ -z $prefix && $(id -u) -ne 0 ]]; then die "run as root (or with --prefix for a test)"; fi
command -v openssl >/dev/null || die "openssl is required"

ETC="$prefix/etc/rem0te-mdm-ca"
STATE="$prefix/var/lib/rem0te-mdm-ca"
LIBDIR="$prefix/usr/local/lib/rem0te-mdm-ca"
SYSD="$prefix/etc/systemd/system"
USER_NAME=rem0te-mdm-ca

as_ca() { if [[ $no_user -eq 1 ]]; then (umask 077; "$@"); else runuser -u "$USER_NAME" -- bash -c 'umask 077; exec "$@"' _ "$@"; fi; }

# 1. The user and directories.
if [[ $no_user -eq 0 ]] && ! id "$USER_NAME" >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE" --shell /usr/sbin/nologin "$USER_NAME"
fi
mkdir -p "$ETC" "$STATE" "$LIBDIR" "$ETC/public"
chmod 0700 "$ETC" "$STATE"
if [[ $no_user -eq 0 ]]; then chown "$USER_NAME:$USER_NAME" "$ETC" "$STATE"; fi

# 2. step-ca, pinned.
BIN="$LIBDIR/step-ca"
sha_ok() { [[ $no_pin -eq 1 ]] || [[ $(sha256sum "$1" | cut -d' ' -f1) == "$2" ]]; }
if [[ -n $o_bin ]]; then
  [[ -x $o_bin ]] || die "--step-ca-bin $o_bin is not executable"
  install -m 0755 "$o_bin" "$BIN"
elif [[ ! -x $BIN ]]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --proto '=https' -o "$tmp/$STEP_CA_TARBALL" "$STEP_CA_URL"
  sha_ok "$tmp/$STEP_CA_TARBALL" "$STEP_CA_SHA256" || die "step-ca download does not match the pinned SHA-256"
  mkdir "$tmp/x" && tar -xzf "$tmp/$STEP_CA_TARBALL" -C "$tmp/x"
  found=$(find "$tmp/x" -type f -name step-ca | head -1)
  [[ -n $found ]] || die "no step-ca binary in the release archive"
  install -m 0755 "$found" "$BIN"
fi
"$BIN" version >/dev/null 2>&1 || die "step-ca does not run"

# 3. Keys and certificates, never overwritten.
have=0
for f in root_ca_key intermediate_ca_key profile_signer_key; do [[ -e $ETC/$f ]] && have=$((have + 1)); done
if [[ $have -ne 0 && $have -ne 3 ]]; then die "$ETC holds some keys but not all: refusing to guess (move them aside or restore the rest)"; fi
if [[ $have -eq 0 ]]; then
  cnf="$ETC/openssl.cnf"
  cat > "$cnf" <<'CNF'
[req]
distinguished_name = dn
prompt = no
[dn]
O = Rem0te
[root]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[intermediate]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign, digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
[signer]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = emailProtection
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF
  if [[ $no_user -eq 0 ]]; then chown "$USER_NAME:$USER_NAME" "$cnf"; fi
  as_ca openssl ecparam -genkey -name secp384r1 -noout -out "$ETC/root_ca_key"
  as_ca openssl req -new -x509 -key "$ETC/root_ca_key" -subj "/O=Rem0te/CN=Rem0te MDM device root" -days 3650 \
    -config "$cnf" -extensions root -sha384 -out "$ETC/root_ca.crt"
  as_ca openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$ETC/intermediate_ca_key"
  as_ca openssl req -new -key "$ETC/intermediate_ca_key" -subj "/O=Rem0te/CN=Rem0te MDM device intermediate" -config "$cnf" -out "$ETC/intermediate.csr"
  as_ca openssl x509 -req -in "$ETC/intermediate.csr" -CA "$ETC/root_ca.crt" -CAkey "$ETC/root_ca_key" -CAcreateserial -days 1825 \
    -extfile "$cnf" -extensions intermediate -sha384 -out "$ETC/intermediate_ca.crt"
  as_ca openssl ecparam -genkey -name prime256v1 -noout -out "$ETC/profile_signer_key"
  as_ca openssl req -new -key "$ETC/profile_signer_key" -subj "/O=Rem0te/CN=Rem0te enrollment profiles" -config "$cnf" -out "$ETC/signer.csr"
  as_ca openssl x509 -req -in "$ETC/signer.csr" -CA "$ETC/intermediate_ca.crt" -CAkey "$ETC/intermediate_ca_key" -CAcreateserial -days 730 \
    -extfile "$cnf" -extensions signer -sha256 -out "$ETC/profile_signer.crt"
  rm -f "$ETC/intermediate.csr" "$ETC/signer.csr"
fi

# 4. ca.json: loopback only; ACME device-attest-01 (Apple) and nothing else.
dns_json=$(printf '"%s",' "${dns[@]}" "127.0.0.1"); dns_json="[${dns_json%,}]"
scep_json='' insecure=''
if [[ -n $scep_port ]]; then
  insecure="\"insecureAddress\": \"127.0.0.1:${scep_port}\","
  scep_json=",{ \"type\": \"SCEP\", \"name\": \"rem0te-mdm-test\", \"challenge\": \"${scep_challenge}\", \"minimumPublicKeyLength\": 2048, \"encryptionAlgorithmIdentifier\": 2 }"
fi
cat > "$ETC/ca.json.new" <<JSON
{
  "root": "$ETC/root_ca.crt",
  "crt": "$ETC/intermediate_ca.crt",
  "key": "$ETC/intermediate_ca_key",
  "address": "127.0.0.1:${port}",
  ${insecure}
  "dnsNames": ${dns_json},
  "logger": { "format": "text" },
  "db": { "type": "badgerv2", "dataSource": "$STATE/db" },
  "authority": {
    "claims": { "minTLSCertDuration": "24h", "maxTLSCertDuration": "8760h", "defaultTLSCertDuration": "8760h" },
    "provisioners": [
      { "type": "ACME", "name": "rem0te-mdm", "challenges": ["device-attest-01"], "attestationFormats": ["apple"] }${scep_json}
    ]
  },
  "tls": { "minVersion": 1.2, "maxVersion": 1.3, "renegotiation": false }
}
JSON
mv "$ETC/ca.json.new" "$ETC/ca.json"
chmod 0600 "$ETC/ca.json"
if [[ $no_user -eq 0 ]]; then chown -R "$USER_NAME:$USER_NAME" "$ETC" "$STATE"; fi

# 6 (before 5, so a unit that starts finds them). The public files.
install -m 0644 "$ETC/root_ca.crt" "$ETC/public/root_ca.crt"
install -m 0644 "$ETC/intermediate_ca.crt" "$ETC/public/intermediate_ca.crt"
install -m 0644 "$ETC/profile_signer.crt" "$ETC/public/profile_signer.crt"
chmod 0755 "$ETC/public"
mkdir -p "$ETC/handoff" && chmod 0700 "$ETC/handoff"
cp "$ETC/profile_signer_key" "$ETC/handoff/profile-signer.key" && chmod 0600 "$ETC/handoff/profile-signer.key"
if [[ $no_user -eq 0 ]]; then chown root:root "$ETC/handoff" "$ETC/handoff/profile-signer.key"; chmod 0711 "$ETC"; fi

# 5. The unit.
if [[ $no_systemd -eq 0 ]]; then
  mkdir -p "$SYSD"
  cat > "$SYSD/rem0te-mdm-ca.service" <<UNIT
[Unit]
Description=Rem0te MDM device identity CA (step-ca)
After=network-online.target

[Service]
User=$USER_NAME
Group=$USER_NAME
ExecStart=$BIN $ETC/ca.json
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ReadWritePaths=$STATE
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
UMask=0077

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now rem0te-mdm-ca.service
fi

cat <<DONE
rem0te-mdm-ca is set up.

  CA (TLS, loopback only):  https://127.0.0.1:${port}
  ACME directory (public):  https://${dns[0]}/acme/rem0te-mdm/directory  (after the Caddy route)

Settings → Mobile devices, step 6:
  Device CA root:           $ETC/public/root_ca.crt
  Device CA intermediate:   $ETC/public/intermediate_ca.crt
  Profile signer:           $ETC/public/profile_signer.crt  (chain: intermediate_ca.crt)
  Profile signer key:       $ETC/handoff/profile-signer.key  (paste it, then: rm -r $ETC/handoff)

Caddy: copy root_ca.crt to /etc/caddy/rem0te-mdm-ca-root.crt and add the
/acme/rem0te-mdm/* route from deploy/caddy/Caddyfile.
DONE
