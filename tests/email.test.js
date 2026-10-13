const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createEmailService } = require('../utils/email');
const secret = 'test-only-email-bridge-secret-32-characters';
const env = { EMAIL_PROVIDER: 'gmail-bridge', EMAIL_BRIDGE_URL: 'https://mail.example.com/api/email', EMAIL_BRIDGE_SECRET: secret };
test('backend signs each purpose and waits for the bridge acknowledgement', async () => {
  const payloads = [];
  const service = createEmailService({env, fetchImpl: async (url, options) => {
    assert.equal(url, env.EMAIL_BRIDGE_URL);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer '+crypto.createHmac('sha256',secret).update(options.body).digest('hex'));
    payloads.push(JSON.parse(options.body));
    return {ok:true,json:async()=>({accepted:true})};
  }});
  await service.sendRegistrationOTP('member@example.com','Member','123456');
  await service.sendPasswordResetOTP('member@example.com','654321');
  await service.sendVerificationEmail('member@example.com','Member','a'.repeat(64));
  assert.deepEqual(payloads.map(p=>p.purpose),['registration','password-reset','verification']);
  assert.equal(new Set(payloads.map(p=>p.nonce)).size,3);
  assert.ok(payloads.every(p=>Math.abs(Date.now()-p.timestamp)<1000));
});
test('backend fails closed on configuration, HTTP, timeout and malformed acknowledgement errors', async () => {
  for (const settings of [{...env,EMAIL_BRIDGE_URL:'http://localhost'}, {...env,EMAIL_BRIDGE_SECRET:'short'}, {...env,EMAIL_PROVIDER:'unknown'}]) {
    await assert.rejects(createEmailService({ env: settings }).sendPasswordResetOTP('member@example.com','123456'), { code: 'EMAIL_UNAVAILABLE', status: 503 });
  }
  for (const fetchImpl of [async()=>({ok:false}),async()=>{throw new Error('private key and OTP');},async()=>({ok:true,json:async()=>({})})]) {
    await assert.rejects(createEmailService({env,fetchImpl}).sendRegistrationOTP('member@example.com','Member','123456'),error=>error.code==='EMAIL_UNAVAILABLE'&&!error.message.includes('private'));
  }
});

test('direct SMTP remains available and escapes names', async()=>{
  let message;
  const service=createEmailService({env:{EMAIL_HOST:'smtp.gmail.com',EMAIL_PORT:'465',EMAIL_USER:'sender@example.com',EMAIL_PASSWORD:'private'},transport:{sendMail:async m=>{message=m;return {accepted:[m.to.address]};}}});
  await service.sendRegistrationOTP('member@example.com','<b>Member</b>','123456');
  assert.match(message.html,/&lt;b&gt;Member&lt;\/b&gt;/);assert.match(message.text,/123456/);
});
