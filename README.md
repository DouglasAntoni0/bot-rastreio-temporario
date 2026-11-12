# Rastreio Rodonaves

Bot Node.js que consulta a Rodonaves a cada cinco minutos e envia avisos ao seu chat privado do Telegram. Funciona em segundo plano no Windows com SQLite e na Discloud com histórico persistente no Upstash Redis Free.

## Instalação local

Use Node.js 24 ou mais recente. O bot usa o SQLite e o cliente HTTP do próprio Node. Execute `npm ci` e `npm test` na raiz do projeto.

1. Copie `.env.example` para `.env` e preencha seus dados do Telegram e da Rodonaves.
2. Abra o bot no Telegram e envie `/start`. Se precisar descobrir o ID privado, execute `npm run chat`. Confira o chat antes de enviar uma mensagem de teste.
3. Execute `npm run config:check` para validar a configuração. A saída mostra o modo de armazenamento, o intervalo e a versão do Node.
4. Execute `npm run telegram:test` para enviar um aviso de teste ao chat configurado. Execute `npm start` para iniciar o monitor.

No Windows, `instalar.bat` verifica o runtime e executa a suíte. Use `iniciar-segundo-plano.bat`, `status.bat` e `parar.bat` para operar a instância local. `ativar-inicio-automatico.bat` e `desativar-inicio-automatico.bat` controlam o início no login.

O `.env` anterior continua aceito. Os aliases `TRACKING_PROTOCOL`, `TRACKING_CTE`, `TRACKING_CNPJ`, `TRACKING_INVOICE` e `POLL_SECONDS` são lidos quando a variável nova correspondente estiver ausente. Preserve os identificadores com a mesma grafia para carregar um histórico existente.

## Variáveis privadas

| Nome | Valor |
|---|---|
| `TELEGRAM_BOT_TOKEN` | Token do bot fornecido pelo BotFather. |
| `TELEGRAM_CHAT_ID` | ID numérico positivo do seu chat privado. |
| `RODONAVES_PROTOCOLO` | Protocolo de rastreamento. |
| `RODONAVES_CTE` | Número do CT-e. |
| `RODONAVES_CNPJ` | CNPJ vinculado, com 14 dígitos. |
| `RODONAVES_NF` | Número da nota fiscal. |
| `CHECK_INTERVAL_MS` | `300000` para consultar a cada cinco minutos. |
| `UPSTASH_REDIS_REST_URL` | Endpoint HTTPS do Redis de produção, usado na nuvem. |
| `UPSTASH_REDIS_REST_TOKEN` | Token Standard do REST API do Upstash, com permissão de gravação. |
| `STATE_NAMESPACE` | Opcional. Use `rodonaves` e mantenha o mesmo valor nas atualizações. |

O `.env` é carregado na execução local. O comando `npm run start:cloud` lê `process.env`. Guarde os valores privados no painel da Discloud ou no `.env` local e use somente os valores fictícios de `.env.example` no Git.

## Como hospedar na Discloud Gold

### 1. Preparar o armazenamento

