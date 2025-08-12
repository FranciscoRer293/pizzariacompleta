const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const moment = require('moment-timezone');
const fs = require('fs');
const path = require('path');
const readline = require('readline'); 
const OpenAI = require('openai'); // ADICIONADO: Importa a biblioteca do OpenAI

// === CONFIGURAÇÕES ===
// Coloque aqui o ID do grupo (ex: '120363025863838383@g.us')
const GRUPO_PEDIDOS = '120363420214800456@g.us'; 

const TAXAS_POR_BAIRRO = {
    "centro": 5,
    "conjunto joão paulo ii": 2,
    "conjunto vale do pindaré": 2,
    "conjunto vale do rio doce": 2,
    "entroncamento": 2
};
const TAXA_PADRAO = 5;

const PIX_INFO = {
    chave: '99991056556',
    nome: 'FRANCISCO ARAUJO MESQUITA',
    banco: 'MERCADO PAGO'
};

const DIR_COMPROVANTES = path.resolve(__dirname, 'comprovantes');
if (!fs.existsSync(DIR_COMPROVANTES)) fs.mkdirSync(DIR_COMPROVANTES);

const CARDAPIO_IMG_PATH = path.resolve(__dirname, 'cardapio.jpg');
let menuImg = null;

const CARDAPIO = {
    P: 24.99,
    G: 44.99,
    F: 54.99,
    Borda: 5,
    Sabores: ['Calabresa', 'Frango com Catupiry', 'Portuguesa', 'Quatro Queijos', 'Margarita', 'Napolitana', 'Bacon', 'Chocolate']
};

const pedidosEmAndamento = new Map();
const etapas = ['nome', 'endereco', 'pagamento'];
const exemplosEtapas = {
    nome: "📌 Exemplo: João da Silva",
    endereco: "📌 Exemplo: Rua das Flores, nº 123",
    bairro: "📌 Exemplo: Centro",
    pagamento: "📌 Exemplo: PIX ou Dinheiro"
};

// === NOVAS CONFIGURAÇÕES PARA PROMOÇÕES ===
const ARQUIVO_CONTATOS = path.resolve(__dirname, 'contatos.txt');
const HORARIO_PROMO_HORA = 15;
const HORARIO_PROMO_MINUTO = 50;
const MENSAGEM_PROMOCAO = '🔥 PROMOÇÃO DO DIA! 🔥\nNa compra de 2 pizzas grandes, ganhe 1 refrigerante de 2L!\n\n*(Para não receber mais promoções, digite "promocao off")*';

let contatosPromocao = new Set();
let promocaoEnviadaHoje = false;

// === NOVO CÓDIGO: INICIALIZA O CLIENTE DA OPENAI ===
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// === Funções Utilitárias ===
const esperar = ms => new Promise(res => setTimeout(res, ms));

const enviar = async (destino, texto, media = null) => {
    const rodape = "\n\nℹ️ Digite 0 para voltar ao menu inicial ou 99 para voltar à pergunta anterior.";
    if (!texto.includes('ℹ️ Digite 0')) texto += rodape;
    const chat = await client.getChatById(destino);
    await chat.sendStateTyping();
    await esperar(Math.min(200 + texto.length * 3, 1000)); 

    if (media) {
        await client.sendMessage(destino, media, { caption: texto });
    } else {
        await client.sendMessage(destino, texto);
    }
};

// === NOVA FUNÇÃO: Gerenciar contatos para promoções ===
function carregarContatos() {
    if (fs.existsSync(ARQUIVO_CONTATOS)) {
        const data = fs.readFileSync(ARQUIVO_CONTATOS, 'utf-8');
        contatosPromocao = new Set(data.split('\n').filter(Boolean));
        console.log(`✅ ${contatosPromocao.size} contatos carregados.`);
    }
}

