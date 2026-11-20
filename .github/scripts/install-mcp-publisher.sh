#!/usr/bin/env bash
# Installs a pinned, checksum-verified mcp-publisher (the MCP Registry CLI) into ./bin.
# Bump MCP_PUBLISHER_VERSION and the SHA-256 together; both come from the release's
# registry_<version>_checksums.txt at https://github.com/modelcontextprotocol/registry/releases
# Pick a release at least 14 days old (supply-chain cooldown).
set -euo pipefail

MCP_PUBLISHER_VERSION="1.8.1"
MCP_PUBLISHER_SHA256="a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc" # linux_amd64

archive="mcp-publisher_linux_amd64.tar.gz"
curl -fsSL --retry 3 -o "$archive" \
  "https://github.com/modelcontextprotocol/registry/releases/download/v${MCP_PUBLISHER_VERSION}/${archive}"
echo "${MCP_PUBLISHER_SHA256}  ${archive}" | sha256sum --check --strict
mkdir -p bin
tar -xzf "$archive" -C bin mcp-publisher
rm "$archive"
./bin/mcp-publisher --help >/dev/null
