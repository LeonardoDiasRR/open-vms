import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { en } from './en';
import { ptBR } from './pt-BR';

// Spec 2026-11-06 (sentence case nos avisos). A regra vale para o texto que o produto mostra no
// toast. O catalogo inteiro NAO entra: 163 chaves em pt-BR sao minusculas de proposito
// ('conectando…', 'selecione uma câmera', 'as duas senhas não são iguais'), e o guarda nelas
// seria ruido permanente. Medido: 163 em pt-BR e 51 em en.
//
// As chaves de aviso sao DERIVADAS do fonte, nao listadas a mao — uma chave nova usada dentro de
// um notify() entra no guarda sozinha. A lista CONHECIDAS do ultimo it() e a trava: se o regex de
// abaixo deixar de ver um notify(), aquele teste falha em vez de o guarda virar silencio.

function primeiraLetraDeCadaFraseEstaMaiuscula(v: string): boolean {
  // Placeholder na frente nao tem o que capitalizar: o primeiro caractere e um valor digitado
  // pelo operador ('{name} bloqueado', '{ok} de {total} excluídos…'). O codigo nao capitaliza
  // o que nao escreveu.
  if (!v || v[0] === '{') return true;
  return v.split(/(?<=[.!?])\s+/).every((f) => !f || f[0] === '{' || f[0] === f[0].toUpperCase());
}

function arquivosDeCodigo(dir: string): string[] {
  const out: string[] = [];
  for (const entrada of readdirSync(dir)) {
    const p = join(dir, entrada);
    if (statSync(p).isDirectory()) out.push(...arquivosDeCodigo(p));
    else if (/\.(ts|tsx)$/.test(p) && !p.includes('.test.') && !p.includes('/i18n/')) out.push(p);
  }
  return out;
}

function chavesDeAviso(): Set<string> {
  const chaves = new Set<string>();
  for (const p of arquivosDeCodigo(join(process.cwd(), 'src'))) {
    const texto = readFileSync(p, 'utf8');
    for (const chamada of texto.matchAll(/notify\(([\s\S]{0,400}?)\)(?:\s*[,;])/g)) {
      for (const k of chamada[1].matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) chaves.add(k[1]);
    }
  }
  return chaves;
}

describe('case dos avisos', () => {
  it('aplica a regra nos quatro casos que a definem', () => {
    expect(primeiraLetraDeCadaFraseEstaMaiuscula('falha na ação')).toBe(false);
    expect(primeiraLetraDeCadaFraseEstaMaiuscula('Falha na ação')).toBe(true);
    expect(primeiraLetraDeCadaFraseEstaMaiuscula('{ok} de {total} excluídos; {failed} falharam')).toBe(true);
    expect(primeiraLetraDeCadaFraseEstaMaiuscula('Não foi possível copiar. selecione o texto.')).toBe(false);
  });

  it('os sete textos que esta entrega corrige estao em maiuscula', () => {
    const ESPERADO: Record<string, string> = {
      'app.action_failed': 'Falha na ação',
      'admin.users.load_failed': 'Falha ao carregar os usuários',
      'admin.users.status_failed': 'Falha ao mudar a situação',
      'admin.users.reset_failed': 'Falha ao resetar a senha',
      'admin.users.delete_failed': 'Falha ao excluir o usuário',
      'admin.profiles.load_failed': 'Falha ao carregar os perfis',
      'admin.profiles.delete_failed': 'Falha ao excluir o perfil',
    };
    for (const [k, v] of Object.entries(ESPERADO)) expect(ptBR[k as keyof typeof ptBR], k).toBe(v);
  });

  it('os dois avisos de situacao comecam com o substantivo, como os irmãos da tabela', () => {
    expect(ptBR['admin.users.blocked' as keyof typeof ptBR]).toBe('Usuário {name} bloqueado');
    expect(ptBR['admin.users.activated' as keyof typeof ptBR]).toBe('Usuário {name} ativado');
    expect(en['admin.users.blocked' as keyof typeof en]).toBe('User {name} blocked');
    expect(en['admin.users.activated' as keyof typeof en]).toBe('User {name} activated');
  });

  it('nenhum aviso e montado em ingles a mao no componente', () => {
    for (const f of ['features/admin/components/TabelaPerfis.tsx', 'features/admin/components/TabelaUsuarios.tsx']) {
      const src = readFileSync(join(process.cwd(), 'src', f), 'utf8');
      expect(src, `${f} chama notify( com template literal`).not.toMatch(/notify\(`/);
    }
  });

  it('nenhum aviso comeca em minuscula nos dois catalogos', () => {
    const chaves = chavesDeAviso();
    const violacoes: string[] = [];
    for (const [nome, cat] of [['pt-BR', ptBR], ['en', en]] as const) {
      for (const k of chaves) {
        const v = (cat as Record<string, string>)[k];
        if (v === undefined) { violacoes.push(`${nome} ${k}: chave ausente no catalogo`); continue; }
        if (!primeiraLetraDeCadaFraseEstaMaiuscula(v)) violacoes.push(`${nome} ${k}: ${JSON.stringify(v)}`);
      }
    }
    expect(violacoes, `avisos fora do padrao:\n${violacoes.join('\n')}`).toEqual([]);
  });

  it('derivacao ve as chaves conhecidas (trava contra regex quebrado)', () => {
    const CONHECIDAS = ['app.action_failed', 'app.delete_partial', 'admin.users.created',
      'admin.users.updated', 'admin.users.deleted', 'admin.users.blocked', 'admin.users.activated',
      'admin.users.pwd_copied', 'admin.users.pwd_copy_failed', 'admin.users.load_failed',
      'admin.users.status_failed', 'admin.users.reset_failed', 'admin.users.delete_failed',
      'admin.profiles.created', 'admin.profiles.updated', 'admin.profiles.deleted',
      'admin.profiles.load_failed', 'admin.profiles.delete_failed'];
    const derivadas = chavesDeAviso();
    expect(CONHECIDAS.filter((k) => !derivadas.has(k))).toEqual([]);
  });
});
