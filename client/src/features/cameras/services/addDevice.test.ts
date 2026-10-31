import { test } from 'vitest'; import assert from 'node:assert';
import { EXAMPLES, defaultPort, parseAddress, expandRange, deviceBody, resultsForScan, subnetEnd, maskIp, invalidOctets, isCameraIneligible, defaultChannels }
  from './addDevice';

test('EXAMPLES carries the five NX examples', () => {
  assert.deepEqual(EXAMPLES, ['192.168.1.15', 'www.example.com:8080',
    'http://example.com:7090/image.jpg', 'rtsp://example.com:554/video', 'udp://239.250.5.5:1234']);
});

test('defaultPort per scheme, with 554 as fallback', () => {
  assert.equal(defaultPort('rtsp'), 554);
  assert.equal(defaultPort('http'), 80);
  assert.equal(defaultPort('https'), 443);
  assert.equal(defaultPort('udp'), 1234);
  assert.equal(defaultPort('onvif'), 554);
});

test('parseAddress: a bare IP uses the given port, else 554, and builds the rtsp source', () => {
  assert.deepEqual(parseAddress('192.168.1.15', '5003'),
    { scheme: 'rtsp', host: '192.168.1.15', port: 5003, source: 'rtsp://192.168.1.15:5003/', informada: true });
  const d = parseAddress('192.168.1.15');
  assert.equal(d.port, 554);
  assert.equal(d.source, 'rtsp://192.168.1.15:554/');
});

test('parseAddress: host:port without a scheme becomes rtsp on the given port', () => {
  assert.deepEqual(parseAddress('www.example.com:8080'),
    { scheme: 'rtsp', host: 'www.example.com', port: 8080, source: 'rtsp://www.example.com:8080/', informada: true });
});

test('parseAddress: a link with a scheme keeps the whole URL as source', () => {
  assert.deepEqual(parseAddress('rtsp://example.com:554/video'),
    { scheme: 'rtsp', host: 'example.com', port: 554, source: 'rtsp://example.com:554/video', informada: true });
  const img = parseAddress('http://example.com:7090/image.jpg');
  assert.equal(img.scheme, 'http'); assert.equal(img.port, 7090);
  assert.equal(img.source, 'http://example.com:7090/image.jpg');
  const udp = parseAddress('udp://239.250.5.5:1234');
  assert.equal(udp.scheme, 'udp'); assert.equal(udp.port, 1234);
});

test('parseAddress: a link without a port falls back to the scheme default', () => {
  assert.equal(parseAddress('rtsp://example.com/video').port, 554);
  assert.equal(parseAddress('http://example.com/x.jpg').port, 80);
});

test('parseAddress refuses an empty address', () => {
  assert.throws(() => parseAddress('   '), /address/i);
});

