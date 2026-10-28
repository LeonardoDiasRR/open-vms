---
version: "alpha"
name: "OpenVMS — Interface de Operação"
description: "Design system observado no cliente React do OpenVMS; tokens atuais e regras para agentes de codificação."
colors:
  primary: "#16b981"
  background: "#0f1115"
  panel: "#161a20"
  border: "#232a33"
  text: "#e6e9ee"
  muted: "#8b95a3"
  warning: "#d9a13b"
  danger: "#e05252"
  scene: "#0b0d11"
  video: "#000000"
  control: "#1d232b"
  input: "#0c0e12"
  active-background: "#10312a"
  selected-row: "#1b2129"
  hovered-row: "#26303c"
  hover-border: "#38424f"
  modal-menu: "#1b1f27"
  banner-warning: "#3a2418"
typography:
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  heading-small:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  label-compact:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "11px"
    fontWeight: 400
  micro:
    fontFamily: "system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "10px"
    fontWeight: 400
rounded:
  xs: "2px"
  sm: "3px"
  md: "4px"
  lg: "6px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "10px"
  xl: "14px"
  xxl: "18px"
components:
  button-default:
    backgroundColor: "{colors.control}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.sm}"
  button-active:
    backgroundColor: "{colors.active-background}"
    textColor: "{colors.primary}"
    borderColor: "{colors.primary}"
    rounded: "{rounded.sm}"
  button-add-camera:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.background}"
    borderColor: "{colors.primary}"
    rounded: "{rounded.md}"
  input-default:
    backgroundColor: "{colors.input}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
    rounded: "{rounded.sm}"
  panel-default:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    borderColor: "{colors.border}"
  video-cell:
    backgroundColor: "{colors.video}"
    rounded: "{rounded.sm}"
  warning-banner:
    backgroundColor: "{colors.banner-warning}"
    textColor: "{colors.warning}"
    borderColor: "{colors.warning}"
  camera-row-selected:
    backgroundColor: "{colors.selected-row}"
    borderColor: "{colors.primary}"
  camera-row-hover:
    backgroundColor: "{colors.hovered-row}"
    borderColor: "{colors.primary}"
---

## Overview

OpenVMS é uma interface operacional compacta e **dark-first** para supervisão de câmeras IP, composição de layouts, reprodução e exportação de gravações. A prioridade é maximizar a área útil do vídeo sem esconder estados críticos de transmissão, gravação e erro. A referência deste documento é o **código efetivo** da branch `main` em 17/10/2026, e não funcionalidades futuras descritas em `TELAS.md`.

**Personalidade visual:** ferramenta técnica de operação contínua; superfícies grafite, separadores discretos, controles compactos e verde como indicação de ação/seleção. O projeto tem referências de interação do Nx Witness, mas os tokens acima vêm do CSS do próprio OpenVMS. Este documento descreve o estado atual; recomendações de evolução aparecem ao fim, fora dos tokens normativos.

**Fontes de verdade:** `client/src/styles.css` (tokens globais, layout e estilos concretos), `client/src/App.tsx` (shell e modos), `client/src/features/live/`, `client/src/features/archive/`, `client/src/features/cameras/`, `client/src/shared/ui/` e `client/src/shared/components/PromptDialog.tsx`. Convivem no projeto classes CSS próprias e componentes React com Tailwind v4, Radix UI e class-variance-authority; **não presumir** que todas as variantes semânticas de shadcn estão conectadas aos tokens de `styles.css`.

## Colors

- `background` é a base do aplicativo; `panel` delimita painéis; `scene` escurece ainda mais a área de vídeo. Vídeo propriamente dito usa preto puro para minimizar distração.
- `primary` é o verde efetivo (`#16b981`) usado para foco de campos, botões selecionados, CTA de inclusão, partes gravadas da timeline e sinalização de disponibilidade. Não substituir por azul por convenção.
- `text` é texto principal claro; `muted` é metadado e ajuda secundária.
- `warning` é amarelo ocre para condições transitórias e gravação ainda indisponível; `danger` é vermelho para perda de sinal ou falha.
- Indicadores circulares de câmera têm 7px: **contorno** sinaliza estado; **preenchimento** tem significado específico de gravação em curso. Não usar preenchimento indiscriminadamente.
- O CSS ainda contém cores literais fora dos tokens (por exemplo, hover, menus, placeholders e algumas ações destrutivas); preservá-las ao reproduzir fielmente a interface existente e centralizá-las somente após revisão visual.

