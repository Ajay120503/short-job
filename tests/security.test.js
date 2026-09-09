const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const { authenticateSocket, canJoinConversation } = require('../utils/socketAccess');
const { resolvePostImageRemoval } = require('../utils/postImageRemoval');
const { downloadImage } = require('../utils/ocrImageDownload');

test('post image deletion rejects assets belonging to other posts and malformed input', () => {
  const owned = [{ publicId: 'posts/mine' }];
  assert.deepEqual(resolvePostImageRemoval('["posts/mine","posts/mine"]', owned), ['posts/mine']);
  assert.throws(() => resolvePostImageRemoval('["profiles/someone-else"]', owned));
  assert.throws(() => resolvePostImageRemoval('{"length":1}', owned));
  assert.throws(() => resolvePostImageRemoval('[null]', owned));
});

test('socket authentication rejects missing, invalid and blocked sessions', async (t) => {
  process.env.JWT_SECRET = 'test-only-socket-secret';
  const id = '64b000000000000000000001';
  const auth = (token) => new Promise((resolve) => {
    const socket = { handshake: { auth: { token } }, data: {} };
    authenticateSocket(socket, (error) => resolve({ error, socket }));
  });
  assert.ok((await auth()).error);
  assert.ok((await auth('invalid')).error);
  const token = jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' });
  t.mock.method(User, 'findById', () => ({ select: async () => ({ _id: id, isActive: true, isBlocked: true }) }));
  assert.ok((await auth(token)).error);
  User.findById.mock.mockImplementation(() => ({ select: async () => ({ _id: id, isActive: true, showOnlineStatus: false }) }));
  const allowed = await auth(token);
  assert.equal(allowed.error, undefined);
  assert.equal(allowed.socket.data.userId, id);
  assert.equal(allowed.socket.data.sharePresence, false);
});

test('conversation authorization scopes the database check to the authenticated participant', async (t) => {
  const userId = '64b000000000000000000001';
  const room = '64b000000000000000000002';
  t.mock.method(Conversation, 'exists', async (filter) => {
    assert.deepEqual(filter, { _id: room, participants: userId });
    return null;
  });
  assert.equal(await canJoinConversation({ data: { userId } }, room), false);
  assert.equal(await canJoinConversation({ data: { userId } }, { $ne: null }), false);
});

test('OCR rejects arbitrary hosts before making a request', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network call'); });
  for (const url of ['http://127.0.0.1/a', 'https://res.cloudinary.com.evil.test/a', 'https://user@res.cloudinary.com/a']) {
    await assert.rejects(downloadImage(url), /trusted Cloudinary/);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('OCR stops streamed downloads that exceed the limit even without content-length', async (t) => {
  let chunksRead = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.redirect, 'error');
    return {
      ok: true,
      headers: new Headers({ 'content-type': 'image/png' }),
      body: (async function* () {
        for (let i = 0; i < 20; i++) { chunksRead++; yield Buffer.alloc(1024 * 1024); }
      })(),
    };
  });
  await assert.rejects(downloadImage('https://res.cloudinary.com/demo/image/upload/sample.png'), /size limit/);
  assert.equal(chunksRead, 7);
});
