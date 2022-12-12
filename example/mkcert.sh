#!/bin/bash
set -e
set -o pipefail
mkcert -install
mkcert localhost
