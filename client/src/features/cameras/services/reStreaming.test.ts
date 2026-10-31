// Port of test/re_streaming.test.mjs: the SAME cases and assertions — only the runner became vitest
// (the assert is still the same `assert.equal`).
import { assert, test } from 'vitest';
import { urlReStreaming } from './reStreaming';

test('urlReStreaming: format published by the hub, with the literal <password> marker', () => {
  assert.equal(
    urlReStreaming({ user: 'admin', host: '192.168.0.10', port: 8554, cameraId: '2150e7b8-3795-4648-ae66-91888f5e94bf' }),
    'rtsp://admin:<password>@192.168.0.10:8554/2150e7b8-3795-4648-ae66-91888f5e94bf');
});

test('urlReStreaming: a missing, null or empty port falls back to the mediamtx 8554', () => {
  const base = { user: 'admin', host: 'h', cameraId: 'c' };
  assert.equal(urlReStreaming(base), 'rtsp://admin:<password>@h:8554/c');
  assert.equal(urlReStreaming({ ...base, port: null }), 'rtsp://admin:<password>@h:8554/c');
  assert.equal(urlReStreaming({ ...base, port: '' }), 'rtsp://admin:<password>@h:8554/c');
});

test('urlReStreaming: a port informed by the server is honoured, number or string', () => {
  assert.equal(urlReStreaming({ user: 'u', host: 'h', port: 8555, cameraId: 'c' }), 'rtsp://u:<password>@h:8555/c');
  assert.equal(urlReStreaming({ user: 'u', host: 'h', port: '8555', cameraId: 'c' }), 'rtsp://u:<password>@h:8555/c');
});

test('urlReStreaming: the camera id goes in whole in the path and the host is not fixed', () => {
  assert.equal(
    urlReStreaming({ user: 'admin', host: '10.3.1.252', port: 8554, cameraId: 'abc-123-def' }),
    'rtsp://admin:<password>@10.3.1.252:8554/abc-123-def');
});
