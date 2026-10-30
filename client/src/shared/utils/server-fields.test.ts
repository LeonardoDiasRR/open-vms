import { describe, expect, it } from 'vitest';
import {
  LOGIN_MEMORY, MODAL_MEMORY, SERVER_HOST_KEY, SERVER_PORT_KEY, buildBase, readLastBase,
  readLastConnection, saveLastConnection, splitServerValue,
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
    saveLastConnection(LOGIN_MEMORY, '10.0.0.9', '8443');
    expect(readLastConnection()).toEqual({ host: '10.0.0.9', port: '8443' });
    expect(localStorage.getItem(SERVER_HOST_KEY)).toBe('10.0.0.9');
    expect(localStorage.getItem(SERVER_PORT_KEY)).toBe('8443');
  });
  it('valor legado URL inteira decompoe na leitura', () => {
    localStorage.clear();
    localStorage.setItem(SERVER_HOST_KEY, 'http://10.95.7.25');
    expect(readLastConnection().host).toBe('10.95.7.25');
  });
  it('readLastBase monta a base da memoria; legado decompoe; sem memoria vazio', () => {
    localStorage.clear();
    saveLastConnection(LOGIN_MEMORY, 'srv9', '7102');
    expect(readLastBase()).toBe(`${window.location.protocol}//srv9:7102`);
    localStorage.clear();
    localStorage.setItem(SERVER_HOST_KEY, 'http://10.95.7.25:7102');
    expect(readLastBase()).toBe('http://10.95.7.25:7102');
    localStorage.clear();
    expect(readLastBase()).toBe('');
  });
});

describe('escopos independentes (spec 2026-10-30 memoria-conexao-independente, 3.1)', () => {
  it('guarda e recupera nas chaves da modal sem tocar no login (e vice-versa)', () => {
    localStorage.clear();
    saveLastConnection(MODAL_MEMORY, '10.0.0.8', '8443');
    expect(readLastConnection(MODAL_MEMORY)).toEqual({ host: '10.0.0.8', port: '8443' });
    expect(localStorage.getItem('openvms.serverModal')).toBe('10.0.0.8');
    expect(localStorage.getItem('openvms.portModal')).toBe('8443');
    expect(readLastConnection(LOGIN_MEMORY).host).toBe(window.location.hostname);
    expect(localStorage.getItem(SERVER_HOST_KEY)).toBeNull();
    saveLastConnection(LOGIN_MEMORY, '10.0.0.7', '7102');
    expect(readLastConnection(MODAL_MEMORY)).toEqual({ host: '10.0.0.8', port: '8443' });
    expect(localStorage.getItem('openvms.serverModal')).toBe('10.0.0.8');
  });
  it('readLastConnection sem argumento le o escopo do login', () => {
    localStorage.clear();
    saveLastConnection(MODAL_MEMORY, 'so.a.modal', '1234');
    expect(readLastConnection()).toEqual(readLastConnection(LOGIN_MEMORY));
    expect(readLastConnection().host).toBe(window.location.hostname);
    expect(readLastBase()).toBe('');
  });
});
