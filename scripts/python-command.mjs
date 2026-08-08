import { spawnSync } from 'node:child_process';

export function resolvePythonCommand() {
  const configured = process.env.PYTHON?.trim();
  const candidates = configured
    ? [{ executable: configured, args: [] }]
    : process.platform === 'win32'
      ? [{ executable: 'py', args: ['-3'] }, { executable: 'python', args: [] }]
      : [{ executable: 'python3', args: [] }, { executable: 'python', args: [] }];
  for (const candidate of candidates) {
    const result = spawnSync(candidate.executable, [...candidate.args, '--version'], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (!result.error && result.status === 0) return candidate;
  }
  throw new Error('Python 3 is required; set PYTHON to an executable path');
}
