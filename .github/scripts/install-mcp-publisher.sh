#!/usr/bin/env bash
# Installs a pinned, checksum-verified mcp-publisher (the MCP Registry CLI) into ./bin.
# Bump MCP_PUBLISHER_VERSION and the SHA-256 together; both come from the release's
# registry_<version>_checksums.txt at https://github.com/modelcontextprotocol/registry/releases
set -euo pipefail

MCP_PUBLISHER_VERSION="1.8.5"
MCP_PUBLISHER_SHA256="2d151ac57275c9a6684d9d22b1cba81058bab195ea0a162e8fce3c6a5ec32812" # linux_amd64

archive="mcp-publisher_linux_amd64.tar.gz"
curl -fsSL -o "$archive" \
  "https://github.com/modelcontextprotocol/registry/releases/download/v${MCP_PUBLISHER_VERSION}/${archive}"
echo "${MCP_PUBLISHER_SHA256}  ${archive}" | sha256sum --check --strict
mkdir -p bin
tar -xzf "$archive" -C bin mcp-publisher
rm "$archive"
./bin/mcp-publisher --help >/dev/null