function salvarContato(numero) {
    if (!contatosPromocao.has(numero)) {
        fs.appendFileSync(ARQUIVO_CONTATOS, `${numero}\n`);
        contatosPromocao.add(numero);
        console.log(`📝 Novo contato salvo: ${numero}`);
    }
}

function removerContato(numero) {
    if (contatosPromocao.has(numero)) {
        contatosPromocao.delete(numero);
        fs.writeFileSync(ARQUIVO_CONTATOS, [...contatosPromocao].join('\n'));
        console.log(`🗑️ Contato removido: ${numero}`);
    }
}

// === NOVA FUNÇÃO: Enviar promoção em massa ===
async function enviarPromocaoEmMassa() {
    console.log('📢 Iniciando envio de promoção...');
    if (contatosPromocao.size === 0) {
        console.log('⚠️ Não há contatos salvos para enviar a promoção.');
        return;
    }
    for (const contato of contatosPromocao) {
        try {
            await client.sendMessage(contato, MENSAGEM_PROMOCAO);
            await esperar(3000); // Pausa para não sobrecarregar
        } catch (error) {
            console.error(`❌ Falha ao enviar para ${contato}:`, error);
        }
    }
    console.log('✅ Envio de promoção concluído.');
}

// === Lógica de Parsing ===
function normalizarTexto(txt) {
    const mapaNumeros = { 'um':'1','uma':'1','dois':'2','duas':'2','três':'3','tres':'3','quatro':'4','cinco':'5','seis':'6','sete':'7','oito':'8','nove':'9' };
    let texto = txt.toLowerCase();

    // Remove acentos e caracteres especiais para melhor comparação
    texto = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, "");
    texto = texto.replace('ç', 'c');
    
    for (const [key, value] of Object.entries(mapaNumeros)) {
        texto = texto.replace(new RegExp(`\\b${key}\\b`, 'gi'), value);
    }
    return texto.trim();
}

// === NOVO CÓDIGO: FUNÇÃO QUE USA A IA PARA PARSEAR O PEDIDO ===
async function getPedidoFromIA(texto) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-4", // Use "gpt-3.5-turbo" se quiser economizar
            messages: [
                {
                    "role": "system",
                    "content": `Você é um assistente de chatbot de uma pizzaria. Sua principal função é extrair detalhes de pedidos de pizza do cliente a partir da conversa em português. 
                    Se o pedido for sobre pizzas do cardápio, extraia as informações no formato JSON. Se não for um pedido de pizza (ex: saudações, outras perguntas), retorne um JSON com o campo "erro".
                    
                    As pizzas disponíveis são nos tamanhos P, G, F e os sabores são ${CARDAPIO.Sabores.join(', ')}. O cliente também pode pedir "com borda". Se o tamanho não for especificado, considere G. Se o sabor não for especificado, considere "Mussarela".
                    
                    Formato de saída JSON:
                    {
                      "pedido": [
                        {
                          "qtd": (número),
                          "tamanho": "(P, G, F)",
                          "sabores": ["sabor1", "sabor2"],
                          "borda": (true/false)
                        },
                        ...
                      ],
                      "erro": (string com a mensagem de erro, se houver)
                    }
                    
                    Exemplos de interação:
                    Cliente: "Queria uma pizza grande de calabresa com borda e 1 pequena de frango com catupiry."
                    Resposta:
                    {
                      "pedido": [
                        { "qtd": 1, "tamanho": "G", "sabores": ["Calabresa"], "borda": true },
                        { "qtd": 1, "tamanho": "P", "sabores": ["Frango com Catupiry"], "borda": false }
                      ]
                    }
                    
                    Cliente: "Me vê duas pizzas grandes, uma de calabresa e outra metade portuguesa metade quatro queijos"
                    Resposta:
                    {
                      "pedido": [
                        { "qtd": 1, "tamanho": "G", "sabores": ["Calabresa"], "borda": false },
                        { "qtd": 1, "tamanho": "G", "sabores": ["Portuguesa", "Quatro Queijos"], "borda": false }
                      ]
                    }
                    
                    Cliente: "Olá, bom dia!"
                    Resposta:
                    {
                      "erro": "Olá! Seja bem-vindo à Pizzaria Di Casa!"
                    }
                    
                    Cliente: "Qual o telefone de vocês?"
                    Resposta:
                    {
                      "erro": "O nosso telefone é (99) 98278-6800."
                    }
                    
                    Se o cliente pedir um sabor que não existe no cardápio, retorne um erro informando.
                    `
                },
                {
                    "role": "user",
                    "content": texto
                }
            ],
            temperature: 0.1,
            max_tokens: 500,
        });

        const respostaIA = response.choices[0].message.content;
        return JSON.parse(respostaIA);

    } catch (error) {
        console.error('❌ Erro ao comunicar com a OpenAI:', error);
        return { erro: "Desculpe, tive um problema para processar seu pedido. Poderia repetir?" };
    }
}


