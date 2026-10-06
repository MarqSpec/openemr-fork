import {start} from './start.js';

const app = await start(process.env, {
  writeError: text => process.stderr.write(text),
});
if (app === undefined) {
  process.exitCode = 1;
} else {
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void app.close());
  }
}