test('expandRange returns the inclusive range', () => {
  const ips = expandRange('10.0.0.1', '10.0.0.4');
  assert.deepEqual(ips, ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']);
  const all = expandRange('0.0.0.0', '0.0.0.255');
  assert.equal(all.length, 256); assert.equal(all[0], '0.0.0.0'); assert.equal(all[255], '0.0.0.255');
});

test('expandRange refuses a lower end, an invalid IP and a range above 1024', () => {
  assert.throws(() => expandRange('10.0.0.5', '10.0.0.1'), /last IP/i);
  assert.throws(() => expandRange('10.0.0.999', '10.0.0.1'), /invalid IP/i);
  assert.throws(() => expandRange('10.0.0.0', '10.0.4.0'), /1024/);
});

test('deviceBody builds name/addresses/credential/source', () => {
  const b = deviceBody({ name: 'Gate', address: 'rtsp://10.0.0.9:5003/ISAPI/Streaming/channels/101',
    port: '554', useDefault: false, login: 'admin', password: 'secret' });
  assert.equal(b.name, 'Gate');
  assert.deepEqual(b.addresses, [{ ip: '10.0.0.9', port: 5003, scheme: 'rtsp', informada: true }]);
  assert.equal(b.source, 'rtsp://10.0.0.9:5003/ISAPI/Streaming/channels/101');
  assert.deepEqual(b.credential, { username: 'admin', password: 'secret' });
});

test('deviceBody uses the host as name when the name is empty', () => {
  assert.equal(deviceBody({ name: '  ', address: '10.0.0.9', port: '5003', useDefault: false }).name, '10.0.0.9');
});

test('deviceBody with useDefault ignores the Port field and uses the scheme default', () => {
  const b = deviceBody({ name: 'x', address: '10.0.0.9', port: '5003', useDefault: true });
  assert.equal(b.addresses[0].port, 554);
});

test('resultsForScan: only what the current scan found', () => {
  const cands = [
    { id: 'a', ip: '10.0.0.1', scan_id: 's1', outcome: 'added' },
    { id: 'b', ip: '10.0.0.2', scan_id: 's2', outcome: 'pending' },
    { id: 'c', ip: '10.0.0.3', scan_id: 's1', outcome: 'pending' },
  ];
  assert.deepEqual(resultsForScan(cands, 's2').map((c) => c.id), ['b']);
  assert.deepEqual(resultsForScan(cands, 's1').map((c) => c.id), ['a', 'c']);
});

test('resultsForScan: without a scan it lists nothing', () => {
  const cands = [{ id: 'a', ip: '10.0.0.1', scan_id: 's1' }];
  assert.deepEqual(resultsForScan(cands, null), []);
  assert.deepEqual(resultsForScan(cands, undefined), []);
});

test('resultsForScan: an empty or missing catalog returns an empty list', () => {
  assert.deepEqual(resultsForScan([], 's1'), []);
  assert.deepEqual(resultsForScan(undefined, 's1'), []);
  assert.deepEqual(resultsForScan([null, { id: 'x', scan_id: 's1' }], 's1').map((c) => c.id), ['x']);
});

test('subnetEnd: highest IP of the /24 subnet, last octet 254', () => {
  assert.equal(subnetEnd('192.168.0.1'), '192.168.0.254');   // the example from the request
  assert.equal(subnetEnd('10.0.0.1'), '10.0.0.254');
  assert.equal(subnetEnd('10.195.96.250'), '10.195.96.254');
  assert.equal(subnetEnd('172.16.31.7'), '172.16.31.254');
  assert.equal(subnetEnd('192.168.0.255'), '192.168.0.254'); // .255 on input does not change the rule
  assert.equal(subnetEnd('0.0.0.0'), '0.0.0.254');
  assert.equal(subnetEnd('  192.168.0.1  '), '192.168.0.254'); // surrounding spaces
  assert.equal(subnetEnd('192.168.007.1'), '192.168.7.254');   // a leading zero is normalized
});

test('subnetEnd: plain IPv4 only; anything else returns null', () => {
  assert.equal(subnetEnd(''), null);
  assert.equal(subnetEnd(undefined), null);
  assert.equal(subnetEnd('192.168.0'), null);
  assert.equal(subnetEnd('192.168.0.1.2'), null);
  assert.equal(subnetEnd('192.168.0.999'), null);
  assert.equal(subnetEnd('www.example.com'), null);
  assert.equal(subnetEnd('rtsp://192.168.0.1:554/video'), null);
});

test('maskIp: formats the digits as 999.999.999.999', () => {
  assert.equal(maskIp('1'), '1');
  assert.equal(maskIp('192'), '192');
  assert.equal(maskIp('1921'), '192.1');
  assert.equal(maskIp('192168'), '192.168');
  assert.equal(maskIp('1921680'), '192.168.0');
  assert.equal(maskIp('192.168.0.254'), '192.168.0.254');
  assert.equal(maskIp('192.'), '192.'); // the trailing separator is PRESERVED (keeps the octet boundary)
  assert.equal(maskIp('192,168.'), '192.168.');     // it works for the comma too
  assert.equal(maskIp('10.195.96.7.'), '10.195.96.7'); // fourth octet full: the extra separator goes away
});

test('maskIp: typing key by key builds the right IP (regression of the dropped separator)', () => {
  let v = '';
  for (const ch of '192.168.0.1') v = maskIp(v + ch);
  assert.equal(v, '192.168.0.1');
  let w = '';
  for (const ch of '10.195.96.7') w = maskIp(w + ch);
  assert.equal(w, '10.195.96.7');
});

test('maskIp: honours a paste, the comma, the digit cap and drops the rest', () => {
  assert.equal(maskIp('10.195.96.7'), '10.195.96.7');   // short octets: the pasted dots count
  assert.equal(maskIp('10.195.96.250'), '10.195.96.250');
  assert.equal(maskIp('192,168,0,1'), '192.168.0.1');   // the pt-BR numeric keypad sends a comma
  assert.equal(maskIp(' 192.168.0.1 '), '192.168.0.1'); // surrounding spaces
  assert.equal(maskIp('192..168'), '192.168');          // a repeated dot does not open an empty octet
  assert.equal(maskIp('999.999.999.9999'), '999.999.999.999'); // 12-digit cap
  assert.equal(maskIp('abc'), '');
  assert.equal(maskIp(''), '');
  assert.equal(maskIp(undefined), '');
});

test('invalidOctets: flags the octet above 255, 1-based index', () => {
  assert.deepEqual(invalidOctets('192.168.0.254'), []);
  assert.deepEqual(invalidOctets('255.255.255.255'), []);
  assert.deepEqual(invalidOctets('256.1.1.1'), [1]);
  assert.deepEqual(invalidOctets('999.1.1.1'), [1]);
  assert.deepEqual(invalidOctets('1.2.3.999'), [4]);
  assert.deepEqual(invalidOctets('192.168.0.256'), [4]);
  assert.deepEqual(invalidOctets('999.999.999.999'), [1, 2, 3, 4]);
});

test('invalidOctets: no false positive while typing', () => {
  assert.deepEqual(invalidOctets(''), []);              // empty field
  assert.deepEqual(invalidOctets('192'), []);            // 1 or 2 digits never go past 99
  assert.deepEqual(invalidOctets('99.9.9.9'), []);
  assert.deepEqual(invalidOctets('192.168.'), []);       // an octet still empty is not an error
  assert.deepEqual(invalidOctets('192.168.0.'), []);
});

test('parseAddress: marks the informed port and only it', () => {
  assert.equal(parseAddress('192.168.1.15', '5003').informada, true);
  assert.equal(parseAddress('192.168.1.15').informada, false);
  assert.equal(parseAddress('www.example.com:8080').informada, true);
  assert.equal(parseAddress('rtsp://example.com:554/video').informada, true);
  assert.equal(parseAddress('rtsp://example.com/video').informada, false);
});

test('deviceBody: carries the informed port and the marker', () => {
  const c = deviceBody({ name: 'CAM', address: '138.219.129.186', port: '5003', useDefault: false, login: 'admin', password: 'x' });
  assert.deepEqual(c.addresses, [{ ip: '138.219.129.186', port: 5003, scheme: 'rtsp', informada: true }]);
  assert.equal(c.source, 'rtsp://138.219.129.186:5003/');
  const d = deviceBody({ name: 'CAM', address: '138.219.129.186', port: '5003', useDefault: true, login: 'admin', password: 'x' });
  assert.deepEqual(d.addresses, [{ ip: '138.219.129.186', port: 554, scheme: 'rtsp', informada: false }]);
  assert.equal(d.source, 'rtsp://138.219.129.186:554/');
});

test('isCameraIneligible: only a refused credential blocks the selection', () => {
  assert.equal(isCameraIneligible('invalid_credential'), true);
  // decision D2: a scan without credential ineligible nothing, and with a credential in the form the
  // gate never emits credential_required — so it does not block
  assert.equal(isCameraIneligible('credential_required'), false);
  assert.equal(isCameraIneligible('verified'), false);
  assert.equal(isCameraIneligible('rtsp'), false);
  assert.equal(isCameraIneligible(undefined), false);
  assert.equal(isCameraIneligible(null), false);
});

test('deviceBody without channels returns today\'s body, with no device and no channels', () => {
  const b = deviceBody({ name: 'CAM', address: '10.0.0.9', port: '5003', useDefault: false, login: 'admin', password: 'x' });
  assert.deepEqual(b, {
    name: 'CAM',
    addresses: [{ ip: '10.0.0.9', port: 5003, scheme: 'rtsp', informada: true }],
    credential: { username: 'admin', password: 'x' },
    source: 'rtsp://10.0.0.9:5003/',
  });
  assert.equal('device' in b, false);
  assert.equal('channels' in b, false);
});

test('deviceBody with channels marks the nvr device and carries the list', () => {
  const b = deviceBody({ name: 'DVR', address: '10.0.0.9', port: '5003', useDefault: false, login: 'admin', password: 'x', channels: [1, 7] });
  assert.deepEqual(b.device, { kind: 'nvr' });
  assert.deepEqual(b.channels, [1, 7]);
});

test('defaultChannels: only the channels with a stream are marked by default', () => {
  assert.deepEqual(defaultChannels([{ channel: 7, has_stream: true }, { channel: 13, has_stream: false }]), [7]);
});
