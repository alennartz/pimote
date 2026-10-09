// Shared ✓/✗/⊝ reporting for manual-test tools.
//
// Usage:
//   const { assert, soft, section, log, stats, softFailures } = makeReporter('fp-smoke');
//   assert(condition, 'message');          // hard failure (counts toward exit)
//   soft(condition, 'message', 'note');    // environment-bounded (never fails the run)
//   section('Phase W — …');                // phase banner
//   …at the end: read stats.failures and softFailures for the summary.

export function makeReporter(prefix) {
  const stats = { failures: 0 };
  const softFailures = [];

  function assert(condition, message) {
    if (condition) console.log(`  ✓ ${message}`);
    else {
      console.error(`  ✗ ${message}`);
      stats.failures++;
    }
  }

  function soft(condition, message, note) {
    if (condition) {
      console.log(`  ✓ ${message}`);
    } else {
      console.log(`  ⊝ ${message} — environment-bounded: ${note}`);
      softFailures.push(message);
    }
  }

  function section(message) {
    console.log(`\n[${prefix}] ${message}`);
  }

  function log(...args) {
    console.log(`[${prefix}]`, ...args);
  }

  return { assert, soft, section, log, stats, softFailures };
}
