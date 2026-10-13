const crypto = require('node:crypto');
const nodemailer = require('nodemailer');

const unavailable = () => Object.assign(new Error('Email delivery is temporarily unavailable. Please try again shortly.'), { code: 'EMAIL_UNAVAILABLE', status: 503 });
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function createEmailService({ env = process.env, fetchImpl = globalThis.fetch, transport } = {}) {
  async function send(email, name, purpose, token) {
    try {
      const provider = env.EMAIL_PROVIDER || 'smtp';
      if (provider === 'gmail-bridge') {
        const endpoint = new URL(env.EMAIL_BRIDGE_URL);
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || !env.EMAIL_BRIDGE_SECRET || env.EMAIL_BRIDGE_SECRET.length < 32) throw unavailable();
        const body = { email, purpose, token, name: name || '', timestamp: Date.now(), nonce: crypto.randomBytes(16).toString('hex') };
        const payload = JSON.stringify(body);
        const signature = crypto.createHmac('sha256', env.EMAIL_BRIDGE_SECRET).update(payload).digest('hex');
        const response = await fetchImpl(endpoint.href, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signature}` }, body: payload, redirect: 'error', signal: AbortSignal.timeout(35000) });
        if (!response.ok || (await response.json()).accepted !== true) throw unavailable();
        return;
      }
      if (provider !== 'smtp') throw unavailable();
      const port = Number(env.EMAIL_PORT || 587);
      if (!env.EMAIL_HOST || !env.EMAIL_USER || !env.EMAIL_PASSWORD || !Number.isInteger(port) || port < 1 || port > 65535) throw unavailable();
      const mailer = transport || nodemailer.createTransport({ host: env.EMAIL_HOST, port,
        secure: env.EMAIL_SECURE ? env.EMAIL_SECURE === 'true' : port === 465,
        auth: { user: env.EMAIL_USER, pass: env.EMAIL_HOST === 'smtp.gmail.com' ? env.EMAIL_PASSWORD.replaceAll(' ', '') : env.EMAIL_PASSWORD },
        connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
        disableFileAccess: true, disableUrlAccess: true });
      const subject = purpose === 'password-reset' ? 'Password Reset OTP - ShortJob' : purpose === 'verification' ? 'Verify Your Email - ShortJob' : 'Your ShortJob Verification Code';
      const expiry = purpose === 'registration' ? '10 minutes' : purpose === 'password-reset' ? '15 minutes' : '1 hour';
      const action = purpose === 'verification' ? new URL(`/verify-email/${encodeURIComponent(token)}`, env.CLIENT_URL).href : token;
      const text = `${name ? `Hello ${name},\n\n` : ''}${subject}\n\n${action}\n\nExpires in ${expiry}. If you did not request this email, ignore it.`;
      const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:32px"><h1 style="color:#0d9488">ShortJob</h1><h2>${subject}</h2>${name ? `<p>Hello ${escape(name)},</p>` : ''}${purpose === 'verification' ? `<a href="${escape(action)}">Verify email</a>` : `<p style="font-size:32px;letter-spacing:6px;font-weight:bold">${escape(token)}</p>`}<p>Expires in ${expiry}. If you did not request this email, ignore it.</p></div>`;
      const result = await mailer.sendMail({ from: { name: 'ShortJob', address: env.EMAIL_USER }, to: { address: email }, subject, text, html });
      if (result.rejected?.length || (result.accepted && !result.accepted.length)) throw unavailable();
    } catch { throw unavailable(); }
  }
  return {
    sendRegistrationOTP: (email, name, otp) => send(email, name, 'registration', otp),
    sendPasswordResetOTP: (email, otp) => send(email, '', 'password-reset', otp),
    sendVerificationEmail: (email, name, token) => send(email, name, 'verification', token),
  };
}
module.exports = { ...createEmailService(), createEmailService };
