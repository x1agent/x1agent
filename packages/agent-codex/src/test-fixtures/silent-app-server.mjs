#!/usr/bin/env node
// Accept stdin but deliberately never answer, simulating a wedged app-server.
process.stdin.resume();