// === NOVA FUNÇÃO: Calcular o total do pedido ===
function calcularTotal(pedidos, taxaEntrega) {
    let total = 0;
    let resumo = '';
    const precos = { 'P': CARDAPIO.P, 'G': CARDAPIO.G, 'F': CARDAPIO.F };

    pedidos.forEach(pedido => {
        const precoPizza = precos[pedido.tamanho];
        let precoItem = precoPizza;
        if (pedido.borda) {
            precoItem += CARDAPIO.Borda;
        }
        
        total += pedido.qtd * precoItem;
        
        let saboresTexto = pedido.sabores.map(s => s.replace(/\b\w/g, c => c.toUpperCase())).join(' e ');
        let bordaTexto = pedido.borda ? ' com borda' : '';
        
        resumo += `\n🍕 ${pedido.qtd}x Pizza ${pedido.tamanho} (${saboresTexto})${bordaTexto} - R$ ${(pedido.qtd * precoItem).toFixed(2)}`;
    });
    
    total += taxaEntrega;
    
    return { resumo: resumo, total: total };
}

function menuInicial(nomeCliente = 'Cliente') {
    return `🍕 Olá, ${nomeCliente}! Seja bem-vindo à Pizzaria Di Casa! 😄

📲 Peça rápido pelo Cardápio Digital:
👉 https://instadelivery.com.br/pizzariadicasa1

1 - Fazer Pedido
2 - Ver Cardápio por WhatsApp
3 - Falar com Atendente
4 - Ver Promoções
5 - Ver Cardápio Digital`;
}

// === Funções para o fluxo do bot ===
async function tratarMenu(from, text, pushname) {
    const menuTxt = `📜 *NOSSO CARDÁPIO* 🍕
━━━━━━━━━━━━━━
🍕 *Pizzas*
• F (Família – 12 fatias) ........ R$ ${CARDAPIO.F.toFixed(2)}
• G (Grande – 8 fatias) .......... R$ ${CARDAPIO.G.toFixed(2)}
• P (Pequena – 4 fatias) ......... R$ ${CARDAPIO.P.toFixed(2)}

➕ *Adicionais*
• Borda Recheada ................ R$ ${CARDAPIO.Borda.toFixed(2)}

🥗 *Sabores Disponíveis*
• ${CARDAPIO.Sabores.join('\n• ')}

📌 *Para fazer o pedido, digite no formato abaixo*:
Exemplo: 1 G Calabresa com borda e 1 F metade Frango/Catupiry, metade Portuguesa`;
    
    if (text === '1') {
        return enviar(from, menuTxt, menuImg);
    }
    if (text === '2' || text === '5') return enviar(from, `Cardápio digital: https://instadelivery.com.br/pizzariadicasa1`);
    if (text === '3') return enviar(from, '👨‍🍳 Um atendente irá lhe atender em instantes.');
    if (text === '4') return enviar(from, '🔥 Promoção: Na compra de 2 G, ganhe 1 refrigerante 1L!');
    
    // === CÓDIGO ANTIGO: parsear pedido manualmente ===
    // const pedidos = parsePedido(text);
    
    // === NOVO CÓDIGO: usa a IA para parsear o pedido ===
    const respostaIA = await getPedidoFromIA(text);
    const pedidos = respostaIA.pedido;

    if (respostaIA.erro) {
        return enviar(from, respostaIA.erro);
    }
    
    if (pedidos && pedidos.length > 0) {
        const { resumo, total } = calcularTotal(pedidos, 0);
        pedidosEmAndamento.set(from, { resumo, total, pedidos, etapa: 'bairro', taxaEntrega: 0, pushname: pushname });
        return enviar(from, `🧾 *RESUMO DO PEDIDO*:
${resumo}

💵 *Total (sem entrega):* R$ ${total.toFixed(2)}
🚚 *A taxa de entrega será calculada de acordo com o bairro informado.*
━━━━━━━━━━━━━━
✍️ *Digite seu bairro para calcular a taxa de entrega:*`);
    }

    return enviar(from, `❌ Não entendi a sua solicitação. Por favor, escolha uma opção do menu (1 a 5) ou digite seu pedido.`);
}

