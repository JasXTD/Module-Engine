/* Larger transfers use owned loopback bytes only. Never open the saved file. */
const fs = require('node:fs/promises'), path = require('node:path'), { createHash } = require('node:crypto');
function transferFixture(GM) {
  const data = document.documentElement.dataset;
  document.addEventListener('transfer-checks', async () => {
    const results = {}, request = GM.xmlHttpRequest;
    try {
      data.transferStage = 'construct FormData';
      const form = new FormData(); form.append('label', 'first ✓'); form.append('label', 'second');
      const bytes = new Uint8Array(262144); bytes[0] = 128; bytes[bytes.length - 1] = 255;
      form.append('file', new Blob([bytes], { type: 'application/octet-stream' }), 'offline.bin');
      data.transferStage = 'send multipart';
      await request({ url: '/usnet/cookie' });
      results.cookieSeeded = (await request({ url: '/usnet/json', responseType: 'json' })).response.cookie.includes('offline_cookie=yes');
      const progress = [], states = [], responseProgress = []; let uploadLoads = 0, loads = 0;
      const response = await request({ url: '/usnet/multipart', method: 'POST', data: form, responseType: 'json', anonymous: true,
        upload: { onprogress: event => progress.push({ loaded: event.loaded, total: event.total, lengthComputable: event.lengthComputable }), onload: () => uploadLoads++ },
        onload: () => loads++, onreadystatechange: event => states.push(event.readyState), onprogress: event => responseProgress.push({readyState:event.readyState,status:event.status,loaded:event.loaded}) });
      const raw = atob(response.response.bodyBase64), last = progress.at(-1);
      results.formData = response.response.contentType.startsWith('multipart/form-data; boundary=') && raw.indexOf('first ') < raw.indexOf('second') && raw.includes('filename="offline.bin"') && raw.includes(String.fromCharCode(128) + '\0');
      results.uploadProgress = progress.length > 0 && last.loaded === last.total && last.total > bytes.length && last.lengthComputable;
      results.separateCompletion = uploadLoads === 1 && loads === 1 && response.status === 200;
      results.responseProgress = states.join(',') === '1,2,3,4' && responseProgress.length > 0 && responseProgress.every(event => event.readyState === 3 && event.status === 200);
      results.anonymous = response.response.cookie === '';
      await request({ url: '/usnet/transfer-cookie', method: 'POST', data: 'anonymous', anonymous: true, upload: { onprogress() {} } });
      results.anonymousNoSetCookie = !(await request({ url: '/usnet/json', responseType: 'json' })).response.cookie.includes('upload_cookie=');
      data.uploadProgress = JSON.stringify(progress);
      const kept = await request({ url: '/usnet/transfer-307', method: 'POST', data: 'preserved', responseType: 'json', upload: { onprogress() {} } });
      results.redirect307 = kept.response.method === 'POST' && kept.response.body === 'preserved';
      const rewritten = await request({ url: '/usnet/redirect', method: 'POST', data: 'discarded', responseType: 'json', upload: { onprogress() {} } });
      results.redirect302 = rewritten.response.method === 'GET' && rewritten.response.body === '' && rewritten.finalUrl.endsWith('/usnet/json');
      const fetched = await request({ url: '/usnet/redirect', responseType: 'json' });
      results.fetchRedirect = fetched.response.value === 42;
      results.scopeGuard = await request({ url: '/usnet/transfer-denied', method: 'POST', data: 'private', upload: { onprogress() {} } }).then(() => false, error => error.message.includes('@connect'));
      results.errorPolicy = await request({ url: '/usnet/redirect', redirect: 'error' }).then(() => false, error => /Redirects are disabled/.test(error.message));
      const file = await GM.download({ url: '/usnet/transfer-file-redirect', name: 'transfer-large.bin', anonymous: true });
      results.largerDownload = file.response.size === 3145728;
      data.transferResults = JSON.stringify(results);
    } catch (error) { data.transferError = error.message; data.transferStack = error.stack; data.transferResults = JSON.stringify(results); }
  });
  document.addEventListener('transfer-slow', () => {
    const pending = GM.xmlHttpRequest({ url: '/usnet/slow?transfer-abort', method: 'POST', data: new Blob([new Uint8Array(524288)]), upload: { onprogress: event => { data.slowUploaded = String(event.loaded); } } });
    pending.then(() => { data.transferAborted = 'unexpected success'; }, error => { data.transferAborted = error.message; });
    document.addEventListener('transfer-abort', () => pending.abort(), { once: true });
  });
}
async function runTransfers({ b, page, check, until, base, fixtureState, temp, evidence }) {
  const bytes = Buffer.alloc(3145728, 173);
  fixtureState.sources ||= {};
  Object.assign(fixtureState.sources, {
    '/usnet/transfer-307': { status: 307, headers: { Location: '/usnet/json' }, body: '' },
    '/usnet/transfer-denied': { status: 302, headers: { Location: base.replace('127.0.0.1', 'localhost') + '/usnet/transfer-secret' }, body: '' },
    '/usnet/transfer-file-redirect': { status: 302, headers: { Location: '/usnet/transfer-file' }, body: '' },
    '/usnet/transfer-cookie': { headers: { 'Set-Cookie': 'upload_cookie=unexpected; SameSite=Lax; Path=/' }, body: 'owned cookie test' },
    '/usnet/transfer-file': { body: bytes, mime: 'application/octet-stream' }
  });
  await b.evaluate('document.dispatchEvent(new Event("transfer-checks"))', page);
  await until('document.documentElement.dataset.transferResults', page);
  const result = await b.evaluate('({checks:JSON.parse(document.documentElement.dataset.transferResults),error:document.documentElement.dataset.transferError,stack:document.documentElement.dataset.transferStack,stage:document.documentElement.dataset.transferStage,progress:document.documentElement.dataset.uploadProgress})', page);
  evidence.transfers = result;
  check('Native transfer fixture has no unexpected error: ' + (result.error || ''), !result.error);
  for (const name of ['cookieSeeded','formData','uploadProgress','separateCompletion','responseProgress','anonymous','anonymousNoSetCookie','redirect307','redirect302','fetchRedirect','scopeGuard','errorPolicy','largerDownload']) check('Native transfer: ' + name, result.checks[name]);
  check('Forbidden redirect never reaches the owned destination', !fixtureState.hits.some(hit => hit.url === '/usnet/transfer-secret'));
  const filename = path.join(temp, 'exports', 'transfer-large.bin'), actual = await fs.readFile(filename);
  check('Larger native file contains the exact three MiB fixture', actual.equals(bytes));
  evidence.transfers.download = { filename, bytes: actual.length, sha256: createHash('sha256').update(actual).digest('hex') };
  await b.evaluate('document.dispatchEvent(new Event("transfer-slow"))', page);
  await until('Number(document.documentElement.dataset.slowUploaded)>0', page);
  await b.evaluate('document.dispatchEvent(new Event("transfer-abort"))', page);
  await until('document.documentElement.dataset.transferAborted', page);
  check('Native upload abort settles the main request', /abort/i.test(await b.evaluate('document.documentElement.dataset.transferAborted', page)));
  return 'transfer-large.bin';
}
module.exports = { transferFixture, runTransfers };
