# 🏛️ Monitor Proposições CMC-MT — Câmara Municipal de Cuiabá

Monitora automaticamente o portal da Câmara Municipal de Cuiabá-MT e envia email quando há proposições novas nos tipos selecionados. Roda **4x por dia** via GitHub Actions (8h, 12h, 17h e 21h, horário de Brasília).

> **Atenção:** este monitor roda em **self-hosted runner** (VPS própria), não nos servidores do GitHub. O portal da CMC-MT usa o sistema Agape, que bloqueia IPs de datacenter como os da AWS/GitHub.

---

## Tipos monitorados

- Projeto de Lei
- Projeto de Lei Complementar
- Projeto de Lei Substitutivo
- Projeto de Lei Complementar Substitutivo
- Projeto de Decreto Legislativo
- Projeto de Decreto de Legislativo Substitutivo
- Projeto de Resolução
- Proposta de Emenda à Lei Orgânica
- Veto
- Indicação
- Requerimento de Informações
- Requerimento de Audiência Pública
- Requerimento de Instauração de Comissão Parlamentar de Inquérito

Todos os outros tipos (Moções, Requerimentos de Sessão, Urgência, etc.) são ignorados — não geram email, mas são marcados como vistos para não reaparecer em runs futuros.

---

## Como funciona

1. GitHub Actions dispara o job nos horários configurados, usando o runner instalado na VPS
2. O script acessa `legislativo.camaracuiaba.mt.gov.br/spl/consulta-producao.aspx`
3. Navega pelas páginas via postback ASP.NET UpdatePanel (sistema Agape — mesmo da ALES-ES e CMV-ES)
4. Filtra pelos tipos monitorados e compara com os IDs já registrados em `estado.json`
5. Se há proposições novas → envia email organizado por tipo
6. Salva o estado atualizado no repositório

---

## Estrutura do repositório

```
monitor-proposicoes-cmc-mt/
├── monitor.js                      # Script principal
├── package.json                    # Dependências (nodemailer)
├── estado.json                     # Estado salvo automaticamente
├── README.md
└── .github/
    └── workflows/
        └── monitor.yml
```

---

## Setup

### PARTE 1 — Gmail (App Password)

> Se já tem App Password configurado para outros monitores, pode reutilizar a mesma senha.

1. Acesse [myaccount.google.com/security](https://myaccount.google.com/security)
2. Ative **Verificação em duas etapas** se ainda não estiver ativa
3. Busque **"Senhas de app"** → Criar → nome: `monitor-cmc-mt`
4. Copie a senha de **16 letras** (aparece só uma vez)

---

### PARTE 2 — Criar repositório no GitHub

1. [github.com](https://github.com) → **+ → New repository**
2. Nome: `monitor-proposicoes-cmc-mt` | Visibilidade: **Private**
3. Clique em **Create repository**

---

### PARTE 3 — Upload dos arquivos

1. Na página do repositório: **"uploading an existing file"**
2. Faça upload de: `monitor.js`, `package.json`, `README.md`
3. Commit changes

4. Para o workflow: **Add file → Create new file**
5. Nome: `.github/workflows/monitor.yml`
6. Cole o conteúdo do `monitor.yml` e commit

---

### PARTE 4 — Secrets

**Settings → Secrets and variables → Actions → New repository secret**

| Name | Valor |
|------|-------|
| `EMAIL_REMETENTE` | flavia@monitorlegislativo.com.br |
| `EMAIL_SENHA` | App Password de 16 letras (sem espaços) |
| `EMAIL_DESTINO` | tramitacao@monitorlegislativo.com.br |

---

### PARTE 5 — Registrar o self-hosted runner

> Se já existe um runner registrado na VPS para outro monitor (ALES-ES ou CMV-ES), **não instale um novo runner**. Basta registrar este repositório em uma nova pasta com `config.sh`.

1. No repositório: **Settings → Actions → Runners → New self-hosted runner**
2. Selecione: **Linux → x64**
3. Execute os comandos na VPS:

```bash
# Criar pasta separada para este runner
mkdir actions-runner-cmc-mt && cd actions-runner-cmc-mt

# Baixar e extrair o runner (use o comando exato gerado pelo GitHub)
curl -o actions-runner-linux-x64-X.X.X.tar.gz -L https://github.com/actions/runner/releases/...
tar xzf ./actions-runner-linux-x64-X.X.X.tar.gz

# Configurar com o token gerado pelo GitHub
./config.sh --url https://github.com/SEU_USUARIO/monitor-proposicoes-cmc-mt --token TOKEN_GERADO

# Instalar como serviço
sudo ./svc.sh install
sudo ./svc.sh start
```

4. O runner deve aparecer com status **Idle** (verde) no GitHub

---

### PARTE 6 — Testar

1. **Actions → Monitor Proposições CMC-MT → Run workflow → Run workflow**
2. Aguarde ~30-60 segundos
3. Verde = funcionou

**Primeiro run:** envia email com as proposições mais recentes dos tipos monitorados (até 500) e salva o estado.
**Runs seguintes:** só notifica se houver novidades.

---

## Resetar o estado

Para forçar reenvio de todas as proposições:

1. No repositório, clique em `estado.json` → ícone de edição (lápis)
2. Substitua todo o conteúdo por:
```json
{"proposicoes_vistas":[],"ultima_execucao":""}
```
3. Commit → rode manualmente

---

## Problemas comuns

**Runner aparece como Offline no GitHub**
→ O serviço na VPS parou. Conecte na VPS e execute:
```bash
cd actions-runner-cmc-mt
sudo ./svc.sh status
sudo ./svc.sh start
```

**`fetch failed` ou erro de conexão**
→ Teste na própria VPS:
```bash
curl -I https://legislativo.camaracuiaba.mt.gov.br/spl/consulta-producao.aspx
```
Se retornar 200, o problema é outro. Se recusar conexão, o IP da VPS foi bloqueado.

**`0 proposições novas` mas deveria ter**
→ Verifique se o tipo aparece exatamente como listado no array `TIPOS_MONITORADOS` dentro do `monitor.js`. Se necessário, adicione a variação e faça commit.

**Erro de autenticação Gmail**
→ Verifique se `EMAIL_SENHA` foi colado sem espaços e se a verificação em duas etapas ainda está ativa na conta.
