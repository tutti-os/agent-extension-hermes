import { spawnSync } from 'node:child_process';
import { resolvePythonCommand } from './python-command.mjs';

const python = resolvePythonCommand();
const result = spawnSync(python.executable, [...python.args, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
