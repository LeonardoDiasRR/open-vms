'use strict';
// ponytail: regex instead of a full XML parser (M1)
function parseProbeMatch(xml) {
  if (!xml.includes('ProbeMatch')) return null;
  const g = (re) => (xml.match(re) || [])[1];
  const scopes = g(/<d:Scopes>([^<]*)<\/d:Scopes>/) || '';
  const scope = (key) => {
    const m = scopes.match(new RegExp('onvif://www\\.onvif\\.org/' + key + '/([^ ]+)'));
    return m ? decodeURIComponent(m[1].replace(/%20/g, ' ')) : null;
  };
  const xaddrs = g(/<d:XAddrs>([^<]+)</);
  return {
    endpoint: g(/<a:Address>([^<]+)</),
    name: scope('name'), model: scope('Model'), hardware: scope('hardware'),
    xaddr: xaddrs ? xaddrs.trim().split(/\s+/)[0] : null,
  };
}
function buildProbe(messageId) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
 xmlns:a="http://schemas.xmlsoap.org/ws/2004/08/addressing"
 xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery"
 xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
 <s:Header>
  <a:Action s:mustUnderstand="1">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</a:Action>
  <a:MessageID>${messageId}</a:MessageID>
  <a:To>http://schemas.xmlsoap.org/ws/2005/04/discovery/multicast</a:To>
 </s:Header>
 <s:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></s:Body>
</s:Envelope>`;
}
module.exports = { parseProbeMatch, buildProbe };