Crie um Redis **Free** no Upstash Console, vinculado à sua conta, e copie a URL REST e o token **Standard** para o `.env` local. Use um banco dedicado ao bot. O Upstash grava o estado em disco. Bancos Free podem ser arquivados após inatividade prolongada, por isso mantenha uma cópia privada do histórico. [Console Upstash](https://console.upstash.com/redis) · [Persistência](https://upstash.com/docs/redis/features/durability) · [Plano Free](https://upstash.com/pricing/redis)

Antes de migrar uma instalação do Windows, desative o início automático e pare o bot local. Faça a troca quando as credenciais do Upstash estiverem prontas, para evitar dois processos enviando para o mesmo chat. Execute os comandos **na pasta da instalação com o SQLite existente**.

```powershell
npm run state:backup -- backups/rastreio-local.state.json
npm run state:import -- backups/rastreio-local.state.json
node --env-file=.env src/cli.js status --cloud
```

Confira os totais de eventos e notificações. O backup inclui os IDs, o último estado válido, a previsão, as falhas consecutivas e a fila completa de avisos. O importador protege o destino contra sobrescrita e exige a mesma identificação da encomenda.

Se for uma instalação realmente nova, execute `npm run state:init` no lugar do backup e da importação. A primeira consulta válida registra os eventos como referência.

### 2. Conectar e selecionar o repositório

1. Entre na Discloud com a conta GitHub proprietária do repositório. Caso a integração ainda precise de acesso, abra **GitHub Integration → Login/Configure** e selecione apenas o repositório do bot.
2. Abra **Nova aplicação → GitHub**. Selecione a conta, o repositório público e a branch `main`. Atualize a lista se o repositório ou a branch acabou de ser criado.
3. Em **Variáveis de ambiente**, preencha a tabela acima. O painel oferece **Colar .env** para adicionar as variáveis em lote. Use apenas as variáveis necessárias ao bot e confira os nomes antes de continuar.
4. Revise a configuração e conclua o upload manual. O `discloud.config` na raiz aponta para `src/cli.js`, executa o modo de nuvem, usa `TYPE=bot`, `VERSION=latest` (Node LTS) e reserva 128 MB. O projeto requer Node.js 24 ou mais recente.

O Gold permite manter o processo rodando continuamente. O deploy manual mantém o controle de quando atualizar, e `AUTORESTART` foi omitido conforme a disponibilidade do plano. [Integração GitHub](https://docs.discloud.com/en/api-and-integrations/github-integration) · [discloud.config](https://docs.discloud.com/configurations/discloud.config) · [Versões](https://docs.discloud.com/configurations/discloud.config/versions)

### 3. Iniciar e validar

Na lista **Aplicações**, abra o bot. Use **Iniciar** se estiver offline e confira os **Logs**. Procure `config_valid`, `started` e `tracking_ok` ou `baseline_saved`. `config_valid` confirma que o processo recebeu as variáveis obrigatórias e mostra apenas versão do Node, intervalo e backend. Confira uma segunda consulta após cinco minutos e o consumo de RAM no painel.

Para testar o Telegram antes do upload, carregue os mesmos valores no `.env` local e rode `npm run telegram:test`. O comando valida o tipo privado do chat antes de enviar uma mensagem identificada como teste.

### 4. Atualizar, fazer backup e restaurar

1. Exporte uma cópia privada do histórico antes de atualizar. Confira se o `.env` local usa o mesmo endpoint e `STATE_NAMESPACE` da nuvem.

   ```powershell
   node --env-file=.env src/cli.js backup-state backups/rastreio-nuvem.state.json --cloud
   ```

2. Envie a nova versão do código para o GitHub. Gere o ZIP a partir do commit publicado e selecione-o em **Aplicação → Commit → Novo commit**. Mantenha as variáveis e o banco. Se o processo estiver offline, inicie-o pelo painel.

   ```sh
   git archive --format=zip -o rastreio-deploy.zip HEAD discloud.config package.json package-lock.json src
   ```

3. Confira os logs e rode `node --env-file=.env src/cli.js status --cloud`. Uma atualização ou reinício lê o mesmo histórico externo. O ZIP de código da Discloud e o repositório público ficam separados dos backups.

Para restaurar um backup, pare a aplicação, escolha um `STATE_NAMESPACE` ainda vazio, configure-o no `.env` e execute `npm run state:import -- backups/arquivo.state.json`. Use o mesmo namespace na Discloud antes de reiniciar. Prefira o backup mais recente para preservar os registros dos avisos já enviados.

### Erros comuns

| Código ou log | Ação |
|---|---|
| `CONFIG_TOKEN_INVALID` ou `TELEGRAM_API_ERROR` | Confira o token do BotFather, o chat privado e o `/start`. Valide com `npm run telegram:test`. |
| `CONFIG_SHIPMENT_INVALID` | Confira protocolo, CT-e, CNPJ e NF. Preserve zeros à esquerda já usados no histórico. |
| `CONFIG_STATE_INVALID` ou `STATE_AUTH_FAILED` | Use a URL REST HTTPS e o token Standard do Upstash. Confira os valores no painel. |
| `STATE_MISSING` | Confira endpoint, namespace e dados do rastreio. Importe o backup existente. Use `state:init` apenas para um rastreio novo. |
| `state_busy` | Uma rodada já tem acesso ao histórico. Se uma instância caiu, o bloqueio expira em até cinco minutos após a última renovação. |
| `state_retry` | O Redis ficou temporariamente indisponível. O bot espera o próximo ciclo antes de consultar ou enviar novamente. |
| `STATE_TOO_LARGE` | O estado ultrapassou o limite de 512 KiB por rastreio. Guarde um backup e ajuste o armazenamento antes de retomar. |
| `tracking_failed` | Confira a rede e a Rodonaves. O alerta é emitido na terceira falha consecutiva da transportadora. |

Se o Telegram confirmar uma rejeição temporária, a notificação fica pendente para nova tentativa. Se a conexão cair depois de um possível envio, o estado fica `uncertain`. Consulte o chat e o `status --cloud` antes de resolver, pois um reenvio automático nesse caso pode duplicar a mensagem.

```powershell
node --env-file=.env src/cli.js status --cloud
node --env-file=.env src/cli.js resolve ID_DA_NOTIFICACAO sent --cloud
# Use retry no lugar de sent somente se o aviso não chegou ao chat.
```

## Como o monitor funciona

- A consulta usa a API que o portal Rodonaves utiliza, com o transporte JWE exigido pelo serviço. O protocolo é a primeira opção e CT-e/CNPJ é o caminho alternativo.
- Movimentações têm identificadores derivados de horário e descrição normalizados. O monitor ignora reordenação, preserva o histórico conhecido e identifica mudanças de status ou previsão.
- Falhas 1 e 2 ficam nos logs. A falha 3 enfileira um alerta. As seguintes preservam o mesmo alerta. A próxima consulta válida zera o contador.
- No Windows, o SQLite guarda as transações. Na nuvem, o SQLite em memória usa o mesmo código e carrega o estado do Redis por rodada. Um bloqueio remoto evita consultas concorrentes entre instâncias da nuvem. A fila é salva antes de enviar e o recibo é salvo após a resposta do Telegram.
- A chave do estado no Redis não expira. O bloqueio tem prazo para liberar uma instância que caiu. Se o Redis ficar indisponível, o bot adia a rodada para preservar o estado válido. Erros críticos saem com código de erro nos logs.

## Publicação e testes

Para publicar em um repositório novo, confira os arquivos de `git ls-files` e o histórico de todas as referências antes do push. Envie apenas código, exemplos fictícios, testes e documentação. A integração GitHub recebe o código versionado e os segredos são configurados no painel. O `.discloudignore` usa nomes exatos, conforme a documentação. [Referência do .discloudignore](https://docs.discloud.com/configurations/.discloudignore)

```sh
npm ci
npm test
git status --short
git ls-files
git push -u origin main
```

Os testes usam dados fictícios e cobrem deduplicação, alertas, retomada do histórico, bloqueios, fila de notificações e validação de configuração. O código de produção usa apenas módulos do Node.js.
