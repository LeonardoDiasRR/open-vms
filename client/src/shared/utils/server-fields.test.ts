import { describe, expect, it } from 'vitest';
import {
  SERVER_HOST_KEY, SERVER_PORT_KEY, buildBase, readLastConnection, saveLastConnection, splitServerValue,
} from './server-fields';

describe('splitServerValue (spec 2026-10-30, 3.2)', () => {
  it('decompõe URL legada com e sem porta', () => {
    expect(splitServerValue('http://10.95.7.25')).toEqual({ host: '10.95.7.25', port: '' });
    expect(splitServerValue('http://10.95.7.30:7102')).toEqual({ host: '10.95.7.30', port: '7102' });
    expect(splitServerValue('https://vms.pf.gov.br:8443')).toEqual({ host: 'vms.pf.gov.br', port: '8443' });
  });
  it('valor sem scheme e host inteiro (host:porta digitado fica invalido na conexao)', () => {
    expect(splitServerValue('10.95.7.30')).toEqual({ host: '10.95.7.30', port: '' });
    expect(splitServerValue('10.95.7.30:7102')).toEqual({ host: '10.95.7.30:7102', port: '' });
  });
  it('http:// sozinho nao explode', () => {
    expect(splitServerValue('http://')).toEqual({ host: 'http://', port: '' });
  });
});

describe('buildBase (spec 2026-10-30, 3.2)', () => {
  it('omite a porta quando vazia', () => {
    expect(buildBase('http:', '10.95.7.30', '')).toBe('http://10.95.7.30');
  });
  it('monta host e porta', () => {
    expect(buildBase('http:', '10.95.7.30', '7102')).toBe('http://10.95.7.30:7102');
  });
});

describe('memoria da ultima conexao (spec 2026-10-30, 3.1)', () => {
  it('sem memoria usa host e porta da pagina', () => {
    localStorage.clear();
    const l = readLastConnection();
    expect(l.host).toBe(window.location.hostname);
    expect(l.port).toBe(window.location.port);
  });
  it('guarda e recupera host e porta', () => {
    localStorage.clear();
    saveLastConnection('10.0.0.9', '8443');
    expect(readLastConnection()).toEqual({ host: '10.0.0.9', port: '8443' });
    expect(localStorage.getItem(SERVER_HOST_KEY)).toBe('10.0.0.9');
    expect(localStorage.getItem(SERVER_PORT_KEY)).toBe('8443');
  });
  it('valor legado URL inteira decompoe na leitura', () => {
    localStorage.clear();
    localStorage.setItem(SERVER_HOST_KEY, 'http://10.95.7.25');
    expect(readLastConnection().host).toBe('10.95.7.25');
  });
});