async function tratarPedido(from, text, estado) {
  const idx = etapas.indexOf(estado.etapa);
  
  if (estado.etapa === 'bairro') {
    const bairroLower = text.toLowerCase().trim();
    const taxaEntrega = TAXAS_POR_BAIRRO[bairroLower] || TAXA_PADRAO;
    const { resumo, total } = calcularTotal(estado.pedidos, taxaEntrega);
    
    estado.nome = estado.pushname || 'Cliente';
    estado.bairro = text;
    estado.taxaEntrega = taxaEntrega;
    estado.resumo = resumo;
    estado.total = total;
    estado.etapa = 'confirmacao';

    let mensagemTaxa = `🚚 *Taxa de entrega para ${text}:* R$ ${taxaEntrega.toFixed(2)}\n`;
    if (!TAXAS_POR_BAIRRO[bairroLower]) {
        mensagemTaxa = `⚠️ O bairro "${text}" não está na nossa lista. Será aplicada a taxa padrão de R$ ${TAXA_PADRAO.toFixed(2)}.\n`;
    }

    return enviar(from, `${mensagemTaxa}💵 *Total atualizado:* R$ ${total.toFixed(2)}
\n*Confirma o pedido?* (Sim/Não)`);
  }

  if (estado.etapa === 'confirmacao') {
    const resposta = text.toLowerCase();
    if (resposta === 'sim' || resposta === 's') {
      estado.etapa = 'nome';
      return enviar(from, `Ótimo! Agora vamos para seus dados.\nDigite seu ${estado.etapa}:\n${exemplosEtapas[estado.etapa]}`);
    } else if (resposta === 'nao' || resposta === 'n') {
      pedidosEmAndamento.delete(from);
      return enviar(from, 'Tudo bem! O pedido foi cancelado. Digite "0" para voltar ao menu inicial.');
    } else {
      return enviar(from, '❌ Por favor, responda com "Sim" ou "Não" para confirmar o pedido.');
    }
  }

  if (idx > -1) {
    estado[estado.etapa] = text;
    if (idx < etapas.length - 1) {
      estado.etapa = etapas[idx + 1];
      return enviar(from, `Digite seu ${estado.etapa}:\n${exemplosEtapas[estado.etapa]}`);
    } else {
      estado.pagamento = text;
      estado.status = text.toLowerCase().includes('pix') ? 'Pendente' : 'Pago';

      if (estado.status === 'Pendente') {
        estado.aguardandoComprovante = true;
        return enviar(from, `💳 PIX — envie o comprovante (JPG, PNG ou PDF).\nChave: ${PIX_INFO.chave}\nNome: ${PIX_INFO.nome}\nBanco: ${PIX_INFO.banco}\nValor: R$${estado.total.toFixed(2)}`);
      } else {
        if (GRUPO_PEDIDOS) {
          await client.sendMessage(GRUPO_PEDIDOS,
            `📦 *NOVO PEDIDO CONFIRMADO* 📦
👤 Cliente: ${estado.nome}
🏠 Endereço: ${estado.endereco}, ${estado.bairro}
🛒 Pedido: ${estado.resumo}
💵 Total: R$ ${estado.total.toFixed(2)}
💳 Pagamento: ${estado.pagamento}
⏰ Horário: ${moment().format('DD/MM/YYYY HH:mm')}`
          );
        }
        pedidosEmAndamento.delete(from);
        return enviar(from, `✅ Pedido confirmado! Previsão: 40 minutos.`);
      }
    }
  }
  return enviar(from, `❌ Não entendi. Por favor, digite seu ${estado.etapa}:\n${exemplosEtapas[estado.etapa]}`);
}

