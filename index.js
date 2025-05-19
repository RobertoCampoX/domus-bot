const {
    makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    jidNormalizedUser,
} = require('@whiskeysockets/baileys');

const P = require('pino');
const fs = require('fs');
const moment = require('moment');
const xlsx = require('xlsx');
const path = require('path');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');

moment.locale('pt-br');

const GASTOS_FILE = './gastos.json';

function loadGastos() {
    if (!fs.existsSync(GASTOS_FILE)) return {};
    return JSON.parse(fs.readFileSync(GASTOS_FILE));
}

function saveGastos(data) {
    fs.writeFileSync(GASTOS_FILE, JSON.stringify(data, null, 2));
}

function parseGasto(text) {
    if (!text) return null;
    const match = text.match(/(.+?)\s+(\d+[\.,]?\d*)\s*(reais?|R\$)?(\s+(\d{4}-\d{2}-\d{2}))?/i);
    if (!match) return null;

    return {
        descricao: match[1].trim(),
        valor: parseFloat(match[2].replace(',', '.')),
        data: match[5] || moment().format('YYYY-MM-DD'),
    };
}

function getCategoria(text) {
    const categorias = ['alimentação', 'transporte', 'saúde', 'lazer', 'moradia', 'outros'];
    const match = categorias.find(c => text.toLowerCase().includes(c));
    return match || 'outros';
}

