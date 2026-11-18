/**
 * Test helper: hold a state-store lock in a second process until stdin ends.
 * Not a *.test.mjs file, so `npm test` does not execute it directly.
 */
import { openStateStore } from '../scripts/state-store.mjs';

const statePath = process.argv[2];
if (!statePath) {
  console.error('usage: node store-lock-holder.mjs <statePath>');
  process.exit(2);
}

const store = await openStateStore(statePath);
process.stdout.write('locked\n');

await new Promise((resolve) => {
  process.stdin.resume();
  process.stdin.once('end', resolve);
});
await store.close();
