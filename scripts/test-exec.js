'use strict';
const execMod = require('../server/src/exec');

async function test() {
  console.log('--- Testing Command Execution Module ---');

  // 1. Run basic stdout command
  console.log('Test 1: Running "node -v"...');
  const res1 = await execMod.runCommand({ command: 'node -v' });
  console.log('Result 1:', res1);

  if (!res1.ok || !res1.stdout.includes('v')) {
    console.error('FAIL: Test 1 failed!');
    process.exit(1);
  }

  // 2. Run command with custom cwd
  console.log('Test 2: Running directory check in process.cwd()...');
  const res2 = await execMod.runCommand({ command: 'dir', cwd: process.cwd() });
  console.log('Result 2 ok:', res2.ok, 'duration:', res2.durationMs);

  if (!res2.ok) {
    console.error('FAIL: Test 2 failed!');
    process.exit(1);
  }

  // 3. Test non-zero exit code / stderr
  console.log('Test 3: Running invalid command...');
  const res3 = await execMod.runCommand({ command: 'node -e "process.exit(42)"' });
  console.log('Result 3 exitCode:', res3.exitCode, 'ok:', res3.ok);

  if (res3.ok || res3.exitCode !== 42) {
    console.error('FAIL: Test 3 failed!');
    process.exit(1);
  }

  console.log('✅ ALL COMMAND EXECUTION TESTS PASSED SUCCESSFULLY!');
}

test().catch((err) => {
  console.error('Unhandled test error:', err);
  process.exit(1);
});