## Typography

- Fonte de sistema, priorizando `Segoe UI` no Windows. Base global: `13px` e `line-height: 1.45`.
- Títulos pequenos: 13px/600. Legendas de cabeçalhos de painel: 11px, uppercase, `letter-spacing: .4px`. Metadados de célula: 11px; labels de modo: 10px, uppercase.
- Densidade alta é intencional para a interface de monitoração; não aumentar toda a tipografia sem estudar impacto nas grades e barras.
- A maioria dos rótulos de ação é apresentada em português; conservar nomenclatura consistente: “Ao vivo”, “Arquivo”, “Gravação”, “Adicionar câmera”, “Sem sinal”.

## Layout

- O `.shell` ocupa `100vh` e usa CSS Grid de **3 colunas** `220px minmax(0, 1fr) 260px` (na implementação, `220px 1fr 260px` com contenções de tamanho na cena), separação de 1px e três linhas `40px 1fr 24px`.
- Regiões: `topbar` (modos/usuário), `sidebar` (câmeras e layouts), `scene` (ao vivo ou arquivo), `rightpanel` (contexto) e `statusbar` (estado operacional).
- Painéis esquerdo e direito recolhidos usam **32px**; o botão de alternância é **22px** no estado atual. Não reconstruir o grid com scroll de página: a cena deve caber verticalmente e cada painel pode controlar sua própria rolagem.
- A sidebar possui **uma única região vertical de rolagem**, `.sidebar-rolagem`, e subárvores de câmeras/layouts internas.
- A grade de vídeo se adapta ao espaço disponível. Conteúdo de `<video>` usa `object-fit: contain`: nunca cortar evidências visuais por `cover`.
- Toolbars são enxutas: `padding: 6px 10px`; gaps pequenos e comandos concentrados perto do objeto controlado.
- O modal de adição de dispositivos possui largura base de **780px**, `max-width: 94vw` e `max-height: calc(100vh - 80px)`, mantendo o rodapé visível.
- A timeline atual tem altura **36px**, com segmentos gravados verdes, lacunas hachuradas, trecho ainda gravando em ocre hachurado, cursor claro e horários reduzidos.

## Elevation & Depth

- Profundidade é criada primeiro por contraste de superfícies e bordas de 1px, **não** por sombras grandes.
- Menus contextuais podem utilizar superfície `#1b1f27`, borda translúcida e sombra `0 8px 24px rgba(0,0,0,.45)`; overlays sobre vídeo são gradientes pretos translúcidos para conservar legibilidade.
- Backdrop de diálogos `.nx-backdrop`: preto translúcido (`#000a`), com diálogo escuro delimitado por borda.
- Reservar sobreposições fortes a menus, diálogos e avisos temporários; não cobrir continuamente a área de vídeo com controles desnecessários.

## Shapes

- Controles, inputs e células tendem ao raio compacto de **3px**; cards e ações pontuais podem utilizar **4px**; menus contextuais aproximadamente **6px**.
- Badges operacionais são círculos de 7px. A forma circular não significa, isoladamente, que a câmera está gravando.
- Ícones são compactos. O controle PTZ na célula tem SVG de 18px; o spinner de carregamento tem 22px, borda de 2px e rotação linear de 0,8s, desativada por `prefers-reduced-motion`.

## Components

### Application shell

`App.tsx` controla login, sessão, modos **Ao vivo** e **Arquivo**, painéis recolhíveis, notificações e fluxos de câmera/layout. Não tratar “Mural” como terceiro modo principal implementado: hoje os layouts aparecem no palco do Ao vivo com abas.

### Camera tree & layout tree

Listas hierárquicas densas permitem seleção, expansão, busca contextual, ações por menu e arrastar/soltar. Linha selecionada usa fundo escuro distinto e barra lateral verde. Hover sobre câmera é mais claro que repouso; hover de pasta destaca **somente o cabeçalho**, não os descendentes. Indicadores de câmera distinguem conectividade, provisionamento, erro e gravação.

### Live stage & stream cell

