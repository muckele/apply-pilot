import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ptyDriver = String.raw`
import errno,json,os,pty,select,signal,sys,time
pid,fd=pty.fork()
if pid==0:
 os.execvpe('npm',['npm','run','correction-flow:review-documents:live','--','--expected-head='+sys.argv[1]],os.environ)
chunks=[];sent=False;deadline=time.monotonic()+30;status=None;reaped=False
try:
 while time.monotonic()<deadline:
  if select.select([fd],[],[],0.1)[0]:
   try:chunk=os.read(fd,65536)
   except OSError as error:
    if error.errno==errno.EIO:break
    raise
   if not chunk:break
   chunks.append(chunk)
   if sum(map(len,chunks))>100000:raise RuntimeError('startup output exceeded bound')
   if not sent and b'Type the exact manifest hash' in b''.join(chunks):
    os.write(fd,b'OFFLINE_REJECTED_CONSENT\n');sent=True
  done,child_status=os.waitpid(pid,os.WNOHANG)
  if done:status=child_status;reaped=True;break
 else:raise RuntimeError('startup exceeded deadline')
 if not reaped:_,status=os.waitpid(pid,0);reaped=True
 # The child can exit before its last diagnostic bytes have been read.
 while select.select([fd],[],[],0.2)[0]:
  try:chunk=os.read(fd,65536)
  except OSError as error:
   if error.errno==errno.EIO:break
   raise
  if not chunk:break
  chunks.append(chunk)
 print(json.dumps({'exitCode':os.waitstatus_to_exitcode(status),'output':b''.join(chunks).decode(errors='replace')}))
finally:
 if not reaped:
  try:os.killpg(pid,signal.SIGKILL)
  except ProcessLookupError:pass
 os.close(fd)
`;

// Injected fault-path coverage for manifest rejection in the real npm entry point.
// The historical intermittent startup failure's root cause remains unproven.
test("real npm/TTY startup reports a manifest failure safely and rejects consent before any transport", {
  skip: process.platform === "win32",
  timeout: 90_000
}, () => {
  const fixture = mkdtempSync(join(tmpdir(), "ap-review-startup-"));
  const source = fileURLToPath(new URL("../", import.meta.url));
  try {
    for (const name of ["lib", "evaluation", "prompts", "node_modules"]) {
      symlinkSync(join(source, name), join(fixture, name), "dir");
    }
    // Only code/config is copied; source data remains the frozen synthetic fixture.
    cpSync(join(source, "scripts"), join(fixture, "scripts"), { recursive: true });
    for (const name of ["package.json", "tsconfig.json", ".gitignore"]) {
      cpSync(join(source, name), join(fixture, name));
    }
    const home = join(fixture, "home");
    const preload = join(fixture, "offline-startup.mjs");
    const transportMarker = join(fixture, "transport-attempted");
    writeFileSync(preload, `
      import { writeFileSync } from 'node:fs';
      import http from 'node:http';
      import https from 'node:https';
      import net from 'node:net';
      const deny = (kind) => () => {
        writeFileSync(${JSON.stringify(transportMarker)}, kind + ':' + (process.argv[1]?.endsWith('/scripts/run-correction-flow-document-review-live.ts') ? 'launcher' : 'npm'));
        throw new Error('OFFLINE_NETWORK_FORBIDDEN');
      };
      globalThis.fetch = deny('fetch');
      http.request = http.get = https.request = https.get = deny('http');
      net.connect = net.createConnection = (...args) => {
        const path = typeof args[0] === 'string' ? args[0] : args[0]?.path;
        // tsx probes its own Unix IPC socket. Deny it too, but it is not a
        // provider/TCP attempt and must not be counted as one.
        if (typeof path === 'string' && path.startsWith('/')) throw new Error('OFFLINE_IPC_FORBIDDEN');
        return deny('net')();
      };
      if (process.env.AP_TEST_INVALID_STARTUP_DATE === '1' && process.argv[1]?.endsWith('/scripts/run-correction-flow-document-review-live.ts')) {
        const OriginalDate = Date;
        globalThis.Date = class extends OriginalDate {
          constructor(...args) { super(...(args.length ? args : [NaN])); }
        };
      }
    `);
    writeFileSync(join(fixture, ".gitignore"), readFileSync(join(fixture, ".gitignore"), "utf8") + "\nhome/\ntransport-attempted\n");
    const env = { PATH: process.env.PATH!, HOME: home, NODE_ENV: "test" as const, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const git = (args: string[]) => execFileSync("git", args, { cwd: fixture, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    git(["init", "--quiet"]);
    git(["add", "."]);
    git(["-c", "user.name=Synthetic Review", "-c", "user.email=review@example.test", "commit", "--quiet", "-m", "Synthetic launcher fixture"]);
    const head = git(["rev-parse", "HEAD"]);
    assert.equal(git(["status", "--porcelain=v1", "--untracked-files=normal"]), "");
    for (const invalidDate of [true, false]) {
      const result = spawnSync("python3", ["-c", ptyDriver, head], {
        cwd: fixture,
        env: {
          ...env,
          NODE_OPTIONS: `--import=${preload}`,
          TSX_DISABLE_CACHE: "1",
          NPM_CONFIG_UPDATE_NOTIFIER: "false",
          NPM_CONFIG_OFFLINE: "true",
          AP_TEST_INVALID_STARTUP_DATE: invalidDate ? "1" : "0"
        },
        encoding: "utf8", timeout: 40_000, maxBuffer: 150_000
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);
      const execution = JSON.parse(result.stdout) as { exitCode: number; output: string };
      assert.equal(execution.exitCode, 1, execution.output);
      assert.match(execution.output, /"status": "stopped_before_provider"/u);
      assert.match(execution.output, /"providerCallsStarted": 0/u);
      assert.match(execution.output, invalidDate
        ? /"failureCode": "LIVE_MANIFEST_BUILD_FAILED"/u
        : /"failureCode": "MANIFEST_CONSENT_MISMATCH"/u);
      assert.equal(execution.output.includes('"status": "awaiting_manifest_consent"'), !invalidDate);
      assert.doesNotMatch(execution.output, /Existing Gemini API key|LIVE_REVIEW_LAUNCHER_FAILED|OFFLINE_NETWORK_FORBIDDEN/u);
    }
    let networkAttempt: string | null = null;
    try { networkAttempt = readFileSync(transportMarker, "utf8"); }
    catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ENOENT"); }
    assert.equal(networkAttempt, null, `Unexpected denied transport attempt: ${networkAttempt}`);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
