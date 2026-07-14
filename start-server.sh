#!/bin/bash
cd "$(dirname "$0")/server"
cargo build
cd ..
./server/target/debug/e2e-chat