// === Handler Principal ===
async function processarMensagem(from, raw, pushname) {
    const text = raw.trim();
    const estado = pedidosEmAndamento.get(from);
    const textoNormalizado = normalizarTexto(text);
    const saudacoes = ['oi', 'ola', 'olá', 'bom dia', 'boa tarde', 'boa noite', 'e ai', 'eae'];

    console.log(`➡️ Mensagem recebida de ${pushname} (${from}): "${text}"`);
    console.log(`Estado do pedido para ${pushname}:`, estado);

    // Salva o contato para promoções (se não for de grupo)
    if (!from.endsWith('@g.us')) {
        salvarContato(from);
    }
    
    // Prioriza comandos especiais que não dependem do estado do pedido
    if (textoNormalizado === 'promocao off') {
        console.log('Comando "promocao off" recebido.');
        removerContato(from);
        pedidosEmAndamento.delete(from);
        return enviar(from, '✅ Você não receberá mais nossas promoções. Para reativar, basta interagir com o bot novamente.');
    }
    
    if (textoNormalizado === 'promocao agora') {
        console.log('Comando "promocao agora" recebido.');
        if (contatosPromocao.size === 0) {
            await enviar(from, '⚠️ Não há contatos salvos para enviar a promoção.');
        } else {
            await enviar(from, `📢 Enviando promoção para ${contatosPromocao.size} contatos.`);
            enviarPromocaoEmMassa();
        }
        return; 
    }

    if (saudacoes.includes(textoNormalizado) || textoNormalizado === '0') {
        console.log('Saudação ou comando "0" recebido. Enviando menu inicial.');
        pedidosEmAndamento.delete(from);
        return enviar(from, menuInicial(pushname));
    }
    
    // Responde se o comando de promoção foi digitado incorretamente
    if (textoNormalizado.includes('promocao') && textoNormalizado !== 'promocao agora' && textoNormalizado !== 'promocao off') {
        console.log('Comando de promoção digitado incorretamente.');
        return enviar(from, '❌ Ops! Para enviar promoções, o comando é `promocao agora`. Para não receber mais, use `promocao off`.');
    }

    // A partir daqui, o bot só processará mensagens de pedido ou menu
    if (estado) {
        // Se há um pedido em andamento, processa a resposta da etapa atual
        console.log(`Cliente com pedido em andamento na etapa: "${estado.etapa}". Tratando como resposta ao pedido.`);
        if (textoNormalizado === '99') {
            console.log('Comando "99" recebido. Voltando para a etapa anterior.');
            if (estado.etapa === 'confirmacao' || estado.etapa === 'bairro') {
                pedidosEmAndamento.delete(from);
                return enviar(from, 'Voltando ao início. Digite 1 para fazer um novo pedido.');
            }
            const idx = etapas.indexOf(estado.etapa);
            if (idx > 0) estado.etapa = etapas[idx - 1];
            return enviar(from, `Voltando para a pergunta anterior.\nDigite seu ${estado.etapa}:\n${exemplosEtapas[estado.etapa]}`);
        }
        return tratarPedido(from, text, estado);
    } else {
        // Se não há pedido em andamento, trata como uma opção do menu
        console.log('Cliente sem pedido em andamento. Tratando como comando do menu.');
        return tratarMenu(from, text, pushname);
    }
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] }
});

