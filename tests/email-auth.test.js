const { test } = require('node:test');
const assert = require('node:assert/strict');
const User = require('../models/User');
const email = require('../utils/email');
const response = () => ({ statusCode: 200, status(code) { this.statusCode=code;return this; }, json(body) {this.body=body;return this;} });

test('password reset returns 503 on mail failure and success only after delivery', async t => {
  let delivered=false, fail=true;
  t.mock.method(email,'sendPasswordResetOTP',async()=>{
    if(fail)throw Object.assign(new Error('Email delivery is temporarily unavailable. Please try again shortly.'),{code:'EMAIL_UNAVAILABLE',status:503});
    delivered=true;
  });
  const { forgotPassword } = require('../controllers/auth.controller');
  t.mock.method(User,'findOne',async()=>({email:'member@example.com',save:async()=>{}}));
  const first=response();await forgotPassword({body:{email:'member@example.com'}},first);
  assert.equal(first.statusCode,503);assert.equal(first.body.success,undefined);assert.equal(delivered,false);
  fail=false;
  const second=response();await forgotPassword({body:{email:'member@example.com'}},second);
  assert.equal(delivered,true);assert.equal(second.statusCode,200);assert.equal(second.body.success,true);
});
