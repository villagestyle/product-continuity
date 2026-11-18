// Real Windows handle that allows reads but denies replace/delete until released.
// Used only by host acceptance against an exact simulated temporary file.
import { spawn } from 'node:child_process';

export async function holdAgainstReplace(path) {
  if (process.platform !== 'win32') throw new Error('This handle check requires Windows');
  const literal = "'" + path.replaceAll("'", "''") + "'";
  const source = `$handle = [System.IO.File]::Open(${literal}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)\ntry { [Console]::Out.WriteLine('HANDLE_READY'); [Console]::Out.Flush(); [Console]::In.ReadLine() | Out-Null } finally { $handle.Dispose() }`;
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolveReady, reject) => {
      const timeout = setTimeout(() => reject(new Error('Windows file handle readiness timed out')), 10000);
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
        if (stdout.includes('HANDLE_READY')) { clearTimeout(timeout); resolveReady(); }
      });
      child.once('error', (error) => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code) => { clearTimeout(timeout); reject(new Error('File handle process exited before readiness: ' + code + ' ' + stderr)); });
    });
  } catch (error) {
    if (child.exitCode === null) child.kill();
    throw error;
  }
  return {
    async release() {
      if (child.exitCode !== null) return;
      await new Promise((resolveExit) => {
        child.once('exit', resolveExit);
        child.stdin.end('\n');
      });
    },
  };
}
