# 🔑 DELTA KEY MASTER - Gerenciador e Monitor de Chaves Personalizadas

Sistema web completo em **Node.js (Express)** para criação e monitoramento de chaves com durações totalmente personalizadas (horas ou dias até 30 dias) utilizando a API oficial da **Delta Proxy** (`geradorproxy.online`).

---

## ⚡ Como Funciona a Lógica

1. **Seleção Flexível de Tempo**:
   - **Horas (ex: 2h, 4h, 12h)**: Gera automaticamente **1 Dia** na API oficial da Delta (menor custo).
   - **Dias (ex: 2 a 6 dias)**: Gera automaticamente **7 Dias** na API oficial (ou 1 dia se for 1d exato).
   - **Dias (ex: 8 a 30 dias)**: Gera automaticamente **30 Dias** na API oficial.
   - **Limite Máximo**: Bloqueio de durações superiores a 30 dias.
2. **Detecção do 1º Login**: O monitor em segundo plano detecta o momento exato em que o cliente abre o app e conecta com a chave (capturando UID e IP).
3. **Cronômetro & Auto-Reset**: O tempo personalizado começa a contar a partir do 1º login. Ao esgotar o prazo estipulado, o sistema executa o reset de Hardware ID (`ResetKeyAPI.php`), encerra a chave e notifica você em tempo real.

---

## 🚀 Como Subir para o GitHub e Rodar no Railway

### Passo 1: Inicializar o Repositório Git Local

Abra o terminal na pasta do projeto e execute:

```bash
git init
git add .
git commit -m "Initial commit - Delta Key Master"
```

### Passo 2: Criar o Repositório no GitHub e Enviar

1. Acesse [github.com/new](https://github.com/new) e crie um novo repositório (pode ser **Público** ou **Privado**).
2. Conecte o repositório local e envie os arquivos:

```bash
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/SEU_REPOSITORIO.git
git push -u origin main
```

---

### Passo 3: Fazer Deploy no Railway

1. Acesse **[railway.com](https://railway.com/)** e faça login com sua conta do GitHub.
2. Clique em **+ New Project** -> **Deploy from GitHub repo**.
3. Selecione o repositório que você acabou de criar.
4. O Railway detectará o Node.js automaticamente e iniciará o build com `npm start`.

#### Configurar Variáveis de Ambiente no Railway (Opcional):
No painel do seu serviço no Railway, vá na aba **Variables** e adicione (se desejar alterar o padrão):
- `DELTA_API_TOKEN`: `DELTA-a480f9e6b7ace86ab59c5507b9e4cc3f`
- `POLLING_INTERVAL_SEC`: `5` (intervalo de checagem em segundos)

#### Gerar Domínio Público no Railway:
1. No seu serviço no Railway, vá na aba **Settings**.
2. Na seção **Networking**, clique em **Generate Domain**.
3. Pronto! O Railway criará uma URL pública HTTPS (ex: `https://delta-key-master-production.up.railway.app`) para você acessar de qualquer lugar (PC, Celular, etc.).

---

## 💻 Rodar Localmente

```bash
# Instalar dependências
npm install

# Iniciar servidor
npm start
```

Acesse: `http://localhost:3000`