Aba de layout, palco adaptável e células pretas com vídeo centralizado por `contain`. Controles em overlay aparecem em hover; nome, perfil e ações ficam sobre gradientes. Estados essenciais incluem **carregando** (spinner e texto), **sem sinal** (X vermelho e mensagem) e **em reprodução**. PTZ, quando disponível, tem modo ativo verde, cursor de mira e faixa indicativa persistente. O fechamento de célula e os gestos de PTZ devem respeitar as rotinas existentes de parada, sem alterações apenas por estética.

### Playback & timeline

Modo Arquivo reúne seleção de câmera, timeline horizontal, reprodução/exportação e estados sem gravação. Trechos concluídos, vazios e ainda gravando têm tratamentos distintos. A timeline é uma superfície de tempo interativa, não uma barra de progresso genérica.

### Dialogs, forms & menus

O projeto usa modal próprio `.nx-dialog` e `PromptDialog` para confirmação e entrada de dados, com botões Cancelar/OK e Escape; telas concretas incluem Adicionar dispositivos e Configurações da câmera. Campos em tema escuro usam borda verde no foco. O login reúne servidor, usuário, senha e botão de revelação. O wizard de câmeras apresenta tabs “Endereço conhecido” e “Varredura de sub-rede”, validação de IP, resultados tabulares e ações por item. Configurações de câmera tem abas “Geral” e “Gravação”. Menu contextual é escuro, compacto e com tratamento de ação destrutiva.

### Primitive library coexistence

`client/src/shared/ui` contém primitivas Button, Input, Dialog, Label, Switch, Badge etc. baseadas em Tailwind/Radix/CVA. Parte da UI de negócio ainda usa CSS e botões HTML diretamente. Para criar componentes novos, conferir se as classes semânticas (`bg-primary`, `bg-background`, `ring`) de cada primitiva estão de fato mapeadas aos tokens reais antes de reutilizá-las; não fazer uma substituição global sem teste de regressão.

## Do's and Don'ts

**Do**
- Preservar tema escuro, verde de interação e densidade operacional.
- Priorizar a imagem de câmera; manter overlays transitórios, exceto estados de segurança/controle que precisam persistir.
- Diferenciar conectado, gravando, carregando, indisponível e falha com cor **e** texto/ícone/forma.
- Preservar as medidas atuais de shell, scroll único lateral e vídeo `contain`.
- Reutilizar `PromptDialog` para confirmação em vez de `window.confirm`/`prompt`.
- Conferir regras existentes em testes de UI antes de alterar componentes.

**Don't**
- Não impor Material Design, Spotify, ou outra identidade sem solicitação específica.
- Não transformar a cor verde em indicador genérico de gravação: o badge cheio possui semântica própria.
- Não inserir rolagem global no palco nem reduzir arbitrariamente a altura útil do vídeo.
- Não trocar os estados de rede/gravação por indicadores somente cromáticos.
- Não tratar propostas de `TELAS.md` como features comprovadamente presentes em `App.tsx`.

---

# Evolução recomendada — Design System Checklist