client.on('qr', qr => console.log(qr));

client.on('ready', async () => {
    console.log('✅ WhatsApp pronto!');
    if (fs.existsSync(CARDAPIO_IMG_PATH)) {
        menuImg = MessageMedia.fromFilePath(CARDAPIO_IMG_PATH);
        console.log('🖼️ Imagem do cardápio carregada.');
    } else {
        console.warn('⚠️ Arquivo cardapio.jpg não encontrado. O bot funcionará, mas sem a imagem.');
    }

    carregarContatos();
    
    setInterval(() => {
        const agora = moment();
        
        if (promocaoEnviadaHoje && agora.hours() === 0 && agora.minutes() === 0) {
            promocaoEnviadaHoje = false;
            console.log('📅 Flag de promoção resetado para um novo dia.');
        }

        if (agora.hours() === HORARIO_PROMO_HORA && agora.minutes() === HORARIO_PROMO_MINUTO && !promocaoEnviadaHoje) {
            enviarPromocaoEmMassa();
            promocaoEnviadaHoje = true;
        }

    }, 60000); // Verifica a cada minuto

    // === NOVO CÓDIGO: LER O TERMINAL ===
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: '' // Remove o prompt padrão para não poluir o terminal
    });

    rl.on('line', (input) => {
        const comando = input.trim().toLowerCase();
        if (comando === 'sendpromo') {
            console.log('\nComando "sendpromo" recebido do terminal.');
            enviarPromocaoEmMassa();
        } else {
            // Isso previne que o bot reaja a qualquer outra coisa digitada no terminal
            console.log(`\n❌ Comando desconhecido no terminal: ${comando}`);
        }
    });

    console.log('\nPara enviar a promoção manualmente, digite "sendpromo" aqui no terminal e pressione Enter.');
});

client.on('message', async msg => {
    const from = msg.from;
    const pushname = msg._data.notifyName || msg._data.pushname || 'Cliente';
    const estado = pedidosEmAndamento.get(from);

    if (estado && estado.aguardandoComprovante && msg.hasMedia) {
        const media = await msg.downloadMedia();
        const ext = media.mimetype.split('/')[1];
        if (!['jpeg', 'jpg', 'png', 'pdf'].includes(ext.toLowerCase())) {
            return enviar(from, '❌ Formato inválido. Envie JPG, PNG ou PDF.');
        }
        const nomeArquivo = `comprovante_${from.replace(/[^0-9]/g, '')}_${moment().format('YYYY-MM-DD_HH-mm')}.${ext}`;
        fs.writeFileSync(path.join(DIR_COMPROVANTES, nomeArquivo), Buffer.from(media.data, 'base64'));
        
        estado.status = 'Pago';
        estado.aguardandoComprovante = false;

        if (GRUPO_PEDIDOS) {
            await client.sendMessage(GRUPO_PEDIDOS,
                `📦 *NOVO PEDIDO CONFIRMADO* 📦
👤 Cliente: ${estado.nome}
🏠 Endereço: ${estado.endereco}, ${estado.bairro}
🛒 Pedido: ${estado.resumo}
💵 Total: R$ ${estado.total.toFixed(2)}
💳 Pagamento: ${estado.pagamento}
⏰ Horário: ${moment().format('DD/MM/YYYY HH:mm')}`
            );
        }

        pedidosEmAndamento.delete(from);
        return enviar(from, `✅ Comprovante recebido! Pedido confirmado.\nPrevisão de entrega: 40 minutos.`);
    }

    await processarMensagem(from, msg.body, pushname);
});

client.initialize();