function formatarValor(valor) {
    return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function gerarExcel(userId, mes, gastosMes) {
    const data = gastosMes.map(g => ({
        Descrição: g.descricao,
        Valor: g.valor,
        Data: g.data,
        Categoria: g.categoria || 'outros',
    }));

    const ws = xlsx.utils.json_to_sheet(data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Gastos');

    const filePath = `./${userId}-${mes}.xlsx`;
    xlsx.writeFile(wb, filePath);

    return filePath;
}

async function gerarGraficoPizza(gastosMes, userId, mes) {
    const categorias = {};
    gastosMes.forEach(g => {
        categorias[g.categoria] = (categorias[g.categoria] || 0) + g.valor;
    });

    const width = 800;
    const height = 600;
    const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

    const data = {
        labels: Object.keys(categorias),
        datasets: [{
            label: 'Gastos por categoria',
            data: Object.values(categorias),
            backgroundColor: [
                '#ff6384', '#36a2eb', '#cc65fe', '#ffce56', '#4bc0c0', '#9966ff'
            ],
        }],
    };

    const config = {
        type: 'pie',
        data,
        options: {
            plugins: {
                legend: { position: 'right' },
                title: { display: true, text: `Gastos por Categoria (${mes})` }
            }
        }
    };

    const buffer = await chartJSNodeCanvas.renderToBuffer(config);
    const filePath = `./grafico-${userId}-${mes}.png`;
    fs.writeFileSync(filePath, buffer);
    return filePath;
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: P({ level: 'silent' }),
        printQRInTerminal: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const sender = msg.key.remoteJid;
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text;
        if (!text) return;

        const textoMinusculo = text.toLowerCase().trim();
        const userId = jidNormalizedUser(sender);
        const gastosData = loadGastos();
        const mesAtual = moment().format('YYYY-MM');

        // Comando ajuda
        if (textoMinusculo === 'ajuda') {
            const ajudaMsg = `
📌 *Comandos disponíveis no Domus:*

1️⃣ *Registrar gasto:*
Envie uma mensagem com a descrição, valor e data opcional para registrar um gasto.

Exemplos:
- "cafezinho 7,50"
- "mercado alimentação 150,00"
- "cinema lazer 50 reais 2025-05-20"

*Dica:* Para categorizar, inclua a categoria na descrição.
Categorias: alimentação, transporte, saúde, lazer, moradia, outros.

2️⃣ *Resumo:* Envie "resumo" para ver quanto gastou por categoria e total do mês.
3️⃣ *Exportar:* Envie "exportar" para gerar uma planilha Excel com os gastos.
4️⃣ *Gráfico:* Envie "gráfico" ou "grafico" para gerar um gráfico em pizza dos gastos.
5️⃣ *Apagar:* 
- "apagar 2" apaga um gasto específico.
- "apagar tudo" remove todos os gastos do mês.
6️⃣ *Menu:* Envie "menu" para acessar os botões interativos.
`;
            await sock.sendMessage(sender, { text: ajudaMsg });
            return;
        }

        // Comando menu
        if (textoMinusculo === 'menu') {
            await sock.sendMessage(sender, {
                text: '📋 Menu de Comandos Domus\n\nEscolha uma opção abaixo:',
                buttons: [
                    { buttonId: 'resumo', buttonText: { displayText: '📊 Resumo' }, type: 1 },
                    { buttonId: 'exportar', buttonText: { displayText: '📁 Exportar Excel' }, type: 1 },
                    { buttonId: 'grafico', buttonText: { displayText: '📈 Gráfico' }, type: 1 },
                    { buttonId: 'ajuda', buttonText: { displayText: '❓ Ajuda' }, type: 1 }
                ],
                headerType: 1,
            });
            return;
        }

        // Comando gráfico (grafico ou gráfico)
        if (['grafico', 'gráfico'].includes(textoMinusculo)) {
            if (!gastosData[userId] || !gastosData[userId][mesAtual]?.length) {
                await sock.sendMessage(sender, { text: 'Você não possui gastos registrados neste mês.' });
                return;
            }

            const filePath = await gerarGraficoPizza(gastosData[userId][mesAtual], userId, moment().format('MMMM'));
            await sock.sendMessage(sender, {
                image: fs.readFileSync(filePath),
                caption: '📈 Gráfico de gastos por categoria'
            });
            fs.unlinkSync(filePath);
            return;
        }

        // Comando exportar
        if (textoMinusculo === 'exportar') {
            if (!gastosData[userId] || !gastosData[userId][mesAtual]) {
                await sock.sendMessage(sender, { text: 'Você não possui gastos registrados neste mês.' });
                return;
            }

            const filePath = gerarExcel(userId, mesAtual, gastosData[userId][mesAtual]);
            await sock.sendMessage(sender, {
                document: fs.readFileSync(filePath),
                mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                fileName: path.basename(filePath),
            });
            fs.unlinkSync(filePath);
            return;
        }

        // Apagar tudo
        if (textoMinusculo.startsWith('apagar tudo')) {
            if (gastosData[userId]) {
                delete gastosData[userId][mesAtual];
                saveGastos(gastosData);
                await sock.sendMessage(sender, { text: 'Todos os seus gastos deste mês foram apagados.' });
            } else {
                await sock.sendMessage(sender, { text: 'Você não tem gastos registrados neste mês.' });
            }
            return;
        }

        // Apagar um gasto
        if (textoMinusculo.startsWith('apagar') || textoMinusculo.startsWith('remover')) {
            const numero = parseInt(text.split(' ')[1]) - 1;

            if (isNaN(numero)) {
                await sock.sendMessage(sender, { text: 'Por favor, informe o número do gasto. Ex: apagar 2' });
                return;
            }

            if (gastosData[userId]?.[mesAtual]?.[numero]) {
                gastosData[userId][mesAtual].splice(numero, 1);
                saveGastos(gastosData);
                await sock.sendMessage(sender, { text: 'Gasto apagado com sucesso.' });
            } else {
                await sock.sendMessage(sender, { text: 'Número inválido.' });
            }
            return;
        }

        // Comando resumo
        if (textoMinusculo === 'resumo') {
            if (!gastosData[userId] || !gastosData[userId][mesAtual]) {
                await sock.sendMessage(sender, { text: 'Você ainda não registrou gastos este mês.' });
                return;
            }

            const gastos = gastosData[userId][mesAtual];
            const resumo = {};
            let total = 0;

            for (const g of gastos) {
                resumo[g.categoria] = (resumo[g.categoria] || 0) + g.valor;
                total += g.valor;
            }

            let mensagem = `📊 Resumo de ${moment().format('MMMM')}\n\n`;
            for (const [categoria, valor] of Object.entries(resumo)) {
                mensagem += `📂 ${categoria}: ${formatarValor(valor)}\n`;
            }

            mensagem += `\n💰 Total geral: ${formatarValor(total)}`;
            await sock.sendMessage(sender, { text: mensagem });
            return;
        }

        // Registrar gasto
        const gasto = parseGasto(text);
        if (!gasto) {
            await sock.sendMessage(sender, {
                text: 'Formato inválido. Ex: "cafezinho 7,50" ou "mercado 100 reais 2025-05-15"',
            });
            return;
        }

        gasto.categoria = getCategoria(text);
        if (!gastosData[userId]) gastosData[userId] = {};
        if (!gastosData[userId][mesAtual]) gastosData[userId][mesAtual] = [];
        gastosData[userId][mesAtual].push(gasto);
        saveGastos(gastosData);

        const lista = gastosData[userId][mesAtual]
            .map((g, i) => `${i + 1}. ${g.descricao} - ${formatarValor(g.valor)} - ${moment(g.data).format('DD')}`)
            .join('\n');

        const total = gastosData[userId][mesAtual].reduce((acc, g) => acc + g.valor, 0);
        await sock.sendMessage(sender, {
            text: `📅 *Gastos de ${moment().format('MMMM')}*\n\n${lista}\n\n💰 *Total:* ${formatarValor(total)}`,
        });
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                console.log('Conexão perdida. Reconectando...');
                startBot();
            } else {
                console.log('Você foi deslogado.');
            }
        }
    });
}

startBot();