> **Este capítulo é consultivo**, não descreve componentes já implementados. As recomendações seguem as dimensões de linguagem visual, fundações, componentes e manutenção do [Design System Checklist](https://www.designsystemchecklist.com/pt). Não alteram os tokens normativos nem autorizam mudanças automáticas no produto.

## P0 — consistência, legibilidade e acessibilidade

1. **Unificar tokens CSS:** mapear os tokens `--bg`, `--panel`, `--border` etc. às classes Tailwind semânticas usadas nas primitivas React. Evitar duas paletas funcionais concorrentes. Centralizar hover, superfície de modal/menu e estilos de ação destrutiva.
2. **Definir estados de foco por teclado:** todos os botões de ícone, ações na árvore, abas, painéis e controles PTZ precisam de `:focus-visible` perceptível. O `input:focus { outline:none }` atual exige alternativa de foco de contraste testado.
3. **Acessibilidade sem depender só da cor:** fornecer nome visível/tooltip, ícone, `aria-label` ou texto acessível para “online”, “gravando”, “erro”, “sem sinal”, “PTZ ativo” e gravando-não-reproduzível.
4. **Dialog e menu com comportamento completo:** validar foco inicial, trap/restore de foco, Escape, teclado, papéis ARIA, nome/descrição, e posição responsiva em todas as modais próprias. Considerar consolidar com Radix após testes.
5. **Contraste:** medir pares texto/superfície, texto-muted e texto de aviso (WCAG 2.2 AA); não alegar aprovação sem executar a medição. Auditar botões de 22px à luz de tamanho/alvo clicável (especialmente touch).
6. **Diferenciar estados assíncronos:** estabelecer padrão visual para idle, connecting, loading, success, empty, offline, unavailable, permission-denied, retry e stale-data. Garantir anúncio de erro e feedback de operação para leitores de tela.

## P1 — tokens e componentes escaláveis

7. **Escalas explícitas:** instituir tokens de espaço (passos compactos), tipografia, altura mínima de controles, radii, z-index, overlay, durações e easing. Manter os valores legados como aliases até completar a migração.
8. **Componente de status de câmera:** API semântica `state`, `recording`, `title`, `ariaLabel` com forma/tooltip definidos; reduzir variantes CSS desconexas entre árvore e eventos.
9. **Catálogo documentado:** Button (default/primary/danger/ghost/icon, foco/loading/disabled), Input, PasswordField, SearchField, Select, Tabs, Switch, Checkbox, Tooltip, DropdownMenu, Dialog, ConfirmationDialog, Banner, Toast, Badge e EmptyState, cada qual com estados e exemplos.
10. **Componentes específicos VMS:** StreamCell, VideoToolbar, CameraTreeRow, LayoutTab, CameraStatus, PTZControl, PlaybackTimeline, RecordingSegment, NetworkDiscoveryRow e RecordingSettingsForm. Documentar contratos, teclado, estados e restrições de segurança.
11. **Responsividade operacional:** definir mínimos de viewport, colapso/ocultação prioritária de painéis, tooltip para nomes truncados, comportamento em telas menores e diferentes fatores de escala do Windows.
12. **Feedback não disruptivo:** padronizar toasts, avisos inline e histórico de eventos para resultados de adição, gravação, reconexão e exportação; não substituir toda falha por modal bloqueante.

## P2 — governança e qualidade

13. **Inventário de componentes e playground visual:** exemplos reais para todos os estados, idealmente Storybook/Ladle ou rota interna de showcase; testes de regressão visual.
14. **Documentar design tokens como contrato:** valores atuais, valores propostos, justificativa, responsáveis, versionamento e depreciação; gerar exports W3C DTCG quando necessário.
15. **Testes automáticos:** contraste, navegação de teclado, acessibilidade com axe, screenshots da grade 1×1/2×2/alta densidade, estados de erro e tamanho de janela; manter testes existentes.
16. **Governança para agentes:** sempre ler `DESIGN.md`, identificar tokens existentes antes de criar novas cores e registrar desvios de UI no PR. Validar com `npx @google/design.md lint DESIGN.md` (a execução depende do pacote estar disponível no ambiente).

## Critérios de aceitação antes de promover uma sugestão a token oficial

- Preserva comportamento atual de monitoramento/arquivo/PTZ e não oculta vídeo nem informação crítica.
- Tem variante visual, estado de teclado, semântica acessível, comportamento de erro e teste.
- É documentada no catálogo e testada nos viewports representativos da operação.
- Evita duplicar tokens de Tailwind e CSS legados.

## Rastros de implementação

- `client/src/styles.css`: paleta, dimensões, shell, células, timeline, modais e estados.
- `client/src/App.tsx`: modos e estrutura da aplicação.
- `client/src/features/live/components/StreamCell.tsx`: estados de mídia e PTZ.
- `client/src/features/live/pages/LiveView.tsx`: abas e layouts em Ao vivo.
- `client/src/features/archive/pages/ArchiveView.tsx`: reprodução, timeline e exportação.
- `client/src/features/cameras/pages/AddDeviceWizard.tsx`: descoberta, tabs e resultados.
- `client/src/features/cameras/pages/CameraSettingsModal.tsx`: configuração e gravação.
- `client/src/shared/components/PromptDialog.tsx`: diálogos de confirmação/pergunta.
- `client/src/shared/ui/`: componentes reutilizáveis de base.

Referências externas: [Google DESIGN.md](https://github.com/google-labs-code/design.md) e [Design System Checklist](https://www.designsystemchecklist.com/pt).