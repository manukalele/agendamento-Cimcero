# Guardrails de Regressao: Aba Principal e Encoding

Data: 2026-04-22
Escopo: `public/agendamentos.html` e fluxo de boot do renderer.

## 1) Incidente: Aba principal de agendamentos nao aparece

### Sintoma observado
- App abre, mas o operador nao ve o fluxo principal.
- Topbar aparece, porem sem card funcional de agendamento.

### Causa raiz
- A funcao `criarBlocoPaciente` foi removida de `public/agendamentos.html`.
- O boot do renderer chamava `adicionarCardExames()`, que depende dessa funcao.
- Resultado: `ReferenceError: criarBlocoPaciente is not defined`, interrompendo `inicializar()`.

### Causa contribuinte
- Havia troca automatica para aba `sistema` em `onSessaoExpirada`, que pode ocultar a area principal e confundir diagnostico.

### Guardrails obrigatorios
1. Nunca remover funcao utilitaria sem verificar referencias reais:
   - Buscar definicao e chamadas antes de salvar.
2. Toda alteracao em `public/agendamentos.html` deve passar por smoke test de UI:
   - Abrir app e confirmar que existe pelo menos 1 card em `#listaExames`.
3. Nao trocar de aba automaticamente em eventos de sessao, exceto se explicitamente aprovado no requisito.

### Checks rapidos (manual/terminal)
```powershell
Select-String -Path public/agendamentos.html -Pattern "function criarBlocoPaciente|criarBlocoPaciente\("
Select-String -Path public/agendamentos.html -Pattern "onSessaoExpirada|ativarAba\('sistema'\)"
```

```powershell
npm start
```

## 2) Incidente: Encoding quebrado (mojibake e simbolos errados)

### Sintoma observado
- Texto com caracteres quebrados (ex: `MÃ¡scara`, `sessÃ£o`).
- Rotulos de botao alterados indevidamente (ex: `? Confirmar Selecionados`).

### Causa raiz
- Edicao/salvamento com encoding inconsistente (UTF-8 vs codepage local).
- Em alguns pontos houve substituicao indevida de caracteres durante edicao.

### Guardrails obrigatorios
1. Padrao unico: salvar arquivos de frontend em UTF-8 consistente.
2. Evitar operacoes de replace em massa sem validar diff por bloco.
3. Nao alterar texto de botao/label sem requisito explicito.
4. Sempre revisar strings visiveis apos qualquer patch em HTML.

### Checks rapidos (manual/terminal)
```powershell
Select-String -Path public/agendamentos.html -Pattern "Ã|�|\? Confirmar|\? Desmarcar"
Select-String -Path public/agendamentos.html -Pattern "Confirmar Selecionados|Desmarcar Todos|mc-btn-rem"
```

## 3) Incidente: Formato de mensagem de envio alterado sem solicitacao

### Sintoma observado
- Mensagem enviada ao fornecedor mudou de formato sem requisito.
- Separadores e bullets ficaram diferentes entre host e cliente.

### Causa raiz
- Alteracao em template de mensagem sem trava de formato.
- Falta de check de regressao em mensagens textuais antes de fechar tarefa.

### Guardrails obrigatorios
1. Nao alterar formato de mensagem de envio (paciente/fornecedor) sem requisito explicito do operador.
2. Manter separadores e bullets padronizados entre fluxo local e fluxo via canal.
3. Ao mexer em envio WhatsApp, validar o texto final real em host e cliente antes de concluir.
4. Em caso de ajuste tecnico, preservar template vigente e mudar apenas o necessario para a correcao.

### Checks rapidos (manual/terminal)
```powershell
Select-String -Path main.cjs -Pattern "montarMensagemClinica|montarMensagemFornecedor|──────────────────|•|—"
Select-String -Path main.cjs -Pattern "Novo agendamento|Paciente:|Exames:|Valor total:|Guia:"
```

## Checklist minimo antes de fechar tarefa

1. `node --check main.cjs` sem erro.
2. `node --check preload.cjs` sem erro.
3. `npm start` abre sem erro JS fatal no renderer.
4. Aba `Exames` visivel e com card funcional.
5. Labels principais sem caracteres quebrados.
6. Mensagem de paciente e fornecedor revisada no formato aprovado (host e cliente/canal).

## Regra de ouro

Qualquer ajuste em `public/agendamentos.html` deve ser seguido de:
- validacao de sintaxe,
- validacao visual basica,
- validacao de texto visivel (sem mojibake),
antes de considerar a mudanca concluida.
